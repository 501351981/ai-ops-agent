<template>
  <div class="page monitors-page">
    <div class="page-header">
      <div>
        <h2>监控</h2>
        <p>查看各环境已配置的监控看板</p>
      </div>
    </div>

    <div v-if="loading" class="body" v-loading="true" />

    <el-empty v-else-if="!tabs.length" class="body">
      <template #description>
        <p class="empty-title">尚未配置监控</p>
        <p class="empty-desc">在「环境管理」进入服务器，通过 AI 对话创建监控画面</p>
        <p class="hint mono">例如：帮我增加监控指标 CPU、内存、硬盘使用情况</p>
      </template>
      <el-button type="primary" @click="$router.push('/servers')">去环境管理</el-button>
    </el-empty>

    <el-tabs
      v-else
      v-model="activeId"
      class="monitor-tabs"
      @tab-change="onTabChange"
    >
      <el-tab-pane
        v-for="item in tabs"
        :key="item.serverId"
        :name="item.serverId"
        lazy
      >
        <template #label>
          <span class="tab-label">
            <span class="tab-name">{{ item.serverName }}</span>
            <span v-if="item.host" class="tab-host mono">{{ item.host }}</span>
          </span>
        </template>
        <div class="panel-wrap">
          <MonitorPanel
            :server-id="item.serverId"
            @goto-chat="gotoChat(item.serverId)"
            @cleared="onCleared(item.serverId)"
          />
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { MonitorSummary } from '../../../shared/types'
import MonitorPanel from '../components/MonitorPanel.vue'
import { useAppStore } from '../stores/app'

interface MonitorTab {
  serverId: string
  serverName: string
  host: string
}

const store = useAppStore()
const route = useRoute()
const router = useRouter()

const loading = ref(true)
const summaries = ref<MonitorSummary[]>([])
const activeId = ref('')

const tabs = computed<MonitorTab[]>(() => {
  const serverMap = new Map(store.servers.map((s) => [s.id, s]))
  return summaries.value
    .filter((s) => serverMap.has(s.serverId))
    .map((s) => {
      const server = serverMap.get(s.serverId)!
      return {
        serverId: s.serverId,
        serverName: server.name,
        host: server.host
      }
    })
})

async function refreshList(): Promise<void> {
  summaries.value = await window.api.monitor.list()
}

function pickActive(preferred?: string): void {
  const ids = tabs.value.map((t) => t.serverId)
  if (!ids.length) {
    activeId.value = ''
    return
  }
  if (preferred && ids.includes(preferred)) {
    activeId.value = preferred
    return
  }
  if (activeId.value && ids.includes(activeId.value)) return
  activeId.value = ids[0]
}

function syncRoute(serverId: string): void {
  const target = serverId ? `/monitors/${serverId}` : '/monitors'
  if (route.path !== target) {
    void router.replace(target)
  }
}

function onTabChange(name: string | number): void {
  syncRoute(String(name))
}

function gotoChat(serverId: string): void {
  void router.push({ path: `/servers/${serverId}`, query: { tab: 'chat' } })
}

async function onCleared(serverId: string): Promise<void> {
  const idx = tabs.value.findIndex((t) => t.serverId === serverId)
  await refreshList()
  const ids = tabs.value.map((t) => t.serverId)
  let next = ''
  if (ids.length) {
    next = ids[Math.min(Math.max(idx, 0), ids.length - 1)] || ids[0]
  }
  pickActive(next)
  syncRoute(activeId.value)
}

onMounted(async () => {
  await store.refreshAll()
  await refreshList()
  const fromRoute = typeof route.params.serverId === 'string' ? route.params.serverId : ''
  pickActive(fromRoute)
  if (activeId.value) syncRoute(activeId.value)
  loading.value = false
})

watch(
  () => route.params.serverId,
  (id) => {
    if (typeof id === 'string' && id && id !== activeId.value) {
      pickActive(id)
    }
  }
)
</script>

<style scoped>
.monitors-page {
  height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.body {
  flex: 1;
  min-height: 320px;
}

.empty-title {
  margin: 0 0 4px;
  color: var(--text);
  font-size: 14px;
}

.empty-desc {
  margin: 0 0 8px;
  color: var(--text-muted);
  font-size: 13px;
}

.hint {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
  opacity: 0.85;
}

.monitor-tabs {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.monitor-tabs :deep(.el-tabs__header) {
  margin-bottom: 8px;
}

.monitor-tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
}

.monitor-tabs :deep(.el-tab-pane) {
  height: 100%;
}

.tab-label {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  max-width: 220px;
}

.tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab-host {
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel-wrap {
  height: calc(100vh - 180px);
  min-height: 480px;
}
</style>
