<template>
  <div class="chat-panel">
    <div class="chat-toolbar">
      <div class="toolbar-left">
        <el-select
          :model-value="sessionId"
          placeholder="选择会话"
          style="width: 220px"
          size="small"
          :disabled="busy || !sessions.length"
          @change="onSelectSession"
        >
          <el-option
            v-for="s in sessions"
            :key="s.id"
            :label="sessionLabel(s)"
            :value="s.id"
          />
        </el-select>
        <el-select v-model="providerId" placeholder="选择模型" style="width: 220px" size="small">
          <el-option
            v-for="p in enabledProviders"
            :key="p.id"
            :label="`${p.name} · ${p.model}`"
            :value="p.id"
          />
        </el-select>
        <el-tag v-if="server" size="small" type="success" class="server-tag">
          {{ server.name }} · {{ server.host }}
        </el-tag>
        <el-tag v-else size="small" type="info" class="server-tag">目标机：对话中指定</el-tag>
      </div>
      <div class="toolbar-actions">
        <el-button size="small" :disabled="busy" :loading="creating" @click="createSession">
          新建会话
        </el-button>
        <el-button v-if="busy" size="small" type="warning" @click="cancelRun">取消</el-button>
        <el-dropdown trigger="click" :disabled="busy || !sessionId">
          <el-button size="small" :disabled="busy || !sessionId">
            更多
            <el-icon class="el-icon--right"><ArrowDown /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item @click="clearHistory">清空当前会话</el-dropdown-item>
              <el-dropdown-item @click="renameSession">重命名</el-dropdown-item>
              <el-dropdown-item divided @click="deleteSession">删除会话</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>

    <el-alert
      v-if="enabledProviders.length === 0"
      type="warning"
      :closable="false"
      show-icon
      title="尚未配置可用模型"
      description="请先到「模型设置」添加 DeepSeek / GLM / Ollama 等 Provider"
      class="provider-hint"
    />

    <div
      ref="scrollRef"
      class="messages"
      :class="{ 'messages--compact': !!pendingDraft }"
      v-loading="historyLoading"
    >
      <div v-if="!historyLoading && displayTurns.length === 0" class="empty">
        试试：「把本机 dist 部署到生产机 /opt/my-app，重启服务并做健康检查」
      </div>

      <div v-for="turn in displayTurns" :key="turn.queryId" class="turn">
        <div v-if="turn.user" class="msg user">
          <div class="role">你</div>
          <div class="body plain">{{ turn.user.content }}</div>
        </div>

        <div v-if="hasAssistantBlock(turn)" class="msg assistant">
          <div class="role">助手</div>
          <div class="assistant-block">
            <details
              v-if="hasProcess(turn)"
              class="process"
              v-bind="turn.live ? { open: true } : {}"
            >
              <summary>{{ processSummary(turn) }}</summary>
              <div class="process-body">
                <div v-for="(r, i) in turn.reasonings" :key="`r-${i}`" class="process-section">
                  <div class="process-label">思考</div>
                  <pre class="reasoning-body">{{ r }}</pre>
                </div>
                <div v-for="(note, i) in turn.notes" :key="`n-${i}`" class="process-section">
                  <div class="process-label">中间说明</div>
                  <div class="note-body" v-html="renderMarkdown(note)" />
                </div>
                <div v-for="tool in turn.tools" :key="tool.toolCallId" class="tool-card">
                  <div class="tool-head">
                    <el-tag size="small" :type="tool.result ? 'success' : 'warning'">
                      {{ tool.result ? '已完成' : '调用中' }}
                    </el-tag>
                    <span class="tool-name mono">{{ tool.toolName }}</span>
                  </div>
                  <div v-if="tool.args" class="tool-part">
                    <div class="tool-part-label">参数</div>
                    <pre class="tool-body mono">{{ formatToolContent(tool.args) }}</pre>
                  </div>
                  <div v-if="tool.result || tool.running" class="tool-part">
                    <div class="tool-part-label">结果</div>
                    <pre class="tool-body mono">{{
                      tool.result ? formatToolContent(tool.result) : '执行中…'
                    }}</pre>
                  </div>
                </div>
              </div>
            </details>

            <div
              v-if="turn.finalContent"
              class="body md-body"
              v-html="renderMarkdown(turn.finalContent)"
            />
            <div v-else-if="turn.live" class="body plain muted">正在回复…</div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="pendingConfirm" class="confirm-bar">
      <div class="confirm-head">
        <div class="confirm-title">
          <strong>需要确认执行</strong>
          <el-tag size="small" :type="riskTag(pendingConfirm.riskLevel)">
            {{ pendingConfirm.riskLevel }}
          </el-tag>
          <span class="confirm-tool mono">{{ pendingConfirm.toolName }}</span>
        </div>
        <div class="confirm-actions">
          <el-button @click="respondConfirm(false)">拒绝</el-button>
          <el-button type="primary" @click="respondConfirm(true)">允许执行</el-button>
        </div>
      </div>
      <div v-if="pendingConfirm.reason" class="reason">{{ pendingConfirm.reason }}</div>
      <pre class="mono confirm-args">{{ formatConfirmArgs(pendingConfirm.arguments) }}</pre>
    </div>

    <div v-if="pendingDraft" class="draft-bar">
      <div class="draft-head">
        <div class="draft-head-text">
          <strong>{{ pendingDraft.projectId ? '确认更新已有模板？' : '确认沉淀为模板？' }}</strong>
          <span class="meta">
            {{
              pendingDraft.projectId
                ? '将覆盖该模板的参数与步骤（版本 +1）；可改标题，不对可写反馈继续优化'
                : '可改标题；参数/步骤不对可写反馈后继续优化'
            }}
          </span>
          <div v-if="pendingDraft.projectId" class="meta mono draft-update-id">
            projectId: {{ pendingDraft.projectId }}
          </div>
          <div class="draft-name-row">
            <el-input
              v-model="draftName"
              size="small"
              placeholder="模板标题"
              class="draft-name-input"
            />
            <span class="meta mono">{{ pendingDraft.kind }}</span>
          </div>
        </div>
      </div>

      <div class="draft-scroll">
        <div class="draft-section">
          <div class="section-label">可变参数（每次部署填写）</div>
          <el-table :data="pendingDraft.params" size="small" empty-text="无参数（全固定流程）">
            <el-table-column prop="key" label="key" width="120" />
            <el-table-column prop="label" label="名称" width="120" />
            <el-table-column prop="type" label="类型" width="90" />
            <el-table-column prop="description" label="说明" min-width="160" />
          </el-table>
        </div>
        <div class="draft-section">
          <div class="section-label">执行过程</div>
          <div v-for="(step, i) in pendingDraft.steps" :key="step.id" class="step-row">
            <div class="step-title">
              <span class="mono">#{{ i + 1 }}</span>
              {{ step.name }}
              <el-tag size="small" :type="riskTag(step.riskLevel)">{{ step.riskLevel }}</el-tag>
            </div>
            <pre class="mono step-cmd">{{ step.command }}</pre>
          </div>
        </div>
        <div v-if="pendingDraft.healthCheck?.command" class="draft-section">
          <div class="section-label">健康检查</div>
          <pre class="mono step-cmd">{{ pendingDraft.healthCheck.command }}</pre>
        </div>
      </div>

      <div class="draft-footer">
        <el-input
          v-model="draftFeedback"
          type="textarea"
          :rows="2"
          placeholder="若需修改，写下反馈（点「继续优化」会带给助手）"
          class="feedback-input"
        />
        <div class="draft-actions">
          <el-button @click="respondDraft(false)">继续优化</el-button>
          <el-button type="primary" @click="respondDraft(true)">
            {{ pendingDraft.projectId ? '确认，更新模板' : '确认，创建模板' }}
          </el-button>
        </div>
      </div>
    </div>

    <div
      v-if="!pendingDraft"
      class="composer"
      :class="{ 'is-dragover': dragOver }"
      @dragenter.prevent="onDragEnter"
      @dragover.prevent="onDragOver"
      @dragleave.prevent="onDragLeave"
      @drop.prevent="onDropFiles"
    >
      <el-input
        v-model="input"
        type="textarea"
        :rows="3"
        placeholder="用自然语言描述部署需求…（可拖入 dist 压缩包，自动填入本机路径）"
        :disabled="busy || enabledProviders.length === 0 || !sessionId"
        @keydown.enter.exact="onEnter"
      />
      <el-button type="primary" :loading="busy" :disabled="!canSend" @click="send">发送</el-button>
      <div v-if="dragOver" class="drop-hint">松开以填入文件路径</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown } from '@element-plus/icons-vue'
import type {
  AgentStreamEvent,
  ChatMessage,
  ChatSession,
  DeployTemplateDraft,
  ToolConfirmRequest
} from '../../../shared/types'
import { DEPLOY_UNBOUND_SERVER_ID } from '../../../shared/types'
import { useAppStore } from '../stores/app'
import { appendPathsToInput, getDroppedFilePaths } from '../utils/drop-files'
import { renderMarkdown } from '../utils/markdown'

const emit = defineEmits<{
  (e: 'template-created', projectId: string): void
}>()

interface ToolStep {
  toolCallId: string
  toolName: string
  args: string
  result: string
  running: boolean
}

interface QueryTurn {
  queryId: string
  user?: ChatMessage
  reasonings: string[]
  notes: string[]
  tools: ToolStep[]
  finalContent: string
  live?: boolean
}

const store = useAppStore()
const STORAGE_KEY = 'aiops.deploy.activeSessionId'

const sessions = ref<ChatSession[]>([])
const sessionId = ref<string | null>(null)
const boundServerId = ref(DEPLOY_UNBOUND_SERVER_ID)
const messages = ref<ChatMessage[]>([])
const input = ref('')
const busy = ref(false)
const creating = ref(false)
const historyLoading = ref(false)
const providerId = ref<string | null>(null)
const pendingConfirm = ref<ToolConfirmRequest | null>(null)
const pendingDraft = ref<DeployTemplateDraft | null>(null)
const draftName = ref('')
const draftFeedback = ref('')
const scrollRef = ref<HTMLElement | null>(null)
const activeQueryId = ref<string | null>(null)
const liveTurn = ref<QueryTurn | null>(null)
const createdProjectId = ref<string | null>(null)
const dragOver = ref(false)
let dragDepth = 0

let unsubscribe: (() => void) | null = null
let loadSeq = 0

const enabledProviders = computed(() => store.providers.filter((p) => p.enabled))
const server = computed(() =>
  boundServerId.value && boundServerId.value !== DEPLOY_UNBOUND_SERVER_ID
    ? store.servers.find((s) => s.id === boundServerId.value)
    : undefined
)
const canSend = computed(() =>
  Boolean(
    input.value.trim() &&
      providerId.value &&
      sessionId.value &&
      !busy.value &&
      !pendingDraft.value &&
      enabledProviders.value.length > 0
  )
)

function sessionLabel(s: ChatSession): string {
  const time = new Date(s.updatedAt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
  return `${s.title} · ${time}`
}

function riskTag(level: string): 'info' | 'warning' | 'danger' | 'success' {
  if (level === 'high') return 'danger'
  if (level === 'medium') return 'warning'
  if (level === 'low') return 'success'
  return 'info'
}

function formatConfirmArgs(args: Record<string, unknown>): string {
  const preview = (value: unknown, limit = 240): unknown => {
    if (typeof value === 'string') {
      if (value.length <= limit) return value
      return `${value.slice(0, limit)}… (+${value.length - limit} chars)`
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = preview(v, limit)
      }
      return out
    }
    if (Array.isArray(value)) return value.map((item) => preview(item, limit))
    return value
  }
  try {
    return JSON.stringify(preview(args), null, 2)
  } catch {
    return String(args)
  }
}

function formatToolContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown> | string
    if (typeof parsed === 'string') return parsed
    if (parsed && typeof parsed === 'object' && ('stdout' in parsed || 'stderr' in parsed)) {
      const code = parsed.code
      const stdout = String(parsed.stdout ?? '')
      const stderr = String(parsed.stderr ?? '')
      const parts = [`exit code: ${code ?? 'null'}`]
      if (stdout) parts.push('--- stdout ---\n' + stdout)
      if (stderr) parts.push('--- stderr ---\n' + stderr)
      return parts.join('\n\n')
    }
    return JSON.stringify(parsed, null, 2)
  } catch {
    return content.length > 4000 ? `${content.slice(0, 4000)}…` : content
  }
}

function hasProcess(turn: QueryTurn): boolean {
  return turn.reasonings.length > 0 || turn.tools.length > 0 || turn.notes.length > 0
}

function hasAssistantBlock(turn: QueryTurn): boolean {
  return hasProcess(turn) || !!turn.finalContent || !!turn.live
}

function processSummary(turn: QueryTurn): string {
  const n = turn.tools.length
  if (n) return `过程（${n} 个工具调用）`
  if (turn.reasonings.length) return '过程（含思考）'
  return '过程'
}

function buildTurns(list: ChatMessage[], live: QueryTurn | null): QueryTurn[] {
  const map = new Map<string, QueryTurn>()
  const order: string[] = []
  for (const m of list) {
    const qid = m.queryId || m.id
    if (!map.has(qid)) {
      map.set(qid, { queryId: qid, reasonings: [], notes: [], tools: [], finalContent: '' })
      order.push(qid)
    }
    const turn = map.get(qid)!
    if (m.role === 'user') turn.user = m
    else if (m.role === 'assistant' && !m.toolName) {
      if (m.reasoning) turn.reasonings.push(m.reasoning)
      if (m.content?.trim()) {
        if (turn.finalContent) turn.notes.push(turn.finalContent)
        turn.finalContent = m.content
      }
    } else if (m.role === 'tool') {
      let tool = turn.tools.find((t) => t.toolCallId === m.toolCallId)
      if (!tool) {
        tool = {
          toolCallId: m.toolCallId || m.id,
          toolName: m.toolName || 'tool',
          args: '',
          result: '',
          running: false
        }
        turn.tools.push(tool)
      }
      if (m.toolPhase === 'start') tool.args = m.content
      else {
        tool.result = m.content
        tool.running = false
      }
    }
  }
  const turns = order.map((id) => map.get(id)!)
  if (live && !map.has(live.queryId)) turns.push(live)
  else if (live) {
    const idx = turns.findIndex((t) => t.queryId === live.queryId)
    if (idx >= 0) turns[idx] = { ...live, user: turns[idx].user || live.user }
  }
  return turns
}

const displayTurns = computed(() => buildTurns(messages.value, liveTurn.value))

async function scrollBottom(): Promise<void> {
  await nextTick()
  if (scrollRef.value) scrollRef.value.scrollTop = scrollRef.value.scrollHeight
}

function rememberSession(id: string | null): void {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

async function refreshSessions(): Promise<void> {
  sessions.value = await window.api.sessions.listByKind('deploy')
}

async function loadHistory(id: string): Promise<void> {
  const seq = ++loadSeq
  historyLoading.value = true
  liveTurn.value = null
  pendingConfirm.value = null
  pendingDraft.value = null
  try {
    const session = await window.api.sessions.get(id)
    if (seq !== loadSeq) return
    boundServerId.value = session?.serverId || DEPLOY_UNBOUND_SERVER_ID
    messages.value = await window.api.chat.history(id)
    if (seq !== loadSeq) return
    bindStream(id)
    await scrollBottom()
  } finally {
    if (seq === loadSeq) historyLoading.value = false
  }
}

function bindStream(id: string): void {
  unsubscribe?.()
  unsubscribe = window.api.agent.onStream(id, onStream)
}

function onStream(event: AgentStreamEvent): void {
  const qid = event.queryId || activeQueryId.value
  if (!qid) return
  if (!liveTurn.value || liveTurn.value.queryId !== qid) {
    liveTurn.value = {
      queryId: qid,
      reasonings: [],
      notes: [],
      tools: [],
      finalContent: '',
      live: true
    }
  }
  const turn = liveTurn.value

  if (event.type === 'reasoning' && event.content) {
    turn.reasonings.push(event.content)
  } else if (event.type === 'text' && event.content) {
    turn.finalContent = event.content
  } else if (event.type === 'tool_start') {
    turn.tools.push({
      toolCallId: event.toolCallId || crypto.randomUUID(),
      toolName: event.toolName || 'tool',
      args: event.content || '',
      result: '',
      running: true
    })
  } else if (event.type === 'tool_result') {
    const tool =
      turn.tools.find((t) => t.toolCallId === event.toolCallId) || turn.tools[turn.tools.length - 1]
    if (tool) {
      tool.result = event.content || ''
      tool.running = false
    }
    if (event.toolName === 'propose_deploy_template' && event.content) {
      try {
        const parsed = JSON.parse(event.content) as {
          created?: boolean
          updated?: boolean
          projectId?: string
          recipeVersion?: number
          message?: string
        }
        if (parsed.created && parsed.projectId) createdProjectId.value = parsed.projectId
        if (parsed.updated && parsed.projectId) {
          ElMessage.success(parsed.message || `模板已更新到 v${parsed.recipeVersion || '?'}`)
        }
      } catch {
        /* ignore */
      }
    }
    if (event.toolName === 'bind_deploy_server' && event.content) {
      try {
        const parsed = JSON.parse(event.content) as { ok?: boolean; serverId?: string }
        if (parsed.ok && parsed.serverId) boundServerId.value = parsed.serverId
      } catch {
        /* ignore */
      }
    }
  } else if (event.type === 'confirm' && event.confirm) {
    pendingConfirm.value = event.confirm
  } else if (event.type === 'template_draft' && event.templateDraft) {
    pendingDraft.value = event.templateDraft
    draftName.value = event.templateDraft.name || ''
    draftFeedback.value = ''
  } else if (event.type === 'error') {
    ElMessage.error(event.error || '错误')
  } else if (event.type === 'done') {
    turn.live = false
    busy.value = false
    pendingConfirm.value = null
    void reloadAfterDone()
  }
  void scrollBottom()
}

async function reloadAfterDone(): Promise<void> {
  if (sessionId.value) {
    messages.value = await window.api.chat.history(sessionId.value)
    liveTurn.value = null
    await refreshSessions()
  }
  if (createdProjectId.value) {
    const id = createdProjectId.value
    createdProjectId.value = null
    ElMessage.success('模板已创建')
    emit('template-created', id)
  }
}

async function onSelectSession(id: string): Promise<void> {
  if (busy.value) return
  sessionId.value = id
  rememberSession(id)
  await loadHistory(id)
}

async function createSession(): Promise<void> {
  if (!store.servers.length) {
    ElMessage.warning('请先在「环境管理」添加至少一台服务器')
    return
  }
  creating.value = true
  try {
    const session = await window.api.sessions.create(
      DEPLOY_UNBOUND_SERVER_ID,
      '部署会话',
      'deploy'
    )
    await refreshSessions()
    sessionId.value = session.id
    rememberSession(session.id)
    await loadHistory(session.id)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    creating.value = false
  }
}

async function clearHistory(): Promise<void> {
  if (!sessionId.value) return
  await ElMessageBox.confirm('确认清空当前会话的全部消息？', '清空确认', { type: 'warning' })
  await window.api.chat.clear(sessionId.value)
  messages.value = []
  liveTurn.value = null
  ElMessage.success('已清空')
}

async function renameSession(): Promise<void> {
  if (!sessionId.value) return
  const cur = sessions.value.find((s) => s.id === sessionId.value)
  const { value } = await ElMessageBox.prompt('输入会话标题', '重命名会话', {
    inputValue: cur?.title || '',
    confirmButtonText: '保存',
    cancelButtonText: '取消'
  })
  await window.api.sessions.rename(sessionId.value, String(value).trim())
  await refreshSessions()
}

async function deleteSession(): Promise<void> {
  if (!sessionId.value) return
  await ElMessageBox.confirm('确认删除该会话？消息文件也会一并删除。', '删除确认', {
    type: 'warning'
  })
  const id = sessionId.value
  if (busy.value) void window.api.agent.cancel(id)
  await window.api.sessions.delete(id)
  sessionId.value = null
  rememberSession(null)
  messages.value = []
  await refreshSessions()
  if (sessions.value[0]) {
    sessionId.value = sessions.value[0].id
    rememberSession(sessionId.value)
    await loadHistory(sessionId.value)
  }
  ElMessage.success('已删除')
}

async function send(): Promise<void> {
  if (!canSend.value || !providerId.value || !sessionId.value) return
  const text = input.value.trim()
  input.value = ''
  const queryId = crypto.randomUUID()
  activeQueryId.value = queryId
  busy.value = true
  pendingConfirm.value = null
  liveTurn.value = {
    queryId,
    user: {
      id: queryId,
      role: 'user',
      content: text,
      queryId,
      createdAt: Date.now()
    },
    reasonings: [],
    notes: [],
    tools: [],
    finalContent: '',
    live: true
  }
  await scrollBottom()
  try {
    await window.api.agent.chat({
      serverId: boundServerId.value || DEPLOY_UNBOUND_SERVER_ID,
      sessionId: sessionId.value,
      providerId: providerId.value,
      message: text,
      queryId,
      mode: 'deploy'
    })
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
    busy.value = false
  }
}

function onEnter(e: KeyboardEvent): void {
  if (e.isComposing) return
  e.preventDefault()
  void send()
}

function onDragEnter(): void {
  dragDepth += 1
  dragOver.value = true
}

function onDragOver(): void {
  dragOver.value = true
}

function onDragLeave(): void {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragOver.value = false
}

function onDropFiles(e: DragEvent): void {
  dragDepth = 0
  dragOver.value = false
  if (busy.value || !!pendingDraft.value) return
  const paths = getDroppedFilePaths(e)
  if (!paths.length) {
    ElMessage.warning('无法读取拖入文件的本机路径')
    return
  }
  input.value = appendPathsToInput(input.value, paths)
}

async function respondConfirm(approved: boolean): Promise<void> {
  const req = pendingConfirm.value
  if (!req) return
  pendingConfirm.value = null
  await window.api.agent.confirm(req.requestId, approved)
}

async function respondDraft(approved: boolean): Promise<void> {
  const draft = pendingDraft.value
  if (!draft) return
  const feedback = draftFeedback.value.trim()
  const name = draftName.value.trim()
  if (approved && !name) {
    ElMessage.warning('请填写模板标题')
    return
  }
  pendingDraft.value = null
  await window.api.agent.respondTemplateDraft(
    draft.requestId,
    approved,
    approved ? undefined : feedback || '请根据我的反馈优化参数和步骤后再提议',
    approved ? { name } : undefined
  )
  if (!approved) ElMessage.info('已驳回草案，可继续对话优化')
}

function cancelRun(): void {
  if (sessionId.value) void window.api.agent.cancel(sessionId.value)
  busy.value = false
  pendingConfirm.value = null
  if (pendingDraft.value) {
    void window.api.agent.respondTemplateDraft(pendingDraft.value.requestId, false, '用户取消')
    pendingDraft.value = null
  }
}

onMounted(async () => {
  await store.refreshAll()
  providerId.value =
    store.settings.defaultProviderId &&
    enabledProviders.value.some((p) => p.id === store.settings.defaultProviderId)
      ? store.settings.defaultProviderId
      : enabledProviders.value[0]?.id || null

  await refreshSessions()
  let remembered = ''
  try {
    remembered = localStorage.getItem(STORAGE_KEY) || ''
  } catch {
    remembered = ''
  }
  const prefer =
    (remembered && sessions.value.some((s) => s.id === remembered) && remembered) ||
    sessions.value[0]?.id ||
    ''
  if (prefer) {
    sessionId.value = prefer
    rememberSession(prefer)
    await loadHistory(prefer)
  } else if (store.servers.length) {
    await createSession()
  }
})

onUnmounted(() => {
  unsubscribe?.()
  if (busy.value && sessionId.value) void window.api.agent.cancel(sessionId.value)
})
</script>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 12px;
  min-height: 0;
  overflow: hidden;
}

.chat-toolbar {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.toolbar-left {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.toolbar-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.server-tag {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.provider-hint {
  flex-shrink: 0;
}

.messages {
  flex: 1 1 0;
  overflow: auto;
  background: #121a26;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px;
  min-height: 120px;
}

.messages--compact {
  flex: 0 1 28%;
  max-height: 32%;
  min-height: 72px;
}

.empty {
  color: var(--text-muted);
  font-size: 13px;
  padding: 24px 8px;
}

.turn {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 18px;
}

.msg {
  display: flex;
  flex-direction: column;
  max-width: min(780px, 88%);
}

.msg.user {
  align-self: flex-end;
  align-items: flex-end;
}

.msg.assistant {
  align-self: flex-start;
  align-items: flex-start;
}

.msg .role {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 4px;
}

.body {
  margin: 0;
  word-break: break-word;
  line-height: 1.55;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg-soft);
}

.body.plain {
  white-space: pre-wrap;
  font-family: inherit;
}

.body.muted {
  color: var(--text-muted);
  font-size: 13px;
}

.msg.user .body {
  background: rgba(232, 160, 48, 0.22);
}

.process {
  margin-bottom: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.15);
}

.process summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--text-muted);
  padding: 6px 10px;
}

.process-body {
  padding: 0 10px 10px;
}

.process-section {
  border-top: 1px solid var(--border);
  padding-top: 8px;
}

.process-label,
.tool-part-label {
  font-size: 11px;
  color: var(--text-muted);
  margin-bottom: 4px;
}

.reasoning-body {
  margin: 0;
  max-height: 200px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.5;
  color: #9aa8bc;
  font-family: 'IBM Plex Mono', 'SF Mono', Menlo, Consolas, monospace;
}

.note-body {
  font-size: 13px;
  color: #b8c5d9;
  line-height: 1.5;
}

.tool-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #0b1220;
  overflow: hidden;
  margin-top: 8px;
}

.tool-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}

.tool-name {
  font-size: 12px;
  color: var(--text-muted);
}

.tool-part {
  padding: 6px 10px 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}

.tool-body {
  margin: 0;
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.45;
  color: #b8c5d9;
}

.confirm-bar {
  flex-shrink: 0;
  border-radius: var(--radius);
  padding: 12px;
  max-height: min(280px, 36vh);
  overflow: auto;
  border: 1px solid var(--warning);
  background: rgba(240, 180, 41, 0.08);
}

.draft-bar {
  /* 吃满剩余高度；头/底固定，中间 draft-scroll 可滚到健康检查末尾 */
  flex: 1 1 0;
  min-height: 0;
  /* 高度链断裂时的兜底，保证中间区域一定出现滚动条 */
  max-height: calc(100vh - 220px);
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-radius: var(--radius);
  padding: 12px;
  overflow: hidden;
  border: 1px solid var(--accent);
  background: rgba(61, 156, 240, 0.08);
}

.draft-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding-right: 6px;
  padding-bottom: 24px;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.draft-footer {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(61, 156, 240, 0.25);
  background: rgba(61, 156, 240, 0.06);
  margin: 0 -4px -4px;
  padding-left: 4px;
  padding-right: 4px;
  padding-bottom: 4px;
}

.confirm-head,
.draft-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  flex-shrink: 0;
}

.draft-head-text {
  min-width: 0;
  width: 100%;
}

.confirm-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.confirm-tool {
  font-size: 12px;
  color: var(--text-muted);
}

.confirm-actions,
.draft-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  flex-shrink: 0;
}

.confirm-actions {
  margin-top: 10px;
}

.confirm-args,
.step-cmd {
  margin: 0;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
  overflow-y: visible;
  max-height: none;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.25);
  color: #b8c5d9;
}

.reason,
.meta {
  font-size: 12px;
  color: var(--text-muted);
}

.draft-update-id {
  margin-top: 6px;
  font-size: 11px;
}

.draft-name-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}

.draft-name-input {
  flex: 1;
  max-width: 420px;
}

.draft-name-input :deep(.el-input__wrapper) {
  font-weight: 600;
}

.draft-section {
  margin-bottom: 12px;
}

.draft-section:last-child {
  margin-bottom: 8px;
}

.section-label {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}

.step-row {
  margin-bottom: 8px;
}

.step-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  margin-bottom: 4px;
}

.feedback-input {
  margin-top: 4px;
}

.composer {
  position: relative;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  align-items: end;
  flex-shrink: 0;
  border-radius: var(--radius);
  transition: box-shadow 0.15s ease, background 0.15s ease;
}

.composer.is-dragover {
  box-shadow: inset 0 0 0 2px var(--accent);
  background: rgba(61, 156, 240, 0.08);
}

.drop-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  font-size: 13px;
  color: var(--accent);
  background: rgba(15, 20, 25, 0.72);
  border-radius: var(--radius);
  z-index: 2;
}

.mono {
  font-family: 'IBM Plex Mono', 'SF Mono', Menlo, Consolas, monospace;
}

.md-body :deep(p) {
  margin: 0 0 0.6em;
}
.md-body :deep(p:last-child) {
  margin-bottom: 0;
}
.md-body :deep(pre) {
  margin: 0.6em 0;
  padding: 10px 12px;
  overflow: auto;
  background: #0b1220;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.md-body :deep(code) {
  font-family: 'IBM Plex Mono', 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.9em;
  background: rgba(0, 0, 0, 0.35);
  padding: 0.1em 0.35em;
  border-radius: 4px;
}
</style>
