import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import type {
  AgentStreamEvent,
  ChatMessage,
  DeployTemplateDraft,
  ToolConfirmRequest
} from '../../shared/types'
import { DEPLOY_UNBOUND_SERVER_ID } from '../../shared/types'
import { getStore } from './credential-store'
import { getChatStore } from './chat-session-store'
import { getDeployStore } from './deploy-store'
import { getLlmClient, type LlmChatMessage } from './llm-client'
import {
  AGENT_TOOLS,
  DEPLOY_AGENT_TOOLS,
  executeTool,
  parseProposeDeployTemplateArgs,
  toolNeedsConfirm
} from '../tools'

interface PendingConfirm {
  serverId: string
  sessionId: string
  resolve: (approved: boolean) => void
}

interface TemplateDraftDecision {
  approved: boolean
  feedback?: string
  /** 用户在确认界面改过的字段（如标题） */
  overrides?: { name?: string }
}

interface PendingTemplateDraft {
  serverId: string
  sessionId: string
  resolve: (result: TemplateDraftDecision) => void
}

interface ActiveRun {
  aborted: boolean
  serverId: string
  sessionId: string
  queryId: string
  mode: 'ops' | 'deploy'
}

export class AgentRuntime {
  private pendingConfirms = new Map<string, PendingConfirm>()
  private pendingTemplateDrafts = new Map<string, PendingTemplateDraft>()
  /** 按 session 互斥；同服务器同时只允许一个会话在跑（SSH） */
  private activeRuns = new Map<string, ActiveRun>()
  private serverRunOwner = new Map<string, string>()

  respondConfirm(requestId: string, approved: boolean): void {
    const pending = this.pendingConfirms.get(requestId)
    if (pending) {
      pending.resolve(approved)
      this.pendingConfirms.delete(requestId)
    }
  }

  /** 用户确认或驳回沉淀模板草案 */
  respondTemplateDraft(
    requestId: string,
    approved: boolean,
    feedback?: string,
    overrides?: TemplateDraftDecision['overrides']
  ): void {
    const pending = this.pendingTemplateDrafts.get(requestId)
    if (pending) {
      pending.resolve({ approved, feedback, overrides })
      this.pendingTemplateDrafts.delete(requestId)
    }
  }

  /** 取消某服务器上挂起的确认与进行中的对话 */
  cancelServer(serverId: string): void {
    const sessionId = this.serverRunOwner.get(serverId)
    if (sessionId) this.cancelSession(sessionId)
    for (const [id, pending] of this.pendingConfirms) {
      if (pending.serverId === serverId) {
        pending.resolve(false)
        this.pendingConfirms.delete(id)
      }
    }
    for (const [id, pending] of this.pendingTemplateDrafts) {
      if (pending.serverId === serverId) {
        pending.resolve({ approved: false, feedback: '已取消' })
        this.pendingTemplateDrafts.delete(id)
      }
    }
  }

  cancelSession(sessionId: string): void {
    const run = this.activeRuns.get(sessionId)
    if (run) run.aborted = true
    for (const [id, pending] of this.pendingConfirms) {
      if (pending.sessionId === sessionId) {
        pending.resolve(false)
        this.pendingConfirms.delete(id)
      }
    }
    for (const [id, pending] of this.pendingTemplateDrafts) {
      if (pending.sessionId === sessionId) {
        pending.resolve({ approved: false, feedback: '已取消' })
        this.pendingTemplateDrafts.delete(id)
      }
    }
  }

  private emit(
    win: BrowserWindow | null,
    channel: string,
    event: AgentStreamEvent,
    queryId?: string
  ): void {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, {
        ...event,
        queryId: event.queryId || queryId
      })
    }
  }

  private emitRun(
    win: BrowserWindow | null,
    channel: string,
    run: ActiveRun,
    event: Omit<AgentStreamEvent, 'queryId'>
  ): void {
    this.emit(win, channel, { ...event, queryId: run.queryId })
  }

  private waitConfirm(
    req: ToolConfirmRequest,
    win: BrowserWindow | null,
    channel: string,
    run: ActiveRun
  ): Promise<boolean> {
    return new Promise((resolve) => {
      if (run.aborted) {
        resolve(false)
        return
      }
      const timer = setTimeout(() => {
        this.pendingConfirms.delete(req.requestId)
        resolve(false)
      }, 5 * 60 * 1000)

      this.pendingConfirms.set(req.requestId, {
        serverId: req.serverId,
        sessionId: run.sessionId,
        resolve: (approved) => {
          clearTimeout(timer)
          resolve(approved)
        }
      })
      this.emitRun(win, channel, run, { type: 'confirm', confirm: req })
    })
  }

  private waitTemplateDraft(
    draft: DeployTemplateDraft,
    win: BrowserWindow | null,
    channel: string,
    run: ActiveRun
  ): Promise<TemplateDraftDecision> {
    return new Promise((resolve) => {
      if (run.aborted) {
        resolve({ approved: false, feedback: '已取消' })
        return
      }
      const timer = setTimeout(() => {
        this.pendingTemplateDrafts.delete(draft.requestId)
        resolve({ approved: false, feedback: '确认超时，请重新提议' })
      }, 30 * 60 * 1000)

      this.pendingTemplateDrafts.set(draft.requestId, {
        serverId: draft.serverId,
        sessionId: run.sessionId,
        resolve: (result) => {
          clearTimeout(timer)
          resolve(result)
        }
      })
      this.emitRun(win, channel, run, { type: 'template_draft', templateDraft: draft })
    })
  }

  private persist(sessionId: string, message: ChatMessage, run: ActiveRun): void {
    if (run.aborted) return
    getChatStore().appendMessage(sessionId, {
      ...message,
      queryId: message.queryId || run.queryId
    })
  }

  private ensureNotAborted(run: ActiveRun): void {
    if (run.aborted) throw new Error('对话已取消')
  }

  async runChat(params: {
    serverId: string
    sessionId: string
    providerId: string
    userMessage: string
    queryId?: string
    window: BrowserWindow | null
    /** ops=日常运维；deploy=部署对话（可沉淀模板） */
    mode?: 'ops' | 'deploy'
  }): Promise<void> {
    const channel = `agent:stream:${params.sessionId}`
    const store = getStore()
    const chatStore = getChatStore()
    const llm = getLlmClient()
    const queryId = params.queryId || randomUUID()
    const mode = params.mode || 'ops'
    const tools = mode === 'deploy' ? DEPLOY_AGENT_TOOLS : AGENT_TOOLS

    const initialServerId = params.serverId || DEPLOY_UNBOUND_SERVER_ID
    const unbound = initialServerId === DEPLOY_UNBOUND_SERVER_ID

    if (this.activeRuns.has(params.sessionId)) {
      this.emit(params.window, channel, {
        type: 'error',
        queryId,
        error: '当前会话已有进行中的对话，请等待完成或取消后再试'
      })
      return
    }
    if (!unbound && this.serverRunOwner.has(initialServerId)) {
      this.emit(params.window, channel, {
        type: 'error',
        queryId,
        error: '该服务器已有进行中的对话，请等待完成或取消后再试'
      })
      return
    }

    const run: ActiveRun = {
      aborted: false,
      serverId: initialServerId,
      sessionId: params.sessionId,
      queryId,
      mode
    }
    this.activeRuns.set(params.sessionId, run)
    if (!unbound) this.serverRunOwner.set(initialServerId, params.sessionId)

    try {
      const boundServer = unbound
        ? null
        : store.listServers().find((s) => s.id === initialServerId) || null
      if (!unbound && !boundServer) {
        this.emitRun(params.window, channel, run, { type: 'error', error: '服务器不存在' })
        return
      }

      const history = chatStore.getMessages(params.sessionId)
      const systemPrompt =
        mode === 'deploy'
          ? [
              '你是部署助手。通过对话帮助用户把应用/文件部署到环境中的服务器，并在成功后提议沉淀为可重复模板。',
              unbound
                ? '当前尚未绑定目标服务器。用户会在对话里说出目标机（名称/IP/主机）；你必须先 list_env_servers，再用 bind_deploy_server 绑定后，才能 SSH/上传。'
                : `当前已绑定服务器: ${boundServer!.name} (${boundServer!.username}@${boundServer!.host}:${boundServer!.port})`,
              '环境管理里已保存 SSH 凭证，绑定后即可操作，无需向用户索要密码。',
              '',
              '工作方式：',
              '1. 从用户描述中识别目标服务器与部署内容（本地路径、远程目录、启动/验证方式）；',
              '2. 未绑定时：list_env_servers → bind_deploy_server（serverId 或 nameOrHost）；',
              '3. 绑定后用 list_dir / run_command / upload_file 实际完成部署（先探测再改动）；',
              '4. 部署成功并验证后，主动询问是否沉淀为固定流程；用户同意后调用 propose_deploy_template；',
              '5. propose_deploy_template 只提交草案：界面展示「参数」和「执行步骤」给用户确认；',
              '   - 确认后才创建/更新模板；驳回则根据反馈优化后再次 propose；',
              '6. 用户要修改已有模板时：先 list_deploy_templates 找到 projectId，再 propose_deploy_template 并传入该 projectId；',
              '   - 可先加载现有步骤再按本次跑通结果修订；不要静默新建同名模板；',
              '7. 参数只提取下次会变的项（如本地 dist 路径 {{artifact}}）；服务器与固定命令写死在 steps；',
              '8. steps.command 对可变值用 {{paramKey}}，且必须是本次已验证可走通的命令；',
              '   - 本机上传步骤写成：upload_file {{artifact}} => /tmp/xxx.zip（不要把本机路径写进远端 unzip）；',
              '   - assertions 仅发布前检查（如 zip 内含 index.html）；发布后站点校验放 steps/healthCheck。',
              '',
              '最终回复用简洁中文 Markdown。'
            ].join('\n')
          : [
              '你是 AI Ops Agent，帮助用户通过 SSH 运维远程 Linux/Unix 服务器。',
              `当前服务器: ${boundServer!.name} (${boundServer!.username}@${boundServer!.host}:${boundServer!.port})`,
              '你可以调用工具执行命令、查看系统信息、浏览目录、读取文件、创建/更新监控看板。',
              '执行会修改系统的操作前应说明意图；优先使用非破坏性命令收集信息。',
              '',
              '【监控看板】当用户要求创建或增加监控指标时：',
              '1. 先调用 get_monitor_dashboard 了解是否已有看板；',
              '2. 再调用 save_monitor_dashboard 保存完整 Bundle（可覆盖更新）；',
              '3. collectScript 必须只读，stdout 最后一行输出 JSON 对象（字段名自定义，如 {"cpu":12.5,"mem":68}）；',
              '4. html 必须是完整文档，且必须定义全局函数 window.renderMonitor = function(data){...}，',
              '   宿主会周期性把采集到的 JSON 传入该函数；你在函数里更新任意 DOM/图表。不要自己轮询，不要依赖持续调用 AI；',
              '5. 深色主题、可用 CDN（如 Chart.js）；',
              '6. 保存成功后明确告诉用户去「监控」Tab 查看。',
              '',
              '最终回复请使用 Markdown 格式（标题、列表、表格、代码块等），便于阅读。',
              '命令输出可用 fenced code block 展示关键片段，并给出简洁中文总结。'
            ].join('\n')

      const contextMessages: LlmChatMessage[] = history
        .filter((m) => m.role === 'user' || (m.role === 'assistant' && !m.toolName))
        .slice(-20)
        .map((m) => {
          const msg: LlmChatMessage = {
            role: m.role as 'user' | 'assistant',
            content: m.content
          }
          // DeepSeek 带 tools 时要求回传历史 reasoning_content
          if (m.role === 'assistant' && m.reasoning) {
            msg.reasoning_content = m.reasoning
          }
          return msg
        })

      const messages: LlmChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...contextMessages,
        { role: 'user', content: params.userMessage }
      ]

      const userMsg: ChatMessage = {
        id: randomUUID(),
        role: 'user',
        content: params.userMessage,
        queryId,
        createdAt: Date.now()
      }
      this.persist(params.sessionId, userMsg, run)

      const maxRounds = Math.min(
        40,
        Math.max(4, store.getSettings().maxAgentRounds || 20)
      )
      let rounds = 0
      while (rounds < maxRounds) {
        this.ensureNotAborted(run)
        rounds += 1
        const result = await llm.chat(params.providerId, messages, tools)
        this.ensureNotAborted(run)

        if (result.tool_calls && result.tool_calls.length > 0) {
          this.emitReasoning(params.window, channel, run, result.reasoningContent)
          // 最后一轮若仍要调工具：不再执行，改为强制总结，避免「跑完工具就没下文」
          if (rounds >= maxRounds) {
            messages.push(this.toAssistantLlmMessage(result))
            for (const tc of result.tool_calls) {
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: '已达到最大工具轮次，本轮工具未执行。请基于已有结果直接给出结论。'
              })
            }
            break
          }
          if (result.content?.trim() || result.reasoningContent?.trim()) {
            const note: ChatMessage = {
              id: randomUUID(),
              role: 'assistant',
              content: result.content || '',
              reasoning: result.reasoningContent || undefined,
              queryId,
              createdAt: Date.now()
            }
            this.persist(params.sessionId, note, run)
            if (result.content?.trim()) {
              this.emitRun(params.window, channel, run, {
                type: 'text',
                content: result.content
              })
            }
          }

          messages.push(this.toAssistantLlmMessage(result))

          for (const tc of result.tool_calls) {
            this.ensureNotAborted(run)
            let args: Record<string, unknown> = {}
            try {
              args = JSON.parse(tc.function.arguments || '{}')
            } catch {
              args = {}
            }

            const startMsg: ChatMessage = {
              id: randomUUID(),
              role: 'tool',
              content: JSON.stringify(args, null, 2),
              toolName: tc.function.name,
              toolCallId: tc.id,
              toolPhase: 'start',
              queryId,
              createdAt: Date.now()
            }
            this.persist(params.sessionId, startMsg, run)
            this.emitRun(params.window, channel, run, {
              type: 'tool_start',
              toolName: tc.function.name,
              toolCallId: tc.id,
              content: startMsg.content
            })

            const assess = toolNeedsConfirm(tc.function.name, args)
            if (assess.blocked) {
              const msg = `已拦截危险命令: ${assess.reason}`
              this.persistToolResult(params.sessionId, tc, msg, run, channel, params.window, messages)
              continue
            }

            if (assess.needsConfirm) {
              const requestId = randomUUID()
              const approved = await this.waitConfirm(
                {
                  requestId,
                  serverId: run.serverId,
                  toolName: tc.function.name,
                  arguments: args,
                  riskLevel: assess.riskLevel,
                  reason: assess.reason
                },
                params.window,
                channel,
                run
              )
              if (!approved) {
                const msg = run.aborted ? '对话已取消' : '用户拒绝执行该工具调用'
                this.persistToolResult(params.sessionId, tc, msg, run, channel, params.window, messages)
                if (run.aborted) throw new Error('对话已取消')
                continue
              }
            }

            try {
              if (tc.function.name === 'propose_deploy_template') {
                if (!run.serverId || run.serverId === DEPLOY_UNBOUND_SERVER_ID) {
                  const msg = '请先 bind_deploy_server 绑定目标服务器，再沉淀模板'
                  this.persistToolResult(params.sessionId, tc, msg, run, channel, params.window, messages)
                  continue
                }
                const requestId = randomUUID()
                let draft: DeployTemplateDraft
                try {
                  draft = parseProposeDeployTemplateArgs(args, run.serverId, requestId)
                } catch (parseErr) {
                  const msg = `草案无效: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
                  this.persistToolResult(params.sessionId, tc, msg, run, channel, params.window, messages)
                  continue
                }

                if (draft.projectId) {
                  const existing = getDeployStore().getProject(draft.projectId)
                  const existingRecipe = getDeployStore().getRecipe(draft.projectId)
                  if (!existing || !existingRecipe) {
                    const msg = `projectId=${draft.projectId} 对应模板不存在，请先 list_deploy_templates 再 propose`
                    this.persistToolResult(params.sessionId, tc, msg, run, channel, params.window, messages)
                    continue
                  }
                }

                const decision = await this.waitTemplateDraft(draft, params.window, channel, run)
                if (run.aborted) throw new Error('对话已取消')

                if (!decision.approved) {
                  const msg = JSON.stringify({
                    ok: false,
                    created: false,
                    updated: false,
                    reason: '用户未确认该草案',
                    feedback: decision.feedback || '请继续对话优化后再次 propose_deploy_template'
                  })
                  this.persistToolResult(params.sessionId, tc, msg, run, channel, params.window, messages)
                  continue
                }

                const deployStore = getDeployStore()
                const templateName =
                  (decision.overrides?.name || draft.name || '').trim() || draft.name
                const isUpdate = Boolean(draft.projectId)
                const project = isUpdate
                  ? deployStore.getProject(draft.projectId!)!
                  : deployStore.createProject(templateName, run.serverId)
                const existingRecipe = isUpdate ? deployStore.getRecipe(project.id) : null
                const recipe = deployStore.saveRecipe(
                  {
                    id: existingRecipe?.id,
                    projectId: project.id,
                    name: templateName,
                    kind: draft.kind,
                    serverId: run.serverId,
                    params: draft.params,
                    assertions: draft.assertions,
                    steps: draft.steps,
                    healthCheck: draft.healthCheck,
                    notes: draft.notes,
                    sourceIntent: draft.sourceIntent
                  },
                  'active'
                )
                const msg = JSON.stringify({
                  ok: true,
                  created: !isUpdate,
                  updated: isUpdate,
                  projectId: project.id,
                  recipeId: recipe.id,
                  recipeVersion: recipe.version,
                  message: isUpdate
                    ? `模板「${recipe.name}」已更新到 v${recipe.version}。可到「模板部署」页用新流程填参发布。`
                    : `模板「${recipe.name}」已创建。请提示用户到「部署」页打开该模板，以后只需填参数即可发布。`
                })
                this.persistToolResult(params.sessionId, tc, msg, run, channel, params.window, messages)
                continue
              }

              const toolArgs =
                tc.function.name === 'bind_deploy_server'
                  ? { ...args, sessionId: params.sessionId }
                  : args

              const toolResult = await executeTool(
                run.serverId,
                tc.function.name,
                toolArgs,
                (chunk) => {
                  if (!run.aborted) {
                    this.emitRun(params.window, channel, run, {
                      type: 'tool_stdout',
                      content: chunk,
                      toolName: tc.function.name,
                      toolCallId: tc.id
                    })
                  }
                },
                { sessionId: params.sessionId }
              )

              if (tc.function.name === 'bind_deploy_server') {
                try {
                  const parsed = JSON.parse(toolResult) as { ok?: boolean; serverId?: string }
                  if (parsed.ok && parsed.serverId) {
                    const prev = run.serverId
                    if (prev !== parsed.serverId) {
                      if (this.serverRunOwner.get(prev) === params.sessionId) {
                        this.serverRunOwner.delete(prev)
                      }
                      run.serverId = parsed.serverId
                      this.serverRunOwner.set(parsed.serverId, params.sessionId)
                    }
                  }
                } catch {
                  /* ignore */
                }
              }

              // 展示可稍长；回灌模型要更短，避免下一轮请求失败/超时导致「没结束就停」
              const resultText = toolResult.slice(0, 12000)
              this.persistToolResult(
                params.sessionId,
                tc,
                resultText,
                run,
                channel,
                params.window,
                messages,
                toolResult.slice(0, 6000)
              )
            } catch (err) {
              const msg = `执行失败: ${err instanceof Error ? err.message : String(err)}`
              this.persistToolResult(params.sessionId, tc, msg, run, channel, params.window, messages)
            }
          }
          continue
        }

        const assistantText = result.content || '（无回复）'
        this.finishAssistant(
          params.sessionId,
          assistantText,
          run,
          channel,
          params.window,
          result.reasoningContent
        )
        return
      }

      // 轮次用尽：再请求一次纯文本总结，尽量给用户完整收尾
      try {
        this.ensureNotAborted(run)
        messages.push({
          role: 'user',
          content:
            '工具调用轮次已达上限。请不要再调用工具，根据目前已收集的信息，用 Markdown 给出完整结论与建议。'
        })
        const finalResult = await llm.chat(params.providerId, messages)
        const assistantText =
          finalResult.content ||
          `已达到最大工具轮次（${maxRounds}），且模型未返回总结。你可以继续追问让我基于已有结果补充说明。`
        this.finishAssistant(
          params.sessionId,
          assistantText,
          run,
          channel,
          params.window,
          finalResult.reasoningContent
        )
      } catch (finalErr) {
        const tip = `已达到最大工具轮次（${maxRounds}）。收尾总结失败：${
          finalErr instanceof Error ? finalErr.message : String(finalErr)
        }`
        this.finishAssistant(params.sessionId, tip, run, channel, params.window)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message === '对话已取消') {
        this.emitRun(params.window, channel, run, { type: 'error', error: '对话已取消' })
      } else {
        // 写入历史，避免只弹 toast、刷新后「像没结束」
        this.persist(
          params.sessionId,
          {
            id: randomUUID(),
            role: 'assistant',
            content: `⚠️ 对话中断：${message}`,
            queryId: run.queryId,
            createdAt: Date.now()
          },
          run
        )
        this.emitRun(params.window, channel, run, { type: 'error', error: message })
      }
    } finally {
      this.activeRuns.delete(params.sessionId)
      if (this.serverRunOwner.get(run.serverId) === params.sessionId) {
        this.serverRunOwner.delete(run.serverId)
      }
      for (const [id, pending] of this.pendingConfirms) {
        if (pending.sessionId === params.sessionId) {
          pending.resolve(false)
          this.pendingConfirms.delete(id)
        }
      }
      for (const [id, pending] of this.pendingTemplateDrafts) {
        if (pending.sessionId === params.sessionId) {
          pending.resolve({ approved: false, feedback: '对话结束' })
          this.pendingTemplateDrafts.delete(id)
        }
      }
    }
  }

  private toAssistantLlmMessage(result: {
    content: string | null
    reasoningContent?: string | null
    tool_calls?: LlmChatMessage['tool_calls']
  }): LlmChatMessage {
    const msg: LlmChatMessage = {
      role: 'assistant',
      content: result.content || ''
    }
    if (result.reasoningContent) {
      msg.reasoning_content = result.reasoningContent
    }
    if (result.tool_calls?.length) {
      msg.tool_calls = result.tool_calls
    }
    return msg
  }

  private emitReasoning(
    window: BrowserWindow | null,
    channel: string,
    run: ActiveRun,
    reasoning: string | null | undefined
  ): void {
    if (reasoning?.trim()) {
      this.emitRun(window, channel, run, { type: 'reasoning', content: reasoning })
    }
  }

  private finishAssistant(
    sessionId: string,
    assistantText: string,
    run: ActiveRun,
    channel: string,
    window: BrowserWindow | null,
    reasoning?: string | null
  ): void {
    this.emitReasoning(window, channel, run, reasoning)
    const assistantMsg: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: assistantText,
      reasoning: reasoning || undefined,
      queryId: run.queryId,
      createdAt: Date.now()
    }
    this.persist(sessionId, assistantMsg, run)
    this.emitRun(window, channel, run, { type: 'text', content: assistantText })
    this.emitRun(window, channel, run, { type: 'done', content: assistantText })
  }

  private persistToolResult(
    sessionId: string,
    tc: { id: string; function: { name: string } },
    content: string,
    run: ActiveRun,
    channel: string,
    window: BrowserWindow | null,
    messages: LlmChatMessage[],
    llmContent?: string
  ): void {
    const resultMsg: ChatMessage = {
      id: randomUUID(),
      role: 'tool',
      content,
      toolName: tc.function.name,
      toolCallId: tc.id,
      toolPhase: 'result',
      queryId: run.queryId,
      createdAt: Date.now()
    }
    this.persist(sessionId, resultMsg, run)
    this.emitRun(window, channel, run, {
      type: 'tool_result',
      toolName: tc.function.name,
      toolCallId: tc.id,
      content
    })
    messages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: llmContent ?? content
    })
  }
}

let agentInstance: AgentRuntime | null = null

export function getAgentRuntime(): AgentRuntime {
  if (!agentInstance) agentInstance = new AgentRuntime()
  return agentInstance
}
