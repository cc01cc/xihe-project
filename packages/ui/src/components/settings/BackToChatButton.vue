<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '../../stores/session'
import { ArrowLeft } from '@lucide/vue'
import { useAuthStore } from '../../stores/auth'
import { workspaceChatPath, workspacePath } from '../../lib/routes'

const router = useRouter()
const { t } = useI18n()
const sessionStore = useSessionStore()
const auth = useAuthStore()

function goBack() {
  const id = sessionStore.currentSessionId
  if (id) {
    const workspaceId = sessionStore.currentSession?.workspaceId ?? auth.currentWorkspaceId
    if (workspaceId) router.push(workspaceChatPath(workspaceId, id))
    else router.push('/workspace')
  } else {
    const workspaceId = auth.currentWorkspaceId
    router.push(workspaceId ? workspacePath(workspaceId) : '/workspace')
  }
}
</script>

<template>
  <button
    class="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3"
    @click="goBack"
  >
     <ArrowLeft class="size-4" aria-hidden="true" />
    {{ t('chat.backToChat') }}
  </button>
</template>
