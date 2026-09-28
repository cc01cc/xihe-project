import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { i18n } from '../../../i18n'
import AgentTemplatesPanel from '../AgentTemplatesPanel.vue'

describe('AgentTemplatesPanel (PLAN-0374 T3.3)', () => {
  it('persists only the frozen template fields and canonical role permission atoms', async () => {
    const wrapper = mount(AgentTemplatesPanel, {
      props: { entries: {} },
      global: { plugins: [i18n] },
    })

    await wrapper.get('[data-testid="agent-role-name"]').setValue('Reader')
    await wrapper.get('[data-testid="agent-role-add-permission"]').trigger('click')
    await wrapper.get('[data-testid="agent-role-action-0"]').setValue('read')
    await wrapper.get('[data-testid="agent-role-resource-0"]').setValue('src/*')
    await wrapper.get('[data-testid="agent-role-form"]').trigger('submit')
    const roleSave = wrapper.emitted('save')?.at(-1)?.[0] as Record<string, string>
    const [role] = JSON.parse(roleSave.roles) as Array<{ id: string; name: string; permissions: unknown[] }>
    expect(role).toMatchObject({ name: 'Reader', permissions: [{ actionClass: 'read', resource: 'src/*' }] })
    expect(role.id).toMatch(/^[0-9a-f-]{36}$/i)
    await wrapper.setProps({ entries: roleSave, saving: true })
    await wrapper.setProps({ saving: false })
    await wrapper.get(`[data-testid="agent-role-edit-${role.id}"]`).trigger('click')
    await wrapper.get('[data-testid="agent-role-name"]').setValue('Reader v2')
    await wrapper.get('[data-testid="agent-role-form"]').trigger('submit')
    const roleUpdate = wrapper.emitted('save')?.at(-1)?.[0] as Record<string, string>
    expect(JSON.parse(roleUpdate.roles)).toMatchObject([{ id: role.id, name: 'Reader v2', permissions: [{ actionClass: 'read', resource: 'src/*' }] }])
    await wrapper.setProps({ entries: roleUpdate, saving: true })
    await wrapper.setProps({ saving: false })

    await wrapper.get('[data-testid="agent-template-name"]').setValue('Workspace Reader')
    await wrapper.get('[data-testid="agent-template-description"]').setValue('Reads project files')
    await wrapper.get('[data-testid="agent-template-prompt"]').setValue('Answer using project sources.')
    await wrapper.get('[data-testid="agent-template-tool-mode"]').setValue('workspace')
    await wrapper.get('[data-testid="agent-template-role"]').setValue(role.id)
    await wrapper.get('[data-testid="agent-template-provider"]').setValue('openai')
    await wrapper.get('[data-testid="agent-template-model"]').setValue('gpt-example')
    await wrapper.get('[data-testid="agent-template-form"]').trigger('submit')
    await flushPromises()

    const templateSave = wrapper.emitted('save')?.at(-1)?.[0] as Record<string, string>
    const [template] = JSON.parse(templateSave.templates) as Array<Record<string, unknown>>
    expect(template).toMatchObject({
      name: 'Workspace Reader',
      description: 'Reads project files',
      systemPrompt: 'Answer using project sources.',
      toolMode: 'workspace',
      provider: 'openai',
      model: 'gpt-example',
      roleId: role.id,
    })
    expect(Object.keys(template).sort()).toEqual(['description', 'id', 'model', 'name', 'provider', 'roleId', 'systemPrompt', 'toolMode'])
    expect(JSON.stringify(template)).not.toMatch(/secret|api.?key|token/i)
    await wrapper.setProps({ entries: templateSave, saving: true })
    await wrapper.setProps({ saving: false })
    expect(wrapper.get(`[data-testid="agent-template-edit-${template.id}"]`).text()).toBe('编辑模板')
  })

  it('requires confirmation before removing a template', async () => {
    const template = {
      id: 'template-1', name: 'Existing', description: '', systemPrompt: 'Keep stable',
      toolMode: 'none',
    }
    const wrapper = mount(AgentTemplatesPanel, {
      props: { entries: { roles: '[]', templates: JSON.stringify([template]) } },
      global: { plugins: [i18n] },
    })
    const remove = wrapper.get('[data-testid="agent-template-delete-template-1"]')
    await remove.trigger('click')
    expect(wrapper.emitted('save')).toBeUndefined()
    await remove.trigger('click')
    const saved = wrapper.emitted('save')?.[0]?.[0] as Record<string, string>
    expect(JSON.parse(saved.templates)).toEqual([])
    await wrapper.setProps({ entries: saved, saving: true })
    await wrapper.setProps({ saving: false })
  })

  it('fails closed when the stored layer contains malformed JSON', async () => {
    const wrapper = mount(AgentTemplatesPanel, {
      props: { entries: { roles: '{broken', templates: '[]' } },
      global: { plugins: [i18n] },
    })

    expect(wrapper.get('[role="alert"]').exists()).toBe(true)
    expect((wrapper.get('[data-testid="agent-template-save"]').element as HTMLButtonElement).disabled).toBe(true)
    expect((wrapper.get('[data-testid="agent-role-save"]').element as HTMLButtonElement).disabled).toBe(true)
    expect(wrapper.emitted('save')).toBeUndefined()
  })

  it('retains form values when a layer write fails', async () => {
    const wrapper = mount(AgentTemplatesPanel, {
      props: { entries: {}, saving: false },
      global: { plugins: [i18n] },
    })
    await wrapper.get('[data-testid="agent-template-name"]').setValue('Retryable template')
    await wrapper.get('[data-testid="agent-template-prompt"]').setValue('Keep this draft')
    await wrapper.get('[data-testid="agent-template-form"]').trigger('submit')
    await wrapper.setProps({ saving: true })
    await wrapper.setProps({ saving: false })

    expect((wrapper.get('[data-testid="agent-template-name"]').element as HTMLInputElement).value).toBe('Retryable template')
    expect((wrapper.get('[data-testid="agent-template-prompt"]').element as HTMLTextAreaElement).value).toBe('Keep this draft')
    expect(wrapper.get('[role="alert"]').text()).toContain('编辑内容已保留')
  })

  it('fails closed when array values do not match the stored contract', async () => {
    const wrapper = mount(AgentTemplatesPanel, {
      props: { entries: { roles: '[null]', templates: '[]' } },
      global: { plugins: [i18n] },
    })

    expect(wrapper.get('[role="alert"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="agent-role-save"]').attributes('disabled')).toBeDefined()
    expect(wrapper.emitted('save')).toBeUndefined()
  })
})
