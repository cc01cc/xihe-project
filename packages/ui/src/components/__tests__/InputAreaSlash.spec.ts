import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import InputArea from '../chat/InputArea.vue'

// Stub browser APIs that child components depend on
beforeAll(() => {
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getDisplayMedia: async () => ({}) } },
    configurable: true,
  })
})

beforeEach(() => {
  setActivePinia(createPinia())
})

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: { chat: { placeholder: 'Type a message...', image: 'Image', voice: 'Voice' }, multimodal: { captureScreen: 'Screenshot' } } },
})

function mountInput() {
  return mount(InputArea, {
    global: {
      plugins: [i18n],
      stubs: {
        ModelPopover: { template: '<div />' },
      },
    },
  })
}

describe('InputArea slash commands', () => {
  it('shows command menu when / is typed', async () => {
    const wrapper = mountInput()
    const textarea = wrapper.find('textarea')
    await textarea.setValue('/')
    await textarea.trigger('input')
    expect(wrapper.text()).toContain('/search')
    expect(wrapper.text()).toContain('/help')
  })

  it('hides command menu after space is typed', async () => {
    const wrapper = mountInput()
    const textarea = wrapper.find('textarea')
    await textarea.setValue('/search')
    await textarea.trigger('input')
    expect(wrapper.text()).toContain('/search')
    await textarea.setValue('/search query')
    await textarea.trigger('input')
    expect(wrapper.text()).not.toContain('/search')
  })

  it('filters commands as user types', async () => {
    const wrapper = mountInput()
    const textarea = wrapper.find('textarea')
    await textarea.setValue('/exp')
    await textarea.trigger('input')
    expect(wrapper.text()).toContain('/export')
    expect(wrapper.text()).not.toContain('/search')
  })

  it('closes menu on Escape', async () => {
    const wrapper = mountInput()
    const textarea = wrapper.find('textarea')
    await textarea.setValue('/')
    await textarea.trigger('input')
    expect(wrapper.text()).toContain('/search')
    await textarea.trigger('keydown', { key: 'Escape' })
    expect(wrapper.text()).not.toContain('/search')
  })

  it('triggers send when /help is selected', async () => {
    const wrapper = mountInput()
    const textarea = wrapper.find('textarea')
    await textarea.setValue('/help')
    await textarea.trigger('input')
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toBeTruthy()
  })
})
