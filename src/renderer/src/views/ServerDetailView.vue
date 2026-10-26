<template>
  <div class="page detail">
    <div class="page-header compact-header">
      <div class="header-left">
        <el-button link @click="$router.push('/servers')">
          <el-icon><ArrowLeft /></el-icon>
          返回
        </el-button>
        <span class="divider" />
        <h2>{{ server?.name || '服务器' }}</h2>
        <span v-if="server" class="mono conn">{{ server.username }}@{{ server.host }}:{{ server.port }}</span>
      </div>
      <el-button v-if="server" size="small" :loading="testing" @click="testConnection">测试连接</el-button>
    </div>

    <el-empty v-if="loaded && !server" description="服务器不存在或已删除">
      <el-button type="primary" @click="$router.push('/servers')">返回列表</el-button>
    </el-empty>

    <el-tabs v-else-if="server" v-model="tab" class="detail-tabs">
      <el-tab-pane label="AI 对话运维" name="chat">
        <div class="panel-wrap">
          <ChatPanel :server-id="id" />
        </div>
      </el-tab-pane>
      <el-tab-pane label="文件管理" name="files">
        <div class="panel-wrap">
          <FileBrowser :server-id="id" />
        </div>
      </el-tab-pane>
      <el-tab-pane label="监控" name="monitor" lazy>
        <div class="panel-wrap monitor-wrap">
          <div class="monitor-toolbar">
            <el-button size="small" link type="primary" @click="openMonitorHub">
              在监控中心打开
            </el-button>
          </div>
          <MonitorPanel :server-id="id" @goto-chat="tab = 'chat'" />
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useAppStore } from '../stores/app'
import ChatPanel from '../components/ChatPanel.vue'
import FileBrowser from '../components/FileBrowser.vue'
import MonitorPanel from '../components/MonitorPanel.vue'

const props = defineProps<{ id: string }>()
const store = useAppStore()
const route = useRoute()
const router = useRouter()
const tab = ref('chat')
const testing = ref(false)
const loaded = ref(false)

const server = computed(() => store.servers.find((s) => s.id === props.id))

const allowedTabs = new Set(['chat', 'files', 'monitor'])

function applyTabFromQuery(): void {
  const q = route.query.tab
  if (typeof q === 'string' && allowedTabs.has(q)) {
    tab.value = q
  }
}

function openMonitorHub(): void {
  void router.push(`/monitors/${props.id}`)
}

async function testConnection(): Promise<void> {
  if (!server.value) return
  testing.value = true
  try {
    const result = await window.api.servers.test({
      id: server.value.id,
      name: server.value.name,
      host: server.value.host,
      port: server.value.port,
      username: server.value.username,
      authType: server.value.authType
    })
    if (result.ok) ElMessage.success(result.message)
    else ElMessage.error(result.message)
  } finally {
    testing.value = false
  }
}

onMounted(async () => {
  applyTabFromQuery()
  await store.refreshAll()
  loaded.value = true
})

watch(
  () => route.query.tab,
  () => applyTabFromQuery()
)

onUnmounted(() => {
  void window.api.servers.disconnect(props.id)
})
</script>

<style scoped>
.detail {
  height: calc(100vh - 48px);
  gap: 10px;
}

.compact-header {
  margin: 0;
  min-height: 32px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
}

.header-left h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  white-space: nowrap;
}

.divider {
  width: 1px;
  height: 14px;
  background: var(--border);
  flex-shrink: 0;
}

.conn {
  color: var(--text-muted);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-tabs {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.detail-tabs :deep(.el-tabs__header) {
  margin-bottom: 8px;
}

.detail-tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
}

.detail-tabs :deep(.el-tab-pane) {
  height: 100%;
}

.panel-wrap {
  height: calc(100vh - 160px);
  min-height: 480px;
}

.monitor-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.monitor-toolbar {
  display: flex;
  justify-content: flex-end;
  flex-shrink: 0;
}

.monitor-wrap :deep(.monitor-panel) {
  flex: 1;
  min-height: 0;
}
</style>
