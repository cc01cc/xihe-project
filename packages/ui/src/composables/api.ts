import type {
  ApprovalDecision,
  ApprovalDecisionKind,
  ApprovalPolicy,
  ApprovalPolicyEffect,
  ApprovalPolicyMode,
  ApprovalPolicyShape,
  ApprovalPolicySourceLayer,
  ApprovalRequest,
  OperationItemView,
  OperationListResponse,
  OperationPolicyView,
  OperationTrace,
  OperationStatus,
  PolicyDomainView,
  PolicyModeUpdateResponse,
  PolicyRuleLayer,
  PolicyRuleView,
  PolicyToolFaceQueryScope,
  PolicyToolFaceView,
  PendingApprovalSummary,
  SessionPolicyMode,
  SessionPolicyModeState,
} from '../types'

const API_BASE = '/api/v1'

export interface ProblemDetails {
  type?: string
  title?: string
  status: number
  code: string
  detail?: string
  requestId: string
  runId?: string
  provider?: string
  model?: string
  retryable?: boolean
  outcome?: string
}

export interface ApiWorkspace {
  id: string
  name: string
  description?: string | null
  /** CP workspace owner (used to gate owner-only actions such as tool classification). */
  ownerId?: string
  storageBackend?: string
  storageRef?: string
  createdAt?: string
  updatedAt?: string
}

export interface ApiSession {
  id: string
  title: string
  workspaceId?: string
  createdAt?: string
  updatedAt?: string
  modelProvider?: string
  modelName?: string
  providerConnectionId?: string
  connectionRevision?: number
}

export interface SessionResponse extends ApiSession {
  workspace?: ApiWorkspace
}

export interface SessionListResponse {
  sessions: SessionResponse[]
  workspace?: ApiWorkspace
}

export interface ChatApprovalDecisionResponse {
  status: 'accepted' | 'already_decided'
  requestId: string
  approved: boolean
  decision?: ApprovalDecisionKind
  propagated?: number
  modeAtGrant?: ApprovalPolicyMode
  rule?: {
    layer: 'session' | 'workspace' | 'user'
    actionClass: string
    resource: string
    effect: 'allow' | 'deny'
  }
}

type JsonRecord = Record<string, unknown>

const approvalPolicyEffects = ['allow', 'ask', 'deny'] as const
const approvalPolicySourceLayers = ['builtin', 'instance', 'user', 'workspace', 'session', 'per_call'] as const
const approvalPolicyModes = ['default', 'bypass', 'managed', 'accept-edits', 'plan'] as const
const approvalPolicyShapes = ['structured', 'interpreter', 'opaque'] as const
const policyRuleLayers = ['instance', 'user', 'workspace'] as const
const policyToolFaceScopes = ['builtin', 'instance', 'workspace'] as const

function isEnumValue<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null ? value as JsonRecord : null
}

function normalizeApprovalPolicy(value: unknown): ApprovalPolicy | undefined {
  const record = asRecord(value)
  if (!record
    || !isEnumValue(record.effect, approvalPolicyEffects)
    || !isEnumValue(record.sourceLayer, approvalPolicySourceLayers)
    || typeof record.reason !== 'string'
    || typeof record.actionClass !== 'string'
    || !isEnumValue(record.shape, approvalPolicyShapes)
    || !(record.matchedRule === null || typeof record.matchedRule === 'string')
    || !(record.mode === null || isEnumValue(record.mode, approvalPolicyModes))
    || !(record.modeAtGrant === undefined || record.modeAtGrant === null || isEnumValue(record.modeAtGrant, approvalPolicyModes))) {
    return undefined
  }

  return {
    effect: record.effect as ApprovalPolicyEffect,
    sourceLayer: record.sourceLayer as ApprovalPolicySourceLayer,
    matchedRule: record.matchedRule as string | null,
    reason: record.reason,
    mode: record.mode as ApprovalPolicyMode,
    ...(record.modeAtGrant !== undefined ? { modeAtGrant: record.modeAtGrant as ApprovalPolicyMode } : {}),
    actionClass: record.actionClass,
    shape: record.shape as ApprovalPolicyShape,
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Strict normalizer for the optional operation item `policy` projection (PLAN-0328 T1.15).
 * Returns `undefined` when the projection is absent or malformed so the view can show the
 * explicit no-verdict state; it never fabricates defaults (e.g. `mode: 'default'`) and
 * ignores unknown keys.
 */
export function normalizeOperationPolicy(value: unknown): OperationPolicyView | undefined {
  const record = asRecord(value)
  if (!record
    || !isEnumValue(record.effect, approvalPolicyEffects)
    || !isEnumValue(record.sourceLayer, approvalPolicySourceLayers)
    || !isNonEmptyString(record.reason)
    || !isNonEmptyString(record.actionClass)
    || !isEnumValue(record.shape, approvalPolicyShapes)
    || !(record.matchedRule === null || isNonEmptyString(record.matchedRule))
    || !(record.mode === null || isEnumValue(record.mode, approvalPolicyModes))
    || !(record.allowedBy === null || isNonEmptyString(record.allowedBy))) {
    return undefined
  }

  return {
    effect: record.effect,
    sourceLayer: record.sourceLayer,
    matchedRule: record.matchedRule,
    reason: record.reason,
    mode: record.mode,
    allowedBy: record.allowedBy,
    actionClass: record.actionClass,
    shape: record.shape,
  }
}

function normalizeOperationItem(value: unknown): OperationItemView | null {
  const record = asRecord(value)
  if (!record || !isNonEmptyString(record.id)) return null
  const { policy: rawPolicy, ...rest } = record
  const policy = normalizeOperationPolicy(rawPolicy)
  return (policy ? { ...rest, policy } : rest) as unknown as OperationItemView
}

function normalizeOperationTrace(value: unknown): OperationTrace {
  const record = asRecord(value)
  if (!record || !Array.isArray(record.items)) return value as OperationTrace
  return {
    ...record,
    items: record.items
      .map(normalizeOperationItem)
      .filter((item): item is OperationItemView => item !== null),
  } as unknown as OperationTrace
}

const approvalStates = ['pending', 'dispatching', 'approved', 'rejected', 'expired', 'dispatch_unknown'] as const

function hasField(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

/** Normalize approval payloads from SSE/recovery without inventing policy evidence. */
export function normalizeApprovalRequest(value: unknown, fallbackSessionId = ''): ApprovalRequest | null {
  const record = asRecord(value)
  if (!record) return null
  if (fallbackSessionId
    && typeof record.sessionId === 'string'
    && record.sessionId.length > 0
    && record.sessionId !== fallbackSessionId) return null
  const requestId = typeof record.requestId === 'string' ? record.requestId : ''
  const sessionId = typeof record.sessionId === 'string' && record.sessionId.length > 0
    ? record.sessionId
    : fallbackSessionId
  if (!requestId || !sessionId) return null

  const state = record.state === undefined
    ? undefined
    : isEnumValue(record.state, approvalStates) ? record.state : null
  if (state === null) return null
  for (const key of ['snapshotId', 'policyClass', 'argumentsHash']) {
    if (hasField(record, key) && record[key] !== null && typeof record[key] !== 'string') return null
  }
  if (record.modeAtGrant !== undefined
    && record.modeAtGrant !== null
    && !isEnumValue(record.modeAtGrant, approvalPolicyModes)) return null
  const policy = record.policy === undefined ? undefined : normalizeApprovalPolicy(record.policy)

  return {
    requestId,
    operationId: typeof record.operationId === 'string' ? record.operationId : undefined,
    runId: typeof record.runId === 'string' ? record.runId : '',
    sessionId,
    workspaceId: typeof record.workspaceId === 'string' ? record.workspaceId : undefined,
    tool: typeof record.tool === 'string' ? record.tool : 'request_approval',
    action: typeof record.action === 'string' ? record.action : '',
    details: typeof record.details === 'string' ? record.details : '',
    ...(hasField(record, 'snapshotId') ? { snapshotId: record.snapshotId as string | null } : {}),
    ...(hasField(record, 'policyClass') ? { policyClass: record.policyClass as string | null } : {}),
    ...(hasField(record, 'argumentsHash') ? { argumentsHash: record.argumentsHash as string | null } : {}),
    expiresAt: typeof record.expiresAt === 'string' ? record.expiresAt : undefined,
    ...(typeof record.replayed === 'boolean' ? { replayed: record.replayed } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(record.modeAtGrant !== undefined ? { modeAtGrant: record.modeAtGrant as ApprovalPolicyMode } : {}),
    ...(policy ? { policy } : {}),
  }
}

function normalizePendingApprovalSummary(value: unknown): PendingApprovalSummary | null {
  const record = asRecord(value)
  const count = record?.count
  if (!record
    || typeof record.sessionId !== 'string'
    || typeof record.workspaceId !== 'string'
    || !Number.isInteger(count)
    || (count as number) < 0
    || (typeof record.oldestRequestedAt !== 'string' && count !== 0)) {
    return null
  }
  return {
    sessionId: record.sessionId,
    workspaceId: record.workspaceId,
    count: count as number,
    oldestRequestedAt: typeof record.oldestRequestedAt === 'string' ? record.oldestRequestedAt : '',
  }
}

function normalizePolicyModeState(value: unknown, fallbackSessionId: string): SessionPolicyModeState {
  const record = asRecord(value)
  if (!record
    || typeof record.sessionId !== 'string'
    || record.sessionId !== fallbackSessionId
    || !isEnumValue(record.mode, approvalPolicyModes)) {
    throw new Error('Invalid policy mode response')
  }
  if (record.sessionRules !== undefined
    && (!Number.isInteger(record.sessionRules) || (record.sessionRules as number) < 0)) {
    throw new Error('Invalid policy mode response')
  }
  return {
    sessionId: record.sessionId,
    mode: record.mode as SessionPolicyMode,
    ...(record.sessionRules === undefined ? {} : { sessionRules: record.sessionRules as number }),
  }
}

function normalizePolicyModeUpdateResponse(value: unknown, fallbackSessionId: string): PolicyModeUpdateResponse {
  const state = normalizePolicyModeState(value, fallbackSessionId)
  const record = asRecord(value)
  if (!record || record.scope !== 'session') {
    throw new Error('Invalid policy mode update response')
  }
  return {
    sessionId: state.sessionId,
    mode: state.mode,
    scope: 'session',
  }
}

function normalizePolicyDomainView(value: unknown): PolicyDomainView {
  const record = asRecord(value)
  if (!record
    || typeof record.actionClass !== 'string'
    || record.actionClass.length === 0
    || !isEnumValue(record.effectiveLayer, approvalPolicySourceLayers)
    || !Array.isArray(record.configuredLayers)
    || !record.configuredLayers.every((layer) => isEnumValue(layer, policyRuleLayers))) {
    throw new Error('Invalid policy domains response')
  }
  const countsRecord = asRecord(record.ruleCounts)
  if (!countsRecord) throw new Error('Invalid policy domains response')
  const ruleCounts: Partial<Record<PolicyRuleLayer, number>> = {}
  for (const [layer, count] of Object.entries(countsRecord)) {
    if (!isEnumValue(layer, policyRuleLayers) || !Number.isInteger(count) || (count as number) < 0) {
      throw new Error('Invalid policy domains response')
    }
    ruleCounts[layer] = count as number
  }
  return {
    actionClass: record.actionClass,
    effectiveLayer: record.effectiveLayer as ApprovalPolicySourceLayer,
    configuredLayers: [...record.configuredLayers] as PolicyRuleLayer[],
    ruleCounts,
  }
}

function normalizePolicyRuleView(value: unknown): PolicyRuleView {
  const record = asRecord(value)
  if (!record
    || typeof record.id !== 'string'
    || record.id.length === 0
    || !isEnumValue(record.layer, policyRuleLayers)
    || !(record.ownerId === null || typeof record.ownerId === 'string')
    || typeof record.actionClass !== 'string'
    || record.actionClass.length === 0
    || typeof record.resource !== 'string'
    || !isEnumValue(record.effect, approvalPolicyEffects)
    || !Number.isInteger(record.priority)
    || typeof record.locked !== 'boolean'
    || typeof record.effective !== 'boolean'
    || !(record.conflict === null || record.conflict === undefined || typeof record.conflict === 'string')) {
    throw new Error('Invalid policy rules response')
  }
  return {
    id: record.id,
    layer: record.layer as PolicyRuleLayer,
    ownerId: (record.ownerId as string | null) ?? null,
    actionClass: record.actionClass,
    resource: record.resource,
    effect: record.effect as ApprovalPolicyEffect,
    priority: record.priority as number,
    locked: record.locked,
    effective: record.effective,
    conflict: typeof record.conflict === 'string' ? record.conflict : null,
  }
}

function normalizePolicyToolFace(value: unknown): PolicyToolFaceView {
  const record = asRecord(value)
  if (!record
    || !(record.id === null || typeof record.id === 'string')
    || !isEnumValue(record.scope, policyToolFaceScopes)
    || !(record.ownerId === null || typeof record.ownerId === 'string')
    || typeof record.tool !== 'string'
    || record.tool.length === 0
    || typeof record.actionClass !== 'string'
    || record.actionClass.length === 0
    || !isEnumValue(record.shape, approvalPolicyShapes)) {
    throw new Error('Invalid policy tool-faces response')
  }
  return {
    id: (record.id as string | null) ?? null,
    scope: record.scope,
    ownerId: (record.ownerId as string | null) ?? null,
    tool: record.tool,
    actionClass: record.actionClass,
    shape: record.shape as ApprovalPolicyShape,
  }
}

function normalizePolicyArray<T>(payload: unknown, normalize: (value: unknown) => T, label: string): T[] {
  if (!Array.isArray(payload)) throw new Error(`Invalid ${label} response: expected an array`)
  return payload.map(normalize)
}

function normalizeWorkspace(value: unknown): ApiWorkspace | undefined {
  const record = asRecord(value)
  if (!record || typeof record.id !== 'string' || typeof record.name !== 'string') return undefined
  return {
    id: record.id,
    name: record.name,
    description: typeof record.description === 'string' ? record.description : record.description === null ? null : undefined,
    ownerId: typeof record.ownerId === 'string' ? record.ownerId : undefined,
    storageBackend: typeof record.storageBackend === 'string' ? record.storageBackend : undefined,
    storageRef: typeof record.storageRef === 'string' ? record.storageRef : undefined,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : undefined,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : undefined,
  }
}

export class ApiError extends Error {
  constructor(public readonly problem: ProblemDetails) {
    super(problem.detail || problem.code || `API error ${problem.status}`)
    this.name = 'ApiError'
  }
}

function normalizeSession(value: unknown): SessionResponse {
  const root = asRecord(value)
  const record = asRecord(root?.session) ?? root
  if (!record || typeof record.id !== 'string') {
    throw new Error('Invalid session response: missing id')
  }
  const workspace = normalizeWorkspace(root?.workspace) ?? normalizeWorkspace(record.workspace)
  return {
    id: record.id,
    title: typeof record.title === 'string' && record.title.length > 0 ? record.title : 'Untitled',
    workspaceId: typeof record.workspaceId === 'string' ? record.workspaceId : workspace?.id,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : undefined,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : undefined,
    modelProvider: typeof record.modelProvider === 'string' ? record.modelProvider : undefined,
    modelName: typeof record.modelName === 'string' ? record.modelName : undefined,
    workspace,
  }
}

function normalizeWorkspaceResponse(value: unknown): ApiWorkspace {
  const root = asRecord(value)
  const workspace = normalizeWorkspace(root?.workspace) ?? normalizeWorkspace(root)
  if (!workspace) throw new Error('Invalid workspace response: missing id or name')
  return workspace
}

function endpoint(path: string): string {
  return path.startsWith('/api/v1/') || path.startsWith('/internal/v1/') ? path : `${API_BASE}${path}`
}

export function apiAuthHeaders(headers?: HeadersInit, includeContentType = true): Record<string, string> {
  const result: Record<string, string> = {}
  if (headers instanceof Headers) headers.forEach((value, key) => { result[key] = value })
  else if (Array.isArray(headers)) headers.forEach(([key, value]) => { result[key] = value })
  else Object.assign(result, headers ?? {})
  const token = localStorage.getItem('xihe-token')
  if (token) result.Authorization = `Bearer ${token}`
  if (includeContentType && !result['Content-Type']) result['Content-Type'] = 'application/json'
  return result
}

export async function apiErrorFromResponse(res: Response): Promise<never> {
  let problem: Partial<ProblemDetails> = {}
  try { problem = await res.json() as Partial<ProblemDetails> } catch { /* non-JSON upstream error */ }
  throw new ApiError({
    type: problem.type,
    title: problem.title,
    status: problem.status ?? res.status,
    code: problem.code ?? 'API_ERROR',
    detail: problem.detail || `API error ${problem.status ?? res.status}`,
    requestId: problem.requestId || res.headers?.get('X-Request-Id') || 'unknown',
    runId: problem.runId,
    provider: problem.provider,
    model: problem.model,
    retryable: problem.retryable,
    outcome: problem.outcome,
  })
}

async function checkedFetch(path: string, options?: RequestInit): Promise<Response> {
  const hasBody = options?.body !== undefined && options.body !== null
  const includeContentType = hasBody && !(options?.body instanceof FormData)
  const res = await fetch(endpoint(path), { ...options, headers: apiAuthHeaders(options?.headers, includeContentType) })
  const isAuthEndpoint = path === '/auth/login' || path === '/auth/register'
  if (res.status === 401 && !isAuthEndpoint) {
    localStorage.removeItem('xihe-token')
    localStorage.removeItem('xihe-user')
    if (!['/login', '/register'].includes(window.location.pathname)) window.location.href = '/login'
    throw new ApiError({ status: 401, code: 'AUTHORIZATION_REQUIRED', detail: 'Session expired', requestId: res.headers?.get('X-Request-Id') || 'unknown' })
  }
  if (!res.ok) return apiErrorFromResponse(res)
  return res
}

export async function apiRaw(path: string, options?: RequestInit): Promise<Response> {
  return checkedFetch(path, options)
}

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await checkedFetch(path, options)
  if (res.status === 204) return undefined as T
  return res.json()
}

export async function apiPost<T = unknown>(path: string, body?: BodyInit | null, headers?: Record<string, string>): Promise<T> {
  const requestHeaders = apiAuthHeaders(headers)
  if (body instanceof FormData) delete requestHeaders['Content-Type']
  const res = await checkedFetch(path, {
    method: 'POST',
    headers: requestHeaders,
    body,
  })
  if (res.status === 204) return undefined as T
  return res.json()
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await checkedFetch(path, {
    headers: apiAuthHeaders(undefined, false),
  })
  if (res.status === 204) return undefined as T
  return res.json()
}

export async function apiDelete(path: string): Promise<void> {
  await checkedFetch(path, {
    method: 'DELETE',
    headers: apiAuthHeaders(undefined, false),
  })
}

export function workspaceHeaders(workspaceId: string | null | undefined): Record<string, string> {
  if (!workspaceId || workspaceId.trim().length === 0) {
    throw new ApiError({
      status: 400,
      code: 'WORKSPACE_CONTEXT_REQUIRED',
      detail: 'Workspace context is required',
      requestId: 'client',
    })
  }
  return { 'X-Workspace-Id': workspaceId }
}

function runtimeMcpHeaders(workspaceId: string): Record<string, string> {
  return {
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2026-07-28',
    ...workspaceHeaders(workspaceId),
  }
}

async function callRuntimeTool<T>(tool: string, args: Record<string, unknown>, workspaceId: string): Promise<T> {
  const res = await checkedFetch('/mcp', {
    method: 'POST',
    headers: runtimeMcpHeaders(workspaceId),
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      id: Date.now(),
      params: { name: tool, arguments: args },
    }),
  })
  const text = await res.text()
  const jsonLine = text.startsWith('data:')
    ? text.split('\n').find((line) => line.startsWith('data:'))!.slice(5).trim()
    : text
  const body = JSON.parse(jsonLine)
  if (body.error) {
    throw new ApiError({
      status: 502,
      code: 'MCP_TOOL_ERROR',
      detail: body.error.message || 'MCP tool call failed',
      requestId: res.headers.get('X-Request-Id') || 'unknown',
    })
  }
  const result = body.result
  if (result?.isError) {
    throw new ApiError({
      status: 502,
      code: 'MCP_TOOL_ERROR',
      detail: result.content?.[0]?.text || 'MCP tool error',
      requestId: res.headers.get('X-Request-Id') || 'unknown',
    })
  }
  if (result?.structuredContent !== undefined) return result.structuredContent as T
  const textContent = result?.content?.[0]?.text
  if (typeof textContent === 'string') {
    try { return JSON.parse(textContent) as T } catch { return textContent as T }
  }
  return result as T
}

export const api = {
  login(email: string, password: string) {
    return request<{ accessToken: string; user: { id: string; email: string; workspaceId?: string }; workspaceId?: string; workspace?: ApiWorkspace }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
  },
  register(email: string, password: string, name: string) {
    return request<{ accessToken: string; user: { id: string; email: string; workspaceId?: string }; workspaceId?: string; workspace?: ApiWorkspace }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    })
  },
  async getSessions(): Promise<SessionListResponse> {
    const payload = await request<unknown>('/sessions')
    const root = asRecord(payload)
    const rawSessions = Array.isArray(root?.sessions) ? root.sessions : Array.isArray(payload) ? payload : null
    if (!rawSessions) throw new Error('Invalid sessions response: missing sessions')
    return {
      sessions: rawSessions.map(normalizeSession),
      workspace: normalizeWorkspace(root?.workspace),
    }
  },
  async getSession(id: string): Promise<SessionResponse> {
    return normalizeSession(await request<unknown>(`/sessions/${encodeURIComponent(id)}`))
  },
  async createSession(title?: string): Promise<SessionResponse> {
    const body = title === undefined ? {} : { title }
    return normalizeSession(await request<unknown>('/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    }))
  },
  async updateSession(id: string, patch: { title?: string; modelProvider?: string; modelName?: string; providerConnectionId?: string }): Promise<SessionResponse> {
    return normalizeSession(await request<unknown>(`/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }))
  },
  deleteSession(id: string) {
    return apiDelete(`/sessions/${encodeURIComponent(id)}`)
  },
  getMessages(sessionId: string) {
    return request<Array<{ id: string; sessionId: string; role: string; content: string; createdAt: string; runId?: string; runStatus?: string; terminalOutcome?: string; errorCode?: string; error?: string; retryable?: boolean; attachments?: Array<{ fileId: string; name: string; type: string; size: number }> }>>(`/sessions/${encodeURIComponent(sessionId)}/messages`)
  },
  deleteMessage(sessionId: string, messageId: string) {
    return apiDelete(`/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`)
  },
  decideChatApproval(requestId: string, decision: ApprovalDecision | boolean): Promise<ChatApprovalDecisionResponse> {
    return request<ChatApprovalDecisionResponse>(`/chat/approvals/${encodeURIComponent(requestId)}/decision`, {
      method: 'POST',
      body: JSON.stringify(typeof decision === 'boolean' ? { approved: decision } : decision),
    })
  },
  async getPendingApprovals(signal?: AbortSignal): Promise<PendingApprovalSummary[]> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const abortFromCaller = () => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', abortFromCaller, { once: true })
    }
    try {
      const payload = await request<unknown>('/approvals/pending', { signal: controller.signal })
      if (!Array.isArray(payload)) throw new Error('Invalid pending approvals response: expected an array')
      const summaries = payload.map(normalizePendingApprovalSummary)
      if (summaries.some((summary): summary is null => summary === null)) {
        throw new Error('Invalid pending approvals response: malformed summary')
      }
      return summaries.filter((summary): summary is PendingApprovalSummary => summary !== null)
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abortFromCaller)
    }
  },
  async getPolicyMode(sessionId: string): Promise<SessionPolicyModeState> {
    const query = new URLSearchParams({ sessionId }).toString()
    return normalizePolicyModeState(await request<unknown>(`/policy/mode?${query}`), sessionId)
  },
  async setPolicyMode(sessionId: string, mode: SessionPolicyMode): Promise<PolicyModeUpdateResponse> {
    return normalizePolicyModeUpdateResponse(await request<unknown>('/policy/mode', {
      method: 'POST',
      body: JSON.stringify({ sessionId, mode }),
    }), sessionId)
  },
  /** PLAN-0328 M1: per-domain effective layer and per-layer rule counts. */
  async listPolicyDomains(): Promise<PolicyDomainView[]> {
    return normalizePolicyArray(await request<unknown>('/policy/domains'), normalizePolicyDomainView, 'policy domains')
  },
  /** Rules of one persisted layer, including the server's `effective` flag and `conflict` note. */
  async listPolicyRules(layer: PolicyRuleLayer): Promise<PolicyRuleView[]> {
    const query = new URLSearchParams({ layer }).toString()
    return normalizePolicyArray(await request<unknown>(`/policy/rules?${query}`), normalizePolicyRuleView, 'policy rules')
  },
  async createPolicyRule(input: {
    layer: PolicyRuleLayer
    actionClass: string
    resource: string
    effect: ApprovalPolicyEffect
    priority?: number
    locked?: boolean
  }): Promise<PolicyRuleView> {
    const body: Record<string, unknown> = {
      layer: input.layer,
      actionClass: input.actionClass,
      resource: input.resource,
      effect: input.effect,
    }
    if (input.priority !== undefined) body.priority = input.priority
    if (input.locked !== undefined) body.locked = input.locked
    return normalizePolicyRuleView(await request<unknown>('/policy/rules', {
      method: 'POST',
      body: JSON.stringify(body),
    }))
  },
  deletePolicyRule(id: string, layer: PolicyRuleLayer) {
    const query = new URLSearchParams({ layer }).toString()
    return apiDelete(`/policy/rules/${encodeURIComponent(id)}?${query}`)
  },
  /** Static conflict view for one layer: the subset of rules carrying a `conflict` note. */
  async listPolicyRuleConflicts(layer: PolicyRuleLayer): Promise<PolicyRuleView[]> {
    const query = new URLSearchParams({ layer }).toString()
    return normalizePolicyArray(
      await request<unknown>(`/policy/rules/conflicts?${query}`),
      normalizePolicyRuleView,
      'policy rule conflicts',
    )
  },
  /**
   * Effective tool-face catalog. `builtin` is response metadata only: persisted instance rows
   * override built-ins and workspace rows override both for a workspace request.
   */
  async listPolicyToolFaces(scope: PolicyToolFaceQueryScope): Promise<PolicyToolFaceView[]> {
    const query = new URLSearchParams({ scope }).toString()
    return normalizePolicyArray(
      await request<unknown>(`/policy/tool-faces?${query}`),
      normalizePolicyToolFace,
      'policy tool-faces',
    )
  },
  /** Explicit classification (workspace OWNER/ADMIN, or instance ADMIN). Never automatic. */
  async upsertPolicyToolFace(input: {
    scope: PolicyToolFaceQueryScope
    tool: string
    actionClass: string
    shape: ApprovalPolicyShape
  }): Promise<PolicyToolFaceView> {
    return normalizePolicyToolFace(await request<unknown>('/policy/tool-faces', {
      method: 'POST',
      body: JSON.stringify({
        scope: input.scope,
        tool: input.tool,
        actionClass: input.actionClass,
        shape: input.shape,
      }),
    }))
  },
  getHealth() {
    return request<{ status: string }>('/health')
  },
  getServiceStatus() {
    return request<{
      status: string
      timestamp: number
      services: Array<{
        name: string
        key: string
        status: string
        responseMs?: number
        error?: string
        version?: string
        database?: string
        size?: string
        connections?: number
        url?: string
        details?: string
      }>
    }>('/status')
  },
  listOperations(filters: {
    sessionId?: string
    workspaceId?: string
    status?: OperationStatus | string
    page?: number
    size?: number
  } = {}): Promise<OperationListResponse> {
    const params = new URLSearchParams()
    if (filters.sessionId) params.set('sessionId', filters.sessionId)
    if (filters.workspaceId) params.set('workspaceId', filters.workspaceId)
    if (filters.status) params.set('status', filters.status)
    if (filters.page !== undefined) params.set('page', String(filters.page))
    if (filters.size !== undefined) params.set('size', String(filters.size))
    const query = params.toString()
    return request<OperationListResponse>(`/operations${query ? `?${query}` : ''}`)
  },
  async getOperationTrace(operationId: string): Promise<OperationTrace> {
    return normalizeOperationTrace(await request<unknown>(`/operations/${encodeURIComponent(operationId)}`))
  },
  async listDirectory(path: string, workspaceId: string) {
    const raw = await callRuntimeTool<{ entries?: Array<{ name: string; path: string; is_dir?: boolean; type?: string; size?: number; modified?: string }> }>(
      'list_directory', { path }, workspaceId
    )
    const entries = (raw.entries ?? []).map((e) => ({
      name: e.name,
      path: e.path,
      type: e.type ?? (e.is_dir ? 'directory' : 'file'),
      size: e.size,
      modified: e.modified,
    }))
    return { entries }
  },
  async readFile(path: string, workspaceId: string) {
    const content = await callRuntimeTool<string>('read_file', { path }, workspaceId)
    return { content: typeof content === 'string' ? content : String(content) }
  },
  // PLAN-292 T6: binary-safe read — the tool returns {content, total_lines,
  // is_binary} where content is base64 when is_binary is true.
  async readFileRange(path: string, workspaceId: string, offset?: number, limit?: number) {
    const args: Record<string, unknown> = { path }
    if (offset !== undefined) args.offset = offset
    if (limit !== undefined) args.limit = limit
    return callRuntimeTool<{ content: string; total_lines: number; is_binary: boolean }>(
      'read_file_range',
      args,
      workspaceId,
    )
  },
  async writeFile(path: string, content: string, workspaceId: string) {
    await callRuntimeTool<string>('write_file', { path, content }, workspaceId)
    return { success: true }
  },
  async deleteFile(path: string, workspaceId: string) {
    await callRuntimeTool<string>('delete_file', { path }, workspaceId)
    return { success: true }
  },
  async moveFile(from: string, to: string, workspaceId: string) {
    await callRuntimeTool<string>('move_file', { from, to }, workspaceId)
    return { success: true }
  },
  async copyFile(from: string, to: string, workspaceId: string) {
    await callRuntimeTool<string>('copy_file', { from, to }, workspaceId)
    return { success: true }
  },
  async createDirectory(path: string, workspaceId: string) {
    await callRuntimeTool<string>('mkdir', { path }, workspaceId)
    return { success: true }
  },
  getMcpConfig(wsId: string) {
    return request<{ mcpServers?: string | Record<string, unknown> }>(`/workspaces/${encodeURIComponent(wsId)}/mcp-config`, {
      headers: workspaceHeaders(wsId),
    })
  },
  async getCurrentWorkspace(): Promise<ApiWorkspace> {
    return normalizeWorkspaceResponse(await request<unknown>('/workspaces/current'))
  },
  async getWorkspace(wsId: string): Promise<ApiWorkspace> {
    return normalizeWorkspaceResponse(await request<unknown>(`/workspaces/${encodeURIComponent(wsId)}`, {
      headers: workspaceHeaders(wsId),
    }))
  },
  async createWorkspace(input: {
    name?: string
    description?: string | null
    profile?: 'strict' | 'coding' | 'isolated'
  }): Promise<ApiWorkspace> {
    const body: Record<string, unknown> = {}
    if (input.name !== undefined) body.name = input.name
    if (input.description !== undefined) body.description = input.description
    if (input.profile !== undefined) body.profile = input.profile
    // image is server-allowlisted (v1: xihe/workspace:latest); UI keeps it read-only.
    return normalizeWorkspaceResponse(await request<unknown>('/workspaces', {
      method: 'POST',
      body: JSON.stringify(body),
    }))
  },
  async updateWorkspace(wsId: string, patch: { name?: string; description?: string | null }): Promise<ApiWorkspace> {
    return normalizeWorkspaceResponse(await request<unknown>(`/workspaces/${encodeURIComponent(wsId)}`, {
      method: 'PATCH',
      headers: workspaceHeaders(wsId),
      body: JSON.stringify(patch),
    }))
  },
  deleteWorkspace(wsId: string) {
    return request<void>(`/workspaces/${encodeURIComponent(wsId)}`, {
      method: 'DELETE',
      headers: workspaceHeaders(wsId),
    })
  },
  getWorkspaceEnvironment(wsId: string) {
    return request<{
      workspaceId: string
      status: string
      storageBackend: string
      storageRef: string
      executionSpec?: { status: string; generation: number; sandboxSpecHash: string }
      assignment?: { status: string; generation: number; sandboxSpecHash: string }
      runtime: { status: string; deviceId: string; lastHeartbeatAt: string }
    }>(`/workspaces/${encodeURIComponent(wsId)}/environment`, {
      headers: workspaceHeaders(wsId),
    })
  },
  /** M4: trigger async materialization (202). Poll getWorkspaceEnvironment for progress. */
  materializeWorkspace(wsId: string) {
    return request<{ status: string }>(`/workspaces/${encodeURIComponent(wsId)}/materialize`, {
      method: 'POST',
      headers: workspaceHeaders(wsId),
    })
  },
  saveMcpConfig(wsId: string, mcpServers: string) {
    return request<{ status: string }>(`/workspaces/${encodeURIComponent(wsId)}/mcp-config`, {
      method: 'PUT',
      headers: workspaceHeaders(wsId),
      body: JSON.stringify({ mcpServers }),
    })
  },
  startOAuthSession(body: {
    workspaceId: string
    serverId: string
    remoteEndpoint: string
    clientId: string
    authorizationEndpoint: string
    tokenEndpoint: string
    redirectUri: string
    scope: string
  }) {
    return request<{ state: string; authorizationUrl: string; expiresAtMillis: number }>('/oauth/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },
  completeOAuthSession(state: string, code: string) {
    const params = new URLSearchParams({ state, code })
    return request<{ status: string }>(`/oauth/callback?${params.toString()}`)
  },
  cancelChatRun(runId: string, reason = 'user_requested'): Promise<{ status: string; runId: string }> {
    return apiPost(`/chat/runs/${encodeURIComponent(runId)}/cancel`, JSON.stringify({ reason }))
  },
  // PLAN-292 M3 (C2): run status recovery for reconnected/refreshed clients.
  async getChatRunStatus(runId: string): Promise<{
    runId: string
    sessionId: string
    status: string
    terminalOutcome?: string | null
    leaseExpired: boolean
    pendingApprovals: ApprovalRequest[]
  }> {
    const payload = await request<unknown>(`/chat/runs/${encodeURIComponent(runId)}`, { method: 'GET' })
    const record = asRecord(payload)
    if (!record || typeof record.sessionId !== 'string') {
      throw new Error('Invalid chat run response: missing sessionId')
    }
    const rawApprovals = Array.isArray(record.pendingApprovals) ? record.pendingApprovals : []
    const pendingApprovals = rawApprovals
      .map((approval) => normalizeApprovalRequest(approval, record.sessionId as string))
      .map((approval) => approval ? { ...approval, runId: approval.runId || runId } : null)
      .filter((approval): approval is ApprovalRequest => approval !== null)
    return {
      runId: typeof record.runId === 'string' ? record.runId : runId,
      sessionId: record.sessionId,
      status: typeof record.status === 'string' ? record.status : 'unknown',
      terminalOutcome: typeof record.terminalOutcome === 'string' || record.terminalOutcome === null
        ? record.terminalOutcome
        : undefined,
      leaseExpired: record.leaseExpired === true,
      pendingApprovals,
    }
  },
}
