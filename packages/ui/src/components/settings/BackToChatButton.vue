<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '../../stores/session'

const router = useRouter()
const { t } = useI18n()
const sessionStore = useSessionStore()

function goBack() {
  const id = sessionStore.currentSessionId
  if (id) {
    router.push(`/chat/${id}`)
  } else {
    router.push('/chat')
  }
}
</script>

<template>
  <button
    class="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3"
    @click="goBack"
  >
    <span class="i-lucide-arrow-left size-4" />
    {{ t('chat.backToChat') }}
  </button>
</template>
