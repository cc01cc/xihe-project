<script setup lang="ts">
import { computed, onMounted, ref, watch, onBeforeUnmount, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { api, ApiError } from '../../composables/api'
import { useAuthStore } from '../../stores/auth'
import { logger } from '../../lib/logger'
import { toast } from 'vue-sonner'

type Environment = Awaited<ReturnType<typeof api.getWorkspaceEnvironment>>

const route = useRoute()
const auth = useAuthStore()
const environment = ref<Environment | null>(null)
const loading = ref(false)
const error = ref('')
const preparing = ref(false)
const prepareError = ref('')
const pollTimer = ref<ReturnType<typeof setInterval> | null>(null)
const workspaceId = computed(() => {
  const fromRoute = String(route.params.workspaceId ?? '').trim()
  return fromRoute || auth.currentWorkspaceId || ''
})

const STATUS_META: Record<string, { cls: string; recovery: string }> = {
  ready: {
    cls: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300',
    recovery: '工作区已就绪，无需操作。',
  },
  materializing: {
    cls: 'border-sky-500/40 text-sky-700 dark:text-sky-300',
    recovery: '正在准备中（可能拉取沙盒镜像），请稍候并点击刷新查看进度。',
  },
  degraded: {
    cls: 'border-amber-500/40 text-amber-700 dark:text-amber-300',
    recovery: '部分降级：检查 Runtime 日志与 Docker 状态，文件不会丢失。',
  },
  blocked: {
    cls: 'border-red-500/40 text-red-700 dark:text-red-300',
    recovery: '已阻塞：确认 Docker Desktop 正在运行且 WSL2 集成已启用；检查宿主机目录可写；修复后点击刷新或重新 Prepare。',
  },
  stale: {
    cls: 'border-amber-500/40 text-amber-700 dark:text-amber-300',
    recovery: '状态过期：Runtime 心跳中断，点击刷新重新获取；长时间 stale 请检查 Runtime 进程。',
  },
  unbound: {
    cls: 'border-amber-500/40 text-amber-700 dark:text-amber-300',
    recovery: '尚未物化：点击下方 Prepare workspace 手动准备，或直接使用文件/对话功能自动准备。',
  },
  pending: {
    cls: 'border-amber-500/40 text-amber-700 dark:text-amber-300',
    recovery: '等待中：点击下方 Prepare workspace 手动准备，或直接使用文件/对话功能自动准备。',
  },
}

const statusMeta = computed(() => {
  const s = (environment.value?.status ?? 'unknown').toLowerCase()
  return STATUS_META[s] ?? {
    cls: 'border-amber-500/40 text-amber-700 dark:text-amber-300',
    recovery: '未知状态：点击刷新重试；持续异常请检查 Runtime 与 Docker。',
  }
})

const showPrepare = computed(() => {
  const s = (environment.value?.status ?? '').toLowerCase()
  return s === 'unbound' || s === 'pending' || s === 'blocked'
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

async function handlePrepare() {
  const id = workspaceId.value
  if (!id || preparing.value) return
  preparing.value = true
  prepareError.value = ''
  // Set synchronously before the first await so the button state flips
  // even if the request resolves on the next microtask (mock/E2E timing).
  await nextTick()
  try {
    await api.materializeWorkspace(id)
    toast.success('Materialization started — polling status')
    startPolling()
  } catch (cause) {
    const message = cause instanceof ApiError ? cause.message : 'Failed to start materialization'
    logger.error('Prepare workspace failed', cause)
    prepareError.value = message
    toast.error(message)
    preparing.value = false
  }
}

function startPolling() {
  stopPolling()
  pollTimer.value = setInterval(async () => {
    const id = workspaceId.value
    if (!id) {
      stopPolling()
      return
    }
    try {
      environment.value = await api.getWorkspaceEnvironment(id)
      const s = (environment.value?.status ?? '').toLowerCase()
      if (s === 'ready' || s === 'blocked') {
        stopPolling()
        if (s === 'ready') toast.success('Workspace is ready')
      }
    } catch (cause) {
      logger.warn('Environment poll failed: ' + (cause instanceof Error ? cause.message : String(cause)))
    }
  }, 3000)
}

function stopPolling() {
  if (pollTimer.value) {
    clearInterval(pollTimer.value)
    pollTimer.value = null
  }
  preparing.value = false
}

onMounted(loadEnvironment)
watch(() => workspaceId.value, () => {
  stopPolling()
  loadEnvironment()
})
onBeforeUnmount(stopPolling)
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

      <div class="mb-5 flex justify-end">
        <button
          class="px-3 py-1.5 text-xs rounded border hover:bg-accent text-muted-foreground transition-colors"
          title="Refresh"
          @click="loadEnvironment()"
        >
          <span class="i-lucide-refresh-cw size-3.5 inline-block mr-1" />
          刷新
        </button>
      </div>

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
            :class="statusMeta.cls"
          >
            {{ environment.status }}
          </span>
        </div>

        <p class="rounded-lg border p-4 text-sm text-muted-foreground" data-testid="workspace-environment-recovery">
          {{ statusMeta.recovery }}
        </p>

        <div
          v-if="showPrepare"
          class="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-sky-500/40 bg-sky-50 dark:bg-sky-950 p-5"
          data-testid="workspace-prepare-card"
        >
          <div>
            <p class="text-sm font-medium">此工作区尚未物化</p>
            <p class="mt-1 max-w-xl text-xs text-muted-foreground">
              首次物化将创建宿主机目录并启动沙盒容器（可能需拉取镜像，约 1–2 分钟）。
              也可以直接使用文件/对话功能，系统会自动准备。
            </p>
            <p v-if="prepareError" class="mt-2 text-xs text-destructive">{{ prepareError }}</p>
          </div>
          <button
            class="px-4 py-2 text-sm rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
            :disabled="preparing"
            data-testid="workspace-prepare-button"
            @click="handlePrepare"
          >
            <span v-if="preparing" class="i-lucide-loader-circle size-3 animate-spin inline-block mr-1" />
            {{ preparing ? 'Preparing…' : 'Prepare workspace' }}
          </button>
        </div>

        <div class="grid gap-5 md:grid-cols-2">
          <article class="rounded-lg border p-5">
            <h2 class="font-medium">Storage</h2>
            <dl class="mt-4 space-y-3 text-sm">
              <div class="flex justify-between gap-4"><dt class="text-muted-foreground">Backend</dt><dd>{{ environment.storageBackend }}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted-foreground">Reference</dt><dd class="break-all font-mono text-right">{{ environment.storageRef }}</dd></div>
              <div class="flex justify-between gap-4"><dt class="text-muted-foreground">宿主机访问</dt><dd class="text-right text-emerald-700 dark:text-emerald-300">✓ 系统文件操作直访</dd></div>
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
