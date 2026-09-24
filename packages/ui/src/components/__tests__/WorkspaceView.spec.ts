import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import WorkspaceView from '../workspace/WorkspaceView.vue'
import WorkspaceAgentManagementDialog from '../workspace/WorkspaceAgentManagementDialog.vue'
import { useSessionStore } from '../../stores/session'
import { api } from '../../composables/api'

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { workspaceId: 'workspace-1' }, path: '/workspace/workspace-1', query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

vi.mock('../../composables/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getSessions: vi.fn(),
      createSession: vi.fn(),
      getWorkspaceAgents: vi.fn(),
    },
  }
})

const mockedApi = vi.mocked(api, true)

const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      workspace: {
        panelCode: 'Code',
        panelChanges: 'Changes',
        chatHeader: 'Workspace chat',
        noSession: 'No active session',
        createSession: 'New chat',
        chooseAgentTitle: 'Choose an Agent',
        chooseAgentLabel: 'Choose Agent',
        chooseAgentPlaceholder: 'Select Agent',
        noBoundAgent: 'No bound Agent',
        agentLoadFailed: 'Failed to load Agents',
        bindAgentAndSend: 'Bind and send',
        agentManagement: 'Agent management',
        activeAgent: 'Active Agent',
        agentManagementDescription: 'Manage Workspace Agents',
        boundAgents: 'Bound Agents',
        refreshAgents: 'Refresh',
        loadingAgents: 'Loading Agents',
        noAgentCapabilities: 'No tool permissions',
        defaultAgentTemplate: 'Default template',
        unbindAgent: 'Unbind',
        editAgentCap: 'Edit cap',
        createAgentPrincipal: 'Create Agent',
        agentName: 'Agent name',
        agentCreatePermissionNote: 'CREATE_ACCOUNT required',
        agentCapNote: 'Choose cap',
        bindAgent: 'Bind Agent',
        saveAgentCap: 'Save cap',
        agentActionRead: 'Read',
        agentActionWrite: 'Write',
        agentActionDelete: 'Delete',
        agentActionExec: 'Execute',
        agentActionNetwork: 'Network',
        agentActionCredential: 'Credential',
        agentResourceFor: 'Resource for {action}',
        agentCreatedUnbound: 'Created but unbound',
        agentBindFailed: 'Bind failed',
        agentCreateFailed: 'Create failed',
        agentSaveFailed: 'Save failed',
        agentUnbindFailed: 'Unbind failed',
        confirmAgentUnbind: 'Confirm unbind',
        cancel: 'Cancel',
        closePanel: 'Close',
        expandFiles: 'Expand the file tree',
        collapseFiles: 'Collapse the file tree',
        toggleCode: 'Toggle the code panel',
        toggleDiff: 'Toggle the changes panel',
      },
    },
  },
})

const stubs = {
  ChatPanel: { template: '<div data-testid="chat-panel-stub" />' },
  FileEditor: { template: '<div data-testid="file-editor-stub" />' },
  FileTreePanel: { template: '<div data-testid="file-tree-stub" />' },
  WorkspaceChangesPanel: { template: '<div data-testid="changes-panel-stub" />' },
}

function mountView(): VueWrapper {
  return mount(WorkspaceView, { global: { plugins: [i18n], stubs } })
}

async function settle() {
  await nextTick()
  await nextTick()
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('xihe-token', 'mock-token')
  localStorage.setItem('xihe-user', JSON.stringify({ id: 'user-1', email: 'test@xihe.local' }))
  localStorage.setItem('xihe-workspace', JSON.stringify({ id: 'workspace-1', name: 'Mock Workspace', ownerId: 'user-1' }))
  setActivePinia(createPinia())
  mockedApi.getSessions.mockResolvedValue({
    sessions: [
      { id: SESSION_A, title: 'A', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), workspaceId: 'workspace-1', archived: false },
      { id: SESSION_B, title: 'B', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), workspaceId: 'workspace-1', archived: false },
    ],
  })
  mockedApi.getWorkspaceAgents.mockResolvedValue([])
})

describe('WorkspaceView conversation-first layout (PLAN-0328 M3 T3.7)', () => {
  it('renders the conversation as the main column with the file tree rail visible and the auxiliary panel collapsed', async () => {
    useSessionStore().currentSessionId = SESSION_A
    const wrapper = mountView()
    await settle()
    await flushPromises()

    expect(wrapper.find('[data-testid="workspace-conversation"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-conversation"]').find('[data-testid="chat-panel-stub"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-file-tree"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="file-editor-stub"]').exists()).toBe(false)
  })

  it('collapses the file tree into a narrow rail and expands it again', async () => {
    useSessionStore().currentSessionId = SESSION_A
    const wrapper = mountView()
    await settle()
    await flushPromises()

    await wrapper.find('[data-testid="workspace-toolbar-toggle-tree"]').trigger('click')
    expect(wrapper.find('[data-testid="workspace-file-tree"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-tree-expand"]').exists()).toBe(true)

    await wrapper.find('[data-testid="workspace-tree-expand"]').trigger('click')
    expect(wrapper.find('[data-testid="workspace-file-tree"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-tree-expand"]').exists()).toBe(false)
  })

  it('toggles the code and changes auxiliary panels through the toolbar', async () => {
    useSessionStore().currentSessionId = SESSION_A
    const wrapper = mountView()
    await settle()
    await flushPromises()

    await wrapper.find('[data-testid="workspace-toolbar-code"]').trigger('click')
    expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-editor-stub"]').exists()).toBe(true)
    await wrapper.find('[data-testid="workspace-toolbar-changes"]').trigger('click')
    expect(wrapper.find('[data-testid="file-editor-stub"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="changes-panel-stub"]').exists()).toBe(true)

    await wrapper.find('[data-testid="workspace-toolbar-changes"]').trigger('click')
    expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(false)
  })

  it('closes the auxiliary panel from its own close action', async () => {
    useSessionStore().currentSessionId = SESSION_A
    const wrapper = mountView()
    await settle()
    await flushPromises()

    await wrapper.find('[data-testid="workspace-toolbar-code"]').trigger('click')
    await wrapper.find('[data-testid="workspace-aux-close"]').trigger('click')
    expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(false)
  })

  it('remembers the layout toggles per session within the component', async () => {
    const sessionStore = useSessionStore()
    sessionStore.currentSessionId = SESSION_A
    const wrapper = mountView()
    await settle()
    await flushPromises()

    await wrapper.find('[data-testid="workspace-toolbar-toggle-tree"]').trigger('click')
    await wrapper.find('[data-testid="workspace-toolbar-code"]').trigger('click')
    expect(wrapper.find('[data-testid="workspace-file-tree"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="file-editor-stub"]').exists()).toBe(true)

    sessionStore.currentSessionId = SESSION_B
    await settle()
    expect(wrapper.find('[data-testid="workspace-file-tree"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(false)

    sessionStore.currentSessionId = SESSION_A
    await settle()
    expect(wrapper.find('[data-testid="workspace-file-tree"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-editor-stub"]').exists()).toBe(true)
  })

  it('keeps the workspace usable without auto-creating a session', async () => {
    mockedApi.getSessions.mockResolvedValue({ sessions: [] })
    mockedApi.getWorkspaceAgents.mockResolvedValue([{
      principalId: 'agent-1', name: 'Research Agent', templateId: null,
      templateName: null, createdAt: new Date().toISOString(), permissions: [],
    }])
    mockedApi.createSession.mockResolvedValue({
      id: SESSION_A,
      title: 'New Chat',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspaceId: 'workspace-1',
      agentPrincipalId: 'agent-1',
      archived: false,
    })
    const wrapper = mountView()
    await nextTick()
    expect(wrapper.find('[data-testid="workspace-create-session"]').text()).toBe('New chat')

    await flushPromises()
    expect(wrapper.find('[data-testid="chat-panel-stub"]').exists()).toBe(false)

    await wrapper.find('[data-testid="workspace-create-session"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="chat-panel-stub"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-agent-principal-select"]').exists()).toBe(true)
    await wrapper.find('[data-testid="workspace-agent-principal-select"]').setValue('agent-1')
    await wrapper.find('[data-testid="workspace-create-agent-session"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="chat-panel-stub"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-active-agent"]').text()).toContain('agent-1')
    expect(mockedApi.createSession).toHaveBeenCalledWith('agent-1', 'New Chat')
  })

  it('opens the Workspace Agent management panel from the toolbar', async () => {
    mockedApi.getWorkspaceAgents.mockResolvedValue([{
      principalId: 'agent-1', name: 'Research Agent', templateId: null,
      templateName: null, createdAt: new Date().toISOString(), permissions: [],
    }])
    const wrapper = mountView()

    await wrapper.find('[data-testid="workspace-toolbar-agents"]').trigger('click')
    await flushPromises()

    expect(wrapper.findComponent(WorkspaceAgentManagementDialog).props('open')).toBe(true)
    expect(mockedApi.getWorkspaceAgents).toHaveBeenCalledWith('workspace-1')
  })
})
