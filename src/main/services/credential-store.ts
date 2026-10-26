import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type {
  AppSettings,
  AuthType,
  FavoriteDir,
  LlmProvider,
  ServerConfig
} from '../../shared/types'
import { getStoreFilePath } from './app-paths'
import { randomUUID } from 'crypto'
import { getChatStore, reloadChatStore } from './chat-session-store'
import { getMonitorStore, reloadMonitorStore } from './monitor-store'
import { reloadDeployStore } from './deploy-store'

interface StoredServer extends Omit<ServerConfig, 'hasCredential'> {
  passwordEnc?: string
  privateKeyEnc?: string
  passphraseEnc?: string
}

interface StoredProvider extends Omit<LlmProvider, 'hasApiKey'> {
  apiKeyEnc?: string
}

interface StoreData {
  servers: StoredServer[]
  providers: StoredProvider[]
  settings: AppSettings
  /** @deprecated 已迁移到 chats/ 目录分文件存储，仅兼容读取 */
  chats?: Record<string, unknown>
  favorites: Record<string, FavoriteDir[]>
  /** @deprecated 已迁移到 monitors/ 分文件存储 */
  monitors?: Record<string, unknown>
}

const DEFAULT_SETTINGS: AppSettings = {
  defaultProviderId: null,
  autoConfirmReadonly: true,
  blockDangerousCommands: true,
  maxAgentRounds: 20
}

function encrypt(plain: string): string {
  if (!plain) return ''
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[credential-store] safeStorage 不可用，敏感数据将使用弱保护存储')
  }
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plain).toString('base64')
  }
  return `plain:${Buffer.from(plain, 'utf8').toString('base64')}`
}

function decrypt(enc: string): string {
  if (!enc) return ''
  if (enc.startsWith('plain:')) {
    return Buffer.from(enc.slice('plain:'.length), 'base64').toString('utf8')
  }
  const buf = Buffer.from(enc, 'base64')
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(buf)
    } catch (err) {
      throw new Error(`凭证解密失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return buf.toString('utf8')
}

function defaultNameFromPath(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean)
  if (parts.length === 0) return '/'
  if (parts.length === 1) return parts[0]
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}

export class CredentialStore {
  private filePath: string
  private data: StoreData

  constructor() {
    this.filePath = getStoreFilePath()
    this.ensureDir()
    this.data = this.load()
  }

  /** 切换数据目录后重新加载 */
  reload(): void {
    this.filePath = getStoreFilePath()
    this.ensureDir()
    this.data = this.load()
  }

  getStorePath(): string {
    return this.filePath
  }

  private ensureDir(): void {
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  private load(): StoreData {
    if (!existsSync(this.filePath)) {
      return {
        servers: [],
        providers: [],
        settings: { ...DEFAULT_SETTINGS },
        favorites: {}
      }
    }
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as StoreData
      return {
        servers: parsed.servers || [],
        providers: parsed.providers || [],
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
        favorites: parsed.favorites || {}
        // monitors 由 monitor-store 分文件管理，不再写入本对象
      }
    } catch {
      return {
        servers: [],
        providers: [],
        settings: { ...DEFAULT_SETTINGS },
        favorites: {}
      }
    }
  }

  private save(): void {
    this.ensureDir()
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8')
  }

  getSettings(): AppSettings {
    return { ...this.data.settings }
  }

  updateSettings(partial: Partial<AppSettings>): AppSettings {
    this.data.settings = { ...this.data.settings, ...partial }
    this.save()
    return this.getSettings()
  }

  listServers(): ServerConfig[] {
    return this.data.servers.map((s) => ({
      id: s.id,
      name: s.name,
      host: s.host,
      port: s.port,
      username: s.username,
      authType: s.authType,
      hasCredential: Boolean(s.passwordEnc || s.privateKeyEnc),
      createdAt: s.createdAt,
      updatedAt: s.updatedAt
    }))
  }

  getServerSecret(id: string): {
    authType: AuthType
    password?: string
    privateKey?: string
    passphrase?: string
    host: string
    port: number
    username: string
  } | null {
    const s = this.data.servers.find((x) => x.id === id)
    if (!s) return null
    return {
      authType: s.authType,
      host: s.host,
      port: s.port,
      username: s.username,
      password: s.passwordEnc ? decrypt(s.passwordEnc) : undefined,
      privateKey: s.privateKeyEnc ? decrypt(s.privateKeyEnc) : undefined,
      passphrase: s.passphraseEnc ? decrypt(s.passphraseEnc) : undefined
    }
  }

  upsertServer(
    input: {
      id: string
      name: string
      host: string
      port: number
      username: string
      authType: AuthType
      password?: string
      privateKey?: string
      passphrase?: string
    },
    isNew: boolean
  ): ServerConfig {
    const now = Date.now()
    const existing = this.data.servers.find((s) => s.id === input.id)
    const next: StoredServer = {
      id: input.id,
      name: input.name,
      host: input.host,
      port: input.port,
      username: input.username,
      authType: input.authType,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      passwordEnc: existing?.passwordEnc,
      privateKeyEnc: existing?.privateKeyEnc,
      passphraseEnc: existing?.passphraseEnc
    }

    if (input.password !== undefined && input.password !== '') {
      next.passwordEnc = encrypt(input.password)
    }
    if (input.privateKey !== undefined && input.privateKey !== '') {
      next.privateKeyEnc = encrypt(input.privateKey)
    }
    if (input.passphrase !== undefined) {
      next.passphraseEnc = input.passphrase ? encrypt(input.passphrase) : undefined
    }
    if (isNew || !existing) {
      if (input.authType === 'password' && !next.passwordEnc && input.password) {
        next.passwordEnc = encrypt(input.password)
      }
      this.data.servers.push(next)
    } else {
      Object.assign(existing, next)
    }
    this.save()
    return this.listServers().find((s) => s.id === input.id)!
  }

  deleteServer(id: string): boolean {
    const before = this.data.servers.length
    this.data.servers = this.data.servers.filter((s) => s.id !== id)
    delete this.data.favorites[id]
    getMonitorStore().clear(id)
    getChatStore().deleteSessionsByServer(id)
    this.save()
    return this.data.servers.length < before
  }

  listProviders(): LlmProvider[] {
    return this.data.providers.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      model: p.model,
      temperature: p.temperature,
      enabled: p.enabled,
      hasApiKey: Boolean(p.apiKeyEnc),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt
    }))
  }

  getProviderSecret(id: string): { baseUrl: string; apiKey: string; model: string; temperature?: number } | null {
    const p = this.data.providers.find((x) => x.id === id)
    if (!p) return null
    return {
      baseUrl: p.baseUrl.replace(/\/$/, ''),
      apiKey: p.apiKeyEnc ? decrypt(p.apiKeyEnc) : '',
      model: p.model,
      temperature: p.temperature
    }
  }

  upsertProvider(
    input: {
      id: string
      name: string
      baseUrl: string
      model: string
      temperature?: number
      enabled: boolean
      apiKey?: string
    },
    isNew: boolean
  ): LlmProvider {
    const now = Date.now()
    const existing = this.data.providers.find((p) => p.id === input.id)
    const next: StoredProvider = {
      id: input.id,
      name: input.name,
      baseUrl: input.baseUrl,
      model: input.model,
      temperature: input.temperature,
      enabled: input.enabled,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      apiKeyEnc: existing?.apiKeyEnc
    }
    if (input.apiKey !== undefined && input.apiKey !== '') {
      next.apiKeyEnc = encrypt(input.apiKey)
    }
    if (isNew || !existing) {
      this.data.providers.push(next)
    } else {
      Object.assign(existing, next)
    }
    this.save()
    return this.listProviders().find((p) => p.id === input.id)!
  }

  cloneProvider(id: string): LlmProvider {
    const source = this.data.providers.find((p) => p.id === id)
    if (!source) throw new Error('Provider 不存在')
    const now = Date.now()
    const next: StoredProvider = {
      id: randomUUID(),
      name: `${source.name} 副本`,
      baseUrl: source.baseUrl,
      model: source.model,
      temperature: source.temperature,
      enabled: source.enabled,
      apiKeyEnc: source.apiKeyEnc,
      createdAt: now,
      updatedAt: now
    }
    this.data.providers.push(next)
    this.save()
    return this.listProviders().find((p) => p.id === next.id)!
  }

  deleteProvider(id: string): boolean {
    const before = this.data.providers.length
    this.data.providers = this.data.providers.filter((p) => p.id !== id)
    if (this.data.settings.defaultProviderId === id) {
      this.data.settings.defaultProviderId = this.data.providers[0]?.id ?? null
    }
    this.save()
    return this.data.providers.length < before
  }

  listFavorites(serverId: string): FavoriteDir[] {
    return [...(this.data.favorites[serverId] || [])].sort((a, b) => a.createdAt - b.createdAt)
  }

  addFavorite(serverId: string, path: string, name?: string): FavoriteDir {
    const normalized = path.trim() || '/'
    const list = this.data.favorites[serverId] || []
    const existing = list.find((f) => f.path === normalized)
    if (existing) return existing

    const item: FavoriteDir = {
      id: randomUUID(),
      path: normalized,
      name: (name || defaultNameFromPath(normalized)).trim() || defaultNameFromPath(normalized),
      createdAt: Date.now()
    }
    this.data.favorites[serverId] = [...list, item]
    this.save()
    return item
  }

  removeFavorite(serverId: string, idOrPath: string): boolean {
    const list = this.data.favorites[serverId] || []
    const next = list.filter((f) => f.id !== idOrPath && f.path !== idOrPath)
    if (next.length === list.length) return false
    this.data.favorites[serverId] = next
    this.save()
    return true
  }

  renameFavorite(serverId: string, id: string, name: string): FavoriteDir | null {
    const list = this.data.favorites[serverId] || []
    const item = list.find((f) => f.id === id)
    if (!item) return null
    item.name = name.trim() || item.name
    this.save()
    return { ...item }
  }

  isFavorite(serverId: string, path: string): boolean {
    return (this.data.favorites[serverId] || []).some((f) => f.path === path)
  }
}

let storeInstance: CredentialStore | null = null

export function getStore(): CredentialStore {
  if (!storeInstance) storeInstance = new CredentialStore()
  return storeInstance
}

export function reloadStore(): CredentialStore {
  if (storeInstance) {
    storeInstance.reload()
  } else {
    storeInstance = new CredentialStore()
  }
  reloadChatStore()
  reloadMonitorStore()
  reloadDeployStore()
  return storeInstance
}
