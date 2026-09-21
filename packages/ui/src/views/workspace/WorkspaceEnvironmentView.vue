<script setup lang="ts">
import { computed, onMounted, ref, watch, onBeforeUnmount, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { api, ApiError } from '../../composables/api'
import { useAuthStore } from '../../stores/auth'
import { logger } from '../../lib/logger'
import { toast } from 'vue-sonner'
import { LoaderCircle, RefreshCw } from '@lucide/vue'

type Environment = Awaited<ReturnType<typeof api.getWorkspaceEnvironment>>
type WorkspaceJob = Awaited<ReturnType<typeof api.getWorkspaceJobs>>[number]

const route = useRoute()
const auth = useAuthStore()
const environment = ref<Environment | null>(null)
const jobs = ref<WorkspaceJob[]>([])
const loading = ref(false)
const error = ref('')
const preparing = ref(false)
const prepareError = ref('')
const selectedExecutionMode = ref<'docker' | 'windows-mxc' | 'windows-host'>('docker')
const changingExecutionMode = ref(false)
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
  // PLAN-0345: explicit 6-state entries — paused/stopped/destroying must not
  // fall into the unknown fallback (T3.1 UI assertion).
  paused: {
    cls: 'border-sky-500/40 text-sky-700 dark:text-sky-300',
    recovery: '已暂停（沙盒进程冻结保留）。下次使用会自动恢复，文件不会丢失。',
  },
  stopped: {
    cls: 'border-amber-500/40 text-amber-700 dark:text-amber-300',
    recovery: '已停止（长时间空闲回收）。再次使用会自动重新准备，文件不会丢失。',
  },
  destroying: {
    cls: 'border-red-500/40 text-red-700 dark:text-red-300',
    recovery: '销毁中：沙盒正在清理。稍后可重新 Prepare workspace。',
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
    selectedExecutionMode.value = environment.value.executionMode
    try {
      jobs.value = await api.getWorkspaceJobs(id)
    } catch (cause) {
      jobs.value = []
      logger.warn('Workspace Job projection unavailable: ' + (cause instanceof Error ? cause.message : String(cause)))
    }
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : 'Failed to load workspace environment'
  } finally {
    loading.value = false
  }
}

async function handleExecutionModeChange(event: Event) {
  const id = workspaceId.value
  if (!id || !environment.value) return
  const nextMode = (event.target as HTMLSelectElement).value as typeof selectedExecutionMode.value
  if (nextMode === environment.value.executionMode) return
  changingExecutionMode.value = true
  try {
    await api.updateWorkspaceExecutionMode(id, nextMode)
    toast.success('执行模式已更新')
    await loadEnvironment()
  } catch (cause) {
    selectedExecutionMode.value = environment.value.executionMode
    const message = cause instanceof ApiError ? cause.message : '执行模式更新失败'
    logger.error('Execution mode update failed', cause)
    toast.error(message)
  } finally {
    changingExecutionMode.value = false
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
        <p class="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">工作区</p>
        <h1 data-testid="workspace-environment-heading" class="mt-2 text-2xl font-semibold tracking-tight">环境状态</h1>
        <p class="mt-2 max-w-2xl text-sm text-muted-foreground">
          查看当前执行配置、存储绑定和 Runtime 运行状态。
        </p>
      </header>

      <div class="mb-5 flex justify-end">
        <button
          class="px-3 py-1.5 text-xs rounded border hover:bg-accent text-muted-foreground transition-colors"
          title="Refresh"
          @click="loadEnvironment()"
        >
           <RefreshCw class="mr-1 inline-block size-3.5" aria-hidden="true" />
          刷新
        </button>
      </div>

       <div v-if="loading" class="rounded-lg border p-6 text-sm text-muted-foreground">正在加载环境...</div>
      <div v-else-if="error" class="rounded-lg border border-destructive/40 p-6 text-sm text-destructive">{{ error }}</div>
      <div v-else-if="environment" class="space-y-5">
        <div class="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-5">
          <div>
             <p class="text-sm text-muted-foreground">工作区 ID</p>
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
             <LoaderCircle v-if="preparing" class="mr-1 inline-block size-3 animate-spin" aria-hidden="true" />
            {{ preparing ? 'Preparing…' : 'Prepare workspace' }}
          </button>
        </div>

        <div class="grid gap-5 md:grid-cols-2">
          <article class="rounded-lg border p-5">
             <h2 class="font-medium">存储</h2>
             <dl class="mt-4 space-y-3 text-sm">
                <div class="flex justify-between gap-4"><dt class="text-muted-foreground">后端</dt><dd>{{ environment.storageBackend }}</dd></div>
                <div class="flex justify-between gap-4"><dt class="text-muted-foreground">存储方式</dt><dd>{{ environment.storageMode }}</dd></div>
                <div class="flex justify-between gap-4"><dt class="text-muted-foreground">引用</dt><dd class="break-all font-mono text-right">{{ environment.storageRef }}</dd></div>
               <div v-if="environment.hostPath" class="flex justify-between gap-4"><dt class="text-muted-foreground">宿主机目录</dt><dd class="break-all font-mono text-right">{{ environment.hostPath }}</dd></div>
             </dl>
          </article>
          <article class="rounded-lg border p-5">
             <h2 class="font-medium">执行配置</h2>
             <dl class="mt-4 space-y-3 text-sm">
                <div class="flex justify-between gap-4"><dt class="text-muted-foreground">状态</dt><dd>{{ (environment.executionSpec ?? environment.assignment)?.status ?? 'unknown' }}</dd></div>
                <div class="flex items-center justify-between gap-4"><dt class="text-muted-foreground">执行模式</dt><dd>
                  <select
                    v-model="selectedExecutionMode"
                    class="rounded border bg-background px-2 py-1 text-xs"
                    :disabled="changingExecutionMode || environment.storageMode !== 'direct_attach'"
                    data-testid="workspace-execution-mode"
                    @change="handleExecutionModeChange"
                  >
                    <option value="docker" :disabled="environment.storageMode === 'direct_attach'">docker</option>
                    <option value="windows-mxc" :disabled="environment.storageMode !== 'direct_attach'">windows-mxc</option>
                    <option value="windows-host" :disabled="environment.storageMode !== 'direct_attach'">windows-host</option>
                  </select>
                </dd></div>
                <div v-if="environment.capability" class="flex justify-between gap-4">
                  <dt class="text-muted-foreground">能力探测</dt>
                  <dd :class="environment.capability.available ? 'text-emerald-700 dark:text-emerald-300' : 'text-destructive'" class="text-right">
                    {{ environment.capability.available ? `${environment.capability.maturity} / 可用` : `不可用：${environment.capability.reason ?? '未知原因'}` }}
                  </dd>
                </div>
                <div class="flex justify-between gap-4"><dt class="text-muted-foreground">代数</dt><dd>{{ (environment.executionSpec ?? environment.assignment)?.generation ?? '—' }}</dd></div>
               <div class="flex justify-between gap-4"><dt class="text-muted-foreground">配置摘要</dt><dd class="break-all font-mono text-right">{{ (environment.executionSpec ?? environment.assignment)?.sandboxSpecHash || '无' }}</dd></div>
            </dl>
          </article>
          <article class="rounded-lg border p-5 md:col-span-2">
             <h2 class="font-medium">运行时</h2>
            <dl class="mt-4 grid gap-3 text-sm sm:grid-cols-3">
               <div><dt class="text-muted-foreground">状态</dt><dd class="mt-1">{{ environment.runtime.status }}</dd></div>
               <div><dt class="text-muted-foreground">设备</dt><dd class="mt-1 break-all font-mono">{{ environment.runtime.deviceId || '未观测到' }}</dd></div>
               <div><dt class="text-muted-foreground">最近心跳</dt><dd class="mt-1 break-all">{{ environment.runtime.lastHeartbeatAt || '未观测到' }}</dd></div>
            </dl>
          </article>
          <article class="rounded-lg border p-5 md:col-span-2" data-testid="workspace-jobs-panel">
            <div class="flex items-center justify-between gap-3">
              <h2 class="font-medium">Workspace Jobs</h2>
              <span class="text-xs text-muted-foreground">{{ jobs.length }} 条</span>
            </div>
            <p v-if="jobs.length === 0" class="mt-3 text-sm text-muted-foreground">暂无 durable Job</p>
            <ul v-else class="mt-3 divide-y text-sm">
              <li v-for="job in jobs" :key="job.operationItemId" class="flex flex-wrap items-center justify-between gap-3 py-3">
                <div class="min-w-0">
                  <p class="truncate font-mono text-xs">{{ job.operationItemId }}</p>
                  <p class="mt-1 text-xs text-muted-foreground">{{ job.source }} · {{ job.scope }}</p>
                </div>
                <span class="rounded border px-2 py-1 text-xs">{{ job.status }}</span>
              </li>
            </ul>
          </article>
        </div>
      </div>
    </div>
  </section>
</template>
