import type { LangChainEvent, SSEEvent } from '../types'
import { logger } from '../lib/logger'

export function mapLangChainEventToSSE(lcEvent: LangChainEvent): SSEEvent | SSEEvent[] | null {
  switch (lcEvent.event) {
    case 'on_chat_model_stream': {
      const chunk = lcEvent.data?.chunk as string | undefined
      if (!chunk) return null
      return { type: 'token', data: { content: chunk } }
    }

    case 'on_tool_start': {
      return {
        type: 'tool_call',
        data: {
          id: lcEvent.run_id ?? crypto.randomUUID(),
          name: lcEvent.name ?? lcEvent.data?.name ?? 'unknown',
          arguments: JSON.stringify(lcEvent.data?.input ?? {}),
        },
      }
    }

    case 'on_tool_end': {
      return {
        type: 'tool_result',
        data: {
          id: lcEvent.run_id ?? crypto.randomUUID(),
          name: lcEvent.name ?? 'unknown',
          result: JSON.stringify(lcEvent.data?.output ?? lcEvent.data ?? ''),
        },
      }
    }

    case 'on_tool_error': {
      return {
        type: 'error',
        data: {
          error: 'Tool execution error',
          details: lcEvent.data?.error ? String(lcEvent.data.error) : 'Unknown tool error',
        },
      }
    }

    case 'on_chain_start': {
      return null
    }

    case 'on_chain_end': {
      return { type: 'done', data: {} }
    }

    case 'on_chat_model_start':
    case 'on_llm_end': {
      return null
    }

    default:
      return null
  }
}

export function parseLangChainEvent(raw: string): LangChainEvent | null {
  try {
    const parsed = JSON.parse(raw) as LangChainEvent
    if (parsed.event && typeof parsed.event === 'string') {
      return parsed
    }
    return null
  } catch {
    logger.warn('Failed to parse LangChain event JSON')
    return null
  }
}
