<template>
  <div class="deploy-panel">
    <div class="toolbar">
      <div class="toolbar-left">
        <el-select
          v-model="projectId"
          placeholder="选择项目"
          size="small"
          style="width: 200px"
          :disabled="busy || planning"
          clearable
          @change="onSelectProject"
        >
          <el-option
            v-for="p in projects"
            :key="p.id"
            :label="p.name"
            :value="p.id"
          />
        </el-select>
        <el-select
          v-model="targetServerId"
          placeholder="目标服务器"
          size="small"
          style="width: 220px"
          :disabled="busy || planning"
          filterable
        >
          <el-option
            v-for="s in store.servers"
            :key="s.id"
            :label="`${s.name} · ${s.host}`"
            :value="s.id"
          />
        </el-select>
        <span v-if="recipe" class="meta mono">
          v{{ recipe.version }} · {{ recipe.kind }} · {{ recipe.status }}
        </span>
        <el-tag v-if="busy" size="small" type="warning">发布中</el-tag>
        <el-tag v-if="unsavedDraft" size="small" type="info">未保存草稿</el-tag>
      </div>
      <div class="toolbar-actions">
        <el-button
          size="small"
          type="primary"
          plain
          :disabled="busy || planning"
          @click="openPlanDialog(false)"
        >
          AI 规划
        </el-button>
        <el-button size="small" :disabled="busy || planning" @click="openCreateProject">新建项目</el-button>
        <el-button
          v-if="projectId"
          size="small"
          type="danger"
          plain
          :disabled="busy || planning"
          @click="deleteProject"
        >
          删除
        </el-button>
      </div>
    </div>

    <div v-if="!loaded" class="empty-wrap" v-loading="true" />

    <div v-else-if="!projects.length" class="empty-wrap">
      <el-empty>
        <template #description>
          <p class="empty-title">还没有部署项目</p>
          <p class="empty-desc">创建项目并定版 Recipe 后，日常发布零 Token 执行</p>
        </template>
        <el-button type="primary" @click="openPlanDialog(false)">AI 规划创建</el-button>
        <el-button @click="openCreateProject">手动新建</el-button>
      </el-empty>
    </div>

    <div v-else-if="!projectId" class="empty-wrap">
      <el-empty description="请选择项目，或用 AI 规划生成配方">
        <el-button type="primary" @click="openPlanDialog(false)">AI 规划</el-button>
      </el-empty>
    </div>

    <template v-else>
      <el-tabs v-model="subTab" class="sub-tabs">
        <el-tab-pane label="发布" name="run">
          <div class="run-pane">
            <el-alert
              v-if="!canRun"
              type="warning"
              :closable="false"
              show-icon
              title="尚无定版配方"
              description="请用「AI 规划」生成草稿，或在「配方」中配置后点击「保存并定版」"
              class="hint-alert"
            />

            <template v-else>
              <div class="params-card">
                <div class="section-title">发布参数</div>
                <el-form label-position="top" class="params-form" @submit.prevent>
                  <el-form-item
                    v-for="def in recipe?.params || []"
                    :key="def.key"
                    :label="def.label || def.key"
                    :required="def.required"
                  >
                    <el-input
                      v-if="def.type !== 'boolean'"
                      :model-value="String(runParams[def.key] ?? '')"
                      size="small"
                      :placeholder="def.description || def.key"
                      :disabled="busy"
                      class="mono"
                      @update:model-value="(v) => (runParams[def.key] = v)"
                    />
                    <el-switch
                      v-else
                      :model-value="Boolean(runParams[def.key])"
                      :disabled="busy"
                      @update:model-value="(v) => (runParams[def.key] = v)"
                    />
                  </el-form-item>
                  <el-empty
                    v-if="!(recipe?.params.length)"
                    description="此配方无参数，可直接发布"
                    :image-size="48"
                  />
                </el-form>
                <div class="run-actions">
                  <el-button
                    type="primary"
                    :loading="busy"
                    :disabled="!recipe"
                    @click="startRun"
                  >
                    发布
                  </el-button>
                  <el-button v-if="busy && activeRunId" type="warning" @click="cancelRun">
                    取消
                  </el-button>
                  <el-button
                    v-if="project?.lastSuccessParams"
                    size="small"
                    text
                    :disabled="busy"
                    @click="fillLastSuccess"
                  >
                    填入上次成功参数
                  </el-button>
                </div>
              </div>

              <div v-if="pendingConfirm" class="confirm-bar">
                <div class="confirm-head">
                  <div class="confirm-title">
                    <el-tag size="small" :type="riskTagType(pendingConfirm.riskLevel)">
                      {{ pendingConfirm.riskLevel }}
                    </el-tag>
                    <span>需要确认部署步骤</span>
                    <span v-if="pendingConfirm.reason" class="reason">{{ pendingConfirm.reason }}</span>
                  </div>
                  <div class="confirm-actions">
                    <el-button size="small" type="danger" plain @click="respondConfirm(false)">
                      拒绝
                    </el-button>
                    <el-button size="small" type="primary" @click="respondConfirm(true)">
                      批准执行
                    </el-button>
                  </div>
                </div>
                <pre class="mono confirm-args">{{ formatConfirmArgs(pendingConfirm.arguments) }}</pre>
              </div>

              <div class="log-card">
                <div class="section-title row">
                  <span>执行日志</span>
                  <el-tag v-if="lastRun" size="small" :type="runStatusType(lastRun.status)">
                    {{ lastRun.status }}
                  </el-tag>
                </div>
                <pre ref="logRef" class="mono log-body">{{ logText || '等待发布…' }}</pre>
              </div>
            </template>
          </div>
        </el-tab-pane>

        <el-tab-pane label="配方" name="recipe" lazy>
          <div class="recipe-pane">
            <el-form label-position="top" class="recipe-form">
              <div class="form-row">
                <el-form-item label="名称" class="grow">
                  <el-input v-model="draft.name" size="small" />
                </el-form-item>
                <el-form-item label="类型">
                  <el-select v-model="draft.kind" size="small" style="width: 160px">
                    <el-option
                      v-for="k in kindOptions"
                      :key="k"
                      :label="k"
                      :value="k"
                    />
                  </el-select>
                </el-form-item>
              </div>

              <el-form-item label="说明">
                <el-input v-model="draft.notes" type="textarea" :rows="2" size="small" />
              </el-form-item>

              <div class="section-head">
                <span class="section-title">参数定义</span>
                <el-button size="small" @click="addParam">添加</el-button>
              </div>
              <el-table :data="draft.params" size="small" class="edit-table" empty-text="无参数">
                <el-table-column label="key" min-width="100">
                  <template #default="{ row }">
                    <el-input v-model="row.key" size="small" class="mono" />
                  </template>
                </el-table-column>
                <el-table-column label="标签" min-width="100">
                  <template #default="{ row }">
                    <el-input v-model="row.label" size="small" />
                  </template>
                </el-table-column>
                <el-table-column label="类型" width="110">
                  <template #default="{ row }">
                    <el-select v-model="row.type" size="small">
                      <el-option label="string" value="string" />
                      <el-option label="number" value="number" />
                      <el-option label="boolean" value="boolean" />
                      <el-option label="file" value="file" />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column label="必填" width="70" align="center">
                  <template #default="{ row }">
                    <el-checkbox v-model="row.required" />
                  </template>
                </el-table-column>
                <el-table-column label="默认值" min-width="120">
                  <template #default="{ row }">
                    <el-input
                      :model-value="String(row.defaultValue ?? '')"
                      size="small"
                      class="mono"
                      @update:model-value="(v) => (row.defaultValue = v)"
                    />
                  </template>
                </el-table-column>
                <el-table-column width="64" align="center">
                  <template #default="{ $index }">
                    <el-button link type="danger" size="small" @click="draft.params.splice($index, 1)">
                      删
                    </el-button>
                  </template>
                </el-table-column>
              </el-table>

              <div class="section-head">
                <span class="section-title">环境断言</span>
                <el-button size="small" @click="addAssertion">添加</el-button>
              </div>
              <el-table :data="draft.assertions" size="small" class="edit-table" empty-text="无断言">
                <el-table-column label="说明" min-width="120">
                  <template #default="{ row }">
                    <el-input v-model="row.description" size="small" />
                  </template>
                </el-table-column>
                <el-table-column label="检查命令" min-width="200">
                  <template #default="{ row }">
                    <el-input v-model="row.checkCommand" size="small" class="mono" />
                  </template>
                </el-table-column>
                <el-table-column label="失败时" width="130">
                  <template #default="{ row }">
                    <el-select v-model="row.onFail" size="small">
                      <el-option label="中止" value="abort" />
                      <el-option label="警告继续" value="warn" />
                      <el-option label="提示修订" value="prompt-revise" />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column width="64" align="center">
                  <template #default="{ $index }">
                    <el-button
                      link
                      type="danger"
                      size="small"
                      @click="draft.assertions.splice($index, 1)"
                    >
                      删
                    </el-button>
                  </template>
                </el-table-column>
              </el-table>

              <div class="section-head">
                <span class="section-title">部署步骤</span>
                <el-button size="small" type="primary" plain @click="addStep">添加步骤</el-button>
              </div>
              <div v-for="(step, idx) in draft.steps" :key="step.id" class="step-card">
                <div class="step-head">
                  <span class="mono">#{{ idx + 1 }}</span>
                  <el-input v-model="step.name" size="small" placeholder="步骤名" style="width: 180px" />
                  <el-select v-model="step.riskLevel" size="small" style="width: 110px">
                    <el-option label="low" value="low" />
                    <el-option label="medium" value="medium" />
                    <el-option label="high" value="high" />
                  </el-select>
                  <el-checkbox v-model="step.requireConfirm">每次确认</el-checkbox>
                  <el-button link type="danger" size="small" @click="draft.steps.splice(idx, 1)">
                    删除
                  </el-button>
                </div>
                <el-input
                  v-model="step.command"
                  type="textarea"
                  :rows="2"
                  size="small"
                  class="mono"
                  placeholder="命令模板，如 cd {{composeDir}} && docker compose up -d"
                />
                <el-input
                  v-model="step.rollbackCommand"
                  size="small"
                  class="mono rollback"
                  placeholder="回滚命令（可选）"
                />
              </div>
              <el-empty v-if="!draft.steps.length" description="至少添加一个步骤" :image-size="48" />

              <div class="section-head">
                <span class="section-title">健康检查（可选）</span>
              </div>
              <div class="form-row health-row">
                <el-input
                  v-model="healthCommand"
                  size="small"
                  class="mono grow"
                  placeholder="如 curl -fsS http://127.0.0.1:8080/health"
                />
                <el-input-number v-model="healthRetries" size="small" :min="1" :max="30" />
                <span class="meta">次 · 间隔</span>
                <el-input-number v-model="healthInterval" size="small" :min="1" :max="60" />
                <span class="meta">秒</span>
              </div>

              <div class="recipe-actions">
                <el-button type="primary" :loading="saving" @click="saveRecipe">
                  保存并定版
                </el-button>
                <el-button :disabled="busy || planning" @click="openPlanDialog(true)">
                  AI 修订配方
                </el-button>
                <span class="meta">定版后日常发布零 Token</span>
              </div>
            </el-form>
          </div>
        </el-tab-pane>

        <el-tab-pane label="历史" name="history" lazy>
          <div class="history-pane">
            <div class="section-head">
              <span class="section-title">发布记录</span>
              <el-button size="small" :loading="historyLoading" @click="loadRuns">刷新</el-button>
            </div>
            <el-table
              :data="runs"
              size="small"
              v-loading="historyLoading"
              empty-text="暂无发布记录"
              @row-click="onRunRowClick"
            >
              <el-table-column prop="createdAt" label="时间" width="160">
                <template #default="{ row }">
                  {{ formatTime(row.createdAt) }}
                </template>
              </el-table-column>
              <el-table-column label="状态" width="110">
                <template #default="{ row }">
                  <el-tag size="small" :type="runStatusType(row.status)">{{ row.status }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="配方" width="80">
                <template #default="{ row }">v{{ row.recipeVersion }}</template>
              </el-table-column>
              <el-table-column label="参数" min-width="180">
                <template #default="{ row }">
                  <span class="mono muted">{{ formatParams(row.params) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="LLM" width="70" align="center">
                <template #default="{ row }">
                  {{ row.usedLlm ? '是' : '否' }}
                </template>
              </el-table-column>
              <el-table-column width="100" align="center">
                <template #default="{ row }">
                  <el-button
                    link
                    type="primary"
                    size="small"
                    :disabled="busy || row.status !== 'succeeded'"
                    @click.stop="replayParams(row)"
                  >
                    重跑参数
                  </el-button>
                </template>
              </el-table-column>
            </el-table>

            <div v-if="selectedRun" class="run-detail">
              <div class="section-title">详情 · {{ selectedRun.id.slice(0, 8) }}</div>
              <p v-if="selectedRun.error" class="error-text">{{ selectedRun.error }}</p>
              <el-table :data="selectedRun.stepResults" size="small" empty-text="无步骤结果">
                <el-table-column prop="stepId" label="步骤" width="120" />
                <el-table-column label="状态" width="100">
                  <template #default="{ row }">
                    <el-tag size="small" :type="stepStatusType(row.status)">{{ row.status }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column prop="exitCode" label="exit" width="60" />
                <el-table-column label="输出尾" min-width="200">
                  <template #default="{ row }">
                    <pre class="mono tiny">{{ row.stdoutTail || row.stderrTail || '' }}</pre>
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </template>

    <el-dialog
      v-model="planVisible"
      :title="planAsRevise ? 'AI 修订配方' : 'AI 规划部署'"
      width="560px"
      destroy-on-close
      @closed="planning = false"
    >
      <el-form label-position="top">
        <el-form-item label="项目名称" required>
          <el-input v-model="planForm.projectName" :disabled="!!projectId && planAsRevise" />
        </el-form-item>
        <el-form-item label="目标服务器" required>
          <el-select v-model="planForm.serverId" filterable style="width: 100%">
            <el-option
              v-for="s in store.servers"
              :key="s.id"
              :label="`${s.name} · ${s.username}@${s.host}`"
              :value="s.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="模型" required>
          <el-select v-model="planForm.providerId" style="width: 100%">
            <el-option
              v-for="p in enabledProviders"
              :key="p.id"
              :label="`${p.name} · ${p.model}`"
              :value="p.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="部署意图" required>
          <el-input
            v-model="planForm.intent"
            type="textarea"
            :rows="5"
            placeholder="例如：用 docker compose 部署 my-api 到 /opt/my-api，蓝绿或滚动，健康检查 http://127.0.0.1:8080/health"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="planVisible = false">取消</el-button>
        <el-button type="primary" :loading="planning" @click="submitPlan">
          {{ planAsRevise ? '生成修订草稿' : '生成配方草稿' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAppStore } from '../stores/app'
import type {
  DeployAssertion,
  DeployKind,
  DeployParamDef,
  DeployProject,
  DeployRun,
  DeployStep,
  DeployStreamEvent,
  DeploymentRecipe,
  ToolConfirmRequest
} from '../../../shared/types'

const store = useAppStore()

const kindOptions: DeployKind[] = [
  'docker-compose',
  'systemd-jar',
  'systemd-binary',
  'k8s',
  'custom'
]

const loaded = ref(false)
const projects = ref<DeployProject[]>([])
const projectId = ref<string>('')
const targetServerId = ref<string>('')
const recipe = ref<DeploymentRecipe | null>(null)
const unsavedDraft = ref(false)
const subTab = ref('run')
const busy = ref(false)
const saving = ref(false)
const planning = ref(false)
const planVisible = ref(false)
const planAsRevise = ref(false)
const activeRunId = ref<string | null>(null)
const lastRun = ref<DeployRun | null>(null)
const pendingConfirm = ref<ToolConfirmRequest | null>(null)
const logText = ref('')
const logRef = ref<HTMLElement | null>(null)
const runs = ref<DeployRun[]>([])
const historyLoading = ref(false)
const selectedRun = ref<DeployRun | null>(null)
const runParams = reactive<Record<string, string | number | boolean>>({})

const draft = reactive({
  name: '',
  kind: 'docker-compose' as DeployKind,
  notes: '',
  params: [] as DeployParamDef[],
  assertions: [] as DeployAssertion[],
  steps: [] as DeployStep[]
})
const healthCommand = ref('')
const healthRetries = ref(5)
const healthInterval = ref(3)

const planForm = reactive({
  projectName: '',
  serverId: '',
  providerId: '',
  intent: ''
})

let unsubscribe: (() => void) | null = null

const project = computed(() => projects.value.find((p) => p.id === projectId.value) || null)
const enabledProviders = computed(() => store.providers.filter((p) => p.enabled))
const canRun = computed(
  () => !!recipe.value && recipe.value.status === 'active' && !unsavedDraft.value
)

function riskTagType(level: string): 'success' | 'warning' | 'danger' | 'info' {
  if (level === 'low') return 'success'
  if (level === 'high') return 'danger'
  return 'warning'
}

function runStatusType(status: string): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'succeeded') return 'success'
  if (status === 'failed' || status === 'cancelled') return 'danger'
  if (status === 'rolled_back') return 'warning'
  if (status === 'running' || status === 'awaiting_confirm' || status === 'asserting') return 'warning'
  return 'info'
}

function stepStatusType(status: string): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'ok') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'rolled_back') return 'warning'
  return 'info'
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

function formatParams(params: Record<string, string | number | boolean>): string {
  try {
    const s = JSON.stringify(params)
    return s.length > 80 ? `${s.slice(0, 80)}…` : s
  } catch {
    return ''
  }
}

function formatConfirmArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

function appendLog(line: string): void {
  logText.value = logText.value ? `${logText.value}\n${line}` : line
  void nextTick(() => {
    if (logRef.value) logRef.value.scrollTop = logRef.value.scrollHeight
  })
}

async function refreshProjects(): Promise<void> {
  projects.value = await window.api.deploy.listProjects()
}

function ensureDefaultServer(preferred?: string | null): void {
  if (preferred && store.servers.some((s) => s.id === preferred)) {
    targetServerId.value = preferred
    return
  }
  if (targetServerId.value && store.servers.some((s) => s.id === targetServerId.value)) return
  targetServerId.value = store.servers[0]?.id || ''
}

async function loadRecipe(): Promise<void> {
  if (!projectId.value) {
    recipe.value = null
    unsavedDraft.value = false
    resetDraft()
    return
  }
  recipe.value = await window.api.deploy.getRecipe(projectId.value)
  unsavedDraft.value = false
  ensureDefaultServer(recipe.value?.serverId || project.value?.serverIds[0])
  syncDraftFromRecipe()
  syncRunParams()
}

function applyDraftRecipe(r: DeploymentRecipe): void {
  recipe.value = { ...r, status: 'draft' }
  unsavedDraft.value = true
  ensureDefaultServer(r.serverId)
  draft.name = r.name
  draft.kind = r.kind
  draft.notes = r.notes || ''
  draft.params = r.params.map((p) => ({ ...p }))
  draft.assertions = r.assertions.map((a) => ({ ...a }))
  draft.steps = r.steps.map((s) => ({ ...s }))
  healthCommand.value = r.healthCheck?.command || ''
  healthRetries.value = r.healthCheck?.retries ?? 5
  healthInterval.value = r.healthCheck?.intervalSec ?? 3
  syncRunParams()
  subTab.value = 'recipe'
}

function resetDraft(): void {
  draft.name = ''
  draft.kind = 'docker-compose'
  draft.notes = ''
  draft.params = []
  draft.assertions = []
  draft.steps = []
  healthCommand.value = ''
  healthRetries.value = 5
  healthInterval.value = 3
}

function syncDraftFromRecipe(): void {
  const r = recipe.value
  if (!r) {
    resetDraft()
    draft.name = project.value?.name || ''
    return
  }
  draft.name = r.name
  draft.kind = r.kind
  draft.notes = r.notes || ''
  draft.params = r.params.map((p) => ({ ...p }))
  draft.assertions = r.assertions.map((a) => ({ ...a }))
  draft.steps = r.steps.map((s) => ({ ...s }))
  healthCommand.value = r.healthCheck?.command || ''
  healthRetries.value = r.healthCheck?.retries ?? 5
  healthInterval.value = r.healthCheck?.intervalSec ?? 3
}

function syncRunParams(): void {
  Object.keys(runParams).forEach((k) => delete runParams[k])
  const r = recipe.value
  if (!r) return
  const last = project.value?.lastSuccessParams
  for (const def of r.params) {
    if (last && last[def.key] !== undefined) {
      runParams[def.key] = last[def.key]
    } else if (def.defaultValue !== undefined) {
      runParams[def.key] = def.defaultValue
    } else if (def.type === 'boolean') {
      runParams[def.key] = false
    } else {
      runParams[def.key] = ''
    }
  }
}

function fillLastSuccess(): void {
  const last = project.value?.lastSuccessParams
  if (!last) return
  for (const [k, v] of Object.entries(last)) {
    runParams[k] = v
  }
  ElMessage.success('已填入上次成功参数')
}

function replayParams(row: DeployRun): void {
  for (const [k, v] of Object.entries(row.params || {})) {
    runParams[k] = v
  }
  subTab.value = 'run'
  ElMessage.success('已填入该次参数，可点发布')
}

async function onSelectProject(): Promise<void> {
  selectedRun.value = null
  logText.value = ''
  lastRun.value = null
  await loadRecipe()
  if (subTab.value === 'history') await loadRuns()
}

async function openCreateProject(): Promise<void> {
  if (!store.servers.length) {
    ElMessage.warning('请先在环境管理中添加服务器')
    return
  }
  const { value } = await ElMessageBox.prompt('项目名称', '新建部署项目', {
    confirmButtonText: '创建',
    cancelButtonText: '取消',
    inputPlaceholder: '如 my-api',
    inputPattern: /\S+/,
    inputErrorMessage: '名称不能为空'
  })
  ensureDefaultServer()
  const created = await window.api.deploy.createProject(
    String(value).trim(),
    targetServerId.value || store.servers[0].id
  )
  await refreshProjects()
  projectId.value = created.id
  await loadRecipe()
  subTab.value = 'recipe'
  ElMessage.success('项目已创建，可手动配配方或用 AI 规划')
}

function openPlanDialog(revise: boolean): void {
  if (!store.servers.length) {
    ElMessage.warning('请先在环境管理中添加服务器')
    return
  }
  if (!enabledProviders.value.length) {
    ElMessage.warning('请先在设置中配置可用模型')
    return
  }
  planAsRevise.value = revise && !!projectId.value
  planForm.projectName = planAsRevise.value
    ? project.value?.name || draft.name || ''
    : ''
  planForm.serverId = targetServerId.value || store.servers[0]?.id || ''
  planForm.providerId =
    store.settings.defaultProviderId &&
    enabledProviders.value.some((p) => p.id === store.settings.defaultProviderId)
      ? store.settings.defaultProviderId
      : enabledProviders.value[0]?.id || ''
  planForm.intent = recipe.value?.sourceIntent || ''
  if (planAsRevise.value && !planForm.intent) {
    planForm.intent = '在现有配方基础上优化：'
  }
  planVisible.value = true
}

async function submitPlan(): Promise<void> {
  if (!planForm.projectName.trim()) {
    ElMessage.warning('请填写项目名称')
    return
  }
  if (!planForm.serverId) {
    ElMessage.warning('请选择目标服务器')
    return
  }
  if (!planForm.providerId) {
    ElMessage.warning('请选择模型')
    return
  }
  if (!planForm.intent.trim()) {
    ElMessage.warning('请填写部署意图')
    return
  }

  planning.value = true
  try {
    if (!window.api?.deploy?.plan) {
      throw new Error('部署 API 未加载。请完全退出应用后重新执行 pnpm run dev（preload 变更不会热更新）')
    }
    const result = await window.api.deploy.plan({
      projectId: planAsRevise.value ? projectId.value || undefined : undefined,
      projectName: planForm.projectName.trim(),
      serverId: planForm.serverId,
      providerId: planForm.providerId,
      intent: planForm.intent.trim(),
      baseRecipeId: planAsRevise.value ? recipe.value?.id : undefined
    })
    await refreshProjects()
    projectId.value = result.draft.projectId
    targetServerId.value = planForm.serverId
    applyDraftRecipe(result.draft)
    planVisible.value = false
    ElMessage.success('已生成草稿，请审阅后「保存并定版」')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    planning.value = false
  }
}

async function deleteProject(): Promise<void> {
  if (!projectId.value) return
  const name = project.value?.name || '该项目'
  await ElMessageBox.confirm(`确认删除「${name}」及其配方与历史？`, '删除确认', {
    type: 'warning',
    confirmButtonText: '删除'
  })
  if (busy.value && activeRunId.value) {
    await window.api.deploy.cancel(activeRunId.value)
  }
  await window.api.deploy.deleteProject(projectId.value)
  projectId.value = ''
  recipe.value = null
  await refreshProjects()
  ElMessage.success('已删除')
}

function addParam(): void {
  draft.params.push({
    key: `param${draft.params.length + 1}`,
    label: '',
    type: 'string',
    required: true,
    defaultValue: ''
  })
}

function addAssertion(): void {
  draft.assertions.push({
    id: `assert-${Date.now()}`,
    description: '',
    checkCommand: '',
    onFail: 'abort'
  })
}

function addStep(): void {
  draft.steps.push({
    id: `step-${Date.now()}`,
    name: `步骤 ${draft.steps.length + 1}`,
    command: '',
    riskLevel: 'medium',
    requireConfirm: false,
    rollbackCommand: ''
  })
}

async function saveRecipe(): Promise<void> {
  if (!projectId.value) return
  if (!targetServerId.value) {
    ElMessage.warning('请选择目标服务器')
    return
  }
  if (!draft.name.trim()) {
    ElMessage.warning('请填写配方名称')
    return
  }
  if (!draft.steps.length) {
    ElMessage.warning('至少添加一个部署步骤')
    return
  }
  for (const s of draft.steps) {
    if (!s.command.trim()) {
      ElMessage.warning(`步骤「${s.name}」命令不能为空`)
      return
    }
  }

  saving.value = true
  try {
    const healthCheck = healthCommand.value.trim()
      ? {
          command: healthCommand.value.trim(),
          retries: healthRetries.value,
          intervalSec: healthInterval.value
        }
      : undefined

    recipe.value = await window.api.deploy.saveRecipe(
      {
        id: recipe.value?.id,
        projectId: projectId.value,
        name: draft.name.trim(),
        kind: draft.kind,
        serverId: targetServerId.value,
        params: draft.params
          .filter((p) => p.key.trim())
          .map((p) => ({
            ...p,
            key: p.key.trim(),
            label: (p.label || p.key).trim(),
            defaultValue:
              p.type === 'number' && p.defaultValue !== undefined && p.defaultValue !== ''
                ? Number(p.defaultValue)
                : p.defaultValue
          })),
        assertions: draft.assertions
          .filter((a) => a.checkCommand.trim())
          .map((a, i) => ({
            ...a,
            id: a.id || `assert-${i}`,
            description: a.description || a.checkCommand
          })),
        steps: draft.steps.map((s, i) => ({
          ...s,
          id: s.id || `step-${i}`,
          name: s.name.trim() || `步骤 ${i + 1}`,
          command: s.command.trim(),
          rollbackCommand: s.rollbackCommand?.trim() || undefined
        })),
        healthCheck,
        notes: draft.notes.trim() || undefined,
        sourceIntent: recipe.value?.sourceIntent
      },
      'active'
    )
    unsavedDraft.value = false
    await refreshProjects()
    syncRunParams()
    ElMessage.success(`配方已定版 v${recipe.value.version}`)
    subTab.value = 'run'
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    saving.value = false
  }
}

async function startRun(): Promise<void> {
  if (!projectId.value || !recipe.value || !canRun.value) return
  if (!targetServerId.value) {
    ElMessage.warning('请选择目标服务器')
    return
  }
  const runId = crypto.randomUUID()
  activeRunId.value = runId
  busy.value = true
  pendingConfirm.value = null
  logText.value = ''
  lastRun.value = null
  appendLog(`[start] runId=${runId}`)

  unsubscribe?.()
  unsubscribe = window.api.deploy.onStream(runId, onStreamEvent)

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
    if (run.status === 'succeeded') {
      ElMessage.success('发布成功')
      await refreshProjects()
    } else if (run.status === 'cancelled') {
      ElMessage.warning('已取消')
    } else {
      ElMessage.error(run.error || `发布结束: ${run.status}`)
    }
  } catch (err) {
    appendLog(`[error] ${err instanceof Error ? err.message : String(err)}`)
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    busy.value = false
    activeRunId.value = null
    pendingConfirm.value = null
    unsubscribe?.()
    unsubscribe = null
    if (subTab.value === 'history') await loadRuns()
  }
}

function onStreamEvent(ev: DeployStreamEvent): void {
  if (ev.run) lastRun.value = ev.run
  if (ev.type === 'confirm' && ev.confirm) {
    pendingConfirm.value = ev.confirm
    appendLog(`[confirm] ${ev.confirm.reason || ev.confirm.toolName}`)
    return
  }
  if (ev.type === 'assert') {
    appendLog(`[assert] ${ev.content || ''}`)
    return
  }
  if (ev.type === 'step_start') {
    appendLog(`\n▶ ${ev.content || ev.stepId || 'step'}`)
    return
  }
  if (ev.type === 'step_stdout') {
    appendLog(ev.content || '')
    return
  }
  if (ev.type === 'step_result') {
    appendLog(`[result] ${ev.stepId}: ${ev.content}`)
    return
  }
  if (ev.type === 'health') {
    appendLog(`[health] ${ev.content || ''}`)
    return
  }
  if (ev.type === 'error') {
    appendLog(`[error] ${ev.error || ''}`)
    return
  }
  if (ev.type === 'done') {
    appendLog(`[done] ${ev.run?.status || ''}`)
  }
}

async function respondConfirm(approved: boolean): Promise<void> {
  const req = pendingConfirm.value
  if (!req) return
  pendingConfirm.value = null
  await window.api.deploy.confirm(req.requestId, approved)
  appendLog(approved ? '[confirm] approved' : '[confirm] rejected')
}

async function cancelRun(): Promise<void> {
  if (!activeRunId.value) return
  await window.api.deploy.cancel(activeRunId.value)
  appendLog('[cancel] requested')
}

async function loadRuns(): Promise<void> {
  if (!projectId.value) {
    runs.value = []
    return
  }
  historyLoading.value = true
  try {
    runs.value = await window.api.deploy.listRuns(projectId.value, 50)
  } finally {
    historyLoading.value = false
  }
}

function onRunRowClick(row: DeployRun): void {
  selectedRun.value = row
}

watch(subTab, (tab) => {
  if (tab === 'history') void loadRuns()
  if (tab === 'recipe') syncDraftFromRecipe()
})

onMounted(async () => {
  try {
    await store.refreshAll()
    await refreshProjects()
    ensureDefaultServer()
    if (projects.value.length === 1) {
      projectId.value = projects.value[0].id
      await loadRecipe()
    }
  } finally {
    loaded.value = true
  }
})

onUnmounted(() => {
  unsubscribe?.()
  unsubscribe = null
  if (activeRunId.value) {
    void window.api.deploy.cancel(activeRunId.value)
  }
})
</script>

<style scoped>
.deploy-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex-wrap: wrap;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.title {
  font-weight: 600;
  font-size: 14px;
}

.meta {
  color: var(--text-muted);
  font-size: 12px;
}

.muted {
  color: var(--text-muted);
}

.empty-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  min-height: 280px;
}

.empty-title {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.empty-desc {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
}

.sub-tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.sub-tabs :deep(.el-tabs__header) {
  margin-bottom: 10px;
  flex-shrink: 0;
}

.sub-tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.sub-tabs :deep(.el-tab-pane) {
  height: 100%;
}

.run-pane,
.recipe-pane,
.history-pane {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding-bottom: 8px;
}

.hint-alert {
  flex-shrink: 0;
}

.params-card,
.log-card,
.step-card,
.run-detail {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}

.section-title.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  margin-bottom: 6px;
}

.section-head .section-title {
  margin-bottom: 0;
}

.params-form {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 4px 16px;
}

.params-form :deep(.el-form-item) {
  margin-bottom: 8px;
}

.run-actions,
.recipe-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}

.log-body {
  margin: 0;
  max-height: min(360px, 42vh);
  min-height: 140px;
  overflow: auto;
  padding: 10px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.28);
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
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
  max-height: min(240px, 32vh);
  flex-shrink: 0;
}

.confirm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.confirm-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.confirm-args {
  margin: 0;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.25);
  color: #b8c5d9;
}

.reason {
  font-size: 12px;
  color: var(--warning);
}

.confirm-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.form-row {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.form-row .grow {
  flex: 1;
}

.health-row {
  align-items: center;
  flex-wrap: wrap;
}

.edit-table {
  width: 100%;
  margin-bottom: 4px;
}

.step-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.step-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.rollback {
  opacity: 0.9;
}

.error-text {
  color: var(--danger);
  font-size: 13px;
  margin: 0 0 8px;
}

.tiny {
  margin: 0;
  font-size: 11px;
  max-height: 80px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.mono {
  font-family: 'IBM Plex Mono', 'SF Mono', Menlo, Consolas, monospace;
}
</style>
