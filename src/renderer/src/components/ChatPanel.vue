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
      </div>
      <div class="toolbar-actions">
        <el-button size="small" :disabled="busy" @click="createSession">新建会话</el-button>
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

    <div ref="scrollRef" class="messages" v-loading="historyLoading">
      <div v-if="!historyLoading && displayTurns.length === 0" class="empty">
        试试：「查看这台服务器磁盘和内存使用情况」或「帮我安装 nginx」
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

    <div
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
        placeholder="用自然语言描述运维需求…（可拖入文件，自动填入本机路径）"
        :disabled="busy || enabledProviders.length === 0 || !sessionId"
        @keydown.enter.exact="onEnter"
      />
      <el-button type="primary" :loading="busy" :disabled="!canSend" @click="send">发送</el-button>
      <div v-if="dragOver" class="drop-hint">松开以填入文件路径</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown } from '@element-plus/icons-vue'
import type { AgentStreamEvent, ChatMessage, ChatSession, ToolConfirmRequest } from '../../../shared/types'
import { useAppStore } from '../stores/app'
import { appendPathsToInput, getDroppedFilePaths } from '../utils/drop-files'
import { renderMarkdown } from '../utils/markdown'

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
  processOpen: boolean
  live?: boolean
}

const props = defineProps<{ serverId: string }>()
const store = useAppStore()

const sessions = ref<ChatSession[]>([])
const sessionId = ref<string | null>(null)
const messages = ref<ChatMessage[]>([])
const input = ref('')
const busy = ref(false)
const dragOver = ref(false)
let dragDepth = 0
const historyLoading = ref(false)
const providerId = ref<string | null>(null)
const pendingConfirm = ref<ToolConfirmRequest | null>(null)
const scrollRef = ref<HTMLElement | null>(null)
const activeQueryId = ref<string | null>(null)
const liveTurn = ref<QueryTurn | null>(null)

let unsubscribe: (() => void) | null = null
let loadSeq = 0

const enabledProviders = computed(() => store.providers.filter((p) => p.enabled))
const canSend = computed(() =>
  Boolean(
    input.value.trim() &&
      providerId.value &&
      sessionId.value &&
      !busy.value &&
      enabledProviders.value.length > 0
  )
)

const historyTurns = computed(() => buildTurns(messages.value, false))

const displayTurns = computed((): QueryTurn[] => {
  const turns = [...historyTurns.value]
  const live = liveTurn.value
  if (!live) return turns
  const idx = turns.findIndex((t) => t.queryId === live.queryId)
  if (idx >= 0) {
    // 用实时过程覆盖同 query 的助手块，保留用户气泡
    const merged: QueryTurn = {
      ...live,
      user: turns[idx].user || live.user,
      processOpen: true,
      live: true
    }
    return [...turns.slice(0, idx), merged, ...turns.slice(idx + 1)]
  }
  return [...turns, { ...live, processOpen: true, live: true }]
})

function sessionLabel(s: ChatSession): string {
  const time = new Date(s.updatedAt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
  return `${s.title} · ${time}`
}

function riskTag(level: string): 'info' | 'warning' | 'danger' {
  if (level === 'high') return 'danger'
  if (level === 'medium') return 'warning'
  return 'info'
}

/** 确认框展示用：超长字符串折叠，避免撑破布局 */
function formatConfirmArgs(args: Record<string, unknown>): string {
  const preview = (value: unknown, limit = 240): unknown => {
    if (typeof value === 'string') {
      if (value.length <= limit) return value
      return `${value.slice(0, limit)}… (+${value.length - limit} chars)`
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = preview(v, k === 'html' || k === 'collectScript' ? 160 : limit)
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
    return content
  }
}

function buildTurns(msgs: ChatMessage[], processOpen: boolean): QueryTurn[] {
  let legacySeq = 0
  let legacyCurrent: string | null = null
  const tagged = msgs.map((m) => {
    if (m.queryId) {
      legacyCurrent = m.queryId
      return m
    }
    if (m.role === 'user') {
      legacyCurrent = `legacy-${++legacySeq}`
      return { ...m, queryId: legacyCurrent }
    }
    if (!legacyCurrent) legacyCurrent = `legacy-${++legacySeq}`
    return { ...m, queryId: legacyCurrent }
  })

  const order: string[] = []
  const groups = new Map<string, ChatMessage[]>()
  for (const m of tagged) {
    const qid = m.queryId!
    if (!groups.has(qid)) {
      order.push(qid)
      groups.set(qid, [])
    }
    groups.get(qid)!.push(m)
  }

  return order.map((qid) => messagesToTurn(qid, groups.get(qid)!, processOpen))
}

function messagesToTurn(queryId: string, msgs: ChatMessage[], processOpen: boolean): QueryTurn {
  const user = msgs.find((m) => m.role === 'user')
  const assistants = msgs.filter((m) => m.role === 'assistant')
  const toolMsgs = msgs.filter((m) => m.role === 'tool')

  const tools: ToolStep[] = []
  const toolMap = new Map<string, ToolStep>()
  for (const t of toolMsgs) {
    const id = t.toolCallId || t.id
    let step = toolMap.get(id)
    if (!step) {
      step = {
        toolCallId: id,
        toolName: t.toolName || 'tool',
        args: '',
        result: '',
        running: false
      }
      toolMap.set(id, step)
      tools.push(step)
    }
    if (t.toolPhase === 'start') step.args = t.content
    else if (t.toolPhase === 'result') step.result = t.content
    else if (!step.args) step.args = t.content
    else step.result = t.content
  }

  const reasonings = assistants.map((a) => a.reasoning).filter((r): r is string => Boolean(r?.trim()))
  const contents = assistants.map((a) => a.content).filter((c) => c.trim())
  const finalContent = contents.length ? contents[contents.length - 1] : ''
  const notes = contents.slice(0, -1)

  return {
    queryId,
    user,
    reasonings,
    notes,
    tools,
    finalContent,
    processOpen
  }
}

function hasProcess(turn: QueryTurn): boolean {
  return turn.reasonings.length > 0 || turn.notes.length > 0 || turn.tools.length > 0
}

function hasAssistantBlock(turn: QueryTurn): boolean {
  return hasProcess(turn) || Boolean(turn.finalContent) || Boolean(turn.live)
}

function processSummary(turn: QueryTurn): string {
  const parts: string[] = []
  if (turn.reasonings.length) parts.push(`思考 ${turn.reasonings.length}`)
  if (turn.tools.length) parts.push(`工具 ${turn.tools.length}`)
  if (turn.notes.length) parts.push(`说明 ${turn.notes.length}`)
  return parts.length ? `中间过程 · ${parts.join(' · ')}` : '中间过程'
}

function emptyLiveTurn(queryId: string, user?: ChatMessage): QueryTurn {
  return {
    queryId,
    user,
    reasonings: [],
    notes: [],
    tools: [],
    finalContent: '',
    processOpen: true,
    live: true
  }
}

function ensureLiveTurn(queryId?: string): QueryTurn | null {
  const qid = queryId || activeQueryId.value
  if (!qid) return null
  if (!liveTurn.value || liveTurn.value.queryId !== qid) {
    const user = messages.value.find((m) => m.queryId === qid && m.role === 'user')
    liveTurn.value = emptyLiveTurn(qid, user)
  }
  return liveTurn.value
}

async function scrollBottom(): Promise<void> {
  await nextTick()
  if (scrollRef.value) scrollRef.value.scrollTop = scrollRef.value.scrollHeight
}

async function refreshSessions(preferId?: string | null): Promise<void> {
  if (!window.api?.sessions) {
    ElMessage.error('会话 API 不可用，请完全重启应用后重试')
    return
  }
  const list = await window.api.sessions.list(props.serverId)
  sessions.value = list
  const want = preferId || sessionId.value
  if (want && list.some((s) => s.id === want)) {
    sessionId.value = want
    return
  }
  const active = await window.api.sessions.ensure(props.serverId)
  sessions.value = await window.api.sessions.list(props.serverId)
  sessionId.value = active.id
}

async function loadHistory(): Promise<void> {
  const seq = ++loadSeq
  const sid = sessionId.value
  if (!sid) {
    messages.value = []
    historyLoading.value = false
    return
  }
  historyLoading.value = true
  try {
    const history = await window.api.chat.history(sid)
    if (seq !== loadSeq || sid !== sessionId.value) return
    messages.value = history
    await scrollBottom()
  } finally {
    if (seq === loadSeq) historyLoading.value = false
  }
}

function resetLiveState(): void {
  activeQueryId.value = null
  liveTurn.value = null
  pendingConfirm.value = null
}

function bindStream(): void {
  unsubscribe?.()
  const boundSessionId = sessionId.value
  if (!boundSessionId) return
  unsubscribe = window.api.agent.onStream(boundSessionId, async (event: AgentStreamEvent) => {
    if (boundSessionId !== sessionId.value) return
    const qid = event.queryId || activeQueryId.value
    if (qid) activeQueryId.value = qid

    if (event.type === 'reasoning') {
      const turn = ensureLiveTurn(qid || undefined)
      if (turn && event.content?.trim()) {
        turn.reasonings = [...turn.reasonings, event.content]
        await scrollBottom()
      }
    } else if (event.type === 'text') {
      const turn = ensureLiveTurn(qid || undefined)
      if (!turn) return
      // 有工具时，先前文本视为中间说明；最终答案在 done 前保持可更新
      if (turn.tools.length > 0 && turn.finalContent.trim()) {
        turn.notes = [...turn.notes, turn.finalContent]
      }
      turn.finalContent = event.content || ''
      await scrollBottom()
    } else if (event.type === 'tool_stdout') {
      const turn = ensureLiveTurn(qid || undefined)
      if (!turn) return
      const tool =
        turn.tools.find((t) => t.toolCallId === event.toolCallId) ||
        [...turn.tools].reverse().find((t) => t.toolName === event.toolName && t.running)
      if (tool) tool.result += event.content || ''
      await scrollBottom()
    } else if (event.type === 'tool_start') {
      const turn = ensureLiveTurn(qid || undefined)
      if (!turn) return
      if (turn.finalContent.trim()) {
        turn.notes = [...turn.notes, turn.finalContent]
        turn.finalContent = ''
      }
      turn.tools.push({
        toolCallId: event.toolCallId || `t-${Date.now()}`,
        toolName: event.toolName || 'tool',
        args: event.content || '',
        result: '',
        running: true
      })
      await scrollBottom()
    } else if (event.type === 'tool_result') {
      const turn = ensureLiveTurn(qid || undefined)
      if (!turn) return
      const tool =
        turn.tools.find((t) => t.toolCallId === event.toolCallId) ||
        [...turn.tools].reverse().find((t) => t.toolName === event.toolName && t.running)
      if (tool) {
        tool.result = (event.content || '').slice(0, 8000)
        tool.running = false
      }
      await scrollBottom()
    } else if (event.type === 'confirm' && event.confirm) {
      pendingConfirm.value = event.confirm
    } else if (event.type === 'error') {
      busy.value = false
      resetLiveState()
      if (event.error && event.error !== '对话已取消') {
        ElMessage.error(event.error)
      } else if (event.error === '对话已取消') {
        ElMessage.info('对话已取消')
      }
      await loadHistory()
      await refreshSessions(sessionId.value)
    } else if (event.type === 'done') {
      busy.value = false
      resetLiveState()
      await loadHistory()
      await refreshSessions(sessionId.value)
    }
  })
}

function onEnter(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
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
  if (busy.value) return
  const paths = getDroppedFilePaths(e)
  if (!paths.length) {
    ElMessage.warning('无法读取拖入文件的本机路径')
    return
  }
  input.value = appendPathsToInput(input.value, paths)
}

function newQueryId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `q-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

async function send(): Promise<void> {
  if (!canSend.value || !providerId.value || !sessionId.value) return
  const text = input.value.trim()
  input.value = ''
  const queryId = newQueryId()
  busy.value = true
  activeQueryId.value = queryId
  pendingConfirm.value = null

  const userMsg: ChatMessage = {
    id: `local-u-${Date.now()}`,
    role: 'user',
    content: text,
    queryId,
    createdAt: Date.now()
  }
  messages.value.push(userMsg)
  liveTurn.value = emptyLiveTurn(queryId, userMsg)
  await scrollBottom()

  try {
    await window.api.agent.chat({
      serverId: props.serverId,
      sessionId: sessionId.value,
      providerId: providerId.value,
      message: text,
      queryId
    })
  } catch (err) {
    busy.value = false
    resetLiveState()
    ElMessage.error(err instanceof Error ? err.message : String(err))
    await loadHistory()
  }
}

async function cancelRun(): Promise<void> {
  if (sessionId.value) await window.api.agent.cancel(sessionId.value)
  else await window.api.agent.cancel(props.serverId)
  busy.value = false
  resetLiveState()
}

async function respondConfirm(approved: boolean): Promise<void> {
  if (!pendingConfirm.value) return
  const id = pendingConfirm.value.requestId
  pendingConfirm.value = null
  await window.api.agent.confirm(id, approved)
}

async function onSelectSession(id: string): Promise<void> {
  if (!id || id === sessionId.value) return
  if (busy.value) {
    ElMessage.warning('请先取消进行中的对话')
    return
  }
  await window.api.sessions.setActive(props.serverId, id)
  sessionId.value = id
  resetLiveState()
  bindStream()
  await loadHistory()
}

async function createSession(): Promise<void> {
  if (busy.value) {
    ElMessage.warning('请先取消进行中的对话')
    return
  }
  const created = await window.api.sessions.create(props.serverId)
  sessions.value = await window.api.sessions.list(props.serverId)
  sessionId.value = created.id
  messages.value = []
  resetLiveState()
  bindStream()
}

async function clearHistory(): Promise<void> {
  if (!sessionId.value) return
  if (busy.value) {
    ElMessage.warning('请先取消进行中的对话')
    return
  }
  await ElMessageBox.confirm('确认清空当前会话的全部消息？', '清空确认', { type: 'warning' })
  await window.api.chat.clear(sessionId.value)
  messages.value = []
  resetLiveState()
  await refreshSessions(sessionId.value)
}

async function renameSession(): Promise<void> {
  if (!sessionId.value) return
  const current = sessions.value.find((s) => s.id === sessionId.value)
  const { value } = await ElMessageBox.prompt('输入会话标题', '重命名会话', {
    inputValue: current?.title || '',
    confirmButtonText: '保存',
    cancelButtonText: '取消'
  })
  const title = value?.trim()
  if (!title) return
  await window.api.sessions.rename(sessionId.value, title)
  await refreshSessions(sessionId.value)
}

async function deleteSession(): Promise<void> {
  if (!sessionId.value) return
  if (busy.value) {
    ElMessage.warning('请先取消进行中的对话')
    return
  }
  await ElMessageBox.confirm('确认删除该会话？消息文件也会一并删除。', '删除确认', {
    type: 'warning'
  })
  const deleting = sessionId.value
  await window.api.sessions.delete(deleting)
  sessionId.value = null
  messages.value = []
  resetLiveState()
  await refreshSessions()
  bindStream()
  await loadHistory()
}

watch(
  () => store.settings.defaultProviderId,
  (id) => {
    if (!providerId.value && id) providerId.value = id
  },
  { immediate: true }
)

watch(
  enabledProviders,
  (list) => {
    if (!providerId.value && list[0]) providerId.value = list[0].id
  },
  { immediate: true }
)

watch(
  () => props.serverId,
  async (_id, prev) => {
    if (prev) await window.api.agent.cancel(prev)
    busy.value = false
    resetLiveState()
    sessionId.value = null
    messages.value = []
    await refreshSessions()
    bindStream()
    await loadHistory()
  }
)

onMounted(async () => {
  await store.refreshProviders()
  await refreshSessions()
  await loadHistory()
  bindStream()
})

onUnmounted(() => {
  unsubscribe?.()
  if (sessionId.value) void window.api.agent.cancel(sessionId.value)
  else void window.api.agent.cancel(props.serverId)
})
</script>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 12px;
}

.chat-toolbar {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
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

.provider-hint {
  flex-shrink: 0;
}

.messages {
  flex: 1;
  overflow: auto;
  background: #121a26;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px;
  min-height: 320px;
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
  color: #f3e6c8;
  border: 1px solid rgba(232, 160, 48, 0.35);
  border-bottom-right-radius: 4px;
}

.msg.assistant .body,
.msg.assistant .assistant-block {
  border-bottom-left-radius: 4px;
}

.assistant-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.process {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #0f1724;
  overflow: hidden;
}

.process summary {
  cursor: pointer;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-muted);
  user-select: none;
  list-style: none;
}

.process summary::-webkit-details-marker {
  display: none;
}

.process summary::before {
  content: '▸ ';
  color: var(--accent);
}

.process[open] summary::before {
  content: '▾ ';
}

.process-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
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

.md-body :deep(p) { margin: 0 0 0.6em; }
.md-body :deep(p:last-child) { margin-bottom: 0; }
.md-body :deep(h1),
.md-body :deep(h2),
.md-body :deep(h3),
.md-body :deep(h4) {
  margin: 0.8em 0 0.4em;
  line-height: 1.3;
  color: var(--text);
}
.md-body :deep(h1) { font-size: 1.25em; }
.md-body :deep(h2) { font-size: 1.15em; }
.md-body :deep(h3) { font-size: 1.05em; }
.md-body :deep(ul),
.md-body :deep(ol) {
  margin: 0.4em 0 0.6em;
  padding-left: 1.4em;
}
.md-body :deep(li) { margin: 0.2em 0; }
.md-body :deep(code) {
  font-family: 'IBM Plex Mono', 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.9em;
  background: rgba(0, 0, 0, 0.35);
  padding: 0.1em 0.35em;
  border-radius: 4px;
}
.md-body :deep(pre) {
  margin: 0.6em 0;
  padding: 10px 12px;
  overflow: auto;
  background: #0b1220;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.md-body :deep(pre code) {
  background: transparent;
  padding: 0;
  font-size: 12px;
  line-height: 1.45;
}
.md-body :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0.6em 0;
  font-size: 13px;
}
.md-body :deep(th),
.md-body :deep(td) {
  border: 1px solid var(--border);
  padding: 6px 8px;
  text-align: left;
}
.md-body :deep(th) {
  background: #152032;
  color: var(--text-muted);
}
.md-body :deep(blockquote) {
  margin: 0.6em 0;
  padding: 0.2em 0.8em;
  border-left: 3px solid var(--accent);
  color: var(--text-muted);
}
.md-body :deep(a) { color: var(--accent); }

.tool-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #0b1220;
  overflow: hidden;
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
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--warning);
  border-radius: var(--radius);
  background: rgba(240, 180, 41, 0.08);
  max-height: min(280px, 36vh);
  min-height: 0;
  flex-shrink: 0;
}

.confirm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
}

.confirm-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}

.confirm-tool {
  font-size: 12px;
  color: var(--text-muted);
}

.confirm-args {
  margin: 0;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  min-height: 0;
  flex: 1;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.25);
  color: #b8c5d9;
}

.reason {
  font-size: 12px;
  color: var(--warning);
  flex-shrink: 0;
}

.confirm-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.composer {
  position: relative;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  align-items: end;
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
</style>
