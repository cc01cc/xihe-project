import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import WorkspaceSourceImportDialog from '../workspace/WorkspaceSourceImportDialog.vue'

const { listImportSources, startWorkspaceImport, getWorkspaceImport } = vi.hoisted(() => ({
  listImportSources: vi.fn(),
  startWorkspaceImport: vi.fn(),
  getWorkspaceImport: vi.fn(),
}))

vi.mock('../../composables/api', () => ({
  api: { listImportSources, startWorkspaceImport, getWorkspaceImport },
}))

describe('WorkspaceSourceImportDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listImportSources.mockResolvedValue({
      path: 'H:/zeogit',
      entries: [{ name: 'one', kind: 'directory', readable: true, size: 0 }],
    })
  })

  it('browses a Runtime-visible directory and starts an import job', async () => {
    const wrapper = mount(WorkspaceSourceImportDialog, {
      props: { open: true, workspaceId: 'ws-1' },
    })
    const input = wrapper.get('input')
    await input.setValue('H:/zeogit')
    await wrapper.findAll('button').find(button => button.text() === '读取')!.trigger('click')
    await flushPromises()

    expect(listImportSources).toHaveBeenCalledWith('H:/zeogit')
    expect(wrapper.text()).toContain('one')

    startWorkspaceImport.mockResolvedValue({ importId: 'imp-1', status: 'completed' })
    await wrapper.findAll('button').find(button => button.text() === '开始导入')!.trigger('click')
    await flushPromises()
    expect(startWorkspaceImport).toHaveBeenCalledWith('ws-1', expect.objectContaining({ sourcePath: 'H:/zeogit' }))
  })
})
