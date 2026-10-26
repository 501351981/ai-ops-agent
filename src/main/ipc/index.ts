import { BrowserWindow, dialog, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import type {
  AppSettings,
  DeploymentRecipeInput,
  DeployPlanRequest,
  DeployRunRequest,
  LlmProviderInput,
  MonitorBundleInput,
  ServerInput
} from '../../shared/types'
import { getStore, reloadStore } from '../services/credential-store'
import { getChatStore } from '../services/chat-session-store'
import { getSshManager } from '../services/ssh-manager'
import { getLlmClient } from '../services/llm-client'
import { getAgentRuntime } from '../services/agent-runtime'
import { getMonitorService } from '../services/monitor-service'
import { getMonitorStore } from '../services/monitor-store'
import { getDeployStore } from '../services/deploy-store'
import { getDeployService } from '../services/deploy-service'
import { planDeployment } from '../services/deploy-planner'
import { getDataLocationInfo, resetDataDirToDefault, setDataDir } from '../services/app-paths'
import { LLM_PRESETS } from '../../shared/types'
import { assessCommandRisk } from '../tools'

export function registerIpcHandlers(): void {
  const ssh = getSshManager()
  const llm = getLlmClient()
  const agent = getAgentRuntime()
  const monitor = getMonitorService()
  const deploy = getDeployService()
  // 启动时初始化并迁移旧版 store.json 内嵌 monitors
  getMonitorStore()
  getDeployStore()

  // ---- settings ----
  ipcMain.handle('settings:get', () => getStore().getSettings())
  ipcMain.handle('settings:update', (_e, partial: Partial<AppSettings>) => getStore().updateSettings(partial))

  // ---- data location ----
  ipcMain.handle('data:location', () => getDataLocationInfo())
  ipcMain.handle('data:choose-dir', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择数据存储目录'
    })
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    return { canceled: false, path: result.filePaths[0] }
  })
  ipcMain.handle('data:set-dir', (_e, dir: string, migrate = true) => {
    const result = setDataDir(dir, { migrate })
    if (result.ok) reloadStore()
    return result
  })
  ipcMain.handle('data:reset-dir', (_e, migrate = true) => {
    const result = resetDataDirToDefault({ migrate })
    if (result.ok) reloadStore()
    return result
  })

  // ---- favorites ----
  ipcMain.handle('favorites:list', (_e, serverId: string) => getStore().listFavorites(serverId))
  ipcMain.handle('favorites:add', (_e, serverId: string, path: string, name?: string) =>
    getStore().addFavorite(serverId, path, name)
  )
  ipcMain.handle('favorites:remove', (_e, serverId: string, idOrPath: string) =>
    getStore().removeFavorite(serverId, idOrPath)
  )
  ipcMain.handle('favorites:rename', (_e, serverId: string, id: string, name: string) =>
    getStore().renameFavorite(serverId, id, name)
  )

  // ---- servers ----
  ipcMain.handle('servers:list', () => getStore().listServers())
  ipcMain.handle('servers:upsert', (_e, input: ServerInput) => {
    const isNew = !input.id
    const id = input.id || randomUUID()
    return getStore().upsertServer({ ...input, id }, isNew)
  })
  ipcMain.handle('servers:delete', (_e, id: string) => {
    monitor.stop(id)
    ssh.disconnect(id)
    return getStore().deleteServer(id)
  })
  ipcMain.handle('servers:test', async (_e, input: ServerInput) => {
    if (input.id && (!input.password && !input.privateKey)) {
      const secret = getStore().getServerSecret(input.id)
      if (!secret) return { ok: false, message: '找不到已保存的凭证' }
      return ssh.testConnection({
        host: input.host || secret.host,
        port: input.port || secret.port,
        username: input.username || secret.username,
        authType: input.authType || secret.authType,
        password: secret.password,
        privateKey: secret.privateKey,
        passphrase: secret.passphrase
      })
    }
    return ssh.testConnection({
      host: input.host,
      port: input.port,
      username: input.username,
      authType: input.authType,
      password: input.password,
      privateKey: input.privateKey,
      passphrase: input.passphrase
    })
  })
  ipcMain.handle('servers:disconnect', (_e, id: string) => {
    monitor.stop(id)
    ssh.disconnect(id)
    return true
  })

  // ---- monitor dashboard ----
  ipcMain.handle('monitor:list', () => getMonitorStore().listSummaries())
  ipcMain.handle('monitor:get', (_e, serverId: string) => monitor.getBundle(serverId))
  ipcMain.handle('monitor:save', (_e, serverId: string, input: MonitorBundleInput) => {
    const script = String(input.collectScript || '')
    const risk = assessCommandRisk(script)
    if (risk.blocked || risk.riskLevel === 'high') {
      throw new Error(`采集脚本不安全: ${risk.reason || '高风险'}`)
    }
    return getMonitorStore().save(serverId, input)
  })
  ipcMain.handle('monitor:clear', (_e, serverId: string) => {
    monitor.stop(serverId)
    return getMonitorStore().clear(serverId)
  })
  ipcMain.handle('monitor:start', (event, serverId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return monitor.start(serverId, win)
  })
  ipcMain.handle('monitor:stop', (_e, serverId: string) => {
    monitor.stop(serverId)
    return true
  })
  ipcMain.handle('monitor:refresh', async (event, serverId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return monitor.refreshOnce(serverId, win)
  })
  ipcMain.handle('monitor:update-interval', (event, serverId: string, intervalSec: number) => {
    const existing = getMonitorStore().get(serverId)
    if (!existing) throw new Error('未配置监控看板')
    const bundle = getMonitorStore().save(serverId, {
      name: existing.manifest.name,
      html: existing.html,
      collectScript: existing.collectScript,
      intervalSec,
      metricsSchema: existing.manifest.metricsSchema,
      version: existing.manifest.version
    })
    const win = BrowserWindow.fromWebContents(event.sender)
    monitor.stop(serverId)
    monitor.start(serverId, win)
    return bundle
  })

  // ---- providers ----
  ipcMain.handle('providers:list', () => getStore().listProviders())
  ipcMain.handle('providers:presets', () => LLM_PRESETS)
  ipcMain.handle('providers:upsert', (_e, input: LlmProviderInput) => {
    const isNew = !input.id
    const id = input.id || randomUUID()
    const store = getStore()
    const provider = store.upsertProvider({ ...input, id }, isNew)
    const settings = store.getSettings()
    if (!settings.defaultProviderId) {
      store.updateSettings({ defaultProviderId: provider.id })
    }
    return provider
  })
  ipcMain.handle('providers:clone', (_e, id: string) => getStore().cloneProvider(id))
  ipcMain.handle('providers:delete', (_e, id: string) => getStore().deleteProvider(id))
  ipcMain.handle(
    'providers:test',
    async (
      _e,
      payload: { id?: string; baseUrl?: string; apiKey?: string; model?: string }
    ) => {
      // 编辑弹窗：用表单里的 model/baseUrl 测，API Key 可复用已保存的
      if (payload.id && (payload.model || payload.baseUrl || payload.apiKey)) {
        return llm.testConnection(payload.id, {
          baseUrl: payload.baseUrl,
          model: payload.model,
          apiKey: payload.apiKey
        })
      }
      if (payload.id) return llm.testConnection(payload.id)
      if (payload.baseUrl && payload.model) {
        return llm.testConnectionWithConfig({
          baseUrl: payload.baseUrl,
          apiKey: payload.apiKey,
          model: payload.model
        })
      }
      return { ok: false, message: '缺少测试参数' }
    }
  )

  // ---- files ----
  ipcMain.handle('files:list', async (_e, serverId: string, path: string) => ssh.listDir(serverId, path))
  ipcMain.handle('files:read', async (_e, serverId: string, path: string) => ssh.readFile(serverId, path))
  ipcMain.handle('files:delete', async (_e, serverId: string, path: string, isDir: boolean) => {
    await ssh.deletePath(serverId, path, isDir)
    return true
  })
  /** 仅选择本机文件，返回绝对路径（模板部署 file 参数等） */
  ipcMain.handle('files:pick-local', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      title: '选择本机文件'
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })
  ipcMain.handle('files:upload', async (event, serverId: string, remoteDir: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
      title: '选择要上传的文件'
    })
    if (result.canceled || result.filePaths.length === 0) return { uploaded: 0 }
    for (const local of result.filePaths) {
      await ssh.uploadFile(serverId, local, remoteDir.endsWith('/') ? remoteDir : remoteDir + '/')
    }
    return { uploaded: result.filePaths.length }
  })
  ipcMain.handle('files:download', async (event, serverId: string, remotePath: string, fileName: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showSaveDialog(win!, {
      defaultPath: fileName,
      title: '保存文件'
    })
    if (result.canceled || !result.filePath) return { ok: false }
    await ssh.downloadFile(serverId, remotePath, result.filePath)
    return { ok: true, path: result.filePath }
  })

  // ---- chat sessions / agent ----
  ipcMain.handle('sessions:list', (_e, serverId: string) => getChatStore().listSessions(serverId))
  ipcMain.handle('sessions:list-by-kind', (_e, kind: 'ops' | 'deploy') =>
    getChatStore().listByKind(kind)
  )
  ipcMain.handle('sessions:ensure', (_e, serverId: string) => getChatStore().ensureActiveSession(serverId))
  ipcMain.handle('sessions:get', (_e, sessionId: string) => getChatStore().getSession(sessionId))
  ipcMain.handle(
    'sessions:create',
    (_e, serverId: string, title?: string, kind?: 'ops' | 'deploy') =>
      getChatStore().createSession(serverId, title, kind || 'ops')
  )
  ipcMain.handle('sessions:set-active', (_e, serverId: string, sessionId: string) =>
    getChatStore().setActiveSession(serverId, sessionId)
  )
  ipcMain.handle('sessions:rename', (_e, sessionId: string, title: string) =>
    getChatStore().renameSession(sessionId, title)
  )
  ipcMain.handle('sessions:delete', (_e, sessionId: string) => {
    agent.cancelSession(sessionId)
    return getChatStore().deleteSession(sessionId)
  })
  ipcMain.handle('chat:history', (_e, sessionId: string) => getChatStore().getMessages(sessionId))
  ipcMain.handle('chat:clear', (_e, sessionId: string) => {
    agent.cancelSession(sessionId)
    getChatStore().clearMessages(sessionId)
    return true
  })
  ipcMain.handle(
    'agent:chat',
    async (
      event,
      payload: {
        serverId: string
        sessionId: string
        providerId: string
        message: string
        queryId?: string
        mode?: 'ops' | 'deploy'
      }
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      await agent.runChat({
        serverId: payload.serverId,
        sessionId: payload.sessionId,
        providerId: payload.providerId,
        userMessage: payload.message,
        queryId: payload.queryId,
        mode: payload.mode,
        window: win
      })
      return true
    }
  )
  ipcMain.handle('agent:confirm', (_e, requestId: string, approved: boolean) => {
    agent.respondConfirm(requestId, approved)
    return true
  })
  ipcMain.handle(
    'agent:template-draft',
    (
      _e,
      requestId: string,
      approved: boolean,
      feedback?: string,
      overrides?: { name?: string }
    ) => {
      agent.respondTemplateDraft(requestId, approved, feedback, overrides)
      return true
    }
  )
  ipcMain.handle('agent:cancel', (_e, serverIdOrSessionId: string) => {
    // 兼容：先按 session 取消，再按 server 取消
    agent.cancelSession(serverIdOrSessionId)
    agent.cancelServer(serverIdOrSessionId)
    return true
  })

  // ---- deploy (Recipe 定版 + 零 Token 发布) ----
  ipcMain.handle('deploy:projects:list', () => getDeployStore().listProjects())
  ipcMain.handle('deploy:projects:get', (_e, projectId: string) => getDeployStore().getProject(projectId))
  ipcMain.handle('deploy:projects:create', (_e, name: string, serverId?: string) =>
    getDeployStore().createProject(name, serverId)
  )
  ipcMain.handle('deploy:projects:delete', (_e, projectId: string) => {
    deploy.cancelProject(projectId)
    return getDeployStore().deleteProject(projectId)
  })
  ipcMain.handle('deploy:recipe:get', (_e, projectId: string) => getDeployStore().getRecipe(projectId))
  ipcMain.handle(
    'deploy:recipe:save',
    (_e, input: DeploymentRecipeInput, status: 'draft' | 'active' | 'archived' = 'active') => {
      for (const step of input.steps || []) {
        const risk = assessCommandRisk(step.command)
        if (risk.blocked) {
          throw new Error(`步骤「${step.name}」含危险命令，已被阻止: ${risk.reason}`)
        }
        if (step.rollbackCommand) {
          const rb = assessCommandRisk(step.rollbackCommand)
          if (rb.blocked) {
            throw new Error(`步骤「${step.name}」回滚命令不安全: ${rb.reason}`)
          }
        }
      }
      for (const a of input.assertions || []) {
        const risk = assessCommandRisk(a.checkCommand)
        if (risk.blocked) {
          throw new Error(`断言「${a.description}」含危险命令: ${risk.reason}`)
        }
      }
      return getDeployStore().saveRecipe(input, status)
    }
  )
  ipcMain.handle('deploy:runs:list', (_e, projectId: string, limit?: number) =>
    getDeployStore().listRuns(projectId, limit)
  )
  ipcMain.handle('deploy:runs:get', (_e, projectId: string, runId: string) =>
    getDeployStore().getRun(projectId, runId)
  )
  ipcMain.handle('deploy:run', async (event, req: DeployRunRequest) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return deploy.run(req, win)
  })
  ipcMain.handle('deploy:confirm', (_e, requestId: string, approved: boolean) => {
    deploy.respondConfirm(requestId, approved)
    return true
  })
  ipcMain.handle('deploy:cancel', (_e, runId: string) => deploy.cancel(runId))
  ipcMain.handle('deploy:plan', async (_e, req: DeployPlanRequest) => planDeployment(req))
}
