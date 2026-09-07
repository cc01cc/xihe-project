<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { useConfigStore } from '../../stores/config'
import { Sun } from '@lucide/vue'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const config = useConfigStore()

const email = ref('')
const password = ref('')
const errorMsg = ref<string | null>(null)
const loading = ref(false)

async function handleSubmit() {
  if (!email.value || !password.value) return
  loading.value = true
  errorMsg.value = null
  const ok = await auth.login(email.value, password.value)
  loading.value = false
  if (ok) {
    config.loadAllDomains().catch(() => {
      // 后端不可用时使用本地持久化配置；错误已在 store 中记录
    })
    const redirect = (route.query.redirect as string) || '/chat'
    router.push(redirect)
  } else {
    errorMsg.value = auth.error
  }
}
</script>

<template>
  <div class="flex items-center justify-center min-h-screen bg-muted/30">
    <div class="w-full max-w-md p-8 bg-background rounded-xl shadow-sm border">
      <div class="text-center mb-6">
         <div class="mb-2 text-3xl"><Sun class="mx-auto size-8" aria-hidden="true" /></div>
        <h1 class="text-2xl font-bold">{{ t('login.title') }}</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ t('login.hint') }}</p>
      </div>

      <form class="space-y-4" @submit.prevent="handleSubmit">
        <div>
          <label class="block text-sm font-medium mb-1" for="email">{{ t('login.username') }}</label>
          <input
            id="email"
            v-model="email"
            type="text"
            name="email"
            autocomplete="email"
            class="w-full px-3 py-2 rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <div>
          <label class="block text-sm font-medium mb-1" for="password">{{ t('login.password') }}</label>
          <input
            id="password"
            v-model="password"
            type="password"
            name="password"
            autocomplete="current-password"
            class="w-full px-3 py-2 rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <button
          type="submit"
          class="w-full py-2 px-4 rounded-md font-medium text-primary-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          :class="email && password && !loading ? 'bg-primary hover:bg-primary/90' : 'bg-muted-foreground/30 text-muted-foreground'"
          :disabled="!email || !password || loading"
        >
          {{ loading ? t('login.loggingIn') : t('login.login') }}
        </button>

        <p v-if="errorMsg" class="text-sm text-destructive text-center">{{ errorMsg }}</p>
        <p class="text-sm text-center text-muted-foreground">
          {{ t('login.noAccount') }}
          <router-link to="/register" class="text-primary hover:underline font-medium">{{ t('login.register') }}</router-link>
        </p>
      </form>
    </div>
  </div>
</template>
