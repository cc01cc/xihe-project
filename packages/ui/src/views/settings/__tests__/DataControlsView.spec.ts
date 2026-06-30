import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import type { RouteLocationNormalizedLoaded } from 'vue-router'

vi.mock('vue-router', () => ({
  useRoute: () => ({ name: 'settings-data', path: '/settings/data', params: {}, query: {}, hash: '', fullPath: '/settings/data', matched: [], redirectedFrom: undefined, meta: {} }) as RouteLocationNormalizedLoaded,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  RouterLink: { template: '<a><slot /></a>' },
}))

const messages = {
  'zh-CN': {
    settings: {
      dataControls: '数据控制',
      exportSettings: '导出设置',
      exportChats: '导出聊天',
      import: '导入',
      configTab: '配置管理',
      knowledge: '知识库',
    },
    common: {
      confirm: '确认',
    },
  },
}

function createI18nInstance() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages })
}

beforeEach(() => {
  setActivePinia(createPinia())
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock')
  globalThis.URL.revokeObjectURL = vi.fn()
})

describe('DataControlsView', () => {
  it('renders title', async () => {
    const { default: DataControlsView } = await import('../DataControlsView.vue')
    const wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } })
    expect(wrapper.text()).toContain('数据控制')
  })

  it('renders export settings button', async () => {
    const { default: DataControlsView } = await import('../DataControlsView.vue')
    const wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } })
    expect(wrapper.text()).toContain('导出设置')
  })

  it('renders export chats button', async () => {
    const { default: DataControlsView } = await import('../DataControlsView.vue')
    const wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } })
    expect(wrapper.text()).toContain('导出聊天')
  })

  it('renders import button', async () => {
    const { default: DataControlsView } = await import('../DataControlsView.vue')
    const wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } })
    expect(wrapper.text()).toContain('导入')
  })

  it('opens ImportPreview on file selection', async () => {
    const { default: DataControlsView } = await import('../DataControlsView.vue')
    const wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } })
    const fileInput = wrapper.find('input[type="file"]')
    expect(fileInput.exists()).toBe(true)
  })

  it('renders SettingsNav with config tab', async () => {
    const { default: DataControlsView } = await import('../DataControlsView.vue')
    const wrapper = mount(DataControlsView, { global: { plugins: [createI18nInstance()] } })
    expect(wrapper.text()).toContain('配置管理')
    expect(wrapper.text()).toContain('知识库')
    expect(wrapper.text()).toContain('数据控制')
  })
})
