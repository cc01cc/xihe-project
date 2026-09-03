import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useConfigStore } from '../config'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

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
        const domain = url.split('/').pop() ?? ''
        const payload: Record<string, Record<string, string>> = {
          logging: { logLevel: 'DEBUG' },
          'llm-provider': { defaultProvider: 'openai' },
          embedding: {},
          'user-preference': { defaultModel: 'gpt-4o' },
          'workspace-config': {},
          rag: {},
          infrastructure: {},
        }
        return Promise.resolve(new Response(JSON.stringify(payload[domain] ?? {}), { status: 200 }))
      })
      const store = useConfigStore()

      await store.loadAllDomains()

      const raw = localStorage.getItem('xihe-config-merged')
      expect(raw).not.toBeNull()
      const parsed = JSON.parse(raw!)
      expect(parsed['llm-provider'].defaultProvider).toBe('openai')
      expect(parsed['user-preference'].defaultModel).toBe('gpt-4o')
    })

    it('loadAllDomains fetches and updates mergedConfig', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        const url = typeof input === 'string' ? input : input.url
        const domain = url.split('/').pop() ?? ''
        const payload: Record<string, Record<string, string>> = {
          logging: { logLevel: 'DEBUG' },
          'llm-provider': { defaultProvider: 'deepseek' },
          embedding: {},
          'user-preference': { defaultModel: 'deepseek-chat' },
          'workspace-config': {},
          rag: {},
          infrastructure: {},
        }
        return Promise.resolve(new Response(JSON.stringify(payload[domain] ?? {}), { status: 200 }))
      })
      const store = useConfigStore()

      await store.loadAllDomains()

      expect(store.mergedConfig['logging']?.logLevel).toBe('DEBUG')
      expect(store.mergedConfig['llm-provider']?.defaultProvider).toBe('deepseek')
      expect(store.mergedConfig['user-preference']?.defaultModel).toBe('deepseek-chat')
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
      store.setSessionModel('s1', 'deepseek', 'deepseek-chat')

      expect(store.getEffectiveModel('s1')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    })

    it('falls back to defaultModel + defaultProvider', () => {
      const store = useConfigStore()
      store.mergedConfig = {
        'llm-provider': { defaultProvider: 'openai' },
        'user-preference': { defaultModel: 'gpt-4o' },
      }

      expect(store.getEffectiveModel('s1')).toEqual({ provider: 'openai', model: 'gpt-4o' })
    })

    it('infers provider from defaultModel when defaultProvider is absent', () => {
      const store = useConfigStore()
      store.mergedConfig = {
        'llm-provider': {},
        'user-preference': { defaultModel: 'deepseek-chat' },
      }

      expect(store.getEffectiveModel('s1')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    })

    it('uses modelCache to resolve provider for defaultModel', () => {
      const store = useConfigStore()
      store.modelCache = { models: { xiaomi: ['mimo-v2.5'] } }
      store.mergedConfig = {
        'llm-provider': {},
        'user-preference': { defaultModel: 'mimo-v2.5' },
      }

      expect(store.getEffectiveModel('s1')).toEqual({ provider: 'xiaomi', model: 'mimo-v2.5' })
    })

    it('falls back to provider defaultModel when only defaultProvider is set', () => {
      const store = useConfigStore()
      store.mergedConfig = {
        'llm-provider': { defaultProvider: 'anthropic' },
        'user-preference': {},
      }

      expect(store.getEffectiveModel('s1')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-20250514' })
    })

    it('returns undefined when no binding or config exists', () => {
      const store = useConfigStore()
      expect(store.getEffectiveModel('s1')).toBeUndefined()
    })

    it('session binding takes precedence over default config', () => {
      const store = useConfigStore()
      store.setSessionModel('s1', 'deepseek', 'deepseek-reasoner')
      store.mergedConfig = {
        'llm-provider': { defaultProvider: 'openai' },
        'user-preference': { defaultModel: 'gpt-4o' },
      }

      expect(store.getEffectiveModel('s1')).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
    })
  })

  describe('findProviderForModel', () => {
    it('finds provider from modelCache', () => {
      const store = useConfigStore()
      store.modelCache = { models: { openai: ['gpt-4o'] } }

      expect(store.findProviderForModel('gpt-4o')).toBe('openai')
    })

    it('returns undefined when model is not in cache', () => {
      const store = useConfigStore()
      store.modelCache = { models: {} }

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
})
