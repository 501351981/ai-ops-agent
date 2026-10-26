import { randomUUID } from 'crypto'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import type {
  MonitorBundle,
  MonitorBundleInput,
  MonitorManifest,
  MonitorSummary
} from '../../shared/types'
import {
  ensureMonitorServerDir,
  getMonitorHtmlPath,
  getMonitorMetaPath,
  getMonitorScriptPath,
  getMonitorServerDir,
  getMonitorsDir,
  getStoreFilePath
} from './app-paths'

interface MonitorMetaFile {
  id: string
  serverId: string
  manifest: MonitorManifest
  updatedAt: number
}

/**
 * 监控看板分文件存储：
 *   {dataDir}/monitors/{serverId}/meta.json
 *   {dataDir}/monitors/{serverId}/dashboard.html
 *   {dataDir}/monitors/{serverId}/collect.sh
 */
export class MonitorStore {
  constructor() {
    getMonitorsDir()
    this.migrateLegacyFromStoreJson()
  }

  reload(): void {
    getMonitorsDir()
    this.migrateLegacyFromStoreJson()
  }

  get(serverId: string): MonitorBundle | null {
    const metaPath = getMonitorMetaPath(serverId)
    const htmlPath = getMonitorHtmlPath(serverId)
    const scriptPath = getMonitorScriptPath(serverId)
    if (!existsSync(metaPath) || !existsSync(htmlPath) || !existsSync(scriptPath)) {
      return null
    }
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as MonitorMetaFile
      return {
        id: meta.id,
        serverId: meta.serverId,
        manifest: meta.manifest,
        html: readFileSync(htmlPath, 'utf8'),
        collectScript: readFileSync(scriptPath, 'utf8'),
        updatedAt: meta.updatedAt
      }
    } catch {
      return null
    }
  }

  /** 扫描已配置看板的轻量摘要（不含 html/script） */
  listSummaries(): MonitorSummary[] {
    const root = getMonitorsDir()
    let entries: string[] = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      return []
    }

    const list: MonitorSummary[] = []
    for (const serverId of entries) {
      const metaPath = getMonitorMetaPath(serverId)
      const htmlPath = getMonitorHtmlPath(serverId)
      const scriptPath = getMonitorScriptPath(serverId)
      if (!existsSync(metaPath) || !existsSync(htmlPath) || !existsSync(scriptPath)) continue
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as MonitorMetaFile
        list.push({
          id: meta.id,
          serverId: meta.serverId || serverId,
          name: meta.manifest?.name || '系统监控',
          version: meta.manifest?.version || '1.0.0',
          intervalSec: meta.manifest?.intervalSec ?? 5,
          updatedAt: meta.updatedAt || 0
        })
      } catch {
        /* skip broken */
      }
    }
    return list.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  save(serverId: string, input: MonitorBundleInput): MonitorBundle {
    const existing = this.get(serverId)
    const intervalSec = Math.min(300, Math.max(2, Math.round(input.intervalSec ?? 5)))
    const name = (input.name || '系统监控').trim() || '系统监控'
    const version = (input.version || existing?.manifest.version || '1.0.0').trim() || '1.0.0'
    const html = String(input.html || '').trim()
    const collectScript = String(input.collectScript || '').trim()
    if (!html) throw new Error('html 不能为空')
    if (!collectScript) throw new Error('collectScript 不能为空')

    const bundle: MonitorBundle = {
      id: existing?.id || randomUUID(),
      serverId,
      manifest: {
        name,
        version,
        intervalSec,
        metricsSchema: input.metricsSchema
      },
      collectScript,
      html,
      updatedAt: Date.now()
    }

    ensureMonitorServerDir(serverId)
    const meta: MonitorMetaFile = {
      id: bundle.id,
      serverId: bundle.serverId,
      manifest: bundle.manifest,
      updatedAt: bundle.updatedAt
    }
    writeFileSync(getMonitorMetaPath(serverId), JSON.stringify(meta, null, 2), 'utf8')
    writeFileSync(getMonitorHtmlPath(serverId), bundle.html, 'utf8')
    writeFileSync(getMonitorScriptPath(serverId), bundle.collectScript, 'utf8')
    return { ...bundle }
  }

  clear(serverId: string): boolean {
    const dir = getMonitorServerDir(serverId)
    const metaPath = getMonitorMetaPath(serverId)
    if (!existsSync(metaPath) && !existsSync(getMonitorHtmlPath(serverId))) {
      // 空目录也清掉
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
      return false
    }
    try {
      rmSync(dir, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }

  /** 把旧版塞进 store.json 的 monitors 迁到分文件，并清理 store 字段 */
  private migrateLegacyFromStoreJson(): void {
    const storePath = getStoreFilePath()
    if (!existsSync(storePath)) return
    try {
      const raw = JSON.parse(readFileSync(storePath, 'utf8')) as {
        monitors?: Record<string, MonitorBundle>
      }
      const monitors = raw.monitors
      if (!monitors || typeof monitors !== 'object') return

      let migrated = 0
      for (const [serverId, bundle] of Object.entries(monitors)) {
        if (!bundle?.html || !bundle?.collectScript) continue
        if (this.get(serverId)) continue
        this.save(serverId, {
          name: bundle.manifest?.name || '系统监控',
          html: bundle.html,
          collectScript: bundle.collectScript,
          intervalSec: bundle.manifest?.intervalSec,
          metricsSchema: bundle.manifest?.metricsSchema,
          version: bundle.manifest?.version
        })
        // 保留原 id / updatedAt
        const metaPath = getMonitorMetaPath(serverId)
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as MonitorMetaFile
        meta.id = bundle.id || meta.id
        meta.updatedAt = bundle.updatedAt || meta.updatedAt
        writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8')
        migrated++
      }

      if (Object.keys(monitors).length > 0 || migrated > 0) {
        delete raw.monitors
        writeFileSync(storePath, JSON.stringify(raw, null, 2), 'utf8')
      }
    } catch (err) {
      console.warn('[monitor-store] 迁移旧 monitors 失败:', err)
    }
  }
}

let instance: MonitorStore | null = null

export function getMonitorStore(): MonitorStore {
  if (!instance) instance = new MonitorStore()
  return instance
}

export function reloadMonitorStore(): MonitorStore {
  if (instance) instance.reload()
  else instance = new MonitorStore()
  return instance
}
