import { app } from 'electron'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'fs'
import { join } from 'path'

interface AppPathConfig {
  /** 用户自定义数据目录；为空则使用默认 userData/data */
  dataDir?: string | null
}

function configPath(): string {
  return join(app.getPath('userData'), 'app-config.json')
}

export function getDefaultDataDir(): string {
  return join(app.getPath('userData'), 'data')
}

function readConfig(): AppPathConfig {
  const file = configPath()
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as AppPathConfig
  } catch {
    return {}
  }
}

function writeConfig(cfg: AppPathConfig): void {
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8')
}

export function getDataDir(): string {
  const cfg = readConfig()
  const dir = cfg.dataDir?.trim() || getDefaultDataDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function getStoreFilePath(): string {
  return join(getDataDir(), 'store.json')
}

/** 会话消息目录：每会话一个 json 文件 */
export function getChatsDir(): string {
  const dir = join(getDataDir(), 'chats')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function getChatIndexPath(): string {
  return join(getChatsDir(), 'index.json')
}

export function getChatSessionFilePath(sessionId: string): string {
  return join(getChatsDir(), `${sessionId}.json`)
}

/** 监控看板根目录 */
export function getMonitorsDir(): string {
  const dir = join(getDataDir(), 'monitors')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 单台服务器监控目录（不自动创建） */
export function getMonitorServerDir(serverId: string): string {
  return join(getMonitorsDir(), serverId)
}

export function ensureMonitorServerDir(serverId: string): string {
  const dir = getMonitorServerDir(serverId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function getMonitorMetaPath(serverId: string): string {
  return join(getMonitorServerDir(serverId), 'meta.json')
}

export function getMonitorHtmlPath(serverId: string): string {
  return join(getMonitorServerDir(serverId), 'dashboard.html')
}

export function getMonitorScriptPath(serverId: string): string {
  return join(getMonitorServerDir(serverId), 'collect.sh')
}

/** 部署配方根目录 */
export function getDeploysDir(): string {
  const dir = join(getDataDir(), 'deploys')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function getDeployProjectDir(projectId: string): string {
  return join(getDeploysDir(), projectId)
}

export function ensureDeployProjectDir(projectId: string): string {
  const dir = getDeployProjectDir(projectId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function getDeployMetaPath(projectId: string): string {
  return join(getDeployProjectDir(projectId), 'meta.json')
}

export function getDeployRecipePath(projectId: string): string {
  return join(getDeployProjectDir(projectId), 'recipe.json')
}

export function getDeployRunsDir(projectId: string): string {
  const dir = join(getDeployProjectDir(projectId), 'runs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function getDeployRunPath(projectId: string, runId: string): string {
  return join(getDeployRunsDir(projectId), `${runId}.json`)
}

export function getDataLocationInfo(): {
  dataDir: string
  storeFile: string
  isDefault: boolean
  defaultDataDir: string
} {
  const dataDir = getDataDir()
  const defaultDataDir = getDefaultDataDir()
  return {
    dataDir,
    storeFile: getStoreFilePath(),
    isDefault: dataDir === defaultDataDir,
    defaultDataDir
  }
}

/**
 * 设置数据目录。
 * migrate=true 时，若目标没有 store.json 且源有，则复制过去。
 */
export function setDataDir(
  nextDir: string,
  options?: { migrate?: boolean }
): { ok: boolean; message: string; info: ReturnType<typeof getDataLocationInfo> } {
  const target = nextDir.trim()
  if (!target) {
    return { ok: false, message: '路径不能为空', info: getDataLocationInfo() }
  }

  try {
    if (!existsSync(target)) mkdirSync(target, { recursive: true })
  } catch (err) {
    return {
      ok: false,
      message: `无法创建目录: ${err instanceof Error ? err.message : String(err)}`,
      info: getDataLocationInfo()
    }
  }

  const prevDataDir = getDataDir()
  const prevStore = getStoreFilePath()
  const nextStore = join(target, 'store.json')
  const prevChats = join(prevDataDir, 'chats')
  const nextChats = join(target, 'chats')
  const prevMonitors = join(prevDataDir, 'monitors')
  const nextMonitors = join(target, 'monitors')
  const prevDeploys = join(prevDataDir, 'deploys')
  const nextDeploys = join(target, 'deploys')
  const migrate = options?.migrate !== false

  if (migrate) {
    try {
      if (existsSync(prevStore) && !existsSync(nextStore)) {
        copyFileSync(prevStore, nextStore)
      }
      if (existsSync(prevChats) && !existsSync(nextChats)) {
        cpSync(prevChats, nextChats, { recursive: true })
      }
      if (existsSync(prevMonitors) && !existsSync(nextMonitors)) {
        cpSync(prevMonitors, nextMonitors, { recursive: true })
      }
      if (existsSync(prevDeploys) && !existsSync(nextDeploys)) {
        cpSync(prevDeploys, nextDeploys, { recursive: true })
      }
    } catch (err) {
      return {
        ok: false,
        message: `迁移数据失败: ${err instanceof Error ? err.message : String(err)}`,
        info: getDataLocationInfo()
      }
    }
  }

  writeConfig({ dataDir: target === getDefaultDataDir() ? null : target })

  return {
    ok: true,
    message: migrate
      ? '已切换数据目录（已尝试迁移 store / 会话 / 监控 / 部署）'
      : '已切换数据目录',
    info: getDataLocationInfo()
  }
}

export function resetDataDirToDefault(options?: { migrate?: boolean }): ReturnType<typeof setDataDir> {
  return setDataDir(getDefaultDataDir(), options)
}
