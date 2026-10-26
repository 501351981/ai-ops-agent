<template>
  <el-drawer
    :model-value="modelValue"
    title="编辑部署模板"
    size="640px"
    destroy-on-close
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="loading" v-loading="true" class="loading-box" />
    <el-form v-else-if="ready" label-position="top" class="editor-form">
      <div class="form-row">
        <el-form-item label="模板标题" class="grow" required>
          <el-input v-model="draft.name" size="small" placeholder="模板名称" />
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="draft.kind" size="small" style="width: 160px">
            <el-option v-for="k in kindOptions" :key="k" :label="k" :value="k" />
          </el-select>
        </el-form-item>
      </div>
      <el-form-item label="默认目标服务器" required>
        <el-select v-model="draft.serverId" filterable size="small" style="width: 100%">
          <el-option
            v-for="s in store.servers"
            :key="s.id"
            :label="`${s.name} · ${s.host}`"
            :value="s.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="说明">
        <el-input v-model="draft.notes" type="textarea" :rows="2" size="small" />
      </el-form-item>

      <div class="section-head">
        <span class="section-title">可变参数</span>
        <el-button size="small" @click="addParam">添加</el-button>
      </div>
      <el-table :data="draft.params" size="small" empty-text="无参数">
        <el-table-column label="key" min-width="100">
          <template #default="{ row }">
            <el-input v-model="row.key" size="small" class="mono" />
          </template>
        </el-table-column>
        <el-table-column label="名称" min-width="100">
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
        <el-table-column label="必填" width="64" align="center">
          <template #default="{ row }">
            <el-checkbox v-model="row.required" />
          </template>
        </el-table-column>
        <el-table-column width="52" align="center">
          <template #default="{ $index }">
            <el-button link type="danger" size="small" @click="draft.params.splice($index, 1)">
              删
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="section-head">
        <span class="section-title">部署步骤</span>
        <el-button size="small" type="primary" plain @click="addStep">添加步骤</el-button>
      </div>
      <div v-for="(step, idx) in draft.steps" :key="step.id" class="edit-step">
        <div class="edit-step-head">
          <span class="mono">#{{ idx + 1 }}</span>
          <el-input v-model="step.name" size="small" placeholder="步骤名" style="width: 160px" />
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
          placeholder="命令模板，可用 {{paramKey}}"
        />
        <el-input
          v-model="step.rollbackCommand"
          size="small"
          class="mono"
          placeholder="回滚命令（可选）"
        />
      </div>
      <el-empty v-if="!draft.steps.length" description="至少添加一个步骤" :image-size="48" />

      <div class="section-head">
        <span class="section-title">健康检查（可选）</span>
      </div>
      <div class="form-row health-row">
        <el-input
          v-model="health.command"
          size="small"
          class="mono grow"
          placeholder="如 test -s /path/index.html"
        />
        <el-input-number v-model="health.retries" size="small" :min="1" :max="30" />
        <span class="meta">次 · 间隔</span>
        <el-input-number v-model="health.intervalSec" size="small" :min="1" :max="60" />
        <span class="meta">秒</span>
      </div>
    </el-form>
    <el-empty v-else description="模板不存在或尚未定版" />

    <template #footer>
      <div class="editor-footer">
        <el-button @click="emit('update:modelValue', false)">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!ready" @click="save">保存</el-button>
      </div>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type {
  DeployAssertion,
  DeployKind,
  DeployParamDef,
  DeployStep,
  DeploymentRecipe
} from '../../../shared/types'
import { useAppStore } from '../stores/app'

const props = defineProps<{
  modelValue: boolean
  projectId: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'saved', recipe: DeploymentRecipe): void
}>()

const kindOptions: DeployKind[] = [
  'docker-compose',
  'systemd-jar',
  'systemd-binary',
  'k8s',
  'custom'
]

const store = useAppStore()
const loading = ref(false)
const saving = ref(false)
const ready = ref(false)
const recipeId = ref<string | undefined>()
const sourceIntent = ref<string | undefined>()

const draft = reactive({
  name: '',
  kind: 'custom' as DeployKind,
  serverId: '',
  notes: '',
  params: [] as DeployParamDef[],
  assertions: [] as DeployAssertion[],
  steps: [] as DeployStep[]
})
const health = reactive({
  command: '',
  retries: 5,
  intervalSec: 3
})

watch(
  () => [props.modelValue, props.projectId] as const,
  async ([visible, id]) => {
    if (!visible || !id) return
    loading.value = true
    ready.value = false
    try {
      await store.refreshAll()
      const recipe = await window.api.deploy.getRecipe(id)
      if (!recipe) return
      recipeId.value = recipe.id
      sourceIntent.value = recipe.sourceIntent
      draft.name = recipe.name
      draft.kind = recipe.kind
      draft.serverId = recipe.serverId
      draft.notes = recipe.notes || ''
      draft.params = recipe.params.map((p) => ({ ...p }))
      draft.assertions = (recipe.assertions || []).map((a) => ({ ...a }))
      draft.steps = recipe.steps.map((s) => ({ ...s, rollbackCommand: s.rollbackCommand || '' }))
      health.command = recipe.healthCheck?.command || ''
      health.retries = recipe.healthCheck?.retries ?? 5
      health.intervalSec = recipe.healthCheck?.intervalSec ?? 3
      ready.value = true
    } finally {
      loading.value = false
    }
  }
)

function addParam(): void {
  draft.params.push({
    key: `param${draft.params.length + 1}`,
    label: '',
    type: 'string',
    required: true,
    defaultValue: ''
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

async function save(): Promise<void> {
  if (!props.projectId || !ready.value) return
  if (!draft.name.trim()) {
    ElMessage.warning('请填写模板标题')
    return
  }
  if (!draft.serverId) {
    ElMessage.warning('请选择默认目标服务器')
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
    const healthCheck = health.command.trim()
      ? {
          command: health.command.trim(),
          retries: health.retries,
          intervalSec: health.intervalSec
        }
      : undefined

    const recipe = await window.api.deploy.saveRecipe(
      {
        id: recipeId.value,
        projectId: props.projectId,
        name: draft.name.trim(),
        kind: draft.kind,
        serverId: draft.serverId,
        params: draft.params
          .filter((p) => p.key.trim())
          .map((p) => ({
            ...p,
            key: p.key.trim(),
            label: (p.label || p.key).trim()
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
        sourceIntent: sourceIntent.value
      },
      'active'
    )
    ElMessage.success(`模板已更新 v${recipe.version}`)
    emit('saved', recipe)
    emit('update:modelValue', false)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.loading-box {
  min-height: 160px;
}

.editor-form {
  padding-right: 4px;
}

.form-row {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.form-row .grow {
  flex: 1;
}

.section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 16px 0 8px;
}

.section-title {
  font-weight: 600;
  font-size: 13px;
}

.edit-step {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.18);
}

.edit-step-head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.health-row {
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.meta {
  color: var(--text-muted);
  font-size: 12px;
}

.editor-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.mono {
  font-family: 'IBM Plex Mono', Menlo, Consolas, monospace;
}
</style>
