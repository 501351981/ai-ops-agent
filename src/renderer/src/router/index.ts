import { createRouter, createWebHashHistory } from 'vue-router'
import ServersView from '../views/ServersView.vue'
import ServerDetailView from '../views/ServerDetailView.vue'
import MonitorsView from '../views/MonitorsView.vue'
import DeploysView from '../views/DeploysView.vue'
import DeployChatView from '../views/DeployChatView.vue'
import DeployTemplateView from '../views/DeployTemplateView.vue'
import SettingsLayout from '../views/SettingsLayout.vue'
import SettingsView from '../views/SettingsView.vue'
import SystemSettingsView from '../views/SystemSettingsView.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/servers' },
    { path: '/servers', name: 'servers', component: ServersView },
    { path: '/servers/:id', name: 'server-detail', component: ServerDetailView, props: true },
    { path: '/monitors', name: 'monitors', component: MonitorsView },
    { path: '/monitors/:serverId', name: 'monitor-server', component: MonitorsView },
    { path: '/deploys', name: 'deploys', component: DeploysView },
    {
      path: '/deploys/chat/:sessionId',
      name: 'deploy-chat',
      component: DeployChatView
    },
    {
      path: '/deploys/templates/:projectId',
      name: 'deploy-template',
      component: DeployTemplateView
    },
    {
      path: '/settings',
      component: SettingsLayout,
      redirect: '/settings/models',
      children: [
        { path: 'models', name: 'settings-models', component: SettingsView },
        { path: 'system', name: 'settings-system', component: SystemSettingsView }
      ]
    },
    // 兼容旧入口
    { path: '/system', redirect: '/settings/system' }
  ]
})

export default router
