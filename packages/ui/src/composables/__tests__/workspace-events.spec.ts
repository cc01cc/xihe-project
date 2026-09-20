import { describe, expect, it } from 'vitest'
import { normalizeWorkspaceEvent } from '../api'

describe('Workspace SSE event normalization', () => {
  it('accepts a relative file event with a known envelope', () => {
    expect(normalizeWorkspaceEvent({
      workspaceId: 'ws-1',
      sequence: 4,
      kind: 'file_changed',
      path: 'src/main.ts',
      changeType: 'modified',
      source: 'runtime',
    }, 'ws-1')).toMatchObject({
      workspaceId: 'ws-1',
      sequence: 4,
      kind: 'file_changed',
      path: 'src/main.ts',
    })
  })

  it('rejects host paths and foreign workspace events', () => {
    expect(normalizeWorkspaceEvent({
      workspaceId: 'ws-1',
      sequence: 1,
      kind: 'file_changed',
      path: 'C:/repo/file.ts',
      source: 'runtime',
    }, 'ws-1')).toBeNull()
    expect(normalizeWorkspaceEvent({
      workspaceId: 'ws-2',
      sequence: 1,
      kind: 'file_changed',
      path: 'file.ts',
      source: 'runtime',
    }, 'ws-1')).toBeNull()
  })

  it('normalizes heartbeat payloads without a source field', () => {
    expect(normalizeWorkspaceEvent({
      workspaceId: 'ws-1',
      sequence: 4,
      type: 'heartbeat',
    }, 'ws-1', 'heartbeat')).toMatchObject({
      kind: 'heartbeat',
      source: 'control-plane',
    })
  })
})
