<template>
  <div class="settings-layout">
    <aside class="sub-sider">
      <div class="sub-title">设置</div>
      <el-menu :default-active="active" router class="sub-menu">
        <el-menu-item index="/settings/models">
          <el-icon><Cpu /></el-icon>
          <span>模型设置</span>
        </el-menu-item>
        <el-menu-item index="/settings/system">
          <el-icon><Setting /></el-icon>
          <span>系统设置</span>
        </el-menu-item>
      </el-menu>
    </aside>
    <section class="sub-content">
      <router-view />
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const active = computed(() => {
  if (route.path.startsWith('/settings/system')) return '/settings/system'
  return '/settings/models'
})
</script>

<style scoped>
.settings-layout {
  display: flex;
  gap: 0;
  min-height: calc(100vh - 48px);
  margin: -24px;
  height: calc(100% + 48px);
}

.sub-sider {
  width: 180px;
  flex-shrink: 0;
  padding: 20px 12px;
  border-right: 1px solid var(--border);
  background: rgba(18, 26, 38, 0.55);
}

.sub-title {
  padding: 4px 12px 14px;
  font-size: 13px;
  color: var(--text-muted);
  letter-spacing: 0.04em;
}

.sub-menu {
  border-right: none;
  background: transparent;
}

.sub-menu :deep(.el-menu-item) {
  border-radius: 8px;
  height: 40px;
  margin-bottom: 4px;
  color: var(--text-muted);
}

.sub-menu :deep(.el-menu-item.is-active) {
  background: var(--accent-soft);
  color: var(--accent);
}

.sub-content {
  flex: 1;
  min-width: 0;
  padding: 24px;
  overflow: auto;
}
</style>
