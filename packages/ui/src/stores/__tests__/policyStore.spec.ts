import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { api } from '../../composables/api'
import { usePolicyStore } from '../policy'

const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

vi.mock('../../composables/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getPolicyMode: vi.fn(),
      setPolicyMode: vi.fn(),
    },
  }
})

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('usePolicyStore', () => {
  it('deduplicates mode loads for mounted chat surfaces', async () => {
    vi.mocked(api.getPolicyMode).mockResolvedValue({ sessionId: SESSION_A, mode: 'auto' })
    const store = usePolicyStore()

    await Promise.all([store.load(SESSION_A), store.load(SESSION_A)])

    expect(api.getPolicyMode).toHaveBeenCalledTimes(1)
    expect(store.getState(SESSION_A)).toMatchObject({ mode: 'auto', loaded: true })
  })

  it('only lets the newest mode mutation clear changing state', async () => {
    let resolveFirst: ((value: { sessionId: string; mode: 'auto'; scope: 'session' }) => void) | undefined
    let resolveSecond: ((value: { sessionId: string; mode: 'manual'; scope: 'session' }) => void) | undefined
    vi.mocked(api.setPolicyMode)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    const store = usePolicyStore()
    const first = store.change(SESSION_A, 'auto')
    const second = store.change(SESSION_A, 'manual')

    resolveFirst?.({ sessionId: SESSION_A, mode: 'auto', scope: 'session' })
    await first
    expect(store.getState(SESSION_A)?.changing).toBe(true)
    resolveSecond?.({ sessionId: SESSION_A, mode: 'manual', scope: 'session' })
    await second

    expect(store.getState(SESSION_A)).toMatchObject({ mode: 'manual', changing: false })
  })
})
