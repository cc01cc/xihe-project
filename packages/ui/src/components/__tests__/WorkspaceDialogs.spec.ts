import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { toast } from 'vue-sonner'
import { api, ApiError } from '../../composables/api'
import type { WorkspaceDirectAttachExecutionMode } from '../../types'
import WorkspaceCreateDialog from '../workspace/WorkspaceCreateDialog.vue'
import WorkspaceSettingsDialog from '../workspace/WorkspaceSettingsDialog.vue'
import { i18n } from '../../i18n'

vi.mock('../../composables/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      createWorkspace: vi.fn(),
      updateWorkspace: vi.fn(),
      deleteWorkspace: vi.fn(),
      listImportSources: vi.fn(),
      preflightDirectAttach: vi.fn(),
    },
  }
})

vi.mock('vue-sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const { workspaceMock } = vi.hoisted(() => ({
  workspaceMock: { value: null as null | { id: string; name: string } },
}))

vi.mock('../../stores/auth', () => ({
  useAuthStore: () => ({
    get workspace() {
      return workspaceMock.value
    },
    set workspace(v: null | { id: string; name: string }) {
      workspaceMock.value = v
    },
    currentWorkspaceId: workspaceMock.value?.id ?? null,
  }),
}))

const mockedApi = vi.mocked(api, true)

function problemError(status: number, code: string): ApiError {
  return new ApiError({ status, code, detail: code, requestId: 'test' })
}

function preflightResult(
  executionMode: WorkspaceDirectAttachExecutionMode,
  available: boolean,
  reason?: string,
) {
  return {
    contractVersion: 'v1',
    backendKind: executionMode,
    backendRevision: 'builtin',
    maturity: executionMode === 'windows-mxc' ? 'experimental' : 'stable',
    executionMode,
    available,
    reason: reason ?? null,
    checkedAt: '2026-09-21T00:00:00Z',
  } as const
}

async function bodyEl<T extends Element>(selector: string): Promise<T> {
  await vi.waitFor(() => {
    expect(document.body.querySelector(selector)).toBeTruthy()
  })
  return document.body.querySelector(selector) as T
}

async function clickBody(selector: string) {
  const el = await bodyEl<HTMLElement>(selector)
  el.click()
  await nextTick()
}

async function setBodyValue(selector: string, value: string) {
  const input = await bodyEl<HTMLInputElement>(selector)
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

function submitDisabled(): boolean {
  const btn = document.body.querySelector('[data-testid="workspace-create-submit"]') as HTMLButtonElement | null
  return !btn || btn.disabled
}

async function mountCreateDialog(wrappers: VueWrapper[]) {
  const wrapper = mount(WorkspaceCreateDialog, {
    props: { open: true },
    attachTo: document.body,
    global: { plugins: [i18n] },
  })
  wrappers.push(wrapper)
  await bodyEl('[data-testid="workspace-create-dialog"]')
  return wrapper
}

async function driveDirectAttachToExecution(
  entries: Array<{ name: string; kind: string; readable: boolean; size: number }> = [
    { name: 'src', kind: 'directory', readable: true, size: 0 },
  ],
) {
  mockedApi.listImportSources.mockResolvedValue({ path: 'H:\\projects\\demo', entries })
  await clickBody('[data-testid="workspace-storage-direct"]')
  await setBodyValue('[data-testid="workspace-source-path"]', 'H:\\projects\\demo')
  await clickBody('[data-testid="workspace-source-read"]')
  await vi.waitFor(() => {
    expect(document.body.querySelector('[data-testid="workspace-source-browser"] button')).toBeTruthy()
  })
  await clickBody('[data-testid="workspace-source-use"]')
}

describe('WorkspaceCreateDialog (PLAN-0384)', () => {
  let wrappers: VueWrapper[] = []
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    wrappers.forEach((w) => w.unmount())
    wrappers = []
    workspaceMock.value = null
    localStorage.clear()
    document.body.innerHTML = ''
  })

  it('submits a managed_import workspace payload without hostPath, executionMode or profile', async () => {
    mockedApi.createWorkspace.mockResolvedValue({ id: 'ws-managed', name: 'Managed' })
    await mountCreateDialog(wrappers)

    // Managed import has no host path to probe and is docker-only on the
    // implemented backend contract, so it skips the execution-mode step.
    await clickBody('[data-testid="workspace-storage-managed"]')
    await setBodyValue('[data-testid="workspace-create-name"]', 'Managed')
    await clickBody('[data-testid="workspace-create-submit"]')
    await vi.waitFor(() => expect(mockedApi.createWorkspace).toHaveBeenCalled())

    const payload = mockedApi.createWorkspace.mock.calls[0]?.[0]
    expect(payload).toEqual({
      name: 'Managed',
      description: null,
      storageMode: 'managed_import',
      idempotencyKey: expect.any(String),
    })
    expect(payload?.executionMode).toBeUndefined()
    expect(payload?.hostPath).toBeUndefined()
    expect(payload?.profile).toBeUndefined()
    expect(toast.success).toHaveBeenCalled()
  })

  it('selects a directory via the source browser and submits a direct_attach payload with a stable idempotency key', async () => {
    mockedApi.preflightDirectAttach.mockImplementation(({ executionMode }) =>
      Promise.resolve(preflightResult(executionMode, true)),
    )
    mockedApi.createWorkspace
      .mockRejectedValueOnce(problemError(409, 'WORKSPACE_ALREADY_EXISTS'))
      .mockResolvedValueOnce({ id: 'ws-direct', name: 'Direct' })

    await mountCreateDialog(wrappers)
    await driveDirectAttachToExecution()

    await vi.waitFor(() => {
      const mxc = document.body.querySelector('[data-testid="workspace-execution-mode-mxc"]') as HTMLButtonElement | null
      expect(mxc && !mxc.disabled).toBe(true)
    })
    expect(mockedApi.preflightDirectAttach).toHaveBeenCalledWith({ hostPath: 'H:\\projects\\demo', executionMode: 'windows-mxc' })
    expect(mockedApi.preflightDirectAttach).toHaveBeenCalledWith({ hostPath: 'H:\\projects\\demo', executionMode: 'windows-host' })

    await clickBody('[data-testid="workspace-execution-next"]')
    await setBodyValue('[data-testid="workspace-create-name"]', 'Direct')
    await clickBody('[data-testid="workspace-create-submit"]')
    await vi.waitFor(() => expect(mockedApi.createWorkspace).toHaveBeenCalledTimes(1))

    const first = mockedApi.createWorkspace.mock.calls[0]?.[0]
    expect(first).toEqual({
      name: 'Direct',
      description: null,
      storageMode: 'direct_attach',
      executionMode: 'windows-mxc',
      hostPath: 'H:\\projects\\demo',
      idempotencyKey: expect.any(String),
    })

    // Retry reuses the same Idempotency-Key.
    await clickBody('[data-testid="workspace-create-submit"]')
    await vi.waitFor(() => expect(mockedApi.createWorkspace).toHaveBeenCalledTimes(2))
    expect(mockedApi.createWorkspace.mock.calls[1]?.[0].idempotencyKey).toBe(first?.idempotencyKey)
  })

  it('disables the MXC card when preflight reports unavailable and never auto-falls back to host', async () => {
    mockedApi.preflightDirectAttach.mockImplementation(({ executionMode }) =>
      Promise.resolve(
        executionMode === 'windows-mxc'
          ? preflightResult('windows-mxc', false, 'MXC_EXECUTABLE_MISSING')
          : preflightResult('windows-host', true),
      ),
    )

    await mountCreateDialog(wrappers)
    await driveDirectAttachToExecution()
    await bodyEl('[data-testid="workspace-mxc-guidance"]')

    const mxc = document.body.querySelector('[data-testid="workspace-execution-mode-mxc"]') as HTMLButtonElement
    expect(mxc.disabled).toBe(true)
    const mxcStatus = document.body.querySelector('[data-testid="workspace-execution-mxc-status"]')?.textContent ?? ''
    expect(mxcStatus).toContain('MXC_EXECUTABLE_MISSING')

    // No automatic fallback: Next stays blocked until the user explicitly switches.
    const next = document.body.querySelector('[data-testid="workspace-execution-next"]') as HTMLButtonElement
    expect(next.disabled).toBe(true)

    await clickBody('[data-testid="workspace-switch-to-host"]')
    await nextTick()
    const nextAfterSwitch = document.body.querySelector('[data-testid="workspace-execution-next"]') as HTMLButtonElement
    expect(nextAfterSwitch.disabled).toBe(false)
  })

  it('blocks submit until the host execution risk is acknowledged', async () => {
    mockedApi.preflightDirectAttach.mockImplementation(({ executionMode }) =>
      Promise.resolve(preflightResult(executionMode, true)),
    )
    mockedApi.createWorkspace.mockResolvedValue({ id: 'ws-host', name: 'Host' })

    await mountCreateDialog(wrappers)
    await driveDirectAttachToExecution()
    await vi.waitFor(() => {
      const host = document.body.querySelector('[data-testid="workspace-execution-mode-host"]') as HTMLButtonElement | null
      expect(host && !host.disabled).toBe(true)
    })

    await clickBody('[data-testid="workspace-execution-mode-host"]')
    await clickBody('[data-testid="workspace-execution-next"]')
    await setBodyValue('[data-testid="workspace-create-name"]', 'Host')

    expect(submitDisabled()).toBe(true)
    await clickBody('[data-testid="workspace-host-risk-ack"]')
    expect(submitDisabled()).toBe(false)

    await clickBody('[data-testid="workspace-create-submit"]')
    await vi.waitFor(() => expect(mockedApi.createWorkspace).toHaveBeenCalled())
    expect(mockedApi.createWorkspace.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      storageMode: 'direct_attach',
      executionMode: 'windows-host',
      hostPath: 'H:\\projects\\demo',
    }))
  })

  it('surfaces a structured reason when the capability preflight fails', async () => {
    mockedApi.preflightDirectAttach.mockRejectedValue(problemError(502, 'RUNTIME_UNAVAILABLE'))

    await mountCreateDialog(wrappers)
    await driveDirectAttachToExecution()

    const error = await bodyEl('[data-testid="workspace-preflight-error"]')
    expect(error.textContent ?? '').toContain('Runtime 暂不可达')

    const next = document.body.querySelector('[data-testid="workspace-execution-next"]') as HTMLButtonElement
    expect(next.disabled).toBe(true)
  })
})

describe('WorkspaceSettingsDialog (M2)', () => {
  let wrappers: VueWrapper[] = []
  beforeEach(() => {
    vi.clearAllMocks()
    workspaceMock.value = { id: 'ws-1', name: 'Dev Workspace' }
  })
  afterEach(() => {
    wrappers.forEach((w) => w.unmount())
    wrappers = []
    document.body.innerHTML = ''
  })

  async function setInput(wrapper: VueWrapper, id: string, value: string) {
    const input = wrapper.find(`#${id}`)
    expect(input.exists()).toBe(true)
    await input.setValue(value)
  }

  async function setBodyInput(id: string, value: string) {
    // AlertDialog content is teleported outside the wrapper tree; use native events.
    // Portal mount can be rAF-deferred under jsdom, so poll instead of single nextTick.
    await vi.waitFor(() => {
      expect(document.body.querySelector(`#${id}`)).toBeTruthy()
    })
    const input = document.body.querySelector(`#${id}`) as HTMLInputElement | null
    input!.value = value
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
  }

  it('saves rename via updateWorkspace', async () => {
    mockedApi.updateWorkspace.mockResolvedValue({ id: 'ws-1', name: 'Renamed' })
    const wrapper = mount(WorkspaceSettingsDialog, { props: { open: true }, attachTo: document.body })
    wrappers.push(wrapper)

    await setInput(wrapper, 'ws-settings-name', 'Renamed')
    const saveBtn = wrapper.findAll('button').find((b) => b.text().trim() === '保存')!
    await saveBtn.trigger('click')
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))

    expect(mockedApi.updateWorkspace).toHaveBeenCalledWith('ws-1', expect.objectContaining({ name: 'Renamed' }))
    expect(toast.success).toHaveBeenCalled()
  })

  it('requires exact workspace name before deleting', async () => {
    const wrapper = mount(WorkspaceSettingsDialog, { props: { open: true }, attachTo: document.body })
    wrappers.push(wrapper)

    const delBtn = wrapper.findAll('button').find((b) => b.text().trim() === '删除…')!
    await delBtn.trigger('click')
    await nextTick()

    // wrong name first: dialog must stay open and show the guard error
    await setBodyInput('ws-delete-confirm', 'Wrong Name')
    await nextTick()
    const confirmBtn = document.body.querySelector(
      '[data-testid="workspace-delete-confirm-btn"]',
    ) as HTMLButtonElement | null
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.click()
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))

    expect(mockedApi.deleteWorkspace).not.toHaveBeenCalled()
    // guard keeps the dialog open (regression: AlertDialogAction auto-close)
    expect(document.body.querySelector('#ws-delete-confirm')).toBeTruthy()

    // exact name
    await setBodyInput('ws-delete-confirm', 'Dev Workspace')
    await nextTick()
    mockedApi.deleteWorkspace.mockResolvedValue(undefined)
    ;(confirmBtn as HTMLButtonElement).click()
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))

    expect(mockedApi.deleteWorkspace).toHaveBeenCalledWith('ws-1')
    expect(toast.success).toHaveBeenCalled()
  })
})
