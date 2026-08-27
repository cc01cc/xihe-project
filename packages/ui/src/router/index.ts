import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      redirect: '/chat',
    },
    {
      path: '/chat',
      component: () => import('../layouts/AppLayout.vue'),
      meta: { requiresAuth: true },
      children: [
        {
          path: '',
          redirect: '/chat/default',
        },
        {
          path: 'new',
          name: 'chat-new',
          redirect: '/chat/default',
        },
        {
          path: ':sessionId',
          name: 'chat',
          component: () => import('../components/chat/ChatView.vue'),
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
      path: '/workspace/:sessionId?',
      name: 'workspace',
      component: () => import('../layouts/AppLayout.vue'),
      meta: { requiresAuth: true },
      children: [
        {
          path: '',
          name: 'workspace-session',
          component: () => import('../components/workspace/WorkspaceView.vue'),
        },
      ],
    },
  ],
})

router.beforeEach((to) => {
  const token = localStorage.getItem('xihe-token')
  const requiresAuth = to.matched.some(r => r.meta?.requiresAuth)

  if (requiresAuth && !token) {
    return { name: 'login', query: { redirect: to.fullPath } }
  } else if ((to.name === 'login' || to.name === 'register') && token) {
    return { name: 'chat' }
  }

  return true
})

export default router
