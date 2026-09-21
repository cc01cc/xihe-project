import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import WorkspaceEnvironmentView from '../WorkspaceEnvironmentView.vue'
import { api } from '../../../composables/api'

vi.mock('vue-router', () => ({
  useRoute: () => ({
    params: { workspaceId: 'workspace-1' },
    path: '/workspace/workspace-1/environment',
    query: {},
  }),
}))

vi.mock('vue-sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('../../../composables/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../composables/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getWorkspaceEnvironment: vi.fn(),
      getWorkspaceJobs: vi.fn(),
    },
  }
})

const mockedApi = vi.mocked(api, true)

function environment(executionMode: 'docker' | 'windows-mxc' | 'windows-host') {
  return {
    workspaceId: 'workspace-1',
    status: 'ready',
    storageBackend: 'local',
    storageRef: 'workspace-1',
    storageMode: 'managed_import' as const,
    hostPath: null,
    executionMode,
    runtime: {
      status: 'up',
      deviceId: 'device-1',
      lastHeartbeatAt: '2026-09-21T00:00:00Z',
    },
  }
}

function job(overrides: Record<string, unknown>) {
  return {
    operationId: 'op-1',
    operationItemId: 'item-1',
    workspaceId: 'workspace-1',
    sessionId: null,
    runId: null,
    source: 'ui',
    scope: 'session',
    status: 'running',
    jobId: 'job-1',
    startedAt: '2026-09-21T00:00:00Z',
    endedAt: null,
    exitCode: null,
    timeoutSecs: 60,
    cancelReason: null,
    backendKind: 'docker',
    executionMode: 'docker',
    actorType: 'user',
    createdAt: '2026-09-21T00:00:00Z',
    cleanupStatus: 'running',
    errorCode: null,
    ...overrides,
  }
}

async function mountView(): Promise<VueWrapper> {
  const wrapper = mount(WorkspaceEnvironmentView)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('xihe-token', 'mock-token')
  setActivePinia(createPinia())
  mockedApi.getWorkspaceEnvironment.mockResolvedValue(environment('docker') as never)
  mockedApi.getWorkspaceJobs.mockResolvedValue([] as never)
})

describe('WorkspaceEnvironmentView job projection', () => {
  it('renders scope, backend kind, status label and the terminal / cleanup detail per job', async () => {
    mockedApi.getWorkspaceJobs.mockResolvedValue([
      job({
        operationItemId: 'item-run',
        status: 'running',
        scope: 'workspace',
        backendKind: 'windows-host',
        cleanupStatus: 'running',
      }),
      job({
        operationItemId: 'item-done',
        status: 'cancelled',
        scope: 'run',
        backendKind: 'docker',
        cleanupStatus: 'completed',
        cancelReason: 'user_cancel',
        errorCode: 'RUNTIME_UNAVAILABLE',
      }),
    ] as never)

    const wrapper = await mountView()

    const secondary = wrapper.findAll('[data-testid="workspace-job-secondary"]')
    const statuses = wrapper.findAll('[data-testid="workspace-job-status"]')
    expect(secondary).toHaveLength(2)
    expect(statuses).toHaveLength(2)

    // Non-terminal job: scope + backend kind + cleanup status, never a cancel reason.
    expect(secondary[0].text()).toContain('workspace')
    expect(secondary[0].text()).toContain('windows-host')
    expect(secondary[0].text()).toContain('清理中')
    expect(secondary[0].text()).not.toContain('用户取消')
    expect(statuses[0].text()).toBe('运行中')

    // Terminal job: mapped cancel reason plus the raw error code.
    expect(secondary[1].text()).toContain('run')
    expect(secondary[1].text()).toContain('docker')
    expect(secondary[1].text()).toContain('用户取消')
    expect(secondary[1].text()).toContain('RUNTIME_UNAVAILABLE')
    expect(statuses[1].text()).toBe('已取消')
  })

  it('does not surface a not_started cleanup status as job detail', async () => {
    mockedApi.getWorkspaceJobs.mockResolvedValue([
      job({ operationItemId: 'item-pending', status: 'pending', cleanupStatus: 'not_started' }),
    ] as never)

    const wrapper = await mountView()

    expect(wrapper.get('[data-testid="workspace-job-secondary"]').text()).not.toContain('清理未开始')
    expect(wrapper.get('[data-testid="workspace-job-status"]').text()).toBe('等待中')
  })
})

describe('WorkspaceEnvironmentView job-start capability (PLAN-0396)', () => {
  it('disables start with an explicit reason when the runtime never reported', async () => {
    mockedApi.getWorkspaceEnvironment.mockResolvedValue(environment('windows-host') as never)

    const wrapper = await mountView()

    const hint = wrapper.get('[data-testid="workspace-job-start-hint"]')
    expect(hint.attributes('aria-disabled')).toBe('true')
    expect(hint.text()).toContain('能力未知')
  })

  it('disables start and shows the runtime reason when unavailable', async () => {
    mockedApi.getWorkspaceEnvironment.mockResolvedValue({
      ...environment('windows-mxc'),
      jobCapability: {
        backendKind: 'windows-mxc',
        canStart: true,
        available: false,
        unavailableReason: 'RUNTIME_UNREACHABLE',
      },
    } as never)

    const wrapper = await mountView()

    const hint = wrapper.get('[data-testid="workspace-job-start-hint"]')
    expect(hint.attributes('aria-disabled')).toBe('true')
    expect(hint.text()).toContain('RUNTIME_UNREACHABLE')
    expect(hint.text()).not.toContain('尚无启动器')
  })

  it('enables start and marks the unrestricted host backend', async () => {
    mockedApi.getWorkspaceEnvironment.mockResolvedValue({
      ...environment('windows-host'),
      jobCapability: {
        backendKind: 'windows-host',
        canStart: true,
        canCancel: true,
        canStreamOutput: true,
        canIsolateFilesystem: false,
        available: true,
      },
    } as never)

    const wrapper = await mountView()

    const hint = wrapper.get('[data-testid="workspace-job-start-hint"]')
    expect(hint.attributes('aria-disabled')).toBe('false')
    expect(hint.text()).toContain('windows-host')
    expect(hint.text()).toContain('无隔离')
  })

  it('enables start and marks the sandboxed mxc backend', async () => {
    mockedApi.getWorkspaceEnvironment.mockResolvedValue({
      ...environment('windows-mxc'),
      jobCapability: {
        backendKind: 'windows-mxc',
        canStart: true,
        canIsolateFilesystem: true,
        available: true,
      },
    } as never)

    const wrapper = await mountView()

    const hint = wrapper.get('[data-testid="workspace-job-start-hint"]')
    expect(hint.attributes('aria-disabled')).toBe('false')
    expect(hint.text()).toContain('windows-mxc')
    expect(hint.text()).toContain('沙盒隔离')
  })
})
