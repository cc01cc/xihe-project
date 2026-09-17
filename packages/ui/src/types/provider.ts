import type { ProviderInfo } from '.'

/**
 * Offline fallback only (PLAN-0364 M4).
 *
 * The authoritative provider source is the CP catalog
 * (`provider-catalog/providers.json`, served by `/api/v1/provider-catalog`):
 * it owns displayName / description / defaultBaseUrl / adapter / supports.
 * This list only covers the "catalog not loaded yet" path (e.g. default-model
 * hints, config settings labels). Do not add capability claims here.
 */
const BUILTIN_PROVIDERS_LIST: ProviderInfo[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    defaultModel: 'gpt-4o',
    defaultBaseUrl: 'https://api.openai.com/v1',
    description: 'OpenAI GPT-4o 及更多模型',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    defaultModel: 'deepseek-chat',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    description: 'DeepSeek V3/R1 系列模型',
  },
  {
    id: 'xiaomi',
    name: '小米 MiMo',
    defaultModel: 'mimo-v2.5',
    defaultBaseUrl: 'https://api.xiaomimimo.com/v1',
    description: '小米 MiMo 系列模型（深度推理、长上下文）',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    defaultModel: 'claude-sonnet-4-20250514',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    description: 'Anthropic Claude 系列模型',
  },
]

export const BUILTIN_PROVIDERS: readonly ProviderInfo[] = Object.freeze(BUILTIN_PROVIDERS_LIST)

export function isBuiltinProvider(id: string): boolean {
  return BUILTIN_PROVIDERS.some((p) => p.id === id)
}

export function getProviderInfo(id: string): ProviderInfo | undefined {
  return BUILTIN_PROVIDERS.find((p) => p.id === id)
}

export interface ModelCache {
  models: Record<string, string[]>
  providers?: Record<string, ProviderCatalog>
  configRevision?: string
  lastFetched?: number
}

export interface ModelCapabilities {
  /** PLAN-0364 M4: model-level vision/tools are no longer guessed here. */
  chat: boolean
}

export interface CatalogModel {
  name: string
  capabilities: ModelCapabilities
}

export interface ProviderCatalog {
  status: 'ready' | 'missing_credentials' | 'invalid_credentials' | 'unreachable' | 'invalid_response' | 'model_unavailable'
  reasonCode?: string | null
  models: CatalogModel[]
  connectionId?: string
  connectionRevision?: number
  scope?: 'USER' | 'WORKSPACE'
  displayName?: string
  verifiedAt?: string | null
  configRevision?: string
}
