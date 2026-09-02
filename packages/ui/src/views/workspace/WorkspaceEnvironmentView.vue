<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api, ApiError } from '../../composables/api'
import { useAuthStore } from '../../stores/auth'

type Environment = Awaited<ReturnType<typeof api.getWorkspaceEnvironment>>

const route = useRoute()
const auth = useAuthStore()
const environment = ref<Environment | null>(null)
const loading = ref(false)
const error = ref('')
const workspaceId = computed(() => {
  const fromRoute = String(route.params.workspaceId ?? '').trim()
  return fromRoute || auth.currentWorkspaceId || ''
})

async function loadEnvironment() {
  const id = workspaceId.value
  if (!id) {
    error.value = 'Workspace context is required'
    return
  }
  loading.value = true
  error.value = ''
  try {
    environment.value = await api.getWorkspaceEnvironment(id)
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : 'Failed to load workspace environment'
  } finally {
    loading.value = false
  }
}

onMounted(loadEnvironment)
watch(() => workspaceId.value, loadEnvironment)
</script>

<template>
  <section class="min-h-full bg-background px-4 py-8 sm:px-8">
    <div class="mx-auto max-w-5xl">
      <header class="mb-8 border-b pb-5">
        <p class="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Workspace</p>
        <h1 data-testid="workspace-environment-heading" class="mt-2 text-2xl font-semibold tracking-tight">Environment status</h1>
        <p class="mt-2 max-w-2xl text-sm text-muted-foreground">
          Read-only view of the active assignment, storage binding and Runtime observation.
        </p>
      </header>

      <div v-if="loading" class="rounded-lg border p-6 text-sm text-muted-foreground">Loading environment...</div>
      <div v-else-if="error" class="rounded-lg border border-destructive/40 p-6 text-sm text-destructive">{{ error }}</div>
      <div v-else-if="environment" class="space-y-5">
        <div class="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-5">
          <div>
            <p class="text-sm text-muted-foreground">Workspace ID</p>
            <p class="mt-1 break-all font-mono text-sm">{{ environment.workspaceId }}</p>
          </div>
          <span
            class="rounded-full border px-3 py-1 text-sm font-medium"
            data-testid="workspace-environment-status"
            :class="environment.status === 'ready' ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' : 'border-amber-500/40 text-amber-700 dark:text-amber-300'"
          >
            {{ environment.status }}
          </span>
        </div>

        <div class="grid gap-5 md:grid-cols-2">
          <article class="rounded-lg border p-5">
            <h2 class="font-medium">Storage</h2>
            <dl class="mt-4 space-y-3 text-sm">
              <div class="flex justify-between gap-4"><dt class="text-muted-foreground">Backend</dt><dd>{{ environment.storageBackend }}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted-foreground">Reference</dt><dd class="break-all font-mono text-right">{{ environment.storageRef }}</dd></div>
            </dl>
          </article>
          <article class="rounded-lg border p-5">
            <h2 class="font-medium">Execution spec</h2>
            <dl class="mt-4 space-y-3 text-sm">
              <div class="flex justify-between gap-4"><dt class="text-muted-foreground">Status</dt><dd>{{ (environment.executionSpec ?? environment.assignment)?.status ?? 'unknown' }}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted-foreground">Generation</dt><dd>{{ (environment.executionSpec ?? environment.assignment)?.generation ?? '—' }}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted-foreground">Spec hash</dt><dd class="break-all font-mono text-right">{{ (environment.executionSpec ?? environment.assignment)?.sandboxSpecHash || 'None' }}</dd></div>
            </dl>
          </article>
          <article class="rounded-lg border p-5 md:col-span-2">
            <h2 class="font-medium">Runtime</h2>
            <dl class="mt-4 grid gap-3 text-sm sm:grid-cols-3">
              <div><dt class="text-muted-foreground">Status</dt><dd class="mt-1">{{ environment.runtime.status }}</dd></div>
              <div><dt class="text-muted-foreground">Device</dt><dd class="mt-1 break-all font-mono">{{ environment.runtime.deviceId || 'Not observed' }}</dd></div>
              <div><dt class="text-muted-foreground">Last heartbeat</dt><dd class="mt-1 break-all">{{ environment.runtime.lastHeartbeatAt || 'Not observed' }}</dd></div>
            </dl>
          </article>
        </div>
      </div>
    </div>
  </section>
</template>
