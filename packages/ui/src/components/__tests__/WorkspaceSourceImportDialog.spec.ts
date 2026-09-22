import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspaceSourceImportDialog from '../workspace/WorkspaceSourceImportDialog.vue'
import { i18n } from '../../i18n'

const { listImportSources, startWorkspaceImport, getWorkspaceImport, cancelWorkspaceImport, listWorkspaceImports } =
  vi.hoisted(() => ({
    listImportSources: vi.fn(),
    startWorkspaceImport: vi.fn(),
    getWorkspaceImport: vi.fn(),
    cancelWorkspaceImport: vi.fn(),
    listWorkspaceImports: vi.fn(),
  }))

vi.mock('../../composables/api', () => ({
  api: { listImportSources, startWorkspaceImport, getWorkspaceImport, cancelWorkspaceImport, listWorkspaceImports },
}))

function mountDialog() {
  return mount(WorkspaceSourceImportDialog, {
    props: { open: true, workspaceId: 'ws-1' },
    global: { plugins: [i18n] },
  })
}

function buttonByTestId(wrapper: ReturnType<typeof mountDialog>, testid: string) {
  return wrapper.get(`[data-testid="${testid}"]`)
}

describe('WorkspaceSourceImportDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listImportSources.mockResolvedValue({
      path: 'H:/zeogit',
      entries: [{ name: 'one', kind: 'directory', readable: true, size: 0 }],
    })
    listWorkspaceImports.mockResolvedValue([])
  })

  it('browses a Runtime-visible directory and starts an import job', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    await buttonByTestId(wrapper, 'workspace-import-path').setValue('H:/zeogit')
    await buttonByTestId(wrapper, 'workspace-import-read').trigger('click')
    await flushPromises()

    expect(listImportSources).toHaveBeenCalledWith('H:/zeogit')
    expect(wrapper.text()).toContain('one')

    startWorkspaceImport.mockResolvedValue({ importId: 'imp-1', status: 'completed' })
    getWorkspaceImport.mockResolvedValue({ status: 'completed' })
    await buttonByTestId(wrapper, 'workspace-import-start').trigger('click')
    await flushPromises()
    expect(startWorkspaceImport).toHaveBeenCalledWith('ws-1', expect.objectContaining({ sourcePath: 'H:/zeogit' }))
  })

  it('cancels a running import through the cancel API', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    await buttonByTestId(wrapper, 'workspace-import-path').setValue('H:/zeogit')
    startWorkspaceImport.mockResolvedValue({ importId: 'imp-2', status: 'running' })
    getWorkspaceImport.mockResolvedValue({ status: 'running' })
    await buttonByTestId(wrapper, 'workspace-import-start').trigger('click')
    await flushPromises()

    expect(buttonByTestId(wrapper, 'workspace-import-status').text()).toContain('进行中')
    cancelWorkspaceImport.mockResolvedValue({ status: 'cancelled' })
    await buttonByTestId(wrapper, 'workspace-import-cancel').trigger('click')
    await flushPromises()

    expect(cancelWorkspaceImport).toHaveBeenCalledWith('imp-2')
    expect(buttonByTestId(wrapper, 'workspace-import-status').text()).toContain('已取消')
    expect(wrapper.find('[data-testid="workspace-import-cancel"]').exists()).toBe(false)
  })

  it('recovers an in-flight import from durable records when opened', async () => {
    listWorkspaceImports.mockResolvedValue([
      { importId: 'imp-9', status: 'running', createdAt: '2026-09-21T00:00:00Z' },
      { importId: 'imp-8', status: 'completed', createdAt: '2026-09-20T00:00:00Z' },
    ])
    const wrapper = mountDialog()
    await flushPromises()

    expect(listWorkspaceImports).toHaveBeenCalledWith('ws-1')
    expect(wrapper.find('[data-testid="workspace-import-recovered"]').exists()).toBe(true)
    expect(buttonByTestId(wrapper, 'workspace-import-status').text()).toContain('进行中')
    expect(wrapper.find('[data-testid="workspace-import-cancel"]').exists()).toBe(true)
  })

  it('surfaces a failed import with its error code', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    await buttonByTestId(wrapper, 'workspace-import-path').setValue('H:/zeogit')
    startWorkspaceImport.mockResolvedValue({ importId: 'imp-3', status: 'failed' })
    getWorkspaceImport.mockResolvedValue({ status: 'failed', errorCode: 'IMPORT_SCAN_FAILED' })
    await buttonByTestId(wrapper, 'workspace-import-start').trigger('click')
    await flushPromises()

    const status = buttonByTestId(wrapper, 'workspace-import-status').text()
    expect(status).toContain('导入失败')
    expect(status).toContain('IMPORT_SCAN_FAILED')
  })
})
