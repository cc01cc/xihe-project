import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSettingsStore } from '../settings'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

describe('useSettingsStore', () => {
  it('theme defaults to system', () => {
    const store = useSettingsStore()
    expect(store.theme).toBe('system')
  })

  it('language defaults to zh-CN', () => {
    const store = useSettingsStore()
    expect(store.language).toBe('zh-CN')
  })
})
