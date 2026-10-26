<template>
  <div class="page template-page">
    <div class="page-header compact-header">
      <div class="header-left">
        <el-button link @click="goBack">
          <el-icon><ArrowLeft /></el-icon>
          返回
        </el-button>
        <span class="divider" />
        <h2>{{ project?.name || '部署模板' }}</h2>
        <span v-if="recipe" class="meta mono">v{{ recipe.version }} · {{ recipe.kind }}</span>
      </div>
      <div v-if="projectId" class="header-actions">
        <el-button size="small" :disabled="busy || !recipe" @click="openEditor">编辑模板</el-button>
        <el-button size="small" type="danger" plain :disabled="busy" @click="removeProject">
          删除模板
        </el-button>
      </div>
    </div>

    <div v-if="!loaded" class="panel" v-loading="true" />
    <el-empty v-else-if="!project || !recipe" description="模板不存在或尚未定版" />

    <div v-else class="layout">
      <div class="main">
        <div class="card">
          <div class="card-title">部署参数</div>
          <el-form label-position="top" class="params-form" @submit.prevent>
            <el-form-item label="目标服务器" required>
              <el-select v-model="targetServerId" filterable style="width: 100%" :disabled="busy">
                <el-option
                  v-for="s in store.servers"
                  :key="s.id"
                  :label="`${s.name} · ${s.host}`"
                  :value="s.id"
                />
              </el-select>
            </el-form-item>
            <el-form-item
              v-for="def in recipe.params"
              :key="def.key"
              :label="def.label || def.key"
              :required="def.required"
            >
              <div v-if="def.type === 'file'" class="file-row">
                <el-input
                  :model-value="String(runParams[def.key] ?? '')"
                  size="small"
                  class="mono"
                  :disabled="busy"
                  placeholder="本机文件路径"
                  @update:model-value="(v) => (runParams[def.key] = v)"
                />
                <el-button size="small" :disabled="busy" @click="pickLocalFile(def.key)">选择</el-button>
              </div>
              <el-switch
                v-else-if="def.type === 'boolean'"
                :model-value="Boolean(runParams[def.key])"
                :disabled="busy"
                @update:model-value="(v) => (runParams[def.key] = v)"
              />
              <el-input
                v-else
                :model-value="String(runParams[def.key] ?? '')"
                size="small"
                class="mono"
                :disabled="busy"
                :placeholder="def.description || def.key"
                @update:model-value="(v) => (runParams[def.key] = v)"
              />
            </el-form-item>
          </el-form>
          <div class="actions">
            <el-button type="primary" :loading="busy" @click="startRun">部署</el-button>
            <el-button v-if="busy && activeRunId" type="warning" @click="cancelRun">取消</el-button>
            <el-button
              v-if="project.lastSuccessParams"
              text
              size="small"
              :disabled="busy"
              @click="fillLast"
            >
              填入上次成功参数
            </el-button>
          </div>
        </div>

        <div v-if="pendingConfirm" class="confirm-bar">
          <div class="confirm-head">
            <strong>确认步骤</strong>
            <div>
              <el-button size="small" @click="respondConfirm(false)">拒绝</el-button>
              <el-button size="small" type="primary" @click="respondConfirm(true)">批准</el-button>
            </div>
          </div>
          <pre class="mono">{{ JSON.stringify(pendingConfirm.arguments, null, 2) }}</pre>
        </div>

        <div class="card">
          <div class="card-title row">
            <span>执行日志</span>
            <el-tag v-if="lastRun" size="small" :type="statusType(lastRun.status)">
              {{ lastRun.status }}
            </el-tag>
          </div>
          <pre ref="logRef" class="log mono">{{ logText || '等待部署…' }}</pre>
        </div>
      </div>

      <aside class="side">
        <div class="card">
          <div class="card-title row">
            <span>执行历史</span>
            <el-button size="small" text @click="loadRuns">刷新</el-button>
          </div>
          <el-table :data="runs" size="small" empty-text="暂无记录" @row-click="onRunClick">
            <el-table-column label="时间" width="150">
              <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag size="small" :type="statusType(row.status)">{{ row.status }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="recipe.notes" class="notes">{{ recipe.notes }}</div>
          <details class="steps-preview">
            <summary>查看固定步骤</summary>
            <div v-for="(s, i) in recipe.steps" :key="s.id" class="step">
              <div>#{{ i + 1 }} {{ s.name }}</div>
              <pre class="mono">{{ s.command }}</pre>
            </div>
          </details>
        </div>
      </aside>
    </div>

    <DeployTemplateEditor
      v-model="editorVisible"
      :project-id="projectId"
      @saved="onEditorSaved"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type {
  DeployProject,
  DeployRun,
  DeployStreamEvent,
  DeploymentRecipe,
  ToolConfirmRequest
} from '../../../shared/types'
import { useAppStore } from '../stores/app'
import DeployTemplateEditor from '../components/DeployTemplateEditor.vue'

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const projectId = computed(() => String(route.params.projectId || ''))

const loaded = ref(false)
const project = ref<DeployProject | null>(null)
const recipe = ref<DeploymentRecipe | null>(null)
const targetServerId = ref('')
const runParams = reactive<Record<string, string | number | boolean>>({})
const busy = ref(false)
const editorVisible = ref(false)
const activeRunId = ref<string | null>(null)
const lastRun = ref<DeployRun | null>(null)
const pendingConfirm = ref<ToolConfirmRequest | null>(null)
const logText = ref('')
const logRef = ref<HTMLElement | null>(null)
const runs = ref<DeployRun[]>([])

let unsubscribe: (() => void) | null = null

function statusType(s: string): 'success' | 'warning' | 'danger' | 'info' {
  if (s === 'succeeded') return 'success'
  if (s === 'failed' || s === 'cancelled') return 'danger'
  if (s === 'rolled_back' || s === 'running' || s === 'awaiting_confirm') return 'warning'
  return 'info'
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

function appendLog(line: string): void {
  logText.value = logText.value ? `${logText.value}\n${line}` : line
  void nextTick(() => {
    if (logRef.value) logRef.value.scrollTop = logRef.value.scrollHeight
  })
}

function syncParams(): void {
  Object.keys(runParams).forEach((k) => delete runParams[k])
  const r = recipe.value
  if (!r) return
  const last = project.value?.lastSuccessParams
  for (const def of r.params) {
    if (last?.[def.key] !== undefined) runParams[def.key] = last[def.key]
    else if (def.defaultValue !== undefined) runParams[def.key] = def.defaultValue
    else runParams[def.key] = def.type === 'boolean' ? false : ''
  }
}

function fillLast(): void {
  const last = project.value?.lastSuccessParams
  if (!last) return
  Object.assign(runParams, last)
}

async function pickLocalFile(key: string): Promise<void> {
  const path = await window.api.files.pickLocal()
  if (path) runParams[key] = path
}

function goBack(): void {
  void router.push({ path: '/deploys', query: { tab: 'templates' } })
}

function openEditor(): void {
  editorVisible.value = true
}

async function onEditorSaved(next: DeploymentRecipe): Promise<void> {
  recipe.value = next
  project.value = await window.api.deploy.getProject(projectId.value)
  if (!targetServerId.value) targetServerId.value = next.serverId
  syncParams()
}

async function load(): Promise<void> {
  project.value = await window.api.deploy.getProject(projectId.value)
  recipe.value = await window.api.deploy.getRecipe(projectId.value)
  targetServerId.value = recipe.value?.serverId || project.value?.serverIds[0] || store.servers[0]?.id || ''
  syncParams()
  await loadRuns()
}

async function loadRuns(): Promise<void> {
  runs.value = await window.api.deploy.listRuns(projectId.value, 30)
}

async function startRun(): Promise<void> {
  if (!recipe.value || recipe.value.status !== 'active') {
    ElMessage.warning('模板未定版')
    return
  }
  if (!targetServerId.value) {
    ElMessage.warning('请选择服务器')
    return
  }
  const runId = crypto.randomUUID()
  activeRunId.value = runId
  busy.value = true
  logText.value = ''
  pendingConfirm.value = null
  lastRun.value = null
  appendLog(`[start] ${runId}`)
  unsubscribe?.()
  unsubscribe = window.api.deploy.onStream(runId, onStream)

  try {
    const params: Record<string, string | number | boolean> = {}
    for (const def of recipe.value.params) {
      let v = runParams[def.key]
      if (def.type === 'number' && v !== '' && v !== undefined) v = Number(v)
      if (def.type === 'boolean') v = Boolean(v)
      params[def.key] = v as string | number | boolean
    }
    const run = await window.api.deploy.run({
      runId,
      projectId: projectId.value,
      serverId: targetServerId.value,
      params
    })
    lastRun.value = run
    project.value = await window.api.deploy.getProject(projectId.value)
    await loadRuns()
    if (run.status === 'succeeded') ElMessage.success('部署成功')
    else if (run.status !== 'cancelled') ElMessage.error(run.error || run.status)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    busy.value = false
    activeRunId.value = null
    pendingConfirm.value = null
    unsubscribe?.()
    unsubscribe = null
  }
}

function onStream(ev: DeployStreamEvent): void {
  if (ev.run) lastRun.value = ev.run
  if (ev.type === 'confirm' && ev.confirm) {
    pendingConfirm.value = ev.confirm
    return
  }
  if (ev.type === 'step_start') appendLog(`\n▶ ${ev.content || ev.stepId}`)
  else if (ev.type === 'step_stdout') appendLog(ev.content || '')
  else if (ev.type === 'assert' || ev.type === 'health') appendLog(`[${ev.type}] ${ev.content || ''}`)
  else if (ev.type === 'error') appendLog(`[error] ${ev.error || ''}`)
  else if (ev.type === 'done') appendLog(`[done] ${ev.run?.status || ''}`)
}

async function respondConfirm(approved: boolean): Promise<void> {
  const req = pendingConfirm.value
  if (!req) return
  pendingConfirm.value = null
  await window.api.deploy.confirm(req.requestId, approved)
}

async function cancelRun(): Promise<void> {
  if (activeRunId.value) await window.api.deploy.cancel(activeRunId.value)
}

function onRunClick(row: DeployRun): void {
  Object.assign(runParams, row.params || {})
  ElMessage.success('已填入该次参数')
}

async function removeProject(): Promise<void> {
  await ElMessageBox.confirm('确认删除该模板及历史？', '删除确认', { type: 'warning' })
  await window.api.deploy.deleteProject(projectId.value)
  ElMessage.success('已删除')
  goBack()
}

onMounted(async () => {
  await store.refreshAll()
  try {
    await load()
  } finally {
    loaded.value = true
  }
})

onUnmounted(() => {
  unsubscribe?.()
  if (activeRunId.value) void window.api.deploy.cancel(activeRunId.value)
})
</script>

<style scoped>
.template-page {
  height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.compact-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.header-left h2 {
  margin: 0;
  font-size: 16px;
}

.divider {
  width: 1px;
  height: 14px;
  background: var(--border);
}

.meta {
  color: var(--text-muted);
  font-size: 12px;
}

.layout {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 12px;
}

.main,
.side {
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.card,
.panel {
  background: rgba(26, 35, 50, 0.55);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
}

.card-title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 10px;
}

.card-title.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.params-form :deep(.el-form-item) {
  margin-bottom: 10px;
}

.file-row {
  display: flex;
  gap: 8px;
  width: 100%;
}

.actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.log {
  margin: 0;
  min-height: 180px;
  max-height: 360px;
  overflow: auto;
  padding: 10px;
  background: rgba(0, 0, 0, 0.28);
  border-radius: 6px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.confirm-bar {
  border: 1px solid var(--warning);
  background: rgba(240, 180, 41, 0.08);
  border-radius: var(--radius);
  padding: 10px;
}

.confirm-head {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
}

.notes {
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-muted);
}

.steps-preview {
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-muted);
}

.step pre {
  margin: 4px 0 10px;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
}

.mono {
  font-family: 'IBM Plex Mono', Menlo, Consolas, monospace;
}

@media (max-width: 960px) {
  .layout {
    grid-template-columns: 1fr;
  }
}
</style>
