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

export interface ApprovalRequest {
  requestId: string
  runId: string
  sessionId: string
  workspaceId?: string
  tool: string
  action: string
  details: string
  expiresAt?: string
  replayed?: boolean
  state?: 'pending' | 'dispatching' | 'approved' | 'rejected' | 'expired' | 'dispatch_unknown'
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
  messageId?: string
  outcome?: 'success' | 'error' | 'partial' | 'ambiguous'
  errorCode?: string
}

export interface AgentState {
  status: 'idle' | 'thinking' | 'executing' | 'awaiting_approval' | 'error'
  currentToolCall: ToolCall | null
  pendingApprovals: ApprovalRequest[]
}

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
