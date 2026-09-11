import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useConfigStore } from '../config'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

function seedReadyModel(store: ReturnType<typeof useConfigStore>, provider: string, model: string) {
  store.modelCache = {
    models: { [provider]: [model] },
    providers: {
      [provider]: {
        status: 'ready',
        models: [{ name: model, capabilities: { chat: true, vision: false, tools: false } }],
      },
    },
  }
}

describe('useConfigStore', () => {
  describe('mergedConfig persistence', () => {
    it('loads persisted mergedConfig from localStorage', () => {
      localStorage.setItem(
        'xihe-config-merged',
        JSON.stringify({
          'llm-provider': { defaultProvider: 'deepseek' },
          'user-preference': { defaultModel: 'deepseek-chat' },
        }),
      )

      const store = useConfigStore()
      expect(store.mergedConfig['llm-provider']?.defaultProvider).toBe('deepseek')
      expect(store.mergedConfig['user-preference']?.defaultModel).toBe('deepseek-chat')
    })

    it('writes mergedConfig to localStorage via loadAllDomains', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        const url = typeof input === 'string' ? input : input.url
        const domain = url.split('/').pop()?.split('?')[0] ?? ''
        const payload: Record<string, Record<string, string>> = {
          logging: { logLevel: 'DEBUG' },
          'llm-provider': { defaultProvider: 'openai', defaultModel: 'gpt-4o' },
          'context-policy': {},
          embedding: {},
          'agent-runtime': {},
          'agent-profile': {},
          'user-preference': {},
          rag: {},
        }
        return Promise.resolve(new Response(JSON.stringify(payload[domain] ?? {}), { status: 200 }))
      })
      const store = useConfigStore()

      await store.loadAllDomains()

      const raw = localStorage.getItem('xihe-config-merged')
      expect(raw).not.toBeNull()
      const parsed = JSON.parse(raw!)
      expect(parsed['llm-provider'].defaultProvider).toBe('openai')
      expect(parsed['llm-provider'].defaultModel).toBe('gpt-4o')
    })

    it('loadAllDomains fetches and updates mergedConfig', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        const url = typeof input === 'string' ? input : input.url
        const domain = url.split('/').pop()?.split('?')[0] ?? ''
        const payload: Record<string, Record<string, string>> = {
          logging: { logLevel: 'DEBUG' },
          'llm-provider': { defaultProvider: 'deepseek', defaultModel: 'deepseek-chat' },
          'context-policy': {},
          embedding: {},
          'agent-runtime': {},
          'agent-profile': {},
          'user-preference': {},
          rag: {},
        }
        return Promise.resolve(new Response(JSON.stringify(payload[domain] ?? {}), { status: 200 }))
      })
      const store = useConfigStore()

      await store.loadAllDomains()

      expect(store.mergedConfig['logging']?.logLevel).toBe('DEBUG')
      expect(store.mergedConfig['llm-provider']?.defaultProvider).toBe('deepseek')
      expect(store.mergedConfig['llm-provider']?.defaultModel).toBe('deepseek-chat')
      expect(store.loading).toBe(false)
      expect(store.error).toBeNull()
    })

    it('loadAllDomains sets error on failure', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'))
      const store = useConfigStore()

      await store.loadAllDomains()

      expect(store.error).toBe('Network error')
      expect(store.loading).toBe(false)
    })
  })

  describe('getEffectiveModel', () => {
    it('returns session binding when set', () => {
      const store = useConfigStore()
      seedReadyModel(store, 'deepseek', 'deepseek-chat')
      store.setSessionModel('s1', 'deepseek', 'deepseek-chat')

      expect(store.getEffectiveModel('s1')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    })

    it('falls back to defaultModel + defaultProvider', () => {
      const store = useConfigStore()
      store.mergedConfig = {
        'llm-provider': { defaultProvider: 'openai', defaultModel: 'gpt-4o' },
      }
      seedReadyModel(store, 'openai', 'gpt-4o')

      expect(store.getEffectiveModel('s1')).toEqual({ provider: 'openai', model: 'gpt-4o' })
    })

    it('uses catalog provider when defaultProvider is absent', () => {
      const store = useConfigStore()
      seedReadyModel(store, 'deepseek', 'deepseek-chat')
      store.mergedConfig = {
        'llm-provider': { defaultModel: 'deepseek-chat' },
      }

      expect(store.getEffectiveModel('s1')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    })

    it('uses modelCache to resolve provider for defaultModel', () => {
      const store = useConfigStore()
      seedReadyModel(store, 'xiaomi', 'mimo-v2.5')
      store.mergedConfig = {
        'llm-provider': { defaultModel: 'mimo-v2.5' },
      }

      expect(store.getEffectiveModel('s1')).toEqual({ provider: 'xiaomi', model: 'mimo-v2.5' })
    })

    it('falls back to provider defaultModel when only defaultProvider is set', () => {
      const store = useConfigStore()
      store.mergedConfig = {
        'llm-provider': { defaultProvider: 'anthropic' },
      }
      seedReadyModel(store, 'anthropic', 'claude-sonnet-4-20250514')

      expect(store.getEffectiveModel('s1')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-20250514' })
    })

    it('returns undefined when no binding or config exists', () => {
      const store = useConfigStore()
      expect(store.getEffectiveModel('s1')).toBeUndefined()
    })

    it('session binding takes precedence over default config', () => {
      const store = useConfigStore()
      seedReadyModel(store, 'deepseek', 'deepseek-reasoner')
      store.setSessionModel('s1', 'deepseek', 'deepseek-reasoner')
      store.mergedConfig = {
        'llm-provider': { defaultProvider: 'openai', defaultModel: 'gpt-4o' },
      }

      expect(store.getEffectiveModel('s1')).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
    })
  })

  describe('findProviderForModel', () => {
    it('finds provider from modelCache', () => {
      const store = useConfigStore()
      seedReadyModel(store, 'openai', 'gpt-4o')

      expect(store.findProviderForModel('gpt-4o')).toBe('openai')
    })

    it('returns undefined when model is not in cache', () => {
      const store = useConfigStore()
      store.modelCache = { models: {}, providers: {} }

      expect(store.findProviderForModel('unknown')).toBeUndefined()
    })
  })

  describe('fetchModels', () => {
    it('populates modelCache on success', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ models: { deepseek: ['deepseek-chat'] } }), { status: 200 }),
      )
      const store = useConfigStore()

      await store.fetchModels()

      expect(store.modelCache.models).toEqual({ deepseek: ['deepseek-chat'] })
    })

    it('sets modelError on failure', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'))
      const store = useConfigStore()

      await store.fetchModels()

      expect(store.modelError).toBe('Network error')
    })
  })

  describe('user switch isolation', () => {
    it('clears config, model, session and favorite caches', () => {
      const store = useConfigStore()
      store.mergedConfig = { 'llm-provider': { defaultProvider: 'openai' } }
      store.modelCache = {
        models: { openai: ['gpt-4o'] },
        providers: {
          openai: {
            status: 'ready',
            models: [{ name: 'gpt-4o', capabilities: { chat: true, vision: false, tools: false } }],
          },
        },
      }
      store.setSessionModel('session-a', 'openai', 'gpt-4o')
      store.toggleFavorite('openai', 'gpt-4o')

      store.clearForUserSwitch()

      expect(store.mergedConfig).toEqual({})
      expect(store.modelCache).toEqual({ models: {}, providers: {} })
      expect(store.getActiveModel('session-a')).toBeUndefined()
      expect(store.modelFavorites).toEqual([])
    })
  })

  describe('layer config (PLAN-0307 T2.17)', () => {
    function mockLayerFetch() {
      const calls: { url: string; init?: RequestInit }[] = []
      vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        const url = typeof input === 'string' ? input : input.url
        calls.push({ url, init: init ?? undefined })
        const parsed = new URL(url, 'http://localhost')
        const domain = parsed.pathname.split('/').pop() ?? ''
        const layer = parsed.searchParams.get('layer') ?? ''
        return Promise.resolve(new Response(JSON.stringify({
          domain,
          entries: { [`${layer}-${domain}-key`]: 'value' },
          envOverridden: domain === 'embedding' ? { model: 'env-model' } : {},
        }), { status: 200 }))
      })
      return calls
    }

    it('loadLayerDomains fetches only the layer domain set with includeMeta', async () => {
      const calls = mockLayerFetch()
      const store = useConfigStore()

      await store.loadLayerDomains('workspace', 'ws-1')

      expect(calls).toHaveLength(5)
      for (const call of calls) {
        expect(call.url).toContain('layer=workspace')
        expect(call.url).toContain('includeMeta=true')
        expect(call.url).toContain('workspaceId=ws-1')
      }
      expect(Object.keys(store.layerConfig.workspace)).toHaveLength(5)
      expect(store.layerConfig.workspace['embedding']).toEqual({ 'workspace-embedding-key': 'value' })
      expect(store.envOverridden['embedding']).toEqual({ model: 'env-model' })
      expect(store.envOverridden['rag']).toEqual({})
    })

    it('loadLayerDomains loads the seven user domains without workspace query', async () => {
      const calls = mockLayerFetch()
      const store = useConfigStore()

      await store.loadLayerDomains('user')

      expect(calls).toHaveLength(7)
      for (const call of calls) {
        expect(call.url).toContain('layer=user')
        expect(call.url).not.toContain('workspaceId=')
      }
      expect(store.layerConfig.user['logging']).toBeUndefined()
    })

    it('putLayerConfig targets the layer endpoint with workspace query', async () => {
      const calls = mockLayerFetch()
      const store = useConfigStore()

      await store.putLayerConfig('workspace', 'rag', { topK: '5' }, 'ws-2')
      await store.putLayerConfig('user', 'agent-profile', { userName: 'zero' })
      await store.putLayerConfig('instance', 'logging', { logLevel: 'DEBUG' })

      expect(calls[0].url).toContain('/config/workspace/rag?workspaceId=ws-2')
      expect(calls[0].init?.method).toBe('PUT')
      expect(calls[0].init?.body).toBe(JSON.stringify({ topK: '5' }))
      expect(calls[1].url).toContain('/config/user/agent-profile')
      expect(calls[2].url).toContain('/config/instance/logging')
    })

    it('exportConfig/importConfig use the instance management endpoints', async () => {
      const calls = mockLayerFetch()
      const store = useConfigStore()

      const exported = await store.exportConfig(false)
      await store.importConfig('{"logging":{"logLevel":"INFO"}}')

      expect(calls[0].url).toContain('/config/export?layer=instance&includeSecrets=false')
      expect(exported).toContain('"domain"')
      expect(calls[1].url).toContain('/config/import?layer=instance')
      expect(calls[1].init?.method).toBe('POST')
    })

    it('clearForUserSwitch clears layer state and env locks', async () => {
      mockLayerFetch()
      const store = useConfigStore()
      await store.loadLayerDomains('instance')
      expect(Object.keys(store.layerConfig.instance).length).toBeGreaterThan(0)

      store.clearForUserSwitch()

      expect(store.layerConfig).toEqual({ instance: {}, workspace: {}, user: {} })
      expect(store.envOverridden).toEqual({})
    })
  })
})
