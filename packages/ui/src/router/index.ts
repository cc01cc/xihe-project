import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      redirect: '/workspace',
    },
    {
      path: '/workspace',
      component: () => import('../layouts/AppLayout.vue'),
      meta: { requiresAuth: true },
      children: [
        {
          path: '',
          name: 'workspace-home',
          component: () => import('../components/workspace/WorkspaceView.vue'),
        },
      ],
    },
    {
      path: '/workspace/:workspaceId',
      component: () => import('../layouts/AppLayout.vue'),
      meta: { requiresAuth: true },
      children: [
        {
          path: '',
          name: 'workspace',
          component: () => import('../components/workspace/WorkspaceView.vue'),
        },
        {
          path: 'chat/:sessionId',
          name: 'workspace-chat',
          component: () => import('../components/workspace/WorkspaceView.vue'),
        },
        {
          path: 'environment',
          name: 'workspace-environment',
          component: () => import('../views/workspace/WorkspaceEnvironmentView.vue'),
        },
      ],
    },
    {
      path: '/settings',
      component: () => import('../layouts/AppLayout.vue'),
      meta: { requiresAuth: true },
      children: [
        {
          path: '',
          redirect: { name: 'settings-config' },
        },
        {
          path: 'config',
          name: 'settings-config',
          component: () => import('../views/settings/ConfigSettings.vue'),
        },
        {
          path: 'policy',
          name: 'settings-policy',
          component: () => import('../views/settings/PolicyRulesView.vue'),
        },
        {
          path: 'tool-faces',
          name: 'settings-tool-faces',
          component: () => import('../views/settings/ToolFacesView.vue'),
        },
        {
          path: 'knowledge',
          name: 'settings-knowledge',
          component: () => import('../views/settings/KnowledgeBaseView.vue'),
        },
        {
          path: 'data',
          name: 'settings-data',
          component: () => import('../views/settings/DataControlsView.vue'),
        },
        {
          path: 'monitoring',
          name: 'settings-monitoring',
          component: () => import('../views/settings/MonitoringView.vue'),
        },
        {
          path: 'audit',
          name: 'settings-audit',
          component: () => import('../views/settings/AuditView.vue'),
        },
      ],
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('../views/auth/LoginView.vue'),
    },
    {
      path: '/register',
      name: 'register',
      component: () => import('../views/auth/RegisterView.vue'),
    },
    {
      // Legacy bookmarks (e.g. removed /chat/:sessionId) recover to the
      // Workspace-first landing instead of a blank unmatched-route view.
      path: '/:pathMatch(.*)*',
      redirect: '/workspace',
    },
  ],
})

router.beforeEach((to) => {
  const token = localStorage.getItem('xihe-token')
  const requiresAuth = to.matched.some(r => r.meta?.requiresAuth)

  if (requiresAuth && !token) {
    return { name: 'login', query: { redirect: to.fullPath } }
  } else if ((to.name === 'login' || to.name === 'register') && token) {
    return { path: '/workspace' }
  }

  return true
})

export default router
