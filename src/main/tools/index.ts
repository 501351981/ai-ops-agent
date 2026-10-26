import type { LlmToolDef } from '../services/llm-client'
import { getSshManager } from '../services/ssh-manager'
import { getStore } from '../services/credential-store'
import { getMonitorStore } from '../services/monitor-store'
import type {
  DeployAssertion,
  DeployKind,
  DeployParamDef,
  DeployStep,
  DeployTemplateDraft,
  MonitorBundleInput
} from '../../shared/types'
import { DEPLOY_UNBOUND_SERVER_ID } from '../../shared/types'
import { getChatStore } from '../services/chat-session-store'
import { getDeployStore } from '../services/deploy-store'

export const AGENT_TOOLS: LlmToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在远程服务器上执行 Shell 命令，返回 stdout/stderr 和退出码。用于查看状态、安装软件、排查问题等。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
          cwd: { type: 'string', description: '可选工作目录' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_system_info',
      description: '获取远程服务器基础运行信息：主机名、系统、CPU/内存/磁盘概览。',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出远程服务器指定目录下的文件和子目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '远程绝对路径，默认 /' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取远程文本文件内容（有大小限制）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '远程文件绝对路径' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_monitor_dashboard',
      description:
        '获取当前服务器已保存的监控看板（MonitorBundle）。在修改/增加监控指标前应先调用，以便在现有看板基础上迭代。',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_monitor_dashboard',
      description:
        '创建或覆盖当前服务器的监控看板。需同时提供：1) collectScript：只读 shell，stdout 打印单行 JSON；2) html：完整 HTML，必须定义 window.renderMonitor=function(data){...}，宿主会把采集 JSON 传入该函数以更新画面（不要自己监听 message/轮询）。保存后用户可在「监控」Tab 查看，刷新不调用 AI。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '看板名称，如「系统资源监控」' },
          collectScript: {
            type: 'string',
            description:
              '在远程执行的 shell。必须只读采集，stdout 最后一行输出 JSON 对象，例如 {"cpu":12.5,"mem":68.2,"disk":41}'
          },
          html: {
            type: 'string',
            description:
              '完整 HTML（可内嵌 CSS/JS，可用 CDN）。必须包含：window.renderMonitor = function(data){ /* 用 data 字段更新 UI */ }。深色背景更协调。'
          },
          intervalSec: {
            type: 'number',
            description: '轮询间隔秒，默认 5，范围 2-300'
          },
          metricsSchema: {
            type: 'object',
            description: '可选，声明 JSON 字段类型，如 {"cpu":"number","mem":"number"}',
            additionalProperties: { type: 'string', enum: ['number', 'string'] }
          },
          version: { type: 'string', description: '可选版本号，默认 1.0.0' }
        },
        required: ['name', 'collectScript', 'html']
      }
    }
  }
]

const deployExtraTools: LlmToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'upload_file',
      description:
        '将本机文件上传到当前服务器远程路径。用于部署本地 dist/包。localPath 为用户本机绝对路径。',
      parameters: {
        type: 'object',
        properties: {
          localPath: { type: 'string', description: '本机文件绝对路径' },
          remotePath: { type: 'string', description: '远程目标路径（含文件名）' }
        },
        required: ['localPath', 'remotePath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_env_servers',
      description:
        '列出环境管理中已配置的服务器（不含密码）。用户用自然语言提到目标机时，先调用本工具匹配。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'bind_deploy_server',
      description:
        '将当前部署会话绑定到某台环境服务器，之后的 SSH/上传都作用于该机。用户说出目标服务器后必须先绑定，再执行部署命令。可通过 serverId，或 name/host 模糊匹配。',
      parameters: {
        type: 'object',
        properties: {
          serverId: { type: 'string', description: '环境中的服务器 id（优先）' },
          nameOrHost: {
            type: 'string',
            description: '当不知道 id 时，用名称或主机名/IP 匹配，如 prod、10.0.0.3'
          },
          sessionId: {
            type: 'string',
            description: '当前聊天 sessionId（宿主会自动注入，也可显式传入）'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_deploy_templates',
      description:
        '列出已沉淀的部署模板（projectId、名称、类型、服务器、步骤摘要）。用户要改已有模板时先调用本工具匹配，再 propose_deploy_template 并传入 projectId。',
      parameters: {
        type: 'object',
        properties: {
          nameHint: {
            type: 'string',
            description: '可选，按名称模糊过滤'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'propose_deploy_template',
      description:
        '提议创建或更新可重复部署模板。只提交草案，须用户在界面确认后才会落盘。' +
        '新建：不传 projectId。更新已有模板：先 list_deploy_templates，再传入对应 projectId。' +
        '步骤里本机上传写成：upload_file {{artifact}} => /tmp/xxx.zip。' +
        'assertions 只放发布前检查；发布后校验放 steps/healthCheck。',
      parameters: {
        type: 'object',
        properties: {
          projectId: {
            type: 'string',
            description: '可选。传入已有模板 id 则更新该模板；省略则新建'
          },
          name: { type: 'string', description: '模板名称，如 my-api 发布' },
          kind: {
            type: 'string',
            enum: ['docker-compose', 'systemd-jar', 'systemd-binary', 'k8s', 'custom']
          },
          notes: { type: 'string' },
          sourceIntent: { type: 'string', description: '用户原始意图摘要' },
          params: {
            type: 'array',
            description: '下次部署需要用户填写的可变参数（如 dist 本地路径）',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                label: { type: 'string' },
                type: { type: 'string', enum: ['string', 'number', 'boolean', 'file', 'secret'] },
                required: { type: 'boolean' },
                defaultValue: {},
                description: { type: 'string' }
              },
              required: ['key', 'label', 'type', 'required']
            }
          },
          assertions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                description: { type: 'string' },
                checkCommand: { type: 'string' },
                onFail: { type: 'string', enum: ['abort', 'warn', 'prompt-revise'] }
              },
              required: ['description', 'checkCommand', 'onFail']
            }
          },
          steps: {
            type: 'array',
            description: '已验证可走通的步骤；可变处用 {{paramKey}}',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                command: { type: 'string' },
                riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
                requireConfirm: { type: 'boolean' },
                rollbackCommand: { type: 'string' }
              },
              required: ['name', 'command', 'riskLevel']
            }
          },
          healthCheck: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              retries: { type: 'number' },
              intervalSec: { type: 'number' }
            }
          }
        },
        required: ['name', 'kind', 'params', 'steps']
      }
    }
  }
]

/** 部署会话工具：不含监控；含上传与沉淀模板提议 */
export const DEPLOY_AGENT_TOOLS: LlmToolDef[] = [
  ...AGENT_TOOLS.filter((t) =>
    ['run_command', 'get_system_info', 'list_dir', 'read_file'].includes(t.function.name)
  ),
  ...deployExtraTools
]

export function parseProposeDeployTemplateArgs(
  args: Record<string, unknown>,
  serverId: string,
  requestId: string
): DeployTemplateDraft {
  const kind = String(args.kind || 'custom') as DeployKind
  const params = (Array.isArray(args.params) ? args.params : []) as Array<Record<string, unknown>>
  const assertions = (Array.isArray(args.assertions) ? args.assertions : []) as Array<
    Record<string, unknown>
  >
  const steps = (Array.isArray(args.steps) ? args.steps : []) as Array<Record<string, unknown>>

  const normalizedParams: DeployParamDef[] = params
    .filter((p) => p?.key)
    .map((p) => ({
      key: String(p.key).trim(),
      label: String(p.label || p.key).trim(),
      type: (['string', 'number', 'boolean', 'file', 'secret'].includes(String(p.type))
        ? String(p.type)
        : 'string') as DeployParamDef['type'],
      required: p.required !== false,
      defaultValue: p.defaultValue as string | number | boolean | undefined,
      description: p.description ? String(p.description) : undefined
    }))

  const normalizedAssertions: DeployAssertion[] = assertions
    .filter((a) => a?.checkCommand)
    .map((a, i) => ({
      id: String(a.id || `assert-${i + 1}`),
      description: String(a.description || a.checkCommand),
      checkCommand: String(a.checkCommand),
      onFail: (['abort', 'warn', 'prompt-revise'].includes(String(a.onFail))
        ? String(a.onFail)
        : 'abort') as DeployAssertion['onFail']
    }))

  const normalizedSteps: DeployStep[] = steps
    .filter((s) => s?.command)
    .map((s, i) => ({
      id: String(s.id || `step-${i + 1}`),
      name: String(s.name || `步骤 ${i + 1}`),
      command: String(s.command).trim(),
      riskLevel: (['low', 'medium', 'high'].includes(String(s.riskLevel))
        ? String(s.riskLevel)
        : 'medium') as DeployStep['riskLevel'],
      requireConfirm: Boolean(s.requireConfirm),
      rollbackCommand: s.rollbackCommand ? String(s.rollbackCommand) : undefined
    }))

  if (!normalizedSteps.length) {
    throw new Error('propose_deploy_template 至少需要一个 steps')
  }

  const hc = args.healthCheck as Record<string, unknown> | undefined
  const projectId = args.projectId ? String(args.projectId).trim() : undefined
  return {
    requestId,
    name: String(args.name || '未命名模板').trim(),
    kind: (['docker-compose', 'systemd-jar', 'systemd-binary', 'k8s', 'custom'].includes(kind)
      ? kind
      : 'custom') as DeployKind,
    serverId,
    projectId: projectId || undefined,
    params: normalizedParams,
    assertions: normalizedAssertions,
    steps: normalizedSteps,
    healthCheck:
      hc?.command
        ? {
            command: String(hc.command),
            retries: Number(hc.retries) || 5,
            intervalSec: Number(hc.intervalSec) || 3
          }
        : undefined,
    notes: args.notes ? String(args.notes) : undefined,
    sourceIntent: args.sourceIntent ? String(args.sourceIntent) : undefined
  }
}

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[^\s]*f[^\s]*\s+)?\/\b/, reason: '危险的 rm 根目录操作' },
  { pattern: /\brm\s+-rf\s+\//, reason: '递归删除根路径' },
  { pattern: /\bmkfs\b/, reason: '格式化磁盘' },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: '直接写入块设备' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: '关机/重启命令' },
  { pattern: />\s*\/dev\/sd/, reason: '写入磁盘设备' },
  { pattern: /\biptables\s+-F\b/, reason: '清空防火墙规则' },
  { pattern: /\bchmod\s+-R\s+777\s+\//, reason: '危险的权限修改' }
]

export function assessCommandRisk(command: string): {
  riskLevel: 'low' | 'medium' | 'high'
  reason?: string
  blocked: boolean
} {
  for (const item of DANGEROUS_PATTERNS) {
    if (item.pattern.test(command)) {
      const block = getStore().getSettings().blockDangerousCommands
      return { riskLevel: 'high', reason: item.reason, blocked: block }
    }
  }
  if (/\b(apt|yum|dnf|apk)\s+(install|remove|purge)\b/.test(command) || /\bsudo\b/.test(command)) {
    return { riskLevel: 'medium', reason: '可能修改系统状态', blocked: false }
  }
  if (/^(ls|pwd|whoami|uname|df|free|top|ps|cat|head|tail|du|uptime|hostname)\b/.test(command.trim())) {
    return { riskLevel: 'low', blocked: false }
  }
  return { riskLevel: 'medium', reason: '写操作或未知命令，建议确认', blocked: false }
}

export function toolNeedsConfirm(toolName: string, args: Record<string, unknown>): {
  needsConfirm: boolean
  riskLevel: 'low' | 'medium' | 'high'
  reason?: string
  blocked?: boolean
} {
  const settings = getStore().getSettings()
  if (toolName === 'run_command') {
    const cmd = String(args.command || '')
    const risk = assessCommandRisk(cmd)
    if (risk.blocked) return { needsConfirm: true, riskLevel: 'high', reason: risk.reason, blocked: true }
    if (risk.riskLevel === 'low' && settings.autoConfirmReadonly) {
      return { needsConfirm: false, riskLevel: 'low' }
    }
    return { needsConfirm: true, riskLevel: risk.riskLevel, reason: risk.reason }
  }
  if (
    toolName === 'get_system_info' ||
    toolName === 'list_dir' ||
    toolName === 'read_file' ||
    toolName === 'get_monitor_dashboard' ||
    toolName === 'list_env_servers'
  ) {
    return { needsConfirm: !settings.autoConfirmReadonly, riskLevel: 'low' }
  }
  if (toolName === 'upload_file') {
    return {
      needsConfirm: true,
      riskLevel: 'medium',
      reason: '将本机文件上传到远程服务器'
    }
  }
  if (
    toolName === 'bind_deploy_server' ||
    toolName === 'propose_deploy_template' ||
    toolName === 'list_deploy_templates'
  ) {
    // bind / 列表 / 沉淀草案由运行时或专用 UI 处理
    return { needsConfirm: false, riskLevel: 'low' }
  }
  if (toolName === 'save_monitor_dashboard') {
    const script = String(args.collectScript || '')
    const risk = assessCommandRisk(script)
    if (risk.blocked || risk.riskLevel === 'high') {
      return {
        needsConfirm: true,
        riskLevel: 'high',
        reason: risk.reason || '采集脚本含高风险命令',
        blocked: risk.blocked
      }
    }
    // 仅写本地配置，默认确认一次即可
    return {
      needsConfirm: true,
      riskLevel: 'medium',
      reason: '将保存监控看板（本地配置 + 定时远程只读采集）'
    }
  }
  return { needsConfirm: true, riskLevel: 'medium' }
}

function unwrapMaybeFence(text: string): string {
  const trimmed = text.trim()
  const m = trimmed.match(/^```(?:html|HTML|bash|sh|shell)?\s*\n([\s\S]*?)\n```$/)
  return m ? m[1].trim() : trimmed
}

function requireBoundServer(serverId: string): void {
  if (!serverId || serverId === DEPLOY_UNBOUND_SERVER_ID) {
    throw new Error('尚未绑定目标服务器。请先 list_env_servers，再 bind_deploy_server。')
  }
}

export async function executeTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  onData?: (chunk: string) => void,
  ctx?: { sessionId?: string }
): Promise<string> {
  const ssh = getSshManager()

  switch (toolName) {
    case 'run_command': {
      requireBoundServer(serverId)
      const command = String(args.command || '')
      const cwd = args.cwd ? String(args.cwd) : undefined
      const result = await ssh.exec(serverId, command, {
        cwd,
        onData: (chunk) => onData?.(chunk)
      })
      return JSON.stringify({
        code: result.code,
        stdout: result.stdout.slice(-20000),
        stderr: result.stderr.slice(-5000)
      })
    }
    case 'get_system_info': {
      requireBoundServer(serverId)
      const script = [
        'echo "=== HOST ==="',
        'hostname; uname -a',
        'echo "=== UPTIME ==="',
        'uptime',
        'echo "=== MEMORY ==="',
        'free -h 2>/dev/null || vm_stat 2>/dev/null || true',
        'echo "=== DISK ==="',
        'df -h',
        'echo "=== CPU ==="',
        'nproc 2>/dev/null; lscpu 2>/dev/null | head -n 20 || sysctl -n machdep.cpu.brand_string 2>/dev/null || true'
      ].join('; ')
      const result = await ssh.exec(serverId, script)
      return result.stdout.slice(-20000) || result.stderr
    }
    case 'list_dir': {
      requireBoundServer(serverId)
      const path = String(args.path || '/')
      const entries = await ssh.listDir(serverId, path)
      return JSON.stringify(entries.slice(0, 200))
    }
    case 'read_file': {
      requireBoundServer(serverId)
      const path = String(args.path || '')
      return await ssh.readFile(serverId, path)
    }
    case 'get_monitor_dashboard': {
      const bundle = getMonitorStore().get(serverId)
      if (!bundle) return JSON.stringify({ exists: false })
      return JSON.stringify({
        exists: true,
        id: bundle.id,
        manifest: bundle.manifest,
        collectScript: bundle.collectScript,
        htmlLength: bundle.html.length,
        htmlPreview: bundle.html.slice(0, 1500),
        updatedAt: bundle.updatedAt
      })
    }
    case 'list_env_servers': {
      const servers = getStore().listServers()
      return JSON.stringify(
        servers.map((s) => ({
          id: s.id,
          name: s.name,
          host: s.host,
          port: s.port,
          username: s.username,
          authType: s.authType
        }))
      )
    }
    case 'list_deploy_templates': {
      const hint = String(args.nameHint || '')
        .trim()
        .toLowerCase()
      const deployStore = getDeployStore()
      const rows = []
      for (const p of deployStore.listProjects()) {
        const recipe = deployStore.getRecipe(p.id)
        if (!recipe || recipe.status !== 'active') continue
        const name = p.name || recipe.name
        if (hint && !name.toLowerCase().includes(hint) && !recipe.kind.toLowerCase().includes(hint)) {
          continue
        }
        rows.push({
          projectId: p.id,
          name,
          kind: recipe.kind,
          serverId: recipe.serverId,
          version: recipe.version,
          paramKeys: recipe.params.map((x) => x.key),
          stepNames: recipe.steps.map((s) => s.name),
          notes: recipe.notes || undefined,
          lastRunAt: p.lastRunAt
        })
      }
      return JSON.stringify({ count: rows.length, templates: rows })
    }
    case 'bind_deploy_server': {
      const sessionId = String(args.sessionId || ctx?.sessionId || '').trim()
      if (!sessionId) throw new Error('缺少 sessionId，无法绑定服务器')
      const servers = getStore().listServers()
      let target = args.serverId
        ? servers.find((s) => s.id === String(args.serverId))
        : undefined
      const hint = String(args.nameOrHost || '').trim().toLowerCase()
      if (!target && hint) {
        target = servers.find(
          (s) =>
            s.name.toLowerCase().includes(hint) ||
            s.host.toLowerCase().includes(hint) ||
            `${s.username}@${s.host}`.toLowerCase().includes(hint)
        )
      }
      if (!target) {
        throw new Error(
          `未匹配到服务器。请先 list_env_servers。当前可用: ${
            servers.map((s) => `${s.name}(${s.host})`).join(', ') || '无'
          }`
        )
      }
      getChatStore().rebindSessionServer(sessionId, target.id)
      return JSON.stringify({
        ok: true,
        serverId: target.id,
        name: target.name,
        host: target.host,
        port: target.port,
        username: target.username,
        message: `已绑定 ${target.name}（${target.username}@${target.host}:${target.port}），可开始部署操作。`
      })
    }
    case 'upload_file': {
      requireBoundServer(serverId)
      const localPath = String(args.localPath || '').trim()
      const remotePath = String(args.remotePath || '').trim()
      if (!localPath || !remotePath) throw new Error('localPath 与 remotePath 必填')
      await ssh.uploadFile(serverId, localPath, remotePath)
      return JSON.stringify({ ok: true, localPath, remotePath })
    }
    case 'propose_deploy_template': {
      // 由 AgentRuntime 拦截处理
      throw new Error('propose_deploy_template 应由运行时处理')
    }
    case 'save_monitor_dashboard': {
      const input: MonitorBundleInput = {
        name: String(args.name || '系统监控'),
        html: unwrapMaybeFence(String(args.html || '')),
        collectScript: unwrapMaybeFence(String(args.collectScript || '')),
        intervalSec: typeof args.intervalSec === 'number' ? args.intervalSec : undefined,
        version: args.version ? String(args.version) : undefined,
        metricsSchema:
          args.metricsSchema && typeof args.metricsSchema === 'object'
            ? (args.metricsSchema as MonitorBundleInput['metricsSchema'])
            : undefined
      }
      const risk = assessCommandRisk(input.collectScript)
      if (risk.blocked || risk.riskLevel === 'high') {
        throw new Error(`采集脚本不安全，已拒绝保存: ${risk.reason || '高风险'}`)
      }
      // 契约校验：必须实现 renderMonitor（宿主只负责把 JSON 推进去）
      if (!/\brenderMonitor\b/.test(input.html)) {
        throw new Error(
          'html 缺少 window.renderMonitor(data) 函数。请在页面脚本中定义：window.renderMonitor = function(data){ /* 根据 data 更新 UI */ }，然后重新调用 save_monitor_dashboard。'
        )
      }
      const bundle = getMonitorStore().save(serverId, input)
      return JSON.stringify({
        ok: true,
        id: bundle.id,
        name: bundle.manifest.name,
        intervalSec: bundle.manifest.intervalSec,
        message:
          '监控看板已保存。宿主会周期调用 renderMonitor(采集JSON)。请提示用户打开「监控」Tab；之后刷新不会再调用 AI。'
      })
    }
    default:
      throw new Error(`未知工具: ${toolName}`)
  }
}
