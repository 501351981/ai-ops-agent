<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2>环境管理</h2>
        <p>通过 SSH 添加并管理第三方服务器</p>
      </div>
      <el-button type="primary" @click="openCreate">
        <el-icon><Plus /></el-icon>
        添加服务器
      </el-button>
    </div>

    <div class="card-panel">
      <el-table :data="store.servers" v-loading="store.loading" empty-text="暂无服务器，请先添加">
        <el-table-column prop="name" label="名称" min-width="140">
          <template #default="{ row }">
            <a class="name-link" href="#" @click.prevent="$router.push(`/servers/${row.id}`)">
              {{ row.name }}
            </a>
          </template>
        </el-table-column>
        <el-table-column label="连接" min-width="220">
          <template #default="{ row }">
            <span class="mono">{{ row.username }}@{{ row.host }}:{{ row.port }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="authType" label="认证" width="110">
          <template #default="{ row }">
            {{ row.authType === 'password' ? '密码' : '私钥' }}
          </template>
        </el-table-column>
        <el-table-column label="凭证" width="90">
          <template #default="{ row }">
            <el-tag :type="row.hasCredential ? 'success' : 'danger'" size="small">
              {{ row.hasCredential ? '已保存' : '缺失' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="280" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="$router.push(`/servers/${row.id}`)">进入</el-button>
            <el-button link :loading="testingId === row.id" @click="testSaved(row)">测试</el-button>
            <el-button link @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑服务器' : '添加服务器'" width="520px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="名称" required>
          <el-input v-model="form.name" placeholder="生产机 / 测试机" />
        </el-form-item>
        <el-form-item label="主机" required>
          <el-input v-model="form.host" placeholder="IP 或域名" />
        </el-form-item>
        <el-form-item label="端口" required>
          <el-input-number v-model="form.port" :min="1" :max="65535" />
        </el-form-item>
        <el-form-item label="用户名" required>
          <el-input v-model="form.username" />
        </el-form-item>
        <el-form-item label="认证方式">
          <el-radio-group v-model="form.authType">
            <el-radio value="password">密码</el-radio>
            <el-radio value="privateKey">私钥</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="form.authType === 'password'" :label="editingId ? '新密码' : '密码'">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            :placeholder="editingId ? '留空则不修改' : 'SSH 密码'"
          />
        </el-form-item>
        <template v-else>
          <el-form-item :label="editingId ? '新私钥' : '私钥'">
            <el-input
              v-model="form.privateKey"
              type="textarea"
              :rows="5"
              :placeholder="editingId ? '留空则不修改' : '粘贴 PEM 私钥内容'"
            />
          </el-form-item>
          <el-form-item label="口令">
            <el-input v-model="form.passphrase" type="password" show-password placeholder="私钥口令（可选）" />
          </el-form-item>
        </template>
      </el-form>
      <template #footer>
        <el-button @click="testForm" :loading="testing">测试连接</el-button>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="save" :loading="saving">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { AuthType, ServerConfig } from '../../../shared/types'
import { useAppStore } from '../stores/app'

const store = useAppStore()
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
const testing = ref(false)
const testingId = ref<string | null>(null)

const form = reactive({
  name: '',
  host: '',
  port: 22,
  username: 'root',
  authType: 'password' as AuthType,
  password: '',
  privateKey: '',
  passphrase: ''
})

function resetForm(): void {
  form.name = ''
  form.host = ''
  form.port = 22
  form.username = 'root'
  form.authType = 'password'
  form.password = ''
  form.privateKey = ''
  form.passphrase = ''
}

function openCreate(): void {
  editingId.value = null
  resetForm()
  dialogVisible.value = true
}

function openEdit(row: ServerConfig): void {
  editingId.value = row.id
  form.name = row.name
  form.host = row.host
  form.port = row.port
  form.username = row.username
  form.authType = row.authType
  form.password = ''
  form.privateKey = ''
  form.passphrase = ''
  dialogVisible.value = true
}

async function save(): Promise<void> {
  if (!form.name || !form.host || !form.username) {
    ElMessage.warning('请填写必要字段')
    return
  }
  if (!editingId.value) {
    if (form.authType === 'password' && !form.password) {
      ElMessage.warning('请填写密码')
      return
    }
    if (form.authType === 'privateKey' && !form.privateKey) {
      ElMessage.warning('请填写私钥')
      return
    }
  }
  saving.value = true
  try {
    await window.api.servers.upsert({
      id: editingId.value || undefined,
      name: form.name,
      host: form.host,
      port: form.port,
      username: form.username,
      authType: form.authType,
      password: form.password || undefined,
      privateKey: form.privateKey || undefined,
      passphrase: form.passphrase || undefined
    })
    ElMessage.success('已保存')
    dialogVisible.value = false
    await store.refreshServers()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  } finally {
    saving.value = false
  }
}

async function testForm(): Promise<void> {
  testing.value = true
  try {
    const result = await window.api.servers.test({
      id: editingId.value || undefined,
      name: form.name,
      host: form.host,
      port: form.port,
      username: form.username,
      authType: form.authType,
      password: form.password || undefined,
      privateKey: form.privateKey || undefined,
      passphrase: form.passphrase || undefined
    })
    if (result.ok) ElMessage.success(result.message)
    else ElMessage.error(result.message)
  } finally {
    testing.value = false
  }
}

async function testSaved(row: ServerConfig): Promise<void> {
  testingId.value = row.id
  try {
    const result = await window.api.servers.test({
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      username: row.username,
      authType: row.authType
    })
    if (result.ok) ElMessage.success(result.message)
    else ElMessage.error(result.message)
  } finally {
    testingId.value = null
  }
}

async function remove(row: ServerConfig): Promise<void> {
  await ElMessageBox.confirm(`确认删除服务器「${row.name}」？`, '删除确认', { type: 'warning' })
  await window.api.servers.delete(row.id)
  ElMessage.success('已删除')
  await store.refreshServers()
}

onMounted(() => store.refreshAll())
</script>

<style scoped>
.name-link {
  color: var(--accent);
  font-weight: 500;
  cursor: pointer;
}

.name-link:hover {
  text-decoration: underline;
}
</style>
