import { Client, ConnectConfig, SFTPWrapper } from 'ssh2'
import { createReadStream, createWriteStream } from 'fs'
import { basename } from 'path'
import type { RemoteFileEntry } from '../../shared/types'
import { getStore } from './credential-store'

/** 规范化远程 POSIX 路径，解析 . / .. */
export function normalizeRemotePath(input: string): string {
  let raw = (input || '/').trim() || '/'
  if (!raw.startsWith('/')) raw = `/${raw}`
  const parts = raw.split('/')
  const stack: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return stack.length === 0 ? '/' : `/${stack.join('/')}`
}

export function posixJoin(dir: string, name: string): string {
  return normalizeRemotePath(`${dir === '/' ? '' : dir}/${name}`)
}

interface PooledConnection {
  client: Client
  lastUsed: number
  ready: boolean
}

export class SshManager {
  private pool = new Map<string, PooledConnection>()
  private connecting = new Map<string, Promise<Client>>()
  private idleTimer: NodeJS.Timeout | null = null
  private readonly idleMs = 10 * 60 * 1000

  constructor() {
    this.idleTimer = setInterval(() => this.reapIdle(), 60_000)
    this.idleTimer.unref?.()
  }

  private reapIdle(): void {
    const now = Date.now()
    for (const [id, pooled] of this.pool) {
      if (now - pooled.lastUsed > this.idleMs) {
        this.disconnect(id)
      }
    }
  }

  async connect(serverId: string): Promise<Client> {
    const existing = this.pool.get(serverId)
    if (existing?.ready) {
      existing.lastUsed = Date.now()
      return existing.client
    }
    if (existing) {
      this.disconnect(serverId)
    }

    const inflight = this.connecting.get(serverId)
    if (inflight) return inflight

    const promise = this.createConnection(serverId).finally(() => {
      this.connecting.delete(serverId)
    })
    this.connecting.set(serverId, promise)
    return promise
  }

  private async createConnection(serverId: string): Promise<Client> {
    const secret = getStore().getServerSecret(serverId)
    if (!secret) throw new Error('服务器不存在或未保存凭证')

    const config: ConnectConfig = {
      host: secret.host,
      port: secret.port,
      username: secret.username,
      readyTimeout: 20000,
      keepaliveInterval: 15000
    }

    if (secret.authType === 'password') {
      config.password = secret.password
    } else {
      config.privateKey = secret.privateKey
      if (secret.passphrase) config.passphrase = secret.passphrase
    }

    const client = await new Promise<Client>((resolve, reject) => {
      const c = new Client()
      const onError = (err: Error): void => {
        c.removeListener('ready', onReady)
        reject(err)
      }
      const onReady = (): void => {
        c.removeListener('error', onError)
        resolve(c)
      }
      c.once('ready', onReady)
      c.once('error', onError)
      c.on('close', () => {
        const pooled = this.pool.get(serverId)
        if (pooled?.client === c) {
          pooled.ready = false
          this.pool.delete(serverId)
        }
      })
      c.on('end', () => {
        const pooled = this.pool.get(serverId)
        if (pooled?.client === c) {
          pooled.ready = false
          this.pool.delete(serverId)
        }
      })
      c.connect(config)
    })

    this.pool.set(serverId, { client, lastUsed: Date.now(), ready: true })
    return client
  }

  async testConnection(input: {
    host: string
    port: number
    username: string
    authType: 'password' | 'privateKey'
    password?: string
    privateKey?: string
    passphrase?: string
  }): Promise<{ ok: boolean; message: string }> {
    const config: ConnectConfig = {
      host: input.host,
      port: input.port,
      username: input.username,
      readyTimeout: 15000
    }
    if (input.authType === 'password') {
      config.password = input.password
    } else {
      config.privateKey = input.privateKey
      if (input.passphrase) config.passphrase = input.passphrase
    }

    return new Promise((resolve) => {
      const c = new Client()
      const timer = setTimeout(() => {
        c.end()
        resolve({ ok: false, message: '连接超时' })
      }, 15000)

      c.on('ready', () => {
        clearTimeout(timer)
        c.end()
        resolve({ ok: true, message: '连接成功' })
      })
      c.on('error', (err) => {
        clearTimeout(timer)
        resolve({ ok: false, message: err.message })
      })
      c.connect(config)
    })
  }

  async exec(
    serverId: string,
    command: string,
    options?: { cwd?: string; onData?: (chunk: string, stream: 'stdout' | 'stderr') => void }
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const client = await this.connect(serverId)
    const cwd = options?.cwd ? normalizeRemotePath(options.cwd) : undefined
    const fullCmd = cwd ? `cd ${JSON.stringify(cwd)} && ${command}` : command

    return new Promise((resolve, reject) => {
      client.exec(fullCmd, (err, stream) => {
        if (err) {
          this.disconnect(serverId)
          return reject(err)
        }
        let stdout = ''
        let stderr = ''
        stream.on('data', (data: Buffer) => {
          const text = data.toString('utf8')
          stdout += text
          options?.onData?.(text, 'stdout')
        })
        stream.stderr.on('data', (data: Buffer) => {
          const text = data.toString('utf8')
          stderr += text
          options?.onData?.(text, 'stderr')
        })
        stream.on('close', (code: number | null) => {
          const pooled = this.pool.get(serverId)
          if (pooled) pooled.lastUsed = Date.now()
          resolve({ code, stdout, stderr })
        })
      })
    })
  }

  private async withSftp<T>(serverId: string, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const client = await this.connect(serverId)
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) {
          this.disconnect(serverId)
          return reject(err)
        }
        fn(sftp)
          .then((result) => {
            const pooled = this.pool.get(serverId)
            if (pooled) pooled.lastUsed = Date.now()
            resolve(result)
          })
          .catch(reject)
          .finally(() => sftp.end())
      })
    })
  }

  async listDir(serverId: string, path: string): Promise<RemoteFileEntry[]> {
    const normalized = normalizeRemotePath(path)
    return this.withSftp(serverId, (sftp) => {
      return new Promise((resolve, reject) => {
        sftp.readdir(normalized, (err, list) => {
          if (err) return reject(err)
          const entries: RemoteFileEntry[] = list.map((item) => {
            const attrs = item.attrs
            let type: RemoteFileEntry['type'] = 'other'
            if (attrs.isDirectory()) type = 'directory'
            else if (attrs.isFile()) type = 'file'
            else if (attrs.isSymbolicLink()) type = 'symlink'
            return {
              name: item.filename,
              path: posixJoin(normalized, item.filename),
              type,
              size: attrs.size || 0,
              modifyTime: (attrs.mtime || 0) * 1000,
              rights: attrs.mode?.toString(8)
            }
          })
          entries.sort((a, b) => {
            if (a.type === 'directory' && b.type !== 'directory') return -1
            if (a.type !== 'directory' && b.type === 'directory') return 1
            return a.name.localeCompare(b.name)
          })
          resolve(entries)
        })
      })
    })
  }

  async readFile(serverId: string, path: string, maxBytes = 256 * 1024): Promise<string> {
    const normalized = normalizeRemotePath(path)
    return this.withSftp(serverId, (sftp) => {
      return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        let total = 0
        const stream = sftp.createReadStream(normalized)
        stream.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > maxBytes) {
            stream.destroy()
            reject(new Error(`文件超过 ${maxBytes} 字节限制`))
            return
          }
          chunks.push(chunk)
        })
        stream.on('error', reject)
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      })
    })
  }

  async uploadFile(serverId: string, localPath: string, remotePath: string): Promise<void> {
    const target = remotePath.endsWith('/')
      ? posixJoin(remotePath.replace(/\/+$/, '') || '/', basename(localPath))
      : normalizeRemotePath(remotePath)

    return this.withSftp(serverId, (sftp) => {
      return new Promise((resolve, reject) => {
        const read = createReadStream(localPath)
        const write = sftp.createWriteStream(target)
        const fail = (err: Error): void => {
          read.destroy()
          write.destroy()
          reject(err)
        }
        read.on('error', fail)
        write.on('error', fail)
        write.on('close', () => resolve())
        read.pipe(write)
      })
    })
  }

  async downloadFile(serverId: string, remotePath: string, localPath: string): Promise<void> {
    const normalized = normalizeRemotePath(remotePath)
    return this.withSftp(serverId, (sftp) => {
      return new Promise((resolve, reject) => {
        const write = createWriteStream(localPath)
        const read = sftp.createReadStream(normalized)
        read.on('error', reject)
        write.on('error', reject)
        write.on('close', () => resolve())
        read.pipe(write)
      })
    })
  }

  async deletePath(serverId: string, path: string, isDir: boolean): Promise<void> {
    const normalized = normalizeRemotePath(path)
    if (normalized === '/') throw new Error('禁止删除根目录')
    return this.withSftp(serverId, (sftp) => {
      return new Promise((resolve, reject) => {
        const cb = (err: Error | undefined | null): void => {
          if (err) {
            if (isDir) reject(new Error(`${err.message}（非空目录需先清空子项）`))
            else reject(err)
          } else resolve()
        }
        if (isDir) sftp.rmdir(normalized, cb)
        else sftp.unlink(normalized, cb)
      })
    })
  }

  disconnect(serverId: string): void {
    const pooled = this.pool.get(serverId)
    if (pooled) {
      pooled.ready = false
      try {
        pooled.client.end()
      } catch {
        // ignore
      }
      this.pool.delete(serverId)
    }
  }

  disconnectAll(): void {
    for (const id of [...this.pool.keys()]) {
      this.disconnect(id)
    }
  }
}

let sshInstance: SshManager | null = null

export function getSshManager(): SshManager {
  if (!sshInstance) sshInstance = new SshManager()
  return sshInstance
}
