import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { api } from '../../../composables/api'
import SSEStream from '../SSEStream.vue'

vi.mock('@/services/chatTransport', () => ({
  chatTransport: {
    sendMessages: vi.fn(async (_sessionId: string, options: { onopen?: (response: Response) => void | Promise<void> }) => {
      await options.onopen?.(new Response(null, { status: 200 }))
    }),
    stop: vi.fn(),
  },
}))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SSEStream session ownership', () => {
  it('does not reuse session A run id after switching to session B', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ status: 'accepted', sessionId: 'session-a', runId: 'run-a' }),
    }))
    const cancel = vi.spyOn(api, 'cancelChatRun').mockResolvedValue({ status: 'cancelled', runId: 'run-a' })
    const wrapper = mount(SSEStream, {
      props: { sessionId: 'session-a', active: true },
    })

    await (wrapper.vm as unknown as { sendMessage: (content: string) => Promise<unknown> }).sendMessage('run')
    await wrapper.setProps({ sessionId: 'session-b' })
    await (wrapper.vm as unknown as { stopStreaming: () => void }).stopStreaming()

    expect(cancel).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
