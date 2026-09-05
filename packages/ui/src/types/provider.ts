import type { ProviderInfo } from '.'

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
    description: '小米 MiMo 系列模型（深度推理、函数调用、256K 上下文）',
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

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-4o': 128,
  'gpt-4o-mini': 128,
  'o1-preview': 128,
  'o1-mini': 128,
  'deepseek-chat': 64,
  'deepseek-reasoner': 64,
  'deepseek-r1': 64,
  'mimo-v2.5': 256,
  'mimo-v2-omni': 256,
  'mimo-v2.5-pro': 256,
  'claude-sonnet-4-20250514': 200,
  'claude-3-5-sonnet-20241022': 200,
}

export function getModelContextWindow(model: string): number | undefined {
  const key = Object.keys(MODEL_CONTEXT_WINDOWS).find((k) =>
    model.toLowerCase().includes(k.toLowerCase()),
  )
  return key ? MODEL_CONTEXT_WINDOWS[key] : undefined
}

export function getModelTags(_provider: string, model: string): string[] {
  const tags: string[] = []
  const lower = model.toLowerCase()
  if (lower.includes('vision')) tags.push('vision')
  if (lower.includes('reasoner') || lower.includes('r1') || lower.includes('o1')) tags.push('reasoning')
  if (lower.includes('omni') || lower.includes('tool')) tags.push('tool-use')
  return tags
}

export interface ModelCache {
  models: Record<string, string[]>
  providers?: Record<string, ProviderCatalog>
  configRevision?: string
  lastFetched?: number
}

export interface ModelCapabilities {
  chat: boolean
  vision: boolean
  tools: boolean
}

export interface CatalogModel {
  name: string
  capabilities: ModelCapabilities
}

export interface ProviderCatalog {
  status: 'ready' | 'missing_credentials' | 'invalid_credentials' | 'unreachable' | 'invalid_response' | 'model_unavailable'
  reasonCode?: string | null
  models: CatalogModel[]
  verifiedAt?: string | null
  configRevision?: string
}
