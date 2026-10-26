export type AuthType = 'password' | 'privateKey'

export interface ServerConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  /** 是否已保存凭证（渲染进程不拿明文） */
  hasCredential: boolean
  createdAt: number
  updatedAt: number
}

export interface ServerInput {
  id?: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  privateKey?: string
  passphrase?: string
}

export interface LlmProvider {
  id: string
  name: string
  baseUrl: string
  model: string
  temperature?: number
  enabled: boolean
  /** 渲染进程只看是否已配置 Key */
  hasApiKey: boolean
  createdAt: number
  updatedAt: number
}

export interface LlmProviderInput {
  id?: string
  name: string
  baseUrl: string
  apiKey?: string
  model: string
  temperature?: number
  enabled: boolean
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  /** 同一次用户提问下的所有回复/工具消息共用 */
  queryId?: string
  /** DeepSeek 等思考模型的 chain-of-thought（reasoning_content） */
  reasoning?: string
  /** tool 消息：工具名 */
  toolName?: string
  toolCallId?: string
  /** tool 消息阶段：调用开始 / 结果 */
  toolPhase?: 'start' | 'result'
  toolCalls?: ToolCall[]
  createdAt: number
}

/**
 * 部署会话尚未在对话中绑定目标机时的占位 serverId。
 * Agent 需先 list_env_servers + bind_deploy_server 再执行 SSH。
 */
export const DEPLOY_UNBOUND_SERVER_ID = '__deploy_unbound__'

/** 会话用途：ops=服务器详情运维对话；deploy=部署页对话 */
export type ChatSessionKind = 'ops' | 'deploy'

/** 会话元数据（消息正文按会话分文件存储） */
export interface ChatSession {
  id: string
  serverId: string
  title: string
  /** 缺省视为 ops（兼容旧数据） */
  kind?: ChatSessionKind
  createdAt: number
  updatedAt: number
  messageCount: number
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolConfirmRequest {
  requestId: string
  serverId: string
  toolName: string
  arguments: Record<string, unknown>
  riskLevel: 'low' | 'medium' | 'high'
  reason?: string
}

export interface RemoteFileEntry {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  modifyTime: number
  rights?: string
}

/** Agent 提议的部署模板草案（须用户确认后才真正创建/更新） */
export interface DeployTemplateDraft {
  requestId: string
  name: string
  kind: DeployKind
  serverId: string
  /**
   * 若传入已有模板 projectId，则确认为「更新」而非新建。
   * 由 list_deploy_templates 获取。
   */
  projectId?: string
  /** 下次可变参数（如 dist 路径） */
  params: DeployParamDef[]
  assertions: DeployAssertion[]
  steps: DeployStep[]
  healthCheck?: DeploymentRecipe['healthCheck']
  notes?: string
  sourceIntent?: string
}

export interface AgentStreamEvent {
  type:
    | 'text'
    | 'reasoning'
    | 'tool_start'
    | 'tool_result'
    | 'tool_stdout'
    | 'confirm'
    | 'template_draft'
    | 'error'
    | 'done'
  queryId?: string
  content?: string
  toolName?: string
  toolCallId?: string
  confirm?: ToolConfirmRequest
  /** 沉淀模板草案，等待用户确认或继续优化 */
  templateDraft?: DeployTemplateDraft
  error?: string
}

export interface AppSettings {
  defaultProviderId: string | null
  autoConfirmReadonly: boolean
  blockDangerousCommands: boolean
  /** Agent 工具调用最大轮次（每次模型往返算 1 轮） */
  maxAgentRounds: number
}

export interface FavoriteDir {
  id: string
  path: string
  name: string
  createdAt: number
}

export interface DataLocationInfo {
  dataDir: string
  storeFile: string
  isDefault: boolean
  defaultDataDir: string
}

/** 监控看板准插件包：AI 生成一次，运行时零 Token 轮询 */
export interface MonitorManifest {
  name: string
  version: string
  intervalSec: number
  metricsSchema?: Record<string, 'number' | 'string'>
}

export interface MonitorBundle {
  id: string
  serverId: string
  manifest: MonitorManifest
  /** AI 生成的 shell，stdout 输出单行 JSON */
  collectScript: string
  /** AI 生成的完整 HTML，监听 postMessage 更新 */
  html: string
  updatedAt: number
}

/** 监控中心列表用摘要（不含 html/script） */
export interface MonitorSummary {
  id: string
  serverId: string
  name: string
  version: string
  intervalSec: number
  updatedAt: number
}

export interface MonitorBundleInput {
  name: string
  html: string
  collectScript: string
  intervalSec?: number
  metricsSchema?: Record<string, 'number' | 'string'>
  version?: string
}

export interface MonitorDataEvent {
  serverId: string
  ok: boolean
  data?: Record<string, unknown>
  error?: string
  collectedAt: number
}

// ---------------------------------------------------------------------------
// 部署配方：AI 规划一次定版，日常发布零 Token 执行（对齐 MonitorBundle 模式）
// 存储建议：{dataDir}/deploys/{projectId}/recipe.json + runs/{runId}.json
// ---------------------------------------------------------------------------

/** 部署形态；执行器按 kind 选模板，不靠模型现场发明命令 */
export type DeployKind = 'docker-compose' | 'systemd-jar' | 'systemd-binary' | 'k8s' | 'custom'

export type DeployRiskLevel = 'low' | 'medium' | 'high'

/** Recipe 内可被 Mustache/简单替换的参数槽 */
export type DeployParamType = 'string' | 'number' | 'boolean' | 'file' | 'secret'

export interface DeployParamDef {
  key: string
  label: string
  type: DeployParamType
  required: boolean
  /** 日常发布默认值（可来自上次成功 Run） */
  defaultValue?: string | number | boolean
  description?: string
}

/** 发布前环境断言：失败则拒绝执行或进入「修订配方」（不默认调 AI） */
export interface DeployAssertion {
  id: string
  description: string
  /** 远端 shell；exit 0 = 通过 */
  checkCommand: string
  onFail: 'abort' | 'warn' | 'prompt-revise'
}

export interface DeployStep {
  id: string
  name: string
  /** 命令模板，变量形如 {{version}} {{artifactPath}} */
  command: string
  riskLevel: DeployRiskLevel
  /** true = 每次发布仍弹确认；false = 沿用全局 autoConfirm 策略 */
  requireConfirm?: boolean
  /** 失败时执行的回滚命令模板；可空 */
  rollbackCommand?: string
  /** 本步成功判定：默认看 exitCode===0；也可额外跑 check */
  successCheck?: string
  /** 超时秒数 */
  timeoutSec?: number
}

/**
 * 定版部署配方。日常 `deploy:run` 只读此结构 + 本次 params，不调 LLM。
 */
export interface DeploymentRecipe {
  id: string
  /** 逻辑项目（可跨多台机器复用同一套步骤） */
  projectId: string
  name: string
  kind: DeployKind
  version: number
  /** 默认可部署到的 server；run 时可覆盖 */
  serverId: string
  params: DeployParamDef[]
  assertions: DeployAssertion[]
  steps: DeployStep[]
  /** 全流程健康检查（切流前/后） */
  healthCheck?: {
    command: string
    retries: number
    intervalSec: number
  }
  /** 人类可读说明；排障时按需截取进 prompt，日常不加载 */
  notes?: string
  /** 首次规划时的用户意图原文（审计用） */
  sourceIntent?: string
  status: 'draft' | 'active' | 'archived'
  createdAt: number
  updatedAt: number
}

export interface DeploymentRecipeInput {
  projectId: string
  name: string
  kind: DeployKind
  serverId: string
  params: DeployParamDef[]
  assertions: DeployAssertion[]
  steps: DeployStep[]
  healthCheck?: DeploymentRecipe['healthCheck']
  notes?: string
  sourceIntent?: string
  /** 省略则新建；传入则升 version 覆盖定版 */
  id?: string
}

/** 项目档案：列表与「一键重跑」用，不含大段 notes */
export interface DeployProject {
  id: string
  name: string
  /** 当前 active recipe id */
  activeRecipeId: string | null
  serverIds: string[]
  lastRunAt?: number
  lastSuccessParams?: Record<string, string | number | boolean>
  createdAt: number
  updatedAt: number
}

export type DeployRunStatus =
  | 'pending'
  | 'asserting'
  | 'running'
  | 'awaiting_confirm'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'rolled_back'

export interface DeployRunStepResult {
  stepId: string
  startedAt: number
  finishedAt?: number
  exitCode?: number
  stdoutTail?: string
  stderrTail?: string
  status: 'pending' | 'running' | 'ok' | 'failed' | 'skipped' | 'rolled_back'
}

/** 单次发布记录：可审计、可重放参数 */
export interface DeployRun {
  id: string
  projectId: string
  recipeId: string
  recipeVersion: number
  serverId: string
  /** 本次填入的参数（含 version / 制品路径） */
  params: Record<string, string | number | boolean>
  status: DeployRunStatus
  currentStepId?: string
  stepResults: DeployRunStepResult[]
  error?: string
  /** 是否动过 LLM：日常应为 false */
  usedLlm: boolean
  createdAt: number
  finishedAt?: number
}

/** 首次 / 重新规划：才走 LLM，产出 draft Recipe 供人审 */
export interface DeployPlanRequest {
  projectId?: string
  projectName: string
  serverId: string
  providerId: string
  /** 自然语言意图，仅此路径消耗 Token */
  intent: string
  /** 已有 recipe 时做「补丁式修订」，避免从零生成 */
  baseRecipeId?: string
}

export interface DeployPlanResult {
  draft: DeploymentRecipe
  /** 探测摘要（给 UI 展示，不重复塞回模型） */
  probeSummary?: string
}

/** 日常发布：零 Token */
export interface DeployRunRequest {
  projectId: string
  /** 默认用 active recipe */
  recipeId?: string
  serverId?: string
  params: Record<string, string | number | boolean>
  /**
   * @deprecated 模板发布默认不再逐步确认；仅步骤 requireConfirm=true 会弹窗。
   * 保留字段以兼容旧调用方。
   */
  autoConfirmLowRisk?: boolean
  /**
   * 可选；前端可先生成 UUID 并 subscribe `deploy:stream:{runId}`，
   * 再调用 run，避免错过早期事件。
   */
  runId?: string
}

/** 失败后可选：小上下文排障 / 提议补丁，不重做全盘计划 */
export interface DeployReviseRequest {
  runId: string
  providerId: string
  /** 用户补充说明，可空 */
  hint?: string
}

export type DeployStreamEventType =
  | 'assert'
  | 'step_start'
  | 'step_stdout'
  | 'step_result'
  | 'confirm'
  | 'health'
  | 'error'
  | 'done'

export interface DeployStreamEvent {
  type: DeployStreamEventType
  runId: string
  stepId?: string
  content?: string
  confirm?: ToolConfirmRequest
  error?: string
  run?: DeployRun
}

export const LLM_PRESETS: Array<Omit<LlmProviderInput, 'apiKey' | 'enabled'> & { enabled: boolean }> = [
  {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    temperature: 0.3,
    enabled: true
  },
  {
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-plus',
    temperature: 0.3,
    enabled: true
  },
  {
    name: 'Ollama (本地)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2',
    temperature: 0.3,
    enabled: true
  }
]
