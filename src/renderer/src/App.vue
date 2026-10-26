<template>
  <div class="layout">
    <aside class="sider">
      <div class="brand">
        <img class="logo" :src="logoUrl" alt="AI Ops Agent" />
        <div>
          <div class="brand-name">Ops Agent</div>
          <div class="brand-sub">本地运维助手</div>
        </div>
      </div>
      <el-menu :default-active="active" router class="menu">
        <el-menu-item index="/servers">
          <el-icon><Monitor /></el-icon>
          <span>环境管理</span>
        </el-menu-item>
        <el-menu-item index="/monitors">
          <el-icon><Odometer /></el-icon>
          <span>监控</span>
        </el-menu-item>
        <el-menu-item index="/deploys">
          <el-icon><Upload /></el-icon>
          <span>部署</span>
        </el-menu-item>
      </el-menu>

      <div class="sider-bottom">
        <router-link
          to="/settings"
          class="bottom-link"
          :class="{ active: isSettings }"
        >
          <el-icon><Setting /></el-icon>
          <span>设置</span>
        </router-link>
      </div>
    </aside>
    <main class="content">
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import logoUrl from './assets/logo.png'

const route = useRoute()
const active = computed(() => {
  if (route.path.startsWith('/servers')) return '/servers'
  if (route.path.startsWith('/monitors')) return '/monitors'
  if (route.path.startsWith('/deploys')) return '/deploys'
  return route.path
})
const isSettings = computed(() => route.path.startsWith('/settings'))
</script>

<style scoped>
.layout {
  display: flex;
  height: 100%;
  background:
    radial-gradient(ellipse at top left, rgba(61, 156, 240, 0.12), transparent 40%),
    radial-gradient(ellipse at bottom right, rgba(62, 207, 142, 0.08), transparent 35%),
    var(--bg);
}

.sider {
  width: 220px;
  padding: 20px 14px 12px;
  border-right: 1px solid var(--border);
  background: rgba(26, 35, 50, 0.85);
  backdrop-filter: blur(8px);
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 8px;
}

.logo {
  width: 44px;
  height: 44px;
  object-fit: contain;
  flex-shrink: 0;
  border-radius: 12px;
  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.45));
}

.brand-name {
  font-weight: 650;
  letter-spacing: 0.02em;
  color: #f4f7fb;
}

.brand-sub {
  font-size: 12px;
  color: #a8b6c9;
}

.menu {
  border-right: none;
  background: transparent;
  flex: 1;
}

.menu :deep(.el-menu-item) {
  border-radius: 8px;
  margin-bottom: 4px;
  color: var(--text-muted);
}

.menu :deep(.el-menu-item.is-active) {
  background: var(--accent-soft);
  color: var(--accent);
}

.sider-bottom {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

.bottom-link {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  color: var(--text-muted);
  font-size: 13px;
  transition: background 0.15s ease, color 0.15s ease;
}

.bottom-link:hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--text);
}

.bottom-link.active {
  background: var(--accent-soft);
  color: var(--accent);
}

.content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 24px;
}
</style>
