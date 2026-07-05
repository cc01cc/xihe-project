import { describe, it, expect } from 'vitest'
import { BUILTIN_PROVIDERS, isBuiltinProvider, getProviderInfo } from '../provider'

describe('BUILTIN_PROVIDERS', () => {
  it('defines exactly 4 providers', () => {
    expect(BUILTIN_PROVIDERS.length).toBe(4)
  })

  it('includes openai', () => {
    const p = BUILTIN_PROVIDERS.find((provider) => provider.id === 'openai')
    expect(p).toBeDefined()
    expect(p!.name).toBe('OpenAI')
    expect(p!.defaultModel).toBe('gpt-4o')
    expect(p!.defaultBaseUrl).toBe('https://api.openai.com/v1')
  })

  it('includes deepseek', () => {
    const p = BUILTIN_PROVIDERS.find((provider) => provider.id === 'deepseek')
    expect(p).toBeDefined()
    expect(p!.name).toBe('DeepSeek')
    expect(p!.defaultModel).toBe('deepseek-chat')
    expect(p!.defaultBaseUrl).toBe('https://api.deepseek.com/v1')
  })

  it('includes xiaomi', () => {
    const p = BUILTIN_PROVIDERS.find((provider) => provider.id === 'xiaomi')
    expect(p).toBeDefined()
    expect(p!.name).toBe('小米 MiMo')
    expect(p!.defaultModel).toBe('mimo-v2-omni')
    expect(p!.defaultBaseUrl).toBe('https://api.xiaomimimo.com/v1')
  })

  it('includes anthropic', () => {
    const p = BUILTIN_PROVIDERS.find((provider) => provider.id === 'anthropic')
    expect(p).toBeDefined()
    expect(p!.name).toBe('Anthropic')
    expect(p!.defaultModel).toBe('claude-sonnet-4-20250514')
    expect(p!.defaultBaseUrl).toBe('https://api.anthropic.com/v1')
  })

  it('every provider has required fields', () => {
    for (const p of BUILTIN_PROVIDERS) {
      expect(p.id).toBeTruthy()
      expect(p.name).toBeTruthy()
      expect(p.defaultModel).toBeTruthy()
      expect(p.defaultBaseUrl).toBeTruthy()
    }
  })

  it('no duplicate ids', () => {
    const ids = BUILTIN_PROVIDERS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every defaultBaseUrl is a valid URL', () => {
    for (const p of BUILTIN_PROVIDERS) {
      expect(() => new URL(p.defaultBaseUrl)).not.toThrow()
    }
  })

  it('is readonly (frozen)', () => {
    expect(Object.isFrozen(BUILTIN_PROVIDERS)).toBe(true)
  })

  it('every defaultBaseUrl ends with /v1', () => {
    for (const p of BUILTIN_PROVIDERS) {
      expect(p.defaultBaseUrl).toMatch(/\/v1$/)
    }
  })
})

describe('isBuiltinProvider', () => {
  it('returns true for built-in providers', () => {
    expect(isBuiltinProvider('openai')).toBe(true)
    expect(isBuiltinProvider('deepseek')).toBe(true)
    expect(isBuiltinProvider('xiaomi')).toBe(true)
    expect(isBuiltinProvider('anthropic')).toBe(true)
  })

  it('returns false for unknown providers', () => {
    expect(isBuiltinProvider('custom')).toBe(false)
    expect(isBuiltinProvider('')).toBe(false)
  })
})

describe('getProviderInfo', () => {
  it('returns provider info for built-in ids', () => {
    const info = getProviderInfo('deepseek')
    expect(info).toBeDefined()
    expect(info!.id).toBe('deepseek')
    expect(info!.defaultModel).toBe('deepseek-chat')
  })

  it('returns undefined for unknown ids', () => {
    expect(getProviderInfo('nonexistent')).toBeUndefined()
  })
})
