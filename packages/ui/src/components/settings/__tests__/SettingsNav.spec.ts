import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import SettingsNav from '../SettingsNav.vue'

vi.mock('vue-router', () => ({
  useRoute: () => ({ name: 'settings-config', path: '/settings/config', params: {}, query: {}, hash: '', fullPath: '/settings/config', matched: [], redirectedFrom: undefined, meta: {} }) as RouteLocationNormalizedLoaded,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  RouterLink: { template: '<a><slot /></a>' },
}))

const messages = {
  'zh-CN': {
    settings: { configTab: '配置管理', knowledge: '知识库', dataControls: '数据控制' },
  },
}

function createI18nInstance() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages })
}

describe('SettingsNav', () => {
  it('renders config tab', () => {
    const wrapper = mount(SettingsNav, { global: { plugins: [createI18nInstance()] } })
    expect(wrapper.text()).toContain('配置管理')
  })

  it('renders knowledge tab', () => {
    const wrapper = mount(SettingsNav, { global: { plugins: [createI18nInstance()] } })
    expect(wrapper.text()).toContain('知识库')
  })

  it('renders data controls tab', () => {
    const wrapper = mount(SettingsNav, { global: { plugins: [createI18nInstance()] } })
    expect(wrapper.text()).toContain('数据控制')
  })

  it('renders links with correct paths', () => {
    const wrapper = mount(SettingsNav, { global: { plugins: [createI18nInstance()] } })
    expect(wrapper.html()).toContain('/settings/config')
    expect(wrapper.html()).toContain('/settings/knowledge')
    expect(wrapper.html()).toContain('/settings/data')
  })
})
