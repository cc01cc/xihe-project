<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '../../composables/api'

// PLAN-0366 T2.1：stdio 服务器状态列表（视觉基线 evidence/ui-preview.html，已确认）。
// 数据源 = `stdio-servers`（配置 name）∪ `mcp/servers`（会话快照 server_id）；
// 刷新 = 打开拉取 + 手动刷新 + 30s 轮询（页面不可见时暂停，决策 #4）；
// 失败保留上次状态并标注「状态可能过期」（spec §刷新与失效）。
const POLL_INTERVAL_MS = 30_000

const props = defineProps<{ workspaceId: string }>()

const { t } = useI18n()

type Snapshot = {
  state: string
  attempt: number
  lastError: string | null
  sinceMs: number
}

const configuredNames = ref<string[]>([])
const snapshots = ref<Record<string, Snapshot>>({})
const loading = ref(false)
const refreshing = ref(false)
const stale = ref(false)

let pollTimer: number | null = null

const rows = computed(() => {
  const ids = new Set<string>([...configuredNames.value, ...Object.keys(snapshots.value)])
  return [...ids].sort().map((serverId) => {
    const snapshot = snapshots.value[serverId]
    return snapshot ? { serverId, ...snapshot } : { serverId, state: 'none' as const }
  })
})

const showStale = computed(() => stale.value && rows.value.length > 0)

function badgeClass(state: string): string {
  switch (state) {
    case 'ready':
      return 'border-green-600/40 bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-300'
    case 'starting':
      return 'border-blue-500/40 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
    case 'restarting':
      return 'border-amber-500/50 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
    case 'failed':
      return 'border-destructive/50 bg-destructive/10 text-destructive'
    case 'stopped':
      return 'border-border bg-muted text-muted-foreground'
    default:
      return 'border-dashed border-border bg-transparent text-muted-foreground'
  }
}

function sinceText(sinceMs?: number): string {
  if (!sinceMs) return ''
  return new Date(sinceMs).toLocaleString()
}

function reasonText(row: { state: string; lastError?: string | null }): string {
  if ((row.state === 'failed' || row.state === 'restarting') && row.lastError) return row.lastError
  return ''
}

function rowTitle(row: { state: string; lastError?: string | null; sinceMs?: number }): string {
  if (row.state === 'none') return t('settings.mcpStatusNoneHint')
  const parts = [sinceText(row.sinceMs)]
  if (row.lastError) parts.push(row.lastError)
  return parts.filter(Boolean).join(' · ')
}

async function load(refresh = false) {
  if (loading.value) return
  loading.value = true
  if (refresh) refreshing.value = true
  try {
    const [config, status] = await Promise.allSettled([
      api.getStdioServers(props.workspaceId),
      api.getMcpServerStatus(props.workspaceId),
    ])
    if (config.status === 'fulfilled') {
      configuredNames.value = Object.keys(config.value.servers ?? {})
    }
    if (status.status === 'fulfilled') {
      const next: Record<string, Snapshot> = {}
      for (const server of status.value.servers ?? []) {
        next[server.serverId] = {
          state: server.state,
          attempt: server.attempt,
          lastError: server.lastError,
          sinceMs: server.sinceMs,
        }
      }
      snapshots.value = next
    }
    // 任一源失败：保留上次成功状态并标注过期（首次失败则列表按已知配置呈现）。
    stale.value = config.status === 'rejected' || status.status === 'rejected'
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

function startPolling() {
  if (pollTimer !== null) return
  pollTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void load(true)
  }, POLL_INTERVAL_MS)
}

function stopPolling() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') void load(true)
}

onMounted(async () => {
  await load()
  startPolling()
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  stopPolling()
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

defineExpose({ load, showStale })
</script>

<template>
  <div data-testid="mcp-servers-panel">
    <div class="mb-2 flex items-center gap-2">
      <span class="text-sm font-medium">{{ t('settings.mcpServersTitle') }}</span>
      <span
        v-if="showStale"
        class="rounded border border-amber-500/50 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
        data-testid="mcp-status-stale"
      >{{ t('settings.mcpStatusStale') }}</span>
      <button
        type="button"
        class="ml-auto rounded border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
        :disabled="loading"
        data-testid="mcp-status-refresh"
        @click="load(true)"
      >{{ refreshing ? t('common.loading') : t('settings.mcpStatusRefresh') }}</button>
    </div>
    <ul v-if="rows.length" class="divide-y rounded border" data-testid="mcp-server-list">
      <li
        v-for="row in rows"
        :key="row.serverId"
        class="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
        data-testid="mcp-server-row"
      >
        <span class="min-w-0 flex-1 truncate font-medium" :title="row.serverId">{{ row.serverId }}</span>
        <span
          v-if="reasonText(row)"
          class="max-w-[20rem] truncate rounded border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs text-destructive"
          :title="reasonText(row)"
          data-testid="mcp-server-reason"
        >{{ reasonText(row) }}</span>
        <span
          class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs whitespace-nowrap"
          :class="badgeClass(row.state)"
          :title="rowTitle(row)"
          data-testid="mcp-server-badge"
        >
          <span class="size-1.5 rounded-full bg-current" aria-hidden="true"></span>
          {{ t(`settings.mcpStatus.${row.state}`) }}
        </span>
      </li>
    </ul>
    <p v-else class="rounded border border-dashed px-3 py-6 text-center text-sm text-muted-foreground" data-testid="mcp-status-empty">
      {{ t('settings.mcpStatusEmpty') }}<br />
      <span class="text-xs">{{ t('settings.mcpStatusEmptyHint') }}</span>
    </p>
  </div>
</template>
