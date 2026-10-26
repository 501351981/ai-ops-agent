<template>
  <div class="redirect" v-loading="true" />
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'

/** 兼容旧路由 /deploys/chat/:sessionId → 部署页对话 Tab */
const route = useRoute()
const router = useRouter()

onMounted(() => {
  const sessionId = String(route.params.sessionId || '')
  void router.replace({
    path: '/deploys',
    query: { tab: 'chat', ...(sessionId ? { session: sessionId } : {}) }
  })
})
</script>

<style scoped>
.redirect {
  height: 240px;
}
</style>
