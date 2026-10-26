import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  AgentStreamEvent,
  AppSettings,
  ChatMessage,
  ChatSession,
  DataLocationInfo,
  DeploymentRecipe,
  DeploymentRecipeInput,
  DeployProject,
  DeployPlanRequest,
  DeployPlanResult,
  DeployRun,
  DeployRunRequest,
  DeployStreamEvent,
  FavoriteDir,
  LlmProviderInput,
  MonitorBundle,
  MonitorBundleInput,
  MonitorDataEvent,
  MonitorSummary,
  ServerInput
} from '../shared/types'

const api = {
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    update: (partial: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:update', partial)
  },
  data: {
    location: (): Promise<DataLocationInfo> => ipcRenderer.invoke('data:location'),
    chooseDir: (): Promise<{ canceled: boolean; path?: string }> =>
      ipcRenderer.invoke('data:choose-dir'),
    setDir: (
      dir: string,
      migrate = true
    ): Promise<{ ok: boolean; message: string; info: DataLocationInfo }> =>
      ipcRenderer.invoke('data:set-dir', dir, migrate),
    resetDir: (
      migrate = true
    ): Promise<{ ok: boolean; message: string; info: DataLocationInfo }> =>
      ipcRenderer.invoke('data:reset-dir', migrate)
  },
  favorites: {
    list: (serverId: string): Promise<FavoriteDir[]> =>
      ipcRenderer.invoke('favorites:list', serverId),
    add: (serverId: string, path: string, name?: string): Promise<FavoriteDir> =>
      ipcRenderer.invoke('favorites:add', serverId, path, name),
    remove: (serverId: string, idOrPath: string): Promise<boolean> =>
      ipcRenderer.invoke('favorites:remove', serverId, idOrPath),
    rename: (serverId: string, id: string, name: string): Promise<FavoriteDir | null> =>
      ipcRenderer.invoke('favorites:rename', serverId, id, name)
  },
  servers: {
    list: () => ipcRenderer.invoke('servers:list'),
    upsert: (input: ServerInput) => ipcRenderer.invoke('servers:upsert', input),
    delete: (id: string) => ipcRenderer.invoke('servers:delete', id),
    test: (input: ServerInput) => ipcRenderer.invoke('servers:test', input),
    disconnect: (id: string) => ipcRenderer.invoke('servers:disconnect', id)
  },
  providers: {
    list: () => ipcRenderer.invoke('providers:list'),
    presets: () => ipcRenderer.invoke('providers:presets'),
    upsert: (input: LlmProviderInput) => ipcRenderer.invoke('providers:upsert', input),
    clone: (id: string) => ipcRenderer.invoke('providers:clone', id),
    delete: (id: string) => ipcRenderer.invoke('providers:delete', id),
    test: (payload: { id?: string; baseUrl?: string; apiKey?: string; model?: string }) =>
      ipcRenderer.invoke('providers:test', payload)
  },
  files: {
    list: (serverId: string, path: string) => ipcRenderer.invoke('files:list', serverId, path),
    read: (serverId: string, path: string) => ipcRenderer.invoke('files:read', serverId, path),
    delete: (serverId: string, path: string, isDir: boolean) =>
      ipcRenderer.invoke('files:delete', serverId, path, isDir),
    upload: (serverId: string, remoteDir: string) =>
      ipcRenderer.invoke('files:upload', serverId, remoteDir),
    download: (serverId: string, remotePath: string, fileName: string) =>
      ipcRenderer.invoke('files:download', serverId, remotePath, fileName),
    /** 拖拽到渲染进程的 File → 本机绝对路径（Electron webUtils） */
    getPathForFile: (file: File): string => webUtils.getPathForFile(file),
    /** 系统文件选择框，返回本机绝对路径；取消则为 null */
    pickLocal: (): Promise<string | null> => ipcRenderer.invoke('files:pick-local')
  },
  sessions: {
    list: (serverId: string): Promise<ChatSession[]> =>
      ipcRenderer.invoke('sessions:list', serverId),
    listByKind: (kind: 'ops' | 'deploy'): Promise<ChatSession[]> =>
      ipcRenderer.invoke('sessions:list-by-kind', kind),
    ensure: (serverId: string): Promise<ChatSession> =>
      ipcRenderer.invoke('sessions:ensure', serverId),
    get: (sessionId: string): Promise<ChatSession | null> =>
      ipcRenderer.invoke('sessions:get', sessionId),
    create: (
      serverId: string,
      title?: string,
      kind?: 'ops' | 'deploy'
    ): Promise<ChatSession> => ipcRenderer.invoke('sessions:create', serverId, title, kind),
    setActive: (serverId: string, sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke('sessions:set-active', serverId, sessionId),
    rename: (sessionId: string, title: string): Promise<ChatSession | null> =>
      ipcRenderer.invoke('sessions:rename', sessionId, title),
    delete: (sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke('sessions:delete', sessionId)
  },
  chat: {
    history: (sessionId: string): Promise<ChatMessage[]> =>
      ipcRenderer.invoke('chat:history', sessionId),
    clear: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('chat:clear', sessionId)
  },
  agent: {
    chat: (payload: {
      serverId: string
      sessionId: string
      providerId: string
      message: string
      queryId?: string
      mode?: 'ops' | 'deploy'
    }) => ipcRenderer.invoke('agent:chat', payload),
    confirm: (requestId: string, approved: boolean) =>
      ipcRenderer.invoke('agent:confirm', requestId, approved),
    respondTemplateDraft: (
      requestId: string,
      approved: boolean,
      feedback?: string,
      overrides?: { name?: string }
    ) => ipcRenderer.invoke('agent:template-draft', requestId, approved, feedback, overrides),
    cancel: (serverIdOrSessionId: string) =>
      ipcRenderer.invoke('agent:cancel', serverIdOrSessionId),
    onStream: (sessionId: string, callback: (event: AgentStreamEvent) => void) => {
      const channel = `agent:stream:${sessionId}`
      const listener = (_event: IpcRendererEvent, data: AgentStreamEvent): void => {
        callback(data)
      }
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    }
  },
  monitor: {
    list: (): Promise<MonitorSummary[]> => ipcRenderer.invoke('monitor:list'),
    get: (serverId: string): Promise<MonitorBundle | null> =>
      ipcRenderer.invoke('monitor:get', serverId),
    save: (serverId: string, input: MonitorBundleInput): Promise<MonitorBundle> =>
      ipcRenderer.invoke('monitor:save', serverId, input),
    clear: (serverId: string): Promise<boolean> => ipcRenderer.invoke('monitor:clear', serverId),
    start: (serverId: string): Promise<boolean> => ipcRenderer.invoke('monitor:start', serverId),
    stop: (serverId: string): Promise<boolean> => ipcRenderer.invoke('monitor:stop', serverId),
    refresh: (serverId: string): Promise<MonitorDataEvent> =>
      ipcRenderer.invoke('monitor:refresh', serverId),
    updateInterval: (serverId: string, intervalSec: number): Promise<MonitorBundle> =>
      ipcRenderer.invoke('monitor:update-interval', serverId, intervalSec),
    onData: (serverId: string, callback: (event: MonitorDataEvent) => void) => {
      const channel = `monitor:data:${serverId}`
      const listener = (_event: IpcRendererEvent, data: MonitorDataEvent): void => {
        callback(data)
      }
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    }
  },
  deploy: {
    listProjects: (): Promise<DeployProject[]> => ipcRenderer.invoke('deploy:projects:list'),
    getProject: (projectId: string): Promise<DeployProject | null> =>
      ipcRenderer.invoke('deploy:projects:get', projectId),
    createProject: (name: string, serverId?: string): Promise<DeployProject> =>
      ipcRenderer.invoke('deploy:projects:create', name, serverId),
    deleteProject: (projectId: string): Promise<boolean> =>
      ipcRenderer.invoke('deploy:projects:delete', projectId),
    getRecipe: (projectId: string): Promise<DeploymentRecipe | null> =>
      ipcRenderer.invoke('deploy:recipe:get', projectId),
    saveRecipe: (
      input: DeploymentRecipeInput,
      status?: 'draft' | 'active' | 'archived'
    ): Promise<DeploymentRecipe> => ipcRenderer.invoke('deploy:recipe:save', input, status),
    listRuns: (projectId: string, limit?: number): Promise<DeployRun[]> =>
      ipcRenderer.invoke('deploy:runs:list', projectId, limit),
    getRun: (projectId: string, runId: string): Promise<DeployRun | null> =>
      ipcRenderer.invoke('deploy:runs:get', projectId, runId),
    run: (req: DeployRunRequest): Promise<DeployRun> => ipcRenderer.invoke('deploy:run', req),
    plan: (req: DeployPlanRequest): Promise<DeployPlanResult> =>
      ipcRenderer.invoke('deploy:plan', req),
    confirm: (requestId: string, approved: boolean): Promise<boolean> =>
      ipcRenderer.invoke('deploy:confirm', requestId, approved),
    cancel: (runId: string): Promise<boolean> => ipcRenderer.invoke('deploy:cancel', runId),
    onStream: (runId: string, callback: (event: DeployStreamEvent) => void) => {
      const channel = `deploy:stream:${runId}`
      const listener = (_event: IpcRendererEvent, data: DeployStreamEvent): void => {
        callback(data)
      }
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronApi = typeof api
