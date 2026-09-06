import { request } from '../composables/api'
import type {
  ProviderConnection,
  ProviderConnectionInput,
  ProviderDefinition,
} from '../types/providerConnection'

export interface ProviderCatalogResponse {
  catalogRevision: string
  providers: ProviderDefinition[]
}

export interface ProviderConnectionListResponse {
  connections: ProviderConnection[]
}

export interface ProviderVerifyResponse {
  connection: ProviderConnection
  models: Array<{ name: string }>
}

export function listProviderCatalog(): Promise<ProviderCatalogResponse> {
  return request<ProviderCatalogResponse>('/provider-catalog')
}

export function listProviderConnections(): Promise<ProviderConnectionListResponse> {
  return request<ProviderConnectionListResponse>('/provider-connections')
}

export function createProviderConnection(input: ProviderConnectionInput): Promise<ProviderConnection> {
  return request<ProviderConnection>('/provider-connections', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateProviderConnection(
  id: string,
  input: Partial<ProviderConnectionInput>,
): Promise<ProviderConnection> {
  return request<ProviderConnection>(`/provider-connections/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export function verifyProviderConnection(id: string): Promise<ProviderVerifyResponse> {
  return request<ProviderVerifyResponse>(`/provider-connections/${encodeURIComponent(id)}/verify`, {
    method: 'POST',
  })
}

export function deleteProviderConnection(id: string): Promise<void> {
  return request<void>(`/provider-connections/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}
