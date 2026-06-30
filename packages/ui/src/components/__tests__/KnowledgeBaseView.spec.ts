import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createRouter, createWebHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { logger } from '../../lib/logger'
import KnowledgeBaseView from '../../views/settings/KnowledgeBaseView.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      settings: { knowledgeBase: 'Knowledge Base', noDocuments: 'No documents yet', model: 'Model', theme: 'Theme', mcp: 'MCP', dataControls: 'Data' },
      common: { upload: 'Upload', uploading: 'Uploading...', delete: 'Delete' },
    },
  },
})

const router = createRouter({ history: createWebHistory(), routes: [{ path: '/settings/knowledge', name: 'settings-knowledge', component: { template: '<div />' } }] })

beforeEach(() => {
  setActivePinia(createPinia())
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'))
  vi.spyOn(logger, 'warn')
})

function mountKnowledgeView() {
  return mount(KnowledgeBaseView, { global: { plugins: [i18n, router] } })
}

describe('KnowledgeBaseView', () => {
  it('renders the heading', async () => {
    router.push('/settings/knowledge')
    await router.isReady()
    const wrapper = mountKnowledgeView()
    expect(wrapper.text()).toContain('Knowledge Base')
  })

  it('shows loading state on mount', async () => {
    const wrapper = mountKnowledgeView()
    wrapper.vm.loading = true
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Loading')
  })

  it('shows error state with retry when fetch fails and logs warning', async () => {
    const wrapper = mountKnowledgeView()
    wrapper.vm.loading = false
    wrapper.vm.loadError = 'HTTP 500'
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('HTTP 500')
    expect(wrapper.text()).toContain('Retry')
    expect(logger.warn).toHaveBeenCalled()
  })

  it('shows empty state when no documents', async () => {
    const wrapper = mountKnowledgeView()
    wrapper.vm.loading = false
    wrapper.vm.documents = []
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('No documents yet')
  })
})
