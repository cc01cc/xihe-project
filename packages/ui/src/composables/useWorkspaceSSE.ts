import { onBeforeUnmount, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { apiErrorFromResponse, normalizeWorkspaceEvent, workspaceHeaders } from './api'
import { logger } from '@/lib/logger'
import { chatTransport } from '@/services/chatTransport'
import type { WorkspaceEvent } from '@/types'

export interface WorkspaceSSEOptions {
  onEvent?: (event: WorkspaceEvent) => void | Promise<void>
}

/**
 * Workspace-scoped SSE subscription. This intentionally uses the existing
 * transport's lifecycle/reconnect machinery with a distinct key; Chat SSE
 * parsing and stores remain separate from Workspace file events.
 */
export function useWorkspaceSSE(
  workspaceId: MaybeRefOrGetter<string | null | undefined>,
  options: WorkspaceSSEOptions = {},
) {
  const isConnected = ref(false)
  const isConnecting = ref(false)
  const connectionError = ref<string | null>(null)
  const lastSequence = ref(0)
  let activeKey: string | null = null
  let activeWorkspaceId: string | null = null

  function stop(key = activeKey) {
    if (key) chatTransport.stop(key)
    if (key === activeKey || !key) {
      activeKey = null
      activeWorkspaceId = null
      isConnected.value = false
      isConnecting.value = false
    }
  }

  function start(id: string) {
    const key = `workspace:${id}`
    activeKey = key
    activeWorkspaceId = id
    lastSequence.value = 0
    connectionError.value = null
    isConnecting.value = true
    void chatTransport.sendMessages(key, {
      url: `/api/v1/workspaces/${encodeURIComponent(id)}/events`,
      headers: {
        ...workspaceHeaders(id),
        Accept: 'text/event-stream',
      },
      onopen: async (response) => {
        if (!response.ok) await apiErrorFromResponse(response)
        isConnected.value = true
        isConnecting.value = false
        connectionError.value = null
      },
      onmessage: async (message) => {
        if (activeWorkspaceId !== id) return
        let payload: unknown
        try {
          payload = JSON.parse(message.data) as unknown
        } catch (error) {
          logger.warn('workspace_sse_invalid_json', { workspaceId: id, event: message.event, error })
          return
        }
        const event = normalizeWorkspaceEvent(payload, id, message.event)
        if (!event) {
          logger.warn('workspace_sse_invalid_event', { workspaceId: id, event: message.event })
          return
        }
        if (
          event.kind !== 'snapshot_required'
          && event.sequence > lastSequence.value + 1
          && lastSequence.value > 0
        ) {
          logger.warn('workspace_sse_sequence_gap', {
            workspaceId: id,
            previousSequence: lastSequence.value,
            receivedSequence: event.sequence,
          })
          await options.onEvent?.({
            workspaceId: id,
            sequence: event.sequence,
            kind: 'snapshot_required',
            source: 'ui-sequence-gap',
            snapshotVersion: event.snapshotVersion ?? String(event.sequence),
          })
        }
        lastSequence.value = Math.max(lastSequence.value, event.sequence)
        await options.onEvent?.(event)
      },
      onerror: (error) => {
        if (activeWorkspaceId !== id) return
        isConnected.value = false
        isConnecting.value = false
        connectionError.value = error.message
      },
      onclose: () => {
        if (activeWorkspaceId !== id) return
        isConnected.value = false
        isConnecting.value = false
      },
    }).catch((error: unknown) => {
      if (activeWorkspaceId !== id) return
      isConnected.value = false
      isConnecting.value = false
      connectionError.value = error instanceof Error ? error.message : String(error)
    })
  }

  watch(
    () => toValue(workspaceId),
    (nextId, previousId) => {
      if (previousId && previousId !== nextId) stop(`workspace:${previousId}`)
      if (nextId) start(nextId)
      else stop()
    },
    { immediate: true },
  )

  onBeforeUnmount(() => stop())

  return {
    isConnected,
    isConnecting,
    connectionError,
    lastSequence,
    stop,
  }
}
