import { defineStore } from 'pinia'
import { useLocalStorage } from '@vueuse/core'
import type { Language } from '../types'

export const useSettingsStore = defineStore('settings', () => {
  const theme = useLocalStorage<'dark' | 'light' | 'system'>('xihe-theme', 'system')
  const language = useLocalStorage<Language>('xihe-language', 'zh-CN')

  return {
    theme,
    language,
  }
})
