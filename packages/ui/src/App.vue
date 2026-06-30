<script setup lang="ts">
import { provide, onMounted } from 'vue'
import { useTheme } from './composables/useTheme'
import { ThemeInjectionKey } from './types'
import { useConfigStore } from './stores/config'
import { useAuthStore } from './stores/auth'
import ToastContainer from './components/shared/ToastContainer.vue'

const theme = useTheme()
provide(ThemeInjectionKey, theme)

const authStore = useAuthStore()
const configStore = useConfigStore()
onMounted(() => {
  if (!authStore.isAuthenticated) return
  configStore.loadAllDomains().catch(() => {
    // 后端不可用时使用本地持久化配置；错误已在 store 中记录
  })
})
</script>

<template>
  <router-view />
  <ToastContainer />
</template>
