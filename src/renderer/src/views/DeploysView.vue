<template>
  <div class="page deploys-page">
    <div class="page-header">
      <div>
        <h2>部署</h2>
        <p>对话部署跑通并沉淀模板；模板页一键填参发布</p>
      </div>
    </div>

    <el-tabs v-model="mainTab" class="main-tabs" @tab-change="onMainTabChange">
      <el-tab-pane label="AI 对话部署" name="chat">
        <div class="chat-wrap">
          <DeployChatPanel @template-created="onTemplateCreated" />
        </div>
      </el-tab-pane>

      <el-tab-pane label="模板部署" name="templates" lazy>
        <div class="templates-pane" v-loading="templatesLoading">
          <el-empty v-if="!templatesLoading && !templates.length">
            <template #description>
              <p class="empty-title">还没有部署模板</p>
              <p class="empty-desc">在「AI 对话部署」跑通并确认沉淀后会出现在这里</p>
            </template>
            <el-button type="primary" @click="mainTab = 'chat'">去对话部署</el-button>
          </el-empty>

          <el-table v-else :data="templates" empty-text="暂无模板">
            <el-table-column label="模板" min-width="180">
              <template #default="{ row }">
                <a class="name-link" href="#" @click.prevent="openTemplate(row.id)">{{ row.name }}</a>
              </template>
            </el-table-column>
            <el-table-column label="类型" width="140">
              <template #default="{ row }">
                <span class="mono">{{ row.kind || '—' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="服务器" min-width="180">
              <template #default="{ row }">
                <span class="mono">{{ serverLabel(row.serverId) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="版本" width="80">
              <template #default="{ row }">v{{ row.version }}</template>
            </el-table-column>
            <el-table-column label="最近发布" width="170">
              <template #default="{ row }">
                {{ row.lastRunAt ? formatTime(row.lastRunAt) : '—' }}
              </template>
            </el-table-column>
            <el-table-column label="操作" width="140" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="editTemplate(row.id)">编辑</el-button>
                <el-button link type="danger" @click="removeTemplate(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>
    </el-tabs>

    <DeployTemplateEditor
      v-model="editorVisible"
      :project-id="editingProjectId"
      @saved="onEditorSaved"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { DeployProject, DeploymentRecipe } from '../../../shared/types'
import { useAppStore } from '../stores/app'
import DeployChatPanel from '../components/DeployChatPanel.vue'
import DeployTemplateEditor from '../components/DeployTemplateEditor.vue'

interface TemplateRow {
  id: string
  name: string
  kind?: string
  serverId?: string
  version?: number
  lastRunAt?: number
}

const store = useAppStore()
const route = useRoute()
const router = useRouter()

const mainTab = ref<'chat' | 'templates'>('chat')
const templates = ref<TemplateRow[]>([])
const templatesLoading = ref(false)
const editorVisible = ref(false)
const editingProjectId = ref('')

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

function serverLabel(serverId?: string): string {
  if (!serverId) return '—'
  const s = store.servers.find((x) => x.id === serverId)
  return s ? `${s.name} (${s.host})` : serverId.slice(0, 8)
}

async function refreshTemplates(): Promise<void> {
  templatesLoading.value = true
  try {
    const projects: DeployProject[] = await window.api.deploy.listProjects()
    const rows: TemplateRow[] = []
    for (const p of projects) {
      const recipe: DeploymentRecipe | null = await window.api.deploy.getRecipe(p.id)
      if (!recipe || recipe.status !== 'active') continue
      rows.push({
        id: p.id,
        name: p.name || recipe.name,
        kind: recipe.kind,
        serverId: recipe.serverId,
        version: recipe.version,
        lastRunAt: p.lastRunAt
      })
    }
    templates.value = rows
  } finally {
    templatesLoading.value = false
  }
}

function openTemplate(id: string): void {
  void router.push(`/deploys/templates/${id}`)
}

function editTemplate(id: string): void {
  editingProjectId.value = id
  editorVisible.value = true
}

function onEditorSaved(): void {
  void refreshTemplates()
}

async function removeTemplate(row: TemplateRow): Promise<void> {
  await ElMessageBox.confirm(`确认删除模板「${row.name}」？`, '删除确认', { type: 'warning' })
  await window.api.deploy.deleteProject(row.id)
  ElMessage.success('已删除')
  await refreshTemplates()
}

function onTemplateCreated(projectId: string): void {
  void refreshTemplates()
  mainTab.value = 'templates'
  void router.push(`/deploys/templates/${projectId}`)
}

function onMainTabChange(name: string | number): void {
  if (name === 'templates') void refreshTemplates()
}

onMounted(async () => {
  await store.refreshAll()
  const qSession = String(route.query.session || '')
  if (qSession) {
    try {
      localStorage.setItem('aiops.deploy.activeSessionId', qSession)
    } catch {
      /* ignore */
    }
  }
  if (String(route.query.tab || '') === 'templates') {
    mainTab.value = 'templates'
    await refreshTemplates()
  }
})
</script>

<style scoped>
.deploys-page {
  /* 扣掉 App .content 上下 padding(24*2) */
  height: calc(100vh - 48px);
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  overflow: hidden;
}

.page-header {
  flex-shrink: 0;
}

.page-header h2 {
  margin: 0 0 4px;
  font-size: 20px;
}

.page-header p {
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
}

.main-tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.main-tabs :deep(.el-tabs__header) {
  margin-bottom: 10px;
  flex-shrink: 0;
}

.main-tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.main-tabs :deep(.el-tab-pane) {
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.chat-wrap {
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.templates-pane {
  height: 100%;
  min-height: 320px;
  background: rgba(26, 35, 50, 0.55);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px;
  overflow: auto;
}

.name-link {
  color: var(--accent);
  font-weight: 500;
}

.empty-title {
  margin: 0 0 6px;
  font-weight: 600;
  color: var(--text);
}

.empty-desc {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
}

.mono {
  font-family: 'IBM Plex Mono', Menlo, Consolas, monospace;
  font-size: 12px;
}
</style>
