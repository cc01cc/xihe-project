import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ConfigDomainPanel, { type DomainField } from '../settings/ConfigDomainPanel.vue'
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

    const labels = wrapper.findAll(String.raw`.text-muted-foreground.w-1\/3`)
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
      apiKey: 'sk-old',
      model: 'new-model',
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

  it('TC8: env-locked field shows env value, hides input, and is excluded from save', async () => {
    const wrapper = mountPanel({
      entries: { model: 'db-model', apiKey: 'sk-old' },
      envLocked: { model: 'env-model' },
    })
    await expandPanel(wrapper)

    const lock = wrapper.find('[data-testid="config-env-lock-test-model"]')
    expect(lock.exists()).toBe(true)
    expect(lock.text()).toBe('env-model')
    expect(wrapper.text()).toContain('env')

    const inputs = wrapper.findAll('input')
    expect(inputs).toHaveLength(2)

    await inputs[1].setValue('8192')
    await wrapper.findAll('button').filter(b => b.text() === 'Save')[0].trigger('click')

    const emitted = wrapper.emitted('save')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toEqual({ apiKey: 'sk-old', maxTokens: 8192 })
    expect(emitted![0][0]).not.toHaveProperty('model')
  })

  it('TC9: json fields render a textarea and are emitted verbatim', async () => {
    const jsonSchema: DomainField[] = [
      { key: 'defaults', label: 'Defaults', type: 'json' },
    ]
    const wrapper = mountPanel({ schema: jsonSchema, entries: { defaults: '{"softThresholdPct":0.8}' } })
    await expandPanel(wrapper)

    const textarea = wrapper.find('textarea')
    expect(textarea.exists()).toBe(true)
    expect(textarea.element.value).toBe('{"softThresholdPct":0.8}')

    await textarea.setValue('{"softThresholdPct":0.9}')
    await wrapper.findAll('button').filter(b => b.text() === 'Save')[0].trigger('click')
    expect(wrapper.emitted('save')![0][0]).toEqual({ defaults: '{"softThresholdPct":0.9}' })
  })
})
