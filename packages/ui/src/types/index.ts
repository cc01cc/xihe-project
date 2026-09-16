import type { InjectionKey, Ref } from 'vue'

export interface SessionContext {
  agents: string[]
  ragContext?: RAGContext
  mcpContext?: MCPContext
  fileContext?: FileContext
}

export interface RAGContext {
  knowledgeBaseIds?: string[]
  searchEnabled?: boolean
}

export interface MCPContext {
  serverIds?: string[]
  toolFilter?: string[]
}

export interface FileContext {
  workspaceFiles?: string[]
  activeFilePath?: string
}

export interface Session {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  workspaceId?: string
  modelProvider?: string
  modelName?: string
  providerConnectionId?: string
  connectionRevision?: number
  context?: SessionContext
}

export interface ToolCall {
  id: string
  name: string
  arguments: string
  status: 'running' | 'completed' | 'failed' | 'pending'
  result?: string
  error?: string
  startedAt?: string
  completedAt?: string
}

export type ApprovalPolicyEffect = 'allow' | 'ask' | 'deny'
export type ApprovalPolicySourceLayer = 'builtin' | 'instance' | 'user' | 'workspace' | 'session' | 'per_call'
export type ApprovalPolicyMode = 'manual' | 'auto' | null
export type SessionPolicyMode = Exclude<ApprovalPolicyMode, null>
export type ApprovalPolicyShape = 'structured' | 'interpreter' | 'opaque'

export interface ApprovalPolicy {
  effect: ApprovalPolicyEffect
  sourceLayer: ApprovalPolicySourceLayer
  matchedRule: string | null
  reason: string
  mode: ApprovalPolicyMode
  modeAtGrant?: ApprovalPolicyMode
  actionClass: string
  shape: ApprovalPolicyShape
}

export type ApprovalRequestState = 'pending' | 'dispatching' | 'approved' | 'rejected' | 'expired' | 'dispatch_unknown'

export interface ApprovalRequest {
  requestId: string
  operationId?: string
  runId: string
  sessionId: string
  workspaceId?: string
  tool: string
  action: string
  details: string
  snapshotId?: string | null
  policyClass?: string | null
  argumentsHash?: string | null
  expiresAt?: string
  replayed?: boolean
  state?: ApprovalRequestState
  modeAtGrant?: ApprovalPolicyMode
  policy?: ApprovalPolicy
}

export type ApprovalDecisionKind = 'once' | 'session' | 'saved' | 'reject' | 'reject_always'

export interface ApprovalRuleSpec {
  resource?: string
}

export interface ApprovalDecision {
  decision: ApprovalDecisionKind
  feedback?: string
  layer?: 'workspace' | 'user'
  rule?: ApprovalRuleSpec
}

/**
 * Decision envelope emitted by the approval modal: the decision plus the `requestId` it was
 * composed for. The classify-and-allow write can resolve after the pending request changed, so
 * the caller must verify the envelope still matches the actionable request before deciding; the
 * `requestId` is dropped again before the API payload is built.
 */
export interface ApprovalDecisionEnvelope extends ApprovalDecision {
  requestId: string
}

export interface PendingApprovalSummary {
  sessionId: string
  workspaceId: string
  count: number
  oldestRequestedAt: string
}

export interface SessionPolicyModeState {
  sessionId: string
  mode: SessionPolicyMode
  sessionRules?: number
}

export interface PolicyModeUpdateResponse {
  sessionId: string
  mode: SessionPolicyMode
  scope: 'session'
}

/** Persisted policy layers (PLAN-0328 decision #53); `builtin` never holds persisted rules. */
export type PolicyRuleLayer = 'instance' | 'user' | 'workspace'

/** Response scope of a tool-face row; `builtin` is catalog metadata, never a write scope. */
export type PolicyToolFaceScope = 'builtin' | 'instance' | 'workspace'

/** Effective catalog scope accepted by `GET /api/v1/policy/tool-faces`. */
export type PolicyToolFaceQueryScope = 'instance' | 'workspace'

/**
 * `DomainView` from the CP policy admin API (PLAN-0328 M1).
 *
 * `effectiveLayer` is the highest configured layer for the domain (`builtin` when no persisted
 * layer configures it); `ruleCounts` only lists layers that hold at least one rule.
 */
export interface PolicyDomainView {
  actionClass: string
  effectiveLayer: ApprovalPolicySourceLayer
  configuredLayers: PolicyRuleLayer[]
  ruleCounts: Partial<Record<PolicyRuleLayer, number>>
}

/**
 * `RuleView` from the CP policy admin API (PLAN-0328 M1).
 *
 * `effective` means this rule's layer is the domain's effective layer — it does NOT mean the
 * rule matched at runtime. `conflict` carries the server's static conflict note (for example an
 * allow shadowed by a more specific deny) and is null when the row has none.
 */
export interface PolicyRuleView {
  id: string
  layer: PolicyRuleLayer
  ownerId: string | null
  actionClass: string
  resource: string
  effect: ApprovalPolicyEffect
  priority: number
  locked: boolean
  effective: boolean
  conflict: string | null
}

/**
 * `FaceView` from the CP policy admin API (PLAN-0328 M1).
 *
 * Built-in catalog rows use `id: null`, `scope: 'builtin'` and `ownerId: null`. Persisted
 * instance/workspace rows override built-ins for the same tool; an unclassified third-party tool
 * is absent until its first approval request.
 */
export interface PolicyToolFaceView {
  id: string | null
  scope: PolicyToolFaceScope
  ownerId: string | null
  tool: string
  actionClass: string
  shape: ApprovalPolicyShape
}

export interface AttachmentFile {
  id: string
  name: string
  type: string
  size: number
  url: string
  state: 'idle' | 'uploading' | 'processing' | 'error' | 'done'
  fileId?: string
}

export type MessagePart =
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'citation'; index: number }
  | { type: 'artifact'; identifier: string; artifactType: string; title: string; content: string }

export interface Message {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  /** @deprecated Use `parts` instead. Kept for backward compat with old data. */
  content: string
  parts?: MessagePart[]
  timestamp: string
  toolCalls?: ToolCall[]
  isStreaming?: boolean
  attachments?: AttachmentFile[]
  marker?: 'status' | 'date' | 'tool'
  status?: string
  runId?: string
  operationId?: string
  runStatus?: 'queued' | 'accepted' | 'running' | 'streaming' | 'succeeded' | 'failed' | 'partial' | 'ambiguous' | 'cancelled'
  terminalOutcome?: 'success' | 'error' | 'partial' | 'ambiguous'
  errorCode?: string
  error?: string
  retryable?: boolean
}

export interface ProviderConfig {
  provider: string
  apiKey: string
  baseUrl?: string
}

export interface ModelConfig {
  provider: string
  model: string
  apiKey: string
  baseUrl?: string
}

export interface ProviderInfo {
  id: string
  name: string
  defaultModel: string
  defaultBaseUrl: string
  description?: string
}

export interface ThemeConfig {
  mode: 'dark' | 'light' | 'system'
}

export interface MCPConfig {
  configJson: string
}

export interface SessionModelBinding {
  provider: string
  model: string
  connectionId?: string
  connectionRevision?: number
}

export interface ModelFavorite {
  provider: string
  model: string
}

export type Language = 'zh-CN' | 'en-US'

export type SSEEventType = 'token' | 'tool_call' | 'tool_result' | 'approval_request' | 'status' | 'error' | 'done'

export interface SSEEvent {
  type: SSEEventType
  data: Record<string, unknown>
}

export interface ChatRunResponse {
  status: 'queued' | 'accepted' | 'running' | 'streaming' | 'succeeded' | 'failed' | 'partial' | 'ambiguous' | 'cancelled'
  sessionId: string
  runId: string
  operationId?: string
  messageId?: string
  outcome?: 'success' | 'error' | 'partial' | 'ambiguous'
  errorCode?: string
}

export type OperationStatus = 'accepted' | 'running' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'ambiguous'

export interface OperationSummary {
  id: string
  sessionId?: string | null
  workspaceId?: string | null
  runId?: string | null
  kind: string
  source: string
  actorType: string
  status: OperationStatus | string
  summary?: string | null
  errorCode?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  createdAt?: string | null
}

/**
 * Safe policy verdict snapshot carried by operation items (PLAN-0328 T1.15, spec ui-ux §3.5).
 * Exactly the server-projected fields; `matchedRule` / `mode` / `allowedBy` are nullable and
 * absent for legacy rows or non-MCP paths. The projection never contains raw arguments.
 *
 * `reused` is the T1.7 session-fingerprint annotation: `true` means this dispatch was authorized
 * by an exact session reuse (never a verdict effect of its own); `null` (or an absent key on
 * legacy V19 snapshots) means reuse was not applicable. The view must not infer reuse otherwise.
 */
export interface OperationPolicyView {
  effect: ApprovalPolicyEffect
  sourceLayer: ApprovalPolicySourceLayer
  matchedRule: string | null
  reason: string
  mode: ApprovalPolicyMode
  allowedBy: string | null
  actionClass: string
  shape: ApprovalPolicyShape
  reused?: boolean | null
}

export interface OperationItemView {
  id: string
  operationId: string
  toolCallId?: string | null
  sequence: number
  kind: string
  toolName?: string | null
  source: string
  policyDecision?: string | null
  policy?: OperationPolicyView
  approvalRequestId?: string | null
  status: string
  errorCode?: string | null
  startedAt?: string | null
  finishedAt?: string | null
}

export interface OperationAttemptView {
  id: string
  itemId: string
  stage: string
  retryNo: number
  parentAttemptId?: string | null
  module: string
  status: string
  errorCode?: string | null
  durationMs?: number | null
  startedAt?: string | null
  finishedAt?: string | null
}

export interface OperationEventView {
  id: string
  operationId: string
  itemId?: string | null
  attemptId?: string | null
  sequence: number
  eventType: string
  state: string
  actor: string
  createdAt?: string | null
}

export interface OperationListResponse {
  operations: OperationSummary[]
  page: number
  size: number
  totalElements: number
  totalPages: number
}

export interface OperationTrace {
  operation: OperationSummary
  items: OperationItemView[]
  attempts: OperationAttemptView[]
  events: OperationEventView[]
}

export interface AgentState {
  status: 'idle' | 'thinking' | 'executing' | 'awaiting_approval' | 'error'
  currentToolCall: ToolCall | null
  pendingApprovals: ApprovalRequest[]
}

export interface ChatSessionRunState {
  runId?: string
  status: AgentState['status']
}

// ── PLAN-0328 M2/M3: Run checkpoint (shadow-git snapshot) ────────────────────
// Wire shapes follow the CP RunCheckpointController / OpenAPI contract. `unknown`
// members are UI-only fallbacks for out-of-contract values: a marker must never
// claim "rollbackable" or "no snapshot" from a value it does not understand.

/** Public checkpoint projection states; `unknown` = out-of-contract fallback. */
export type RunCheckpointState = 'none' | 'base' | 'sealed' | 'unsealed' | 'degraded' | 'expired' | 'unknown'

/** Last revert outcome; `unknown` = out-of-contract fallback. */
export type RunCheckpointRevertState = 'none' | 'rolled_back' | 'partial' | 'failed' | 'unknown'

export interface RunCheckpointChangedFile {
  status: string
  path: string
}

/** Projection revert counts; individual keys may be absent in legacy summaries. */
export interface RunCheckpointRevertCounts {
  restored?: number
  deleted?: number
  skippedConflict?: number
  failed?: number
  noop?: number
}

/** Last revert attempt view (`revert` object of the projection and the SSE event). */
export interface RunCheckpointRevertView {
  state: RunCheckpointRevertState
  at: string | null
  counts: RunCheckpointRevertCounts | null
  ref: string | null
}

/** `GET /api/v1/chat/runs/{runId}/checkpoint` projection. */
export interface RunCheckpointView {
  runId: string
  checkpointId?: string
  state: RunCheckpointState
  unrollableReason?: string
  changedCount: number
  /** Capped at 20 by the CP; `changedCount` always covers the full set. */
  changedFiles: RunCheckpointChangedFile[]
  sealedAt: string | null
  revert: RunCheckpointRevertView | null
}

/** SSE `run_checkpoint` payload (seal / degradation / completed revert). */
export interface RunCheckpointEvent {
  runId: string
  sessionId: string
  state: RunCheckpointState
  changedCount: number
  unrollableReason?: string
  revert?: RunCheckpointRevertView
}

/** Dry-run action; `unknown` = out-of-contract fallback. */
export type RevertPreviewAction = 'restore' | 'delete' | 'unknown'

export interface RevertPreviewEntry {
  path: string
  oldPath?: string
  action: RevertPreviewAction
  /** Frozen conflict reason code when this entry will be skipped. */
  conflictReason?: string
}

export interface RevertPreviewCounts {
  restore: number
  delete: number
  skipConflicts: number
  noop: number
}

export type HeadFingerprintStatus = 'ok' | 'changed' | 'unknown' | 'not_repo'

export interface HeadFingerprint {
  recorded: string | null
  current: string | null
  status: HeadFingerprintStatus
}

/** `POST .../checkpoint/revert/preview` response. */
export interface RevertPreview {
  runId: string
  state: string
  /** `null` when the server projection is incomplete; the UI must not guess. */
  counts: RevertPreviewCounts | null
  entries: RevertPreviewEntry[]
  headFingerprint: HeadFingerprint
  sealedWithLiveJobs: boolean
  truncated: boolean
}

/** Per-entry execution outcome; `unknown` = out-of-contract fallback. */
export type RevertEntryResult = 'restored' | 'deleted' | 'skippedConflict' | 'failed' | 'noop' | 'unknown'

export interface RevertResultEntry {
  path: string
  result: RevertEntryResult
  reason?: string
}

export interface RevertResultCounts {
  restored: number
  deleted: number
  skippedConflict: number
  failed: number
  noop: number
}

/** `POST .../checkpoint/revert` response. */
export interface RevertResult {
  runId: string
  /** Runtime audit ref; `null` when it could not be written. */
  revertRef: string | null
  counts: RevertResultCounts | null
  entries: RevertResultEntry[]
  durationMs: number
}

/** Acknowledge payload of the revert execute call. */
export interface RevertAcknowledge {
  acknowledgeConflicts: string[]
  acknowledgeHeadChange: boolean
}

export interface WorkspaceGitStatusEntry {
  status: string
  path: string
}

/** `GET /api/v1/workspaces/{id}/git-status` (dual-diff "待提交" side). */
export interface WorkspaceGitStatus {
  isRepository: boolean
  entries: WorkspaceGitStatusEntry[]
}

/** `GET .../checkpoints/retention` response (decision #10 constants + counts). */
export interface CheckpointRetention {
  maxRuns: number
  ttlDays: number
  unsealedNeverDeleted: boolean
  currentRuns: number
  currentRefs: number
}

/** `POST .../checkpoints/gc` counts; keys are Runtime-defined. */
export type CheckpointGcCounts = Record<string, number>

export type LangChainEventType =
  | 'on_chat_model_start'
  | 'on_chat_model_stream'
  | 'on_llm_end'
  | 'on_tool_start'
  | 'on_tool_end'
  | 'on_tool_error'
  | 'on_chain_start'
  | 'on_chain_end'

export interface LangChainEvent {
  event: LangChainEventType
  name?: string
  data?: Record<string, unknown>
  run_id?: string
}

export interface User {
  id: string
  email: string
  name?: string
  workspaceId?: string
  /** CP role name (`ADMIN` / `USER`); drives the instance settings entry (PLAN-0307 T2.17). */
  role?: string
}

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  mimeType?: string
  size?: number
  modified?: string
  children?: FileNode[]
}

export interface OpenFile {
  path: string
  name: string
  content: string
  originalContent: string
  language: string
  modified: boolean
  loading: boolean
  truncated?: boolean
  chunks?: string[]
  chunkIndex?: number
}

export interface UploadItem {
  file: File
  name: string
  size: number
  status: 'pending' | 'uploading' | 'done' | 'error' | 'cancelled'
  targetPath: string
  error?: string
}

export type ViewMode = 'single' | 'scrollable' | 'dual'

export interface ThemeContext {
  theme: Ref<'light' | 'dark'>
  colorMode: Ref<'light' | 'dark' | 'system'>
  setColorMode: (mode: 'light' | 'dark' | 'system') => void
}

export const ThemeInjectionKey: InjectionKey<ThemeContext> = Symbol('theme')
