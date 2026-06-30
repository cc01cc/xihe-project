import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useLocalStorage } from '@vueuse/core'
import { getProviderInfo, inferProviderFromModel, type ModelCache } from '../types/provider'
import type { SessionModelBinding, ModelFavorite } from '../types'
import { request } from '../composables/api'

type Domain = 'logging' | 'llm-provider' | 'embedding' | 'user-preference' | 'workspace-config' | 'infrastructure' | 'mcp' | 'rag'

const MODEL_CACHE_KEY = 'xihe-model-cache'
const SESSION_MODELS_KEY = 'xihe-session-models'
const MODEL_FAVORITES_KEY = 'xihe-model-favorites'
const MERGED_CONFIG_KEY = 'xihe-config-merged'

export const useConfigStore = defineStore('config', () => {
  const mergedConfig = useLocalStorage<Record<string, Record<string, string>>>(MERGED_CONFIG_KEY, {})
  const loading = ref(false)
  const error = ref<string | null>(null)

  const modelCache = useLocalStorage<ModelCache>(MODEL_CACHE_KEY, { models: {} })
  const sessionModels = useLocalStorage<Record<string, SessionModelBinding>>(SESSION_MODELS_KEY, {})
  const modelFavorites = useLocalStorage<ModelFavorite[]>(MODEL_FAVORITES_KEY, [])
  const modelError = ref<string | null>(null)

  function findProviderForModel(modelId: string): string | undefined {
    const models = modelCache.value.models ?? {}
    for (const [provider, modelIds] of Object.entries(models)) {
      if (modelIds.includes(modelId)) return provider
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
    const domains: Domain[] = ['logging', 'llm-provider', 'embedding', 'user-preference', 'workspace-config', 'rag', 'infrastructure']
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

  async function putAdminConfig(domain: string, body: Record<string, string>): Promise<void> {
    await request(`/config/admin/${domain}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  }

  async function putUserConfig(domain: string, body: Record<string, string>): Promise<void> {
    await request(`/config/user/${domain}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  }

  async function putUserPreference(theme?: string, language?: string, defaultModel?: string): Promise<void> {
    const body: Record<string, string> = {}
    if (theme !== undefined) body.theme = theme
    if (language !== undefined) body.language = language
    if (defaultModel !== undefined) body.defaultModel = defaultModel
    await putUserConfig('user-preference', body)
  }

  function getActiveModel(sessionId: string): SessionModelBinding | undefined {
    return sessionModels.value[sessionId]
  }

  function getEffectiveModel(sessionId: string): SessionModelBinding | undefined {
    const sessionBinding = sessionModels.value[sessionId]
    if (sessionBinding) return sessionBinding

    const llmProvider = mergedConfig.value['llm-provider'] ?? {}
    const userPreference = mergedConfig.value['user-preference'] ?? {}

    const defaultModel = userPreference.defaultModel
    const defaultProvider = llmProvider.defaultProvider

    if (defaultModel) {
      const provider = defaultProvider
        || findProviderForModel(defaultModel)
        || inferProviderFromModel(defaultModel)
      if (provider) {
        return { provider, model: defaultModel }
      }
    }

    if (defaultProvider) {
      const info = getProviderInfo(defaultProvider)
      if (info) {
        return { provider: defaultProvider, model: info.defaultModel }
      }
    }

    return undefined
  }

  function setSessionModel(sessionId: string, provider: string, model: string) {
    sessionModels.value = { ...sessionModels.value, [sessionId]: { provider, model } }
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

  async function fetchModels() {
    try {
      modelError.value = null
      const data = await request<{ models?: Record<string, string[]> }>('/models')
      modelCache.value = { models: data.models ?? {}, lastFetched: Date.now() }
    } catch (e) {
      modelError.value = e instanceof Error ? e.message : 'Failed to fetch models'
    }
  }

  return {
    mergedConfig,
    loading,
    error,
    modelError,
    modelCache,
    modelFavorites,
    fetchDomain,
    loadAllDomains,
    putAdminConfig,
    putUserConfig,
    putUserPreference,
    getActiveModel,
    getEffectiveModel,
    findProviderForModel,
    setSessionModel,
    toggleFavorite,
    isFavorite,
    fetchModels,
  }
})
