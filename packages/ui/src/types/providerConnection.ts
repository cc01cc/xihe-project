export type ProviderScope = 'USER' | 'WORKSPACE' | 'SYSTEM'
export type ProviderAdapter = 'native-litellm' | 'openai-compatible' | 'manual-model'
export type ProviderCredentialType = 'api-key' | 'none'
export type ProviderConnectionStatus =
  | 'UNVERIFIED'
  | 'VERIFYING'
  | 'READY'
  | 'INVALID_CREDENTIALS'
  | 'UNREACHABLE'
  | 'DISABLED'

export interface ProviderDefinition {
  id: string
  displayName: string
  category?: 'recommended' | 'other' | 'custom'
  description?: string
  adapter: ProviderAdapter
  litellmProvider?: string | null
  defaultBaseUrl?: string | null
  modelDiscovery: 'remote-models' | 'litellm-catalog' | 'curated' | 'manual'
  credential: {
    type: ProviderCredentialType
    required: boolean
    placeholder?: string | null
  }
  supports: {
    customBaseUrl: boolean
    streaming: boolean
    tools?: boolean
    vision?: boolean
  }
}

export interface ProviderConnection {
  id: string
  providerId: string
  label: string
  scope: ProviderScope
  workspaceId?: string | null
  baseUrl?: string | null
  hasKey: boolean
  maskedKey?: string | null
  enabled: boolean
  status: ProviderConnectionStatus
  lastVerifiedAt?: string | null
  lastErrorCode?: string | null
  modelCount?: number
  revision: number
}

export interface ProviderConnectionInput {
  providerId: string
  label: string
  scope: Exclude<ProviderScope, 'SYSTEM'>
  apiKey?: string
  baseUrl?: string
  modelDiscovery?: ProviderDefinition['modelDiscovery']
  manualModels?: string[]
  enabled?: boolean
}
