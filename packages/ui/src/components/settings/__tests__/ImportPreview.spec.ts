import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { nextTick } from 'vue'
import ImportPreview from '../ImportPreview.vue'

const messages = {
  'zh-CN': {
    settings: { importPreview: '导入预览' },
    common: { cancel: '取消', confirm: '确认' },
  },
}

function createI18nInstance() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages })
}

function createMockFile(content: string, name: string): File {
  return {
    name,
    size: content.length,
    lastModified: Date.now(),
    text: () => Promise.resolve(content),
    slice: () => new Blob(),
    stream: () => new ReadableStream(),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    type: 'application/json',
  } as File
}

beforeEach(() => {
  // oxlint-disable-next-line no-console
  console.warn = vi.fn()
})

describe('ImportPreview', () => {
  it('renders nothing when no file prop', async () => {
    const _wrapper = mount(ImportPreview, {
      props: { file: null },
      global: { plugins: [createI18nInstance()] },
    })
    expect(_wrapper.text()).toBe('')
  })

  it('parses valid JSON and shows preview', async () => {
    const validJson = JSON.stringify({
      chats: [
        { id: '1', messages: [{ role: 'user', content: 'hi' }] },
        { id: '2', messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }] },
      ],
    })
    const file = createMockFile(validJson, 'export.json')
    const wrapper = mount(ImportPreview, {
      props: { file },
      global: { plugins: [createI18nInstance()] },
    })

    // Wait for async parseFile (watch immediate) to complete
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('导入预览')
    })
    expect(wrapper.text()).toContain('2')
    expect(wrapper.text()).toContain('3')
  })

  it('shows parse error for invalid JSON', async () => {
    const file = createMockFile('not json', 'bad.json')
    const _wrapper = mount(ImportPreview, {
      props: { file },
      global: { plugins: [createI18nInstance()] },
    })

    await vi.waitFor(() => {
      // oxlint-disable-next-line no-console
      expect(console.warn).toHaveBeenCalled()
    })
  })

  it('emits confirm on confirm button click', async () => {
    const validJson = JSON.stringify({ chats: [{ id: '1', messages: [{ role: 'user', content: 'hi' }] }] })
    const file = createMockFile(validJson, 'export.json')
    const wrapper = mount(ImportPreview, {
      props: { file },
      global: { plugins: [createI18nInstance()] },
    })

    // Wait for modal to appear after async parse
    await vi.waitFor(() => {
      expect(wrapper.findAll('button').length).toBeGreaterThanOrEqual(2)
    })

    const confirmBtn = wrapper.findAll('button').at(-1)
    await confirmBtn!.trigger('click')
    await nextTick()

    expect(wrapper.emitted('confirm')).toBeTruthy()
    expect(wrapper.emitted('confirm')![0][0]).toHaveProperty('file')
    expect(wrapper.emitted('confirm')![0][0]).toHaveProperty('chatCount', 1)
    expect(wrapper.emitted('confirm')![0][0]).toHaveProperty('messageCount', 1)
  })

  it('emits cancel on cancel button click', async () => {
    const validJson = JSON.stringify({ chats: [{ id: '1', messages: [] }] })
    const file = createMockFile(validJson, 'export.json')
    const wrapper = mount(ImportPreview, {
      props: { file },
      global: { plugins: [createI18nInstance()] },
    })

    // Wait for modal to appear after async parse
    await vi.waitFor(() => {
      expect(wrapper.findAll('button').length).toBeGreaterThanOrEqual(2)
    })

    const cancelBtn = wrapper.findAll('button').at(0)
    await cancelBtn!.trigger('click')
    await nextTick()

    expect(wrapper.emitted('cancel')).toBeTruthy()
  })
})
