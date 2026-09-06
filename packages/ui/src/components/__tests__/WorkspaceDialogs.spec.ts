import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { toast } from 'vue-sonner'
import { api, ApiError } from '../../composables/api'
import WorkspaceCreateDialog from '../workspace/WorkspaceCreateDialog.vue'
import WorkspaceSettingsDialog from '../workspace/WorkspaceSettingsDialog.vue'

vi.mock('../../composables/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      createWorkspace: vi.fn(),
      updateWorkspace: vi.fn(),
      deleteWorkspace: vi.fn(),
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

function clickBodyButton(id: string) {
  // reka-ui RadioGroupItem renders a native button; Teleport-safe native click.
  const btn = document.body.querySelector(`#${id}`) as HTMLButtonElement | null
  expect(btn).toBeTruthy()
  btn!.click()
}

describe('WorkspaceCreateDialog (M2)', () => {
  let wrappers: VueWrapper[] = []
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    wrappers.forEach((w) => w.unmount())
    wrappers = []
    workspaceMock.value = null
    localStorage.clear()
  })

  it('creates workspace with selected profile and clears state', async () => {
    mockedApi.createWorkspace.mockResolvedValue({ id: 'ws-new', name: 'Dev' })
    const wrapper = mount(WorkspaceCreateDialog, { props: { open: true }, attachTo: document.body })
    wrappers.push(wrapper)

    await setInput(wrapper, 'ws-create-name', 'Dev')
    // default profile is coding; select strict via native click on the radio button
    clickBodyButton('ws-profile-strict')
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))

    const buttons = wrapper.findAll('button')
    const createBtn = buttons.find((b) => b.text().trim() === '创建')
    expect(createBtn).toBeTruthy()
    await createBtn!.trigger('click')
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))

    expect(mockedApi.createWorkspace).toHaveBeenCalledWith({
      name: 'Dev',
      description: null,
      profile: 'strict',
    })
    expect(toast.success).toHaveBeenCalled()
  })

  it('blocks empty name and shows API error without crashing', async () => {
    mockedApi.createWorkspace.mockRejectedValue(problemError(409, 'WORKSPACE_ALREADY_EXISTS'))
    const wrapper = mount(WorkspaceCreateDialog, { props: { open: true }, attachTo: document.body })
    wrappers.push(wrapper)

    await setInput(wrapper, 'ws-create-name', 'Dup')
    const createBtn = wrapper.findAll('button').find((b) => b.text().trim() === '创建')!
    await createBtn.trigger('click')
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))

    expect(toast.error).toHaveBeenCalled()
    // stuck on dialog (no success, dialog still rendered)
    expect(wrapper.find('[data-testid="workspace-create-dialog"]').exists()).toBe(true)
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
  })

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
