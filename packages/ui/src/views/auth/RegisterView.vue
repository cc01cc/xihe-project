<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../../stores/auth'

const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()

const email = ref('')
const password = ref('')
const confirmPassword = ref('')
const localError = ref<string | null>(null)
const loading = ref(false)

const passwordMismatch = computed(() => {
  return !!(confirmPassword.value && password.value !== confirmPassword.value)
})

async function handleSubmit() {
  if (!email.value || !password.value) return
  if (password.value !== confirmPassword.value) {
    localError.value = t('common.passwordMismatch')
    return
  }
  loading.value = true
  localError.value = null
  const name = email.value.includes('@') ? email.value.split('@')[0] : email.value
  const ok = await auth.register(email.value, password.value, name)
  loading.value = false
  if (ok) {
    router.push('/chat')
  } else {
    localError.value = auth.error
  }
}
</script>

<template>
  <div class="flex items-center justify-center min-h-screen bg-muted/30">
    <div class="w-full max-w-md p-8 bg-background rounded-xl shadow-sm border">
      <div class="text-center mb-6">
        <div class="text-3xl mb-2"><span class="i-lucide-sun size-8" /></div>
        <h1 class="text-2xl font-bold">{{ t('register.title') }}</h1>
      </div>
      <p class="text-sm text-muted-foreground mb-6">{{ t('login.hint') }}</p>

      <form class="space-y-4" @submit.prevent="handleSubmit">
        <div>
          <label class="block text-sm font-medium mb-1" for="email">{{ t('register.username') }}</label>
          <input
            id="email"
            v-model="email"
            type="text"
            name="email"
            autocomplete="email"
            class="w-full px-3 py-2 rounded-md border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div>
          <label class="block text-sm font-medium mb-1" for="password">{{ t('register.password') }}</label>
          <input
            id="password"
            v-model="password"
            type="password"
            name="password"
            autocomplete="new-password"
            class="w-full px-3 py-2 rounded-md border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div>
          <label class="block text-sm font-medium mb-1" for="confirmPassword">{{ t('register.confirmPassword') }}</label>
          <input
            id="confirmPassword"
            v-model="confirmPassword"
            type="password"
            name="confirmPassword"
            autocomplete="new-password"
            class="w-full px-3 py-2 rounded-md border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            :class="passwordMismatch ? 'ring-1 ring-destructive' : ''"
          />
          <p v-if="passwordMismatch" class="text-xs text-destructive mt-1">{{ t('common.passwordMismatch') }}</p>
        </div>

        <p v-if="localError" class="text-sm text-destructive">{{ localError }}</p>

        <button
          type="submit"
          :disabled="loading || !email || !password || passwordMismatch"
          class="w-full px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {{ loading ? t('common.loading') : t('register.submit') }}
        </button>

        <p class="text-sm text-center text-muted-foreground">
          {{ t('login.hasAccount') }}
          <router-link to="/login" class="text-primary hover:underline">{{ t('login.login') }}</router-link>
        </p>
      </form>
    </div>
  </div>
</template>
