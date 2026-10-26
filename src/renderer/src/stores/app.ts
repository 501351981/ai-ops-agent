import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AppSettings, LlmProvider, ServerConfig } from '../../../shared/types'

export const useAppStore = defineStore('app', () => {
  const servers = ref<ServerConfig[]>([])
  const providers = ref<LlmProvider[]>([])
  const settings = ref<AppSettings>({
    defaultProviderId: null,
    autoConfirmReadonly: true,
    blockDangerousCommands: true,
    maxAgentRounds: 20
  })
  const loading = ref(false)

  async function refreshAll(): Promise<void> {
    loading.value = true
    try {
      ;[servers.value, providers.value, settings.value] = await Promise.all([
        window.api.servers.list(),
        window.api.providers.list(),
        window.api.settings.get()
      ])
    } finally {
      loading.value = false
    }
  }

  async function refreshServers(): Promise<void> {
    servers.value = await window.api.servers.list()
  }

  async function refreshProviders(): Promise<void> {
    providers.value = await window.api.providers.list()
    settings.value = await window.api.settings.get()
  }

  return {
    servers,
    providers,
    settings,
    loading,
    refreshAll,
    refreshServers,
    refreshProviders
  }
})
