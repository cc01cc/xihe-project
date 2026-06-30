import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ConfigDomainPanel from '../settings/ConfigDomainPanel.vue'
import type { DomainField } from '../settings/ConfigDomainPanel.vue'
import { createI18n } from 'vue-i18n'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      settings: { notSet: '(not set)', empty: '(empty)', resetToDefault: 'Reset' },
      common: { save: 'Save' },
    },
  },
})

const schema: DomainField[] = [
  { key: 'defaultProvider', label: 'Provider', type: 'select', options: [
    { label: 'DeepSeek', value: 'deepseek' },
    { label: 'OpenAI', value: 'openai' },
  ]},
  { key: 'apiKey', label: 'API Key', type: 'password' },
  { key: 'model', label: 'Model', type: 'text' },
  { key: 'maxTokens', label: 'Max Tokens', type: 'number' },
]

function mountPanel(props: Record<string, unknown> = {}) {
  return mount(ConfigDomainPanel, {
    props: {
      domain: 'test',
      title: 'Test Domain',
      entries: {},
      schema,
      ...props,
    },
    global: { plugins: [i18n] },
  })
}

async function expandPanel(wrapper: ReturnType<typeof mountPanel>) {
  await wrapper.find('button').trigger('click')
}

describe('ConfigDomainPanel', () => {
  it('TC1: renders all schema fields when entries is empty', async () => {
    const wrapper = mountPanel({ entries: {} })
    await expandPanel(wrapper)

    const labels = wrapper.findAll('.text-muted-foreground.w-1\\/3')
    expect(labels).toHaveLength(4)
    expect(labels[0].text()).toBe('Provider')
    expect(labels[1].text()).toBe('API Key')
    expect(labels[2].text()).toBe('Model')
    expect(labels[3].text()).toBe('Max Tokens')
  })

  it('TC2: fills values from entries', async () => {
    const wrapper = mountPanel({
      entries: { defaultProvider: 'deepseek', apiKey: 'sk-xxx', model: 'gpt-4', maxTokens: '4096' },
    })
    await expandPanel(wrapper)

    const inputs = wrapper.findAll('input')
    const selects = wrapper.findAll('select')
    expect(selects[0].element.value).toBe('deepseek')
    expect(inputs[0].element.value).toBe('sk-xxx')
    expect(inputs[1].element.value).toBe('gpt-4')
    expect(inputs[2].element.value).toBe('4096')
  })

  it('TC3: missing entry fields default to empty string', async () => {
    const wrapper = mountPanel({
      entries: { model: 'gpt-4' },
    })
    await expandPanel(wrapper)

    const inputs = wrapper.findAll('input')
    expect(inputs[0].element.value).toBe('')
    expect(inputs[1].element.value).toBe('gpt-4')
    expect(inputs[2].element.value).toBe('')
  })

  it('TC4: readonly mode shows text instead of inputs', async () => {
    const wrapper = mountPanel({
      entries: { apiKey: 'sk-12345678', model: 'gpt-4' },
      readonly: true,
    })
    await expandPanel(wrapper)

    expect(wrapper.find('input').exists()).toBe(false)
    expect(wrapper.find('select').exists()).toBe(false)
    const spans = wrapper.findAll('.flex-1.text-sm')
    const passwordSpan = spans.find(s => s.text().includes('****'))
    expect(passwordSpan).toBeTruthy()
    expect(passwordSpan!.text()).toBe('sk-****5678')
  })

  it('TC5: select type renders dropdown with options', async () => {
    const wrapper = mountPanel()
    await expandPanel(wrapper)

    const select = wrapper.find('select')
    expect(select.exists()).toBe(true)
    const options = select.findAll('option')
    expect(options).toHaveLength(2)
    expect(options[0].text()).toBe('DeepSeek')
    expect(options[1].text()).toBe('OpenAI')
  })

  it('TC6: save emits editing values', async () => {
    const wrapper = mountPanel({
      entries: { apiKey: 'sk-old', model: 'old-model' },
    })
    await expandPanel(wrapper)

    const modelInput = wrapper.findAll('input')[1]
    await modelInput.setValue('new-model')
    await wrapper.findAll('button').filter(b => b.text() === 'Save')[0].trigger('click')

    const emitted = wrapper.emitted('save')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toEqual({
      defaultProvider: '',
      apiKey: 'sk-old',
      model: 'new-model',
      maxTokens: '',
    })
  })

  it('TC7: admin mode shows reset button and emits reset', async () => {
    const wrapper = mountPanel({ admin: true })
    await expandPanel(wrapper)

    const resetButtons = wrapper.findAll('button').filter(b => b.text().includes('↺'))
    expect(resetButtons.length).toBe(4)

    await resetButtons[2].trigger('click')
    const emitted = wrapper.emitted('reset')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('model')
  })
})
