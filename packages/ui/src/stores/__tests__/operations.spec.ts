import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { api } from '../../composables/api'
import { useOperationStore } from '../operations'

vi.mock('../../composables/api', () => ({
  api: {
    listOperations: vi.fn(),
    getOperationTrace: vi.fn(),
  },
}))

const listOperations = vi.mocked(api.listOperations)
const getOperationTrace = vi.mocked(api.getOperationTrace)

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
})

describe('useOperationStore', () => {
  it('loads paginated user operations', async () => {
    listOperations.mockResolvedValue({
      operations: [{ id: 'op-1', kind: 'chat', source: 'ui', actorType: 'user', status: 'completed' }],
      page: 1,
      size: 20,
      totalElements: 21,
      totalPages: 2,
    })

    const store = useOperationStore()
    await store.load({ status: 'completed', page: 1, size: 20 })

    expect(listOperations).toHaveBeenCalledWith({ status: 'completed', page: 1, size: 20 })
    expect(store.operations).toHaveLength(1)
    expect(store.page).toBe(1)
    expect(store.totalPages).toBe(2)
  })

  it('loads and clears a selected trace', async () => {
    const trace = {
      operation: { id: 'op-1', kind: 'chat', source: 'ui', actorType: 'user', status: 'completed' },
      items: [],
      attempts: [],
      events: [],
    }
    getOperationTrace.mockResolvedValue(trace)

    const store = useOperationStore()
    await store.loadTrace('op-1')
    expect(store.selectedTrace).toEqual(trace)

    store.clearTrace()
    expect(store.selectedTrace).toBeNull()
  })

  it('exposes the safe policy projection carried by trace items', async () => {
    const trace = {
      operation: { id: 'op-1', kind: 'chat', source: 'ui', actorType: 'user', status: 'completed' },
      items: [{
        id: 'item-1',
        operationId: 'op-1',
        toolCallId: 'call-bypass-1',
        sequence: 1,
        kind: 'tool_call',
        toolName: 'write_file',
        source: 'mcp',
        policyDecision: 'allow',
        status: 'completed',
        policy: {
          // A bypass verdict is an allow with a non-null allowedBy (CP PolicyVerdict.allowedByMode).
          effect: 'allow' as const,
          sourceLayer: 'builtin' as const,
          matchedRule: '{ write, "*", ask }',
          reason: 'requires approval for domain write',
          mode: 'bypass' as const,
          allowedBy: 'bypass@session',
          actionClass: 'write',
          shape: 'structured' as const,
        },
      }],
      attempts: [],
      events: [],
    }
    getOperationTrace.mockResolvedValue(trace)

    const store = useOperationStore()
    await store.loadTrace('op-1')

    expect(store.selectedTrace?.items[0]?.policy).toEqual(trace.items[0]?.policy)
    expect(store.selectedTrace?.items[0]?.policy?.allowedBy).toBe('bypass@session')
  })

  it('stores the error and rethrows failed loads', async () => {
    const failure = new Error('audit unavailable')
    listOperations.mockRejectedValue(failure)

    const store = useOperationStore()
    await expect(store.load()).rejects.toThrow('audit unavailable')
    expect(store.error).toBe('audit unavailable')
    expect(store.loading).toBe(false)
  })
})
