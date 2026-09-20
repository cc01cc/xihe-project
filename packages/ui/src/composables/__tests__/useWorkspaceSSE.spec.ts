import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chatTransport } from '@/services/chatTransport'
import { useWorkspaceSSE } from '../useWorkspaceSSE'

vi.mock('@/services/chatTransport', () => ({
  chatTransport: {
    sendMessages: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  },
}))

describe('useWorkspaceSSE', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('subscribes with an isolated workspace key and forwards valid events', async () => {
    const onEvent = vi.fn()
    useWorkspaceSSE('ws-1', { onEvent })
    await flushPromises()

    expect(chatTransport.sendMessages).toHaveBeenCalledWith(
      'workspace:ws-1',
      expect.objectContaining({
        url: '/api/v1/workspaces/ws-1/events',
      }),
    )
    const options = vi.mocked(chatTransport.sendMessages).mock.calls[0][1]
    await options.onmessage?.({
      id: '1',
      event: 'file_changed',
      data: JSON.stringify({
        workspaceId: 'ws-1',
        sequence: 1,
        kind: 'file_changed',
        path: 'src/main.ts',
        changeType: 'modified',
        source: 'runtime',
      }),
    })

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      sequence: 1,
      path: 'src/main.ts',
    }))
  })

  it('requests a snapshot when a local sequence gap is observed', async () => {
    const onEvent = vi.fn()
    useWorkspaceSSE('ws-1', { onEvent })
    await flushPromises()
    const options = vi.mocked(chatTransport.sendMessages).mock.calls[0][1]
    const event = (sequence: number) => options.onmessage?.({
      id: String(sequence),
      event: 'file_changed',
      data: JSON.stringify({
        workspaceId: 'ws-1',
        sequence,
        kind: 'file_changed',
        path: 'src/main.ts',
        changeType: 'modified',
        source: 'runtime',
      }),
    })

    await event(1)
    await event(3)

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'snapshot_required',
      source: 'ui-sequence-gap',
    }))
  })
})
