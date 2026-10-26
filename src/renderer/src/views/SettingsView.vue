<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2>模型设置</h2>
        <p>通用 OpenAI 兼容配置，支持 DeepSeek、GLM、Ollama 等</p>
      </div>
      <div class="actions">
        <el-dropdown @command="addPreset">
          <el-button>
            从模板添加
            <el-icon class="el-icon--right"><ArrowDown /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="p in presets" :key="p.name" :command="p">
                {{ p.name }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button type="primary" @click="openCreate">自定义 Provider</el-button>
      </div>
    </div>

    <div class="card-panel">
      <el-form label-width="160px" style="max-width: 640px; margin-bottom: 20px">
        <el-form-item label="默认模型">
          <el-select
            :model-value="store.settings.defaultProviderId"
            placeholder="选择默认 Provider"
            style="width: 100%"
            @change="onDefaultChange"
          >
            <el-option
              v-for="p in store.providers"
              :key="p.id"
              :label="`${p.name} (${p.model})`"
              :value="p.id"
            />
          </el-select>
        </el-form-item>
      </el-form>

      <el-table :data="store.providers" empty-text="尚未配置模型，请添加 Provider">
        <el-table-column prop="name" label="名称" min-width="120" />
        <el-table-column prop="baseUrl" label="Base URL" min-width="220" show-overflow-tooltip />
        <el-table-column prop="model" label="模型" min-width="140" />
        <el-table-column label="API Key" width="100">
          <template #default="{ row }">
            <el-tag :type="row.hasApiKey ? 'success' : 'info'" size="small">
              {{ row.hasApiKey ? '已配置' : '空' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="启用" width="80">
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">
              {{ row.enabled ? '是' : '否' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="260" fixed="right">
          <template #default="{ row }">
            <el-button link :loading="testingId === row.id" @click="testProvider(row.id)">测试</el-button>
            <el-button link @click="openEdit(row)">编辑</el-button>
            <el-button link @click="cloneProvider(row.id)">克隆</el-button>
            <el-button link type="danger" @click="remove(row.id)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑 Provider' : '添加 Provider'" width="560px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="名称" required>
          <el-input v-model="form.name" />
        </el-form-item>
        <el-form-item label="Base URL" required>
          <el-input v-model="form.baseUrl" placeholder="https://api.deepseek.com/v1" />
        </el-form-item>
        <el-form-item label="模型" required>
          <el-input v-model="form.model" placeholder="deepseek-chat" />
        </el-form-item>
        <el-form-item :label="editingId ? '新 API Key' : 'API Key'">
          <el-input
            v-model="form.apiKey"
            type="password"
            show-password
            :placeholder="editingId ? '留空则不修改' : 'Ollama 可留空'"
          />
        </el-form-item>
        <el-form-item label="Temperature">
          <el-slider v-model="form.temperature" :min="0" :max="1" :step="0.1" show-input />
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="form.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="testForm" :loading="testing">测试连接</el-button>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { AppSettings, LlmProvider } from '../../../shared/types'
import { useAppStore } from '../stores/app'

const store = useAppStore()
const presets = ref<Array<{ name: string; baseUrl: string; model: string; temperature?: number; enabled: boolean }>>([])
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
const testing = ref(false)
const testingId = ref<string | null>(null)

const form = reactive({
  name: '',
  baseUrl: '',
  model: '',
  apiKey: '',
  temperature: 0.3,
  enabled: true
})

function resetForm(): void {
  form.name = ''
  form.baseUrl = ''
  form.model = ''
  form.apiKey = ''
  form.temperature = 0.3
  form.enabled = true
}

function openCreate(): void {
  editingId.value = null
  resetForm()
  dialogVisible.value = true
}

function addPreset(p: { name: string; baseUrl: string; model: string; temperature?: number }): void {
  editingId.value = null
  form.name = p.name
  form.baseUrl = p.baseUrl
  form.model = p.model
  form.temperature = p.temperature ?? 0.3
  form.apiKey = ''
  form.enabled = true
  dialogVisible.value = true
}

function openEdit(row: LlmProvider): void {
  editingId.value = row.id
  form.name = row.name
  form.baseUrl = row.baseUrl
  form.model = row.model
  form.temperature = row.temperature ?? 0.3
  form.enabled = row.enabled
  form.apiKey = ''
  dialogVisible.value = true
}

async function save(): Promise<void> {
  if (!form.name || !form.baseUrl || !form.model) {
    ElMessage.warning('请填写名称、Base URL 和模型')
    return
  }
  saving.value = true
  try {
    await window.api.providers.upsert({
      id: editingId.value || undefined,
      name: form.name,
      baseUrl: form.baseUrl,
      model: form.model,
      apiKey: form.apiKey || undefined,
      temperature: form.temperature,
      enabled: form.enabled
    })
    ElMessage.success('已保存')
    dialogVisible.value = false
    await store.refreshProviders()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    saving.value = false
  }
}

async function testForm(): Promise<void> {
  if (!form.baseUrl || !form.model) {
    ElMessage.warning('请先填写 Base URL 和模型')
    return
  }
  testing.value = true
  try {
    // 始终用表单当前值测；编辑时 API Key 留空则主进程复用已保存密钥
    const result = await window.api.providers.test({
      id: editingId.value || undefined,
      baseUrl: form.baseUrl,
      model: form.model,
      apiKey: form.apiKey || undefined
    })
    if (result.ok) ElMessage.success(result.message)
    else ElMessage.error(result.message)
  } finally {
    testing.value = false
  }
}

async function testProvider(id: string): Promise<void> {
  testingId.value = id
  try {
    const result = await window.api.providers.test({ id })
    if (result.ok) ElMessage.success(result.message)
    else ElMessage.error(result.message)
  } finally {
    testingId.value = null
  }
}

async function cloneProvider(id: string): Promise<void> {
  try {
    const cloned = await window.api.providers.clone(id)
    await store.refreshProviders()
    ElMessage.success(`已克隆为「${cloned.name}」`)
    openEdit(cloned)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  }
}

async function remove(id: string): Promise<void> {
  await ElMessageBox.confirm('确认删除该 Provider？', '删除确认', { type: 'warning' })
  await window.api.providers.delete(id)
  await store.refreshProviders()
  ElMessage.success('已删除')
}

async function onDefaultChange(id: string): Promise<void> {
  await updateSetting({ defaultProviderId: id })
}

async function updateSetting(partial: Partial<AppSettings>): Promise<void> {
  store.settings = await window.api.settings.update(partial)
  ElMessage.success('设置已更新')
}

onMounted(async () => {
  await store.refreshAll()
  presets.value = await window.api.providers.presets()
})
</script>

<style scoped>
.actions {
  display: flex;
  gap: 8px;
}
</style>
