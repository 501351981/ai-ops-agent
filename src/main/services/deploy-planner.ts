import { randomUUID } from 'crypto'
import type {
  DeployAssertion,
  DeployKind,
  DeploymentRecipe,
  DeployParamDef,
  DeployPlanRequest,
  DeployPlanResult,
  DeployStep
} from '../../shared/types'
import { getLlmClient } from './llm-client'
import { getDeployStore } from './deploy-store'
import { getSshManager } from './ssh-manager'
import { getStore } from './credential-store'

const KINDS: DeployKind[] = [
  'docker-compose',
  'systemd-jar',
  'systemd-binary',
  'k8s',
  'custom'
]

interface LlmRecipePayload {
  name?: string
  kind?: string
  notes?: string
  params?: Array<{
    key?: string
    label?: string
    type?: string
    required?: boolean
    defaultValue?: string | number | boolean
    description?: string
  }>
  assertions?: Array<{
    id?: string
    description?: string
    checkCommand?: string
    onFail?: string
  }>
  steps?: Array<{
    id?: string
    name?: string
    command?: string
    riskLevel?: string
    requireConfirm?: boolean
    rollbackCommand?: string
    successCheck?: string
    timeoutSec?: number
  }>
  healthCheck?: {
    command?: string
    retries?: number
    intervalSec?: number
  }
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw = fence ? fence[1].trim() : trimmed
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型未返回 JSON 对象')
  return JSON.parse(raw.slice(start, end + 1)) as unknown
}

async function probeServer(serverId: string): Promise<string> {
  const ssh = getSshManager()
  const script = [
    'echo "=== uname ==="',
    'uname -a 2>/dev/null || true',
    'echo "=== os ==="',
    'cat /etc/os-release 2>/dev/null | head -n 8 || true',
    'echo "=== docker ==="',
    'docker --version 2>/dev/null || echo none',
    'docker compose version 2>/dev/null || true',
    'echo "=== systemd ==="',
    'systemctl --version 2>/dev/null | head -n 1 || echo none',
    'echo "=== java ==="',
    'java -version 2>&1 | head -n 1 || echo none',
    'echo "=== k8s ==="',
    'kubectl version --client 2>/dev/null | head -n 3 || echo none',
    'echo "=== disk ==="',
    'df -h / 2>/dev/null | tail -n 1 || true',
    'echo "=== listening ==="',
    'ss -lnt 2>/dev/null | head -n 20 || netstat -lnt 2>/dev/null | head -n 20 || true'
  ].join('\n')

  try {
    const result = await ssh.exec(serverId, script)
    const out = `${result.stdout || ''}\n${result.stderr || ''}`.trim()
    return out.slice(0, 6000)
  } catch (err) {
    return `探测失败: ${err instanceof Error ? err.message : String(err)}`
  }
}

function normalizeKind(raw: string | undefined): DeployKind {
  if (raw && (KINDS as string[]).includes(raw)) return raw as DeployKind
  return 'custom'
}

function normalizeRisk(raw: string | undefined): DeployStep['riskLevel'] {
  if (raw === 'low' || raw === 'high' || raw === 'medium') return raw
  return 'medium'
}

function normalizeOnFail(raw: string | undefined): DeployAssertion['onFail'] {
  if (raw === 'warn' || raw === 'prompt-revise' || raw === 'abort') return raw
  return 'abort'
}

function normalizeParamType(raw: string | undefined): DeployParamDef['type'] {
  if (raw === 'number' || raw === 'boolean' || raw === 'file' || raw === 'secret' || raw === 'string') {
    return raw
  }
  return 'string'
}

function buildDraft(
  req: DeployPlanRequest,
  projectId: string,
  payload: LlmRecipePayload,
  base?: DeploymentRecipe | null
): DeploymentRecipe {
  const now = Date.now()
  const steps: DeployStep[] = (payload.steps || [])
    .filter((s) => s?.command?.trim())
    .map((s, i) => ({
      id: s.id?.trim() || `step-${i + 1}`,
      name: (s.name || `步骤 ${i + 1}`).trim(),
      command: String(s.command).trim(),
      riskLevel: normalizeRisk(s.riskLevel),
      requireConfirm: Boolean(s.requireConfirm) || normalizeRisk(s.riskLevel) === 'high',
      rollbackCommand: s.rollbackCommand?.trim() || undefined,
      successCheck: s.successCheck?.trim() || undefined,
      timeoutSec: typeof s.timeoutSec === 'number' ? s.timeoutSec : undefined
    }))

  if (steps.length === 0) {
    throw new Error('模型未生成有效部署步骤')
  }

  const params: DeployParamDef[] = (payload.params || [])
    .filter((p) => p?.key?.trim())
    .map((p) => ({
      key: String(p.key).trim(),
      label: (p.label || p.key || '').trim(),
      type: normalizeParamType(p.type),
      required: p.required !== false,
      defaultValue: p.defaultValue,
      description: p.description
    }))

  const assertions: DeployAssertion[] = (payload.assertions || [])
    .filter((a) => a?.checkCommand?.trim())
    .map((a, i) => ({
      id: a.id?.trim() || `assert-${i + 1}`,
      description: (a.description || a.checkCommand || '').trim(),
      checkCommand: String(a.checkCommand).trim(),
      onFail: normalizeOnFail(a.onFail)
    }))

  const healthCheck =
    payload.healthCheck?.command?.trim()
      ? {
          command: payload.healthCheck.command.trim(),
          retries: Math.max(1, Number(payload.healthCheck.retries) || 5),
          intervalSec: Math.max(1, Number(payload.healthCheck.intervalSec) || 3)
        }
      : undefined

  return {
    id: base?.id || randomUUID(),
    projectId,
    name: (payload.name || req.projectName || '未命名配方').trim(),
    kind: normalizeKind(payload.kind),
    version: base ? base.version + 1 : 1,
    serverId: req.serverId,
    params,
    assertions,
    steps,
    healthCheck,
    notes: payload.notes?.trim() || undefined,
    sourceIntent: req.intent,
    status: 'draft',
    createdAt: base?.createdAt || now,
    updatedAt: now
  }
}

/**
 * AI 规划：探测环境 + 单次 LLM 调用，产出 draft Recipe（不自动定版）。
 * 有 baseRecipe 时做补丁修订，避免从零生成。
 */
export async function planDeployment(req: DeployPlanRequest): Promise<DeployPlanResult> {
  if (!req.intent?.trim()) throw new Error('请填写部署意图')
  if (!req.serverId) throw new Error('请选择目标服务器')
  if (!req.providerId) throw new Error('请选择模型 Provider')

  const store = getStore()
  const server = store.listServers().find((s) => s.id === req.serverId)
  if (!server) throw new Error('服务器不存在')
  if (!store.getProviderSecret(req.providerId)) throw new Error('未找到 LLM Provider')

  const deployStore = getDeployStore()
  let projectId = req.projectId
  if (projectId) {
    const project = deployStore.getProject(projectId)
    if (!project) throw new Error('项目不存在')
  } else {
    const created = deployStore.createProject(req.projectName.trim() || '未命名项目', req.serverId)
    projectId = created.id
  }

  // 修订：传入 projectId / baseRecipeId 时基于已有配方打补丁
  const baseRecipe =
    req.baseRecipeId || req.projectId ? deployStore.getRecipe(projectId!) : null

  const probeSummary = await probeServer(req.serverId)

  const system = [
    '你是部署配方规划器。根据用户意图与服务器探测结果，输出一份可重复执行的 Deployment Recipe。',
    '只输出一个 JSON 对象，不要 Markdown 解释。',
    '命令必须可在目标 Linux 上经 SSH 直接执行；参数用 {{paramKey}} 占位。',
    '日常发布会零 Token 重跑这份配方，因此步骤要稳定、可幂等，并尽量提供 rollbackCommand。',
    '禁止生成破坏性命令（rm -rf /、mkfs、dd、shutdown 等）。',
    'JSON schema:',
    '{',
    '  "name": string,',
    '  "kind": "docker-compose"|"systemd-jar"|"systemd-binary"|"k8s"|"custom",',
    '  "notes": string,',
    '  "params": [{"key","label","type":"string"|"number"|"boolean"|"file","required","defaultValue","description"}],',
    '  "assertions": [{"id","description","checkCommand","onFail":"abort"|"warn"|"prompt-revise"}],',
    '  "steps": [{"id","name","command","riskLevel":"low"|"medium"|"high","requireConfirm","rollbackCommand","successCheck","timeoutSec"}],',
    '  "healthCheck": {"command","retries","intervalSec"}',
    '}'
  ].join('\n')

  const userParts = [
    `项目名: ${req.projectName}`,
    `目标服务器: ${server.name} (${server.username}@${server.host}:${server.port})`,
    `用户意图:\n${req.intent.trim()}`,
    `环境探测:\n${probeSummary}`
  ]

  if (baseRecipe) {
    userParts.push(
      '已有定版/草稿配方，请在其基础上做最小必要修订（保留可用步骤与参数 key），不要推倒重来：',
      JSON.stringify(
        {
          name: baseRecipe.name,
          kind: baseRecipe.kind,
          params: baseRecipe.params,
          assertions: baseRecipe.assertions,
          steps: baseRecipe.steps,
          healthCheck: baseRecipe.healthCheck,
          notes: baseRecipe.notes
        },
        null,
        2
      )
    )
  }

  const llm = getLlmClient()
  const result = await llm.chat(req.providerId, [
    { role: 'system', content: system },
    { role: 'user', content: userParts.join('\n\n') }
  ])

  const content = result.content?.trim()
  if (!content) throw new Error('模型返回为空')

  let payload: LlmRecipePayload
  try {
    payload = extractJsonObject(content) as LlmRecipePayload
  } catch (err) {
    throw new Error(
      `解析配方 JSON 失败: ${err instanceof Error ? err.message : String(err)}\n片段: ${content.slice(0, 200)}`
    )
  }

  // 不落盘：避免覆盖已定版 recipe；由 UI 审阅后 saveRecipe(active)
  const draft = buildDraft(req, projectId!, payload, baseRecipe)

  return {
    draft,
    probeSummary
  }
}
