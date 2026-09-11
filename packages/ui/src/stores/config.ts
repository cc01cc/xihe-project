import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useLocalStorage } from '@vueuse/core'
import { getProviderInfo, type ModelCache } from '../types/provider'
import type { SessionModelBinding, ModelFavorite } from '../types'
import { request } from '../composables/api'

export type ConfigLayer = 'instance' | 'workspace' | 'user'

/** PLAN-0307 target domain set (decision #37): instance(8) ⊇ user(7) ⊇ workspace(5). */
export const CONFIG_DOMAINS = [
  'llm-provider', 'context-policy', 'embedding', 'rag',
  'agent-runtime', 'agent-profile', 'user-preference', 'logging',
] as const

export type ConfigDomain = typeof CONFIG_DOMAINS[number]

export const LAYER_DOMAINS: Record<ConfigLayer, readonly ConfigDomain[]> = {
  instance: CONFIG_DOMAINS,
  user: ['llm-provider', 'context-policy', 'embedding', 'rag', 'agent-runtime', 'agent-profile', 'user-preference'],
  workspace: ['llm-provider', 'context-policy', 'embedding', 'rag', 'agent-runtime'],
}

export interface ConfigImportReport {
  status: string
  imported: number
  skipped: number
  warnings: string[]
}

const MODEL_CACHE_KEY = 'xihe-model-cache'
const SESSION_MODELS_KEY = 'xihe-session-models'
const MODEL_FAVORITES_KEY = 'xihe-model-favorites'
const MERGED_CONFIG_KEY = 'xihe-config-merged'

export const useConfigStore = defineStore('config', () => {
  const mergedConfig = useLocalStorage<Record<string, Record<string, string>>>(MERGED_CONFIG_KEY, {})
  const loading = ref(false)
  const error = ref<string | null>(null)

  /** Per-layer raw entries for the three settings entries (T2.17). */
  const layerConfig = ref<Record<ConfigLayer, Record<string, Record<string, string>>>>({
    instance: {},
    workspace: {},
    user: {},
  })
  const layerLoading = ref(false)
  /** domain -> key -> env-effective value when an env overlay wins (decision #22). */
  const envOverridden = ref<Record<string, Record<string, string>>>({})

  const modelCache = useLocalStorage<ModelCache>(MODEL_CACHE_KEY, { models: {}, providers: {} })
  const sessionModels = useLocalStorage<Record<string, SessionModelBinding>>(SESSION_MODELS_KEY, {})
  const modelFavorites = useLocalStorage<ModelFavorite[]>(MODEL_FAVORITES_KEY, [])
  const modelError = ref<string | null>(null)

  function findProviderForModel(modelId: string): string | undefined {
    for (const provider of Object.keys(modelCache.value.providers ?? {})) {
      if (getChatModels(provider).includes(modelId)) return provider
    }
    return undefined
  }

  function migrateSessionModels() {
    try {
      const raw = sessionModels.value
      let changed = false
      for (const [sid, val] of Object.entries(raw)) {
        if (typeof val === 'string') {
          const provider = findProviderForModel(val as unknown as string)
          raw[sid] = { provider: provider ?? '', model: val as unknown as string }
          changed = true
        }
      }
      if (changed) sessionModels.value = { ...raw }
    } catch {
      sessionModels.value = {}
    }
  }

  migrateSessionModels()

  async function fetchDomain(domain: string): Promise<Record<string, string>> {
    return request<Record<string, string>>(`/config/${domain}`)
  }

  async function loadAllDomains() {
    loading.value = true
    error.value = null
    const domains: ConfigDomain[] = [...CONFIG_DOMAINS]
    try {
      const results = await Promise.all(domains.map(d => fetchDomain(d).then(data => ({ domain: d, data }))))
      const nextConfig: Record<string, Record<string, string>> = {}
      for (const { domain, data } of results) {
        nextConfig[domain] = data
      }
      mergedConfig.value = nextConfig
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load config'
    } finally {
      loading.value = false
    }
  }

  /**
   * PLAN-0307 T2.17: load one layer's entries for all writable domains of that
   * layer, together with the env-lock metadata (`includeMeta=true`).
   */
  async function loadLayerDomains(layer: ConfigLayer, workspaceId?: string | null): Promise<void> {
    layerLoading.value = true
    error.value = null
    const workspaceQuery = layer === 'workspace' && workspaceId
      ? `&workspaceId=${encodeURIComponent(workspaceId)}`
      : ''
    try {
      const domains = LAYER_DOMAINS[layer]
      const results = await Promise.all(domains.map(async (domain) => {
        const body = await request<{
          domain: string
          entries: Record<string, string>
          envOverridden?: Record<string, string>
        }>(`/config/${domain}?layer=${layer}&includeMeta=true${workspaceQuery}`)
        return { domain, body }
      }))
      const nextLayer: Record<string, Record<string, string>> = { ...layerConfig.value[layer] }
      const nextEnv: Record<string, Record<string, string>> = { ...envOverridden.value }
      for (const { domain, body } of results) {
        nextLayer[domain] = body.entries ?? {}
        nextEnv[domain] = body.envOverridden ?? {}
      }
      layerConfig.value = { ...layerConfig.value, [layer]: nextLayer }
      envOverridden.value = nextEnv
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to load layer config'
      throw e
    } finally {
      layerLoading.value = false
    }
  }

  /** PLAN-0307 T2.17: write one layer/domain through the unified layer endpoint. */
  async function putLayerConfig(
    layer: ConfigLayer,
    domain: string,
    body: Record<string, string>,
    workspaceId?: string | null,
  ): Promise<void> {
    const workspaceQuery = layer === 'workspace' && workspaceId
      ? `?workspaceId=${encodeURIComponent(workspaceId)}`
      : ''
    await request(`/config/${layer}/${domain}${workspaceQuery}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  }

  /** Admin export (instance layer, T2.21/T2.25). */
  async function exportConfig(includeSecrets: boolean): Promise<string> {
    const data = await request<Record<string, unknown>>(
      `/config/export?layer=instance&includeSecrets=${includeSecrets}`,
    )
    return JSON.stringify(data, null, 2)
  }

  /** Admin import (instance layer, per-domain merge; credentials are never restored). */
  async function importConfig(content: string): Promise<ConfigImportReport> {
    return request<ConfigImportReport>('/config/import?layer=instance', {
      method: 'POST',
      body: content,
    })
  }

  function getActiveModel(sessionId: string): SessionModelBinding | undefined {
    return sessionModels.value[sessionId]
  }

  function isChatModelAvailable(provider: string, model: string): boolean {
    const catalog = modelCache.value.providers?.[provider]
    if (!catalog || catalog.status !== 'ready') return false
    return catalog.models.some((entry) => entry.name === model && entry.capabilities.chat)
  }

  function getChatModels(provider: string): string[] {
    const catalog = modelCache.value.providers?.[provider]
    if (!catalog || catalog.status !== 'ready') return []
    return catalog.models.filter((entry) => entry.capabilities.chat).map((entry) => entry.name)
  }

  function getEffectiveModel(sessionId: string): SessionModelBinding | undefined {
    const sessionBinding = sessionModels.value[sessionId]
    if (sessionBinding && isChatModelAvailable(sessionBinding.provider, sessionBinding.model)) {
      return sessionBinding
    }

    const llmProvider = mergedConfig.value['llm-provider'] ?? {}

    // PLAN-0307 decision #16/#37: model parameters moved to llm-provider.
    const defaultModel = llmProvider.defaultModel
    const defaultProvider = llmProvider.defaultProvider

    if (defaultModel) {
      const provider = defaultProvider
        || findProviderForModel(defaultModel)
      if (provider && isChatModelAvailable(provider, defaultModel)) {
        return { provider, model: defaultModel }
      }
    }

    if (defaultProvider) {
      const info = getProviderInfo(defaultProvider)
      if (info && isChatModelAvailable(defaultProvider, info.defaultModel)) {
        return { provider: defaultProvider, model: info.defaultModel }
      }
    }

    return undefined
  }

  function setSessionModel(
    sessionId: string,
    provider: string,
    model: string,
    connectionId?: string,
    connectionRevision?: number,
  ) {
    sessionModels.value = {
      ...sessionModels.value,
      [sessionId]: { provider, model, connectionId, connectionRevision },
    }
  }

  function toggleFavorite(provider: string, model: string) {
    const idx = modelFavorites.value.findIndex(f => f.provider === provider && f.model === model)
    if (idx >= 0) {
      modelFavorites.value = modelFavorites.value.filter((_, i) => i !== idx)
    } else {
      modelFavorites.value = [...modelFavorites.value, { provider, model }]
    }
  }

  function isFavorite(provider: string, model: string): boolean {
    return modelFavorites.value.some(f => f.provider === provider && f.model === model)
  }

  function clearForUserSwitch() {
    mergedConfig.value = {}
    modelCache.value = { models: {}, providers: {} }
    sessionModels.value = {}
    modelFavorites.value = []
    modelError.value = null
    layerConfig.value = { instance: {}, workspace: {}, user: {} }
    envOverridden.value = {}
  }

  async function fetchModels() {
    try {
      modelError.value = null
      const data = await request<{
        models?: Record<string, string[]>
        providers?: ModelCache['providers']
        configRevision?: string
      }>('/models')
      modelCache.value = {
        models: data.models ?? {},
        providers: data.providers ?? {},
        configRevision: data.configRevision,
        lastFetched: Date.now(),
      }
    } catch (e) {
      modelError.value = e instanceof Error ? e.message : 'Failed to fetch models'
    }
  }

  return {
    mergedConfig,
    loading,
    error,
    layerConfig,
    layerLoading,
    envOverridden,
    modelError,
    modelCache,
    modelFavorites,
    fetchDomain,
    loadAllDomains,
    loadLayerDomains,
    putLayerConfig,
    exportConfig,
    importConfig,
    getActiveModel,
    getEffectiveModel,
    findProviderForModel,
    isChatModelAvailable,
    getChatModels,
    setSessionModel,
    toggleFavorite,
    isFavorite,
    clearForUserSwitch,
    fetchModels,
  }
})
