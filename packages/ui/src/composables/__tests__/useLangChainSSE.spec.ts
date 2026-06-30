import { describe, it, expect } from 'vitest'
import { mapLangChainEventToSSE, parseLangChainEvent } from '../useLangChainSSE'

describe('parseLangChainEvent', () => {
  it('parses valid JSON with event field', () => {
    const result = parseLangChainEvent('{"event":"on_chat_model_stream","data":{"chunk":"Hello"}}')
    expect(result).not.toBeNull()
    expect(result!.event).toBe('on_chat_model_stream')
  })

  it('returns null for invalid JSON', () => {
    expect(parseLangChainEvent('not json')).toBeNull()
  })

  it('returns null for JSON without event field', () => {
    expect(parseLangChainEvent('{"foo":"bar"}')).toBeNull()
  })
})

describe('mapLangChainEventToSSE', () => {
  it('maps on_chat_model_stream to token event', () => {
    const result = mapLangChainEventToSSE({
      event: 'on_chat_model_stream',
      data: { chunk: 'Hello' },
    })
    expect(result).toEqual({ type: 'token', data: { content: 'Hello' } })
  })

  it('returns null for on_chat_model_stream without chunk', () => {
    const result = mapLangChainEventToSSE({
      event: 'on_chat_model_stream',
      data: {},
    })
    expect(result).toBeNull()
  })

  it('maps on_tool_start to tool_call event', () => {
    const result = mapLangChainEventToSSE({
      event: 'on_tool_start',
      run_id: 'run-1',
      name: 'read_file',
      data: { input: { path: '/tmp' } },
    })
    expect(result).toEqual({
      type: 'tool_call',
      data: {
        id: 'run-1',
        name: 'read_file',
        arguments: JSON.stringify({ path: '/tmp' }),
      },
    })
  })

  it('maps on_tool_end to tool_result event', () => {
    const result = mapLangChainEventToSSE({
      event: 'on_tool_end',
      run_id: 'run-1',
      name: 'read_file',
      data: { output: 'content' },
    })
    expect(result).toEqual({
      type: 'tool_result',
      data: {
        id: 'run-1',
        name: 'read_file',
        result: JSON.stringify('content'),
      },
    })
  })

  it('maps on_tool_error to error event', () => {
    const result = mapLangChainEventToSSE({
      event: 'on_tool_error',
      data: { error: 'Permission denied' },
    })
    expect(result).toEqual({
      type: 'error',
      data: { error: 'Tool execution error', details: 'Permission denied' },
    })
  })

  it('maps on_chain_end to done event', () => {
    const result = mapLangChainEventToSSE({
      event: 'on_chain_end',
      data: {},
    })
    expect(result).toEqual({ type: 'done', data: {} })
  })

  it('returns null for on_chain_start', () => {
    expect(mapLangChainEventToSSE({ event: 'on_chain_start', data: {} })).toBeNull()
  })

  it('returns null for unknown events', () => {
    expect(mapLangChainEventToSSE({ event: 'unknown_event', data: {} })).toBeNull()
  })
})
