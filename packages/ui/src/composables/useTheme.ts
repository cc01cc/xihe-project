import { watchEffect, ref, type Ref } from 'vue'
import { useColorMode, useLocalStorage } from '@vueuse/core'

export function useTheme() {
  const colorMode = useColorMode({
    selector: 'html',
    attribute: 'class',
    initialValue: 'system',
    storageKey: 'xihe-theme',
  })

  const storedTheme = useLocalStorage<'light' | 'dark' | 'system'>('xihe-theme', 'system')

  const theme = ref<'light' | 'dark'>(
    colorMode.value === 'dark' ? 'dark' : 'light',
  )

  watchEffect(() => {
    if (colorMode.value === 'dark') {
      theme.value = 'dark'
    } else if (colorMode.value === 'light') {
      theme.value = 'light'
    }
  })

  watchEffect(() => {
    if (storedTheme.value !== colorMode.value) {
      colorMode.value = storedTheme.value
    }
  })

  function setColorMode(mode: 'light' | 'dark' | 'system') {
    storedTheme.value = mode
    colorMode.value = mode
  }

  return {
    theme,
    colorMode: storedTheme as unknown as Ref<'light' | 'dark' | 'system'>,
    setColorMode,
  }
}
