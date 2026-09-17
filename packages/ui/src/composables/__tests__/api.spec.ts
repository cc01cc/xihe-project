import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { api, normalizeApprovalRequest, normalizeOperationPolicy } from '../api'

let fetchSpy: ReturnType<typeof vi.spyOn>
const TEST_PASSWORD = `ui-test-${globalThis.crypto.randomUUID()}`
const INVALID_PASSWORD = `ui-invalid-${globalThis.crypto.randomUUID()}`
const APPROVAL_ID = '11111111-1111-4111-8111-111111111111'
const APPROVAL_ID_2 = '22222222-2222-4222-8222-222222222222'
const RUN_ID = '33333333-3333-4333-8333-333333333333'
const RUN_ID_2 = '44444444-4444-4444-8444-444444444444'
const SESSION_ID = '55555555-5555-4555-8555-555555555555'
const WORKSPACE_ID = '66666666-6666-4666-8666-666666666666'

beforeEach(() => {
  localStorage.clear()
  fetchSpy = vi.spyOn(globalThis, 'fetch')
})

afterEach(() => {
  fetchSpy.mockRestore()
})

describe('api.login', () => {
  it('sends POST to /api/v1/auth/login with credentials', async () => {
    const mockResponse = {
      accessToken: 'test-token',
      user: { id: '1', email: 'test@test.com' },
    }
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response)

    const result = await api.login('test@test.com', TEST_PASSWORD)

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'test@test.com', password: TEST_PASSWORD }),
      }),
    )
    expect(result.accessToken).toBe('test-token')
    expect(result.user.email).toBe('test@test.com')
  })

  it('includes Authorization header when token exists', async () => {
    localStorage.setItem('xihe-token', 'existing-token')
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ accessToken: 't', user: { id: '1', email: 'a@b.com' } }),
    } as Response)

    await api.login('a@b.com', TEST_PASSWORD)

    const callHeaders = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(callHeaders['Authorization']).toBe('Bearer existing-token')
  })

  it('throws on non-ok response', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
       json: () => Promise.resolve({ code: 'INVALID_CREDENTIALS', detail: 'Invalid credentials' }),
    } as Response)

    await expect(api.login('bad@test.com', INVALID_PASSWORD)).rejects.toThrow('Invalid credentials')
  })

  it('clears token and redirects to login on 401 for protected paths', async () => {
    localStorage.setItem('xihe-token', 'existing-token')
    localStorage.setItem('xihe-user', '{}')
    // @ts-expect-error jsdom allows location.href assignment
    delete window.location
    // @ts-expect-error redefine for test
    window.location = { href: '/chat', pathname: '/chat' }

    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Unauthorized' }),
    } as Response)

    await expect(api.getSessions()).rejects.toThrow('Session expired')
    expect(localStorage.getItem('xihe-token')).toBeNull()
    expect(localStorage.getItem('xihe-user')).toBeNull()
    expect(window.location.href).toBe('/login')
  })

  it('does not redirect on 401 when already on public auth pages', async () => {
    localStorage.setItem('xihe-token', 'existing-token')
    // @ts-expect-error jsdom allows location.href assignment
    delete window.location
    // @ts-expect-error redefine for test
    window.location = { href: '/login', pathname: '/login' }

    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Unauthorized' }),
    } as Response)

    await expect(api.getSessions()).rejects.toThrow('Session expired')
    expect(window.location.href).toBe('/login')
    expect(localStorage.getItem('xihe-token')).toBeNull()
  })
})

describe('api.register', () => {
  it('sends POST to /api/v1/auth/register with user data', async () => {
    const mockResponse = {
      accessToken: 'reg-token',
      user: { id: '2', email: 'new@test.com' },
    }
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response)

    const result = await api.register('new@test.com', TEST_PASSWORD, 'New User')

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/auth/register',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'new@test.com', password: TEST_PASSWORD, name: 'New User' }),
      }),
    )
    expect(result.accessToken).toBe('reg-token')
  })
})

describe('api.getSessions', () => {
  it('sends GET to /api/v1/sessions and returns session list', async () => {
    const mockSessions = {
      sessions: [
        { id: '1', title: 'Chat 1' },
        { id: '2', title: 'Chat 2' },
      ],
    }
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockSessions),
    } as Response)

    const result = await api.getSessions()

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/sessions',
      expect.objectContaining({ headers: expect.any(Object) }),
    )
    expect(result.sessions).toHaveLength(2)
    expect(result.sessions[0].title).toBe('Chat 1')
  })
})

describe('api.createSession', () => {
  it('sends POST to /api/v1/sessions with title', async () => {
    const mockSession = { id: '3', title: 'New Chat' }
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockSession),
    } as Response)

    const result = await api.createSession('New Chat')

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/sessions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: 'New Chat' }),
      }),
    )
    expect(result.id).toBe('3')
    expect(result.title).toBe('New Chat')
  })

  it('sends POST without title when omitted', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: '4', title: 'Untitled' }),
    } as Response)

    await api.createSession()

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/sessions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: undefined }),
      }),
    )
  })
})

describe('api.deleteSession', () => {
  it('sends DELETE to /api/v1/sessions/:id', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 204,
    } as Response)

    await api.deleteSession('session-123')

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/sessions/session-123',
      expect.objectContaining({ method: 'DELETE', headers: expect.any(Object) }),
    )
  })

  it('includes Authorization header for every HTTP request', async () => {
    localStorage.setItem('xihe-token', 'some-token')
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 204,
    } as Response)

    await api.deleteSession('s1')

    const callOptions = fetchSpy.mock.calls[0][1] as RequestInit
    expect((callOptions.headers as Record<string, string>).Authorization).toBe('Bearer some-token')
  })
})

describe('api.decideChatApproval', () => {
  it('sends the structured decision body', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        status: 'accepted',
        requestId: APPROVAL_ID,
        approved: true,
        decision: 'saved',
        propagated: 2,
        modeAtGrant: 'manual',
        rule: { layer: 'workspace', actionClass: 'write', resource: 'src/**', effect: 'allow' },
      }),
    } as Response)

    const result = await api.decideChatApproval(APPROVAL_ID, {
      decision: 'saved',
      layer: 'workspace',
      rule: { resource: 'src/**' },
    })

    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/v1/chat/approvals/${APPROVAL_ID}/decision`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          decision: 'saved',
          layer: 'workspace',
          rule: { resource: 'src/**' },
        }),
      }),
    )
    expect(result.propagated).toBe(2)
    expect(result.modeAtGrant).toBe('manual')
    expect(result.rule?.resource).toBe('src/**')
  })

  it('keeps the legacy boolean body available for compatibility', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ status: 'accepted', requestId: APPROVAL_ID_2, approved: false }),
    } as Response)

    await api.decideChatApproval(APPROVAL_ID_2, false)

    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/v1/chat/approvals/${APPROVAL_ID_2}/decision`,
      expect.objectContaining({ body: JSON.stringify({ approved: false }) }),
    )
  })
})

describe('api.getPendingApprovals', () => {
  it('returns endpoint-only session summaries', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{
        sessionId: SESSION_ID,
        workspaceId: WORKSPACE_ID,
        count: 2,
        oldestRequestedAt: '2026-09-14T12:00:00Z',
      }]),
    } as Response)

    const result = await api.getPendingApprovals()

    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/approvals/pending', expect.objectContaining({ headers: expect.any(Object) }))
    expect(result).toEqual([{
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      count: 2,
      oldestRequestedAt: '2026-09-14T12:00:00Z',
    }])
  })

  it('accepts explicit zero-count pending summaries as authoritative', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{
        sessionId: SESSION_ID,
        workspaceId: WORKSPACE_ID,
        count: 0,
        oldestRequestedAt: '2026-09-14T12:00:00Z',
      }]),
    } as Response)

    await expect(api.getPendingApprovals()).resolves.toEqual([{
        sessionId: SESSION_ID,
        workspaceId: WORKSPACE_ID,
      count: 0,
      oldestRequestedAt: '2026-09-14T12:00:00Z',
    }])
  })

  it('aborts a stalled pending summary request after five seconds', async () => {
    vi.useFakeTimers()
    try {
      fetchSpy.mockImplementation((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      }))

      const request = api.getPendingApprovals()
      const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
      await vi.advanceTimersByTimeAsync(5000)

      await rejected
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('api policy mode', () => {
  it('reads a session mode with its server-derived rule count', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ sessionId: SESSION_ID, mode: 'auto', sessionRules: 3 }),
    } as Response)

    const result = await api.getPolicyMode(SESSION_ID)

    expect(fetchSpy).toHaveBeenCalledWith(`/api/v1/policy/mode?sessionId=${SESSION_ID}`, expect.any(Object))
    expect(result).toEqual({ sessionId: SESSION_ID, mode: 'auto', sessionRules: 3 })
  })

  it('writes only the selected session mode', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ sessionId: SESSION_ID, mode: 'manual', scope: 'session' }),
    } as Response)

    const result = await api.setPolicyMode(SESSION_ID, 'manual')

    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/policy/mode', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ sessionId: SESSION_ID, mode: 'manual' }),
    }))
    expect(result).toEqual({ sessionId: SESSION_ID, mode: 'manual', scope: 'session' })
  })

  it('rejects a POST response without the session scope marker', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ sessionId: SESSION_ID, mode: 'manual' }),
    } as Response)

    await expect(api.setPolicyMode(SESSION_ID, 'manual')).rejects.toThrow('Invalid policy mode update response')
  })
})

describe('api.getChatRunStatus approval recovery', () => {
  it('normalizes and preserves nested policy evidence', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        runId: RUN_ID,
        sessionId: SESSION_ID,
        status: 'awaiting_approval',
        leaseExpired: false,
        pendingApprovals: [{
          requestId: APPROVAL_ID,
          runId: RUN_ID,
          sessionId: SESSION_ID,
          tool: 'write_file',
          action: 'write',
          details: '/README.md',
          argumentsHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
          state: 'pending',
          replayed: true,
          policy: {
            effect: 'ask',
            sourceLayer: 'workspace',
            matchedRule: null,
            reason: 'No rule matched',
            mode: null,
            actionClass: 'write',
            shape: 'interpreter',
          },
        }],
      }),
    } as Response)

    const result = await api.getChatRunStatus(RUN_ID)

    expect(result.pendingApprovals[0]?.policy).toEqual({
      effect: 'ask',
      sourceLayer: 'workspace',
      matchedRule: null,
      reason: 'No rule matched',
      mode: null,
      actionClass: 'write',
      shape: 'interpreter',
    })
    expect(result.pendingApprovals[0]).toMatchObject({
      requestId: APPROVAL_ID,
      argumentsHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      state: 'pending',
      replayed: true,
    })
  })

  it('preserves strict mode-at-grant evidence without replacing ask-time mode', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        runId: RUN_ID,
        sessionId: SESSION_ID,
        status: 'awaiting_approval',
        pendingApprovals: [{
          requestId: APPROVAL_ID,
          runId: RUN_ID,
          sessionId: SESSION_ID,
          policy: {
            effect: 'ask',
            sourceLayer: 'workspace',
            matchedRule: null,
            reason: 'No rule matched',
            mode: 'manual',
            modeAtGrant: 'manual',
            actionClass: 'write',
            shape: 'structured',
          },
        }],
      }),
    } as Response)
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        runId: RUN_ID_2,
        sessionId: SESSION_ID,
        status: 'awaiting_approval',
        pendingApprovals: [{
          requestId: APPROVAL_ID_2,
          runId: RUN_ID_2,
          sessionId: SESSION_ID,
          argumentsHash: null,
          state: 'pending',
          modeAtGrant: 'auto',
        }],
      }),
    } as Response)

    const nested = await api.getChatRunStatus(RUN_ID)
    const topLevel = await api.getChatRunStatus(RUN_ID_2)

    expect(nested.pendingApprovals[0]?.policy).toMatchObject({ mode: 'manual', modeAtGrant: 'manual' })
    expect(topLevel.pendingApprovals[0]?.modeAtGrant).toBe('auto')
    expect(normalizeApprovalRequest({ requestId: APPROVAL_ID, sessionId: SESSION_ID, modeAtGrant: 'future-mode' })).toBeNull()
  })

  it('does not invent omitted envelope metadata or copy details into policy', () => {
    const normalized = normalizeApprovalRequest({
      requestId: APPROVAL_ID_2,
      sessionId: SESSION_ID,
      policy: {
        effect: 'ask',
        sourceLayer: 'workspace',
        matchedRule: null,
        reason: 'No rule matched',
        mode: 'manual',
        modeAtGrant: null,
        actionClass: 'write',
        shape: 'structured',
        details: 'must not be copied',
      },
    })

    expect(normalized).not.toHaveProperty('state')
    expect(normalized?.policy).toMatchObject({ modeAtGrant: null })
    expect(normalized?.policy).not.toHaveProperty('details')
  })
})

describe('api.getHealth', () => {
  it('sends GET to /api/v1/health and returns status', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ status: 'UP' }),
    } as Response)

    const result = await api.getHealth()

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/health',
      expect.objectContaining({ headers: expect.any(Object) }),
    )
    expect(result.status).toBe('UP')
  })
})

const RULE_ID = '77777777-7777-4777-8777-777777777777'
const FACE_ID = '88888888-8888-4888-8888-888888888888'

describe('api policy admin (PLAN-0328)', () => {
  it('lists policy domains with the effective layer and rule counts', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([
        { actionClass: 'exec', effectiveLayer: 'workspace', configuredLayers: ['user', 'workspace'], ruleCounts: { user: 1, workspace: 2 } },
        { actionClass: 'read', effectiveLayer: 'builtin', configuredLayers: [], ruleCounts: {} },
      ]),
    } as Response)

    const domains = await api.listPolicyDomains()

    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/policy/domains', expect.any(Object))
    expect(domains[0]).toEqual({
      actionClass: 'exec',
      effectiveLayer: 'workspace',
      configuredLayers: ['user', 'workspace'],
      ruleCounts: { user: 1, workspace: 2 },
    })
    expect(domains[1]?.effectiveLayer).toBe('builtin')
  })

  it('rejects a malformed domains payload instead of inventing defaults', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ actionClass: 'exec', effectiveLayer: 'unknown-layer', configuredLayers: [], ruleCounts: {} }]),
    } as Response)

    await expect(api.listPolicyDomains()).rejects.toThrow('Invalid policy domains response')
  })

  it('lists rules for one layer and preserves effective plus conflict fields', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{
        id: RULE_ID,
        layer: 'workspace',
        ownerId: WORKSPACE_ID,
        actionClass: 'exec',
        resource: 'pnpm *',
        effect: 'allow',
        priority: 5,
        locked: false,
        effective: true,
        conflict: '该 allow 不会生效：存在更具体的 deny "pnpm test *"',
      }]),
    } as Response)

    const rules = await api.listPolicyRules('workspace')

    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/policy/rules?layer=workspace', expect.any(Object))
    expect(rules[0]).toMatchObject({ id: RULE_ID, effective: true, locked: false, priority: 5 })
    expect(rules[0]?.conflict).toContain('allow')
  })

  it('creates a rule with the full layer-scoped draft body', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: RULE_ID,
        layer: 'user',
        ownerId: null,
        actionClass: 'exec',
        resource: 'pnpm *',
        effect: 'ask',
        priority: 3,
        locked: true,
        effective: false,
        conflict: null,
      }),
    } as Response)

    const created = await api.createPolicyRule({
      layer: 'user',
      actionClass: 'exec',
      resource: 'pnpm *',
      effect: 'ask',
      priority: 3,
      locked: true,
    })

    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/policy/rules', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        layer: 'user',
        actionClass: 'exec',
        resource: 'pnpm *',
        effect: 'ask',
        priority: 3,
        locked: true,
      }),
    }))
    expect(created.locked).toBe(true)
    expect(created.conflict).toBeNull()
  })

  it('deletes a rule scoped by layer', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 204 } as Response)

    await api.deletePolicyRule(RULE_ID, 'workspace')

    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/v1/policy/rules/${RULE_ID}?layer=workspace`,
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('lists only conflict-carrying rules for a layer', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{
        id: RULE_ID,
        layer: 'user',
        ownerId: null,
        actionClass: 'exec',
        resource: 'pnpm *',
        effect: 'allow',
        priority: 0,
        locked: false,
        effective: false,
        conflict: 'shadowed by deny',
      }]),
    } as Response)

    const conflicts = await api.listPolicyRuleConflicts('user')

    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/policy/rules/conflicts?layer=user', expect.any(Object))
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.conflict).toBe('shadowed by deny')
  })

  it('lists tool faces including builtin rows with nullable id and owner', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([
        { id: null, scope: 'builtin', ownerId: null, tool: 'read_file', actionClass: 'read', shape: 'structured' },
        { id: FACE_ID, scope: 'workspace', ownerId: WORKSPACE_ID, tool: 'mcp_tool', actionClass: 'unclassified', shape: 'opaque' },
      ]),
    } as Response)

    const faces = await api.listPolicyToolFaces('workspace')

    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/policy/tool-faces?scope=workspace', expect.any(Object))
    expect(faces[0]).toEqual({ id: null, scope: 'builtin', ownerId: null, tool: 'read_file', actionClass: 'read', shape: 'structured' })
    expect(faces[1]).toMatchObject({ id: FACE_ID, ownerId: WORKSPACE_ID, actionClass: 'unclassified' })
  })

  it('upserts a tool-face classification for the requested scope', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: FACE_ID, scope: 'workspace', ownerId: WORKSPACE_ID, tool: 'mcp_tool', actionClass: 'exec', shape: 'interpreter' }),
    } as Response)

    const face = await api.upsertPolicyToolFace({
      scope: 'workspace',
      tool: 'mcp_tool',
      actionClass: 'exec',
      shape: 'interpreter',
    })

    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/policy/tool-faces', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ scope: 'workspace', tool: 'mcp_tool', actionClass: 'exec', shape: 'interpreter' }),
    }))
    expect(face.actionClass).toBe('exec')
  })

  it('rejects a malformed rule row instead of guessing missing evidence', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{
        id: RULE_ID,
        layer: 'workspace',
        ownerId: null,
        actionClass: 'exec',
        resource: 'pnpm *',
        effect: 'allow',
        priority: 0,
        locked: false,
      }]),
    } as Response)

    await expect(api.listPolicyRules('workspace')).rejects.toThrow('Invalid policy rules response')
  })
})

const OPERATION_ID = '99999999-9999-4999-8999-999999999999'

// Exact shape produced by CP OperationPolicySummary (PLAN-0328 T1.15). An auto verdict is
// `effect: 'allow'` with a non-null allowedBy; the ask rule it upgraded stays in matchedRule.
// `reused` is the T1.7 annotation and is nullable (null = reuse not applicable; V19 snapshots
// omit the key entirely).
const OPERATION_POLICY = {
  effect: 'allow',
  sourceLayer: 'builtin',
  matchedRule: '{ write, "*", ask }',
  reason: 'requires approval for domain write',
  mode: 'auto',
  allowedBy: 'auto@session',
  actionClass: 'write',
  shape: 'structured',
  reused: null,
}

// A plain non-auto ask verdict: the same key set with no allowedBy.
const OPERATION_ASK_POLICY = {
  effect: 'ask',
  sourceLayer: 'builtin',
  matchedRule: null,
  reason: 'exec requires approval',
  mode: 'manual',
  allowedBy: null,
  actionClass: 'exec',
  shape: 'structured',
  reused: null,
}

const OPERATION_ITEM = {
  id: 'item-1',
  operationId: OPERATION_ID,
  toolCallId: 'call-auto-1',
  sequence: 1,
  kind: 'tool_call',
  toolName: 'write_file',
  source: 'mcp',
  policyDecision: 'allow',
  status: 'completed',
}

function operationTrace(items: unknown[]) {
  return {
    operation: { id: OPERATION_ID, kind: 'chat', source: 'agent', actorType: 'agent', status: 'completed' },
    items,
    attempts: [],
    events: [],
  }
}

describe('api operation policy projection (PLAN-0328 T1.15)', () => {
  it('normalizes the server projection verbatim and ignores unknown keys', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(operationTrace([
        { ...OPERATION_ITEM, policy: { ...OPERATION_POLICY, arguments: 'raw' } },
        { ...OPERATION_ITEM, id: 'item-2', toolCallId: 'call-ask-2', policy: OPERATION_ASK_POLICY },
      ])),
    } as Response)

    const trace = await api.getOperationTrace(OPERATION_ID)

    expect(fetchSpy).toHaveBeenCalledWith(`/api/v1/operations/${OPERATION_ID}`, expect.any(Object))
    expect(trace.items[0]?.policy).toEqual(OPERATION_POLICY)
    expect(trace.items[0]?.policyDecision).toBe('allow')
    expect(trace.items[1]?.policy).toEqual(OPERATION_ASK_POLICY)
  })

  it('preserves explicitly null matchedRule, mode and allowedBy', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(operationTrace([{
        ...OPERATION_ITEM,
        toolCallId: 'call-default-2',
        policy: { ...OPERATION_POLICY, effect: 'deny', matchedRule: null, mode: null, allowedBy: null },
      }])),
    } as Response)

    const trace = await api.getOperationTrace(OPERATION_ID)

    expect(trace.items[0]?.policy).toEqual({
      ...OPERATION_POLICY,
      effect: 'deny',
      matchedRule: null,
      mode: null,
      allowedBy: null,
    })
  })

  it('carries the nullable T1.7 reused annotation without inventing it', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(operationTrace([
        { ...OPERATION_ITEM, policy: { ...OPERATION_POLICY, reused: true } },
        { ...OPERATION_ITEM, id: 'item-2', toolCallId: 'call-ask-2', policy: OPERATION_ASK_POLICY },
      ])),
    } as Response)

    const trace = await api.getOperationTrace(OPERATION_ID)

    expect(trace.items[0]?.policy?.reused).toBe(true)
    expect(trace.items[1]?.policy?.reused).toBeNull()
  })

  it('omits the policy entirely for legacy rows instead of deriving one from policyDecision', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(operationTrace([OPERATION_ITEM])),
    } as Response)

    const trace = await api.getOperationTrace(OPERATION_ID)

    expect(trace.items[0]).not.toHaveProperty('policy')
    expect(trace.items[0]?.policyDecision).toBe('allow')
  })

  it('treats a malformed projection as absent rather than fabricating a default', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(operationTrace([{ ...OPERATION_ITEM, policy: { effect: 'ALLOW' } }])),
    } as Response)

    const trace = await api.getOperationTrace(OPERATION_ID)

    expect(trace.items[0]).not.toHaveProperty('policy')
  })

  it('drops non-object items instead of rendering them', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(operationTrace([null, 'ghost', OPERATION_ITEM])),
    } as Response)

    const trace = await api.getOperationTrace(OPERATION_ID)

    expect(trace.items).toHaveLength(1)
    expect(trace.items[0]?.id).toBe('item-1')
  })
})

describe('normalizeOperationPolicy', () => {
  it('returns undefined for absent or non-object projections', () => {
    expect(normalizeOperationPolicy(undefined)).toBeUndefined()
    expect(normalizeOperationPolicy(null)).toBeUndefined()
    expect(normalizeOperationPolicy('ask')).toBeUndefined()
    expect(normalizeOperationPolicy([])).toBeUndefined()
  })

  it('accepts the exact projection and ignores unknown keys', () => {
    expect(normalizeOperationPolicy({ ...OPERATION_POLICY, extra: 'ignored' })).toEqual(OPERATION_POLICY)
  })

  it('rejects uppercase or unknown enums, blank required text and non-string nullable fields', () => {
    expect(normalizeOperationPolicy({ ...OPERATION_POLICY, effect: 'ALLOW' })).toBeUndefined()
    expect(normalizeOperationPolicy({ ...OPERATION_POLICY, sourceLayer: 'cloud' })).toBeUndefined()
    expect(normalizeOperationPolicy({ ...OPERATION_POLICY, shape: 'magic' })).toBeUndefined()
    expect(normalizeOperationPolicy({ ...OPERATION_POLICY, mode: 'future-mode' })).toBeUndefined()
    expect(normalizeOperationPolicy({ ...OPERATION_POLICY, reason: '' })).toBeUndefined()
    expect(normalizeOperationPolicy({ ...OPERATION_POLICY, actionClass: '' })).toBeUndefined()
    expect(normalizeOperationPolicy({ ...OPERATION_POLICY, matchedRule: 42 })).toBeUndefined()
    expect(normalizeOperationPolicy({ ...OPERATION_POLICY, allowedBy: false })).toBeUndefined()
  })

  it('rejects projections that omit nullable keys instead of fabricating defaults', () => {
    const withoutNullables: Record<string, unknown> = { ...OPERATION_POLICY }
    delete withoutNullables.matchedRule
    delete withoutNullables.mode
    delete withoutNullables.allowedBy
    expect(normalizeOperationPolicy(withoutNullables)).toBeUndefined()
  })

  it('keeps the optional nullable reused annotation and never invents it', () => {
    expect(normalizeOperationPolicy({ ...OPERATION_POLICY, reused: true })?.reused).toBe(true)
    expect(normalizeOperationPolicy({ ...OPERATION_POLICY, reused: null })?.reused).toBeNull()

    // V19 snapshots predate `reused`: the key stays absent instead of becoming `false`.
    const legacySnapshot: Record<string, unknown> = { ...OPERATION_POLICY }
    delete legacySnapshot.reused
    const legacy = normalizeOperationPolicy(legacySnapshot)
    expect(legacy).toEqual(legacySnapshot)
    expect(legacy).not.toHaveProperty('reused')
  })

  it('rejects a non-boolean reused value instead of guessing the annotation', () => {
    expect(normalizeOperationPolicy({ ...OPERATION_POLICY, reused: 'yes' })).toBeUndefined()
    expect(normalizeOperationPolicy({ ...OPERATION_POLICY, reused: 1 })).toBeUndefined()
  })
})
