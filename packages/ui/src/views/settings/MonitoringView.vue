<script setup lang="ts">
import { onMounted, ref, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import SettingsNav from '../../components/settings/SettingsNav.vue'
import BackToChatButton from '../../components/settings/BackToChatButton.vue'
import { api } from '../../composables/api'

const { t } = useI18n()

interface ServiceStatus {
  name: string
  key: string
  status: string
  responseMs?: number
  error?: string
  version?: string
  database?: string
  size?: string
  connections?: number
  url?: string
  details?: string
}

const services = ref<ServiceStatus[]>([])
const overallStatus = ref<string>('loading')
const lastUpdated = ref<number>(0)
const loading = ref(false)
const error = ref<string | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

async function fetchStatus() {
  loading.value = true
  error.value = null
  try {
    const data = await api.getServiceStatus()
    services.value = data.services
    overallStatus.value = data.status
    lastUpdated.value = data.timestamp
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    overallStatus.value = 'error'
  } finally {
    loading.value = false
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'up': return 'bg-green-500'
    case 'down': return 'bg-red-500'
    default: return 'bg-yellow-500'
  }
}

function statusText(status: string): string {
  switch (status) {
    case 'up': return t('settings.serviceUp')
    case 'down': return t('settings.serviceDown')
    default: return t('settings.serviceUnknown')
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

onMounted(() => {
  fetchStatus()
  timer = setInterval(fetchStatus, 15000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <BackToChatButton />
  <SettingsNav />
  <div class="max-w-2xl mx-auto px-4 py-6">
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-lg font-semibold">{{ t('settings.monitoringTitle') }}</h2>
        <p class="text-sm text-muted-foreground">{{ t('settings.monitoringDesc') }}</p>
      </div>
      <button
        class="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-accent transition-colors"
        :disabled="loading"
        @click="fetchStatus"
      >
        {{ t('settings.refresh') }}
      </button>
    </div>

    <div v-if="error" class="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
      {{ error }}
    </div>

    <div class="mb-4 flex items-center gap-2 text-sm">
      <span
        class="inline-block size-2.5 rounded-full"
        :class="overallStatus === 'healthy' ? 'bg-green-500' : overallStatus === 'loading' ? 'bg-muted animate-pulse' : 'bg-red-500'"
      />
      <span class="font-medium">
        {{ overallStatus === 'healthy' ? t('settings.allHealthy') : overallStatus === 'loading' ? t('common.loading') : t('settings.someDown') }}
      </span>
      <span v-if="lastUpdated" class="text-muted-foreground ml-auto">
        {{ t('settings.lastUpdated') }}: {{ formatTime(lastUpdated) }}
      </span>
    </div>

    <div class="space-y-3">
      <div
        v-for="svc in services"
        :key="svc.key"
        class="rounded-lg border border-border bg-card p-4"
      >
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <span
              class="inline-block size-3 rounded-full"
              :class="statusColor(svc.status)"
            />
            <div>
              <span class="font-medium">{{ svc.name }}</span>
              <span class="ml-2 text-xs text-muted-foreground">{{ svc.key }}</span>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <span v-if="svc.responseMs !== undefined" class="text-xs text-muted-foreground">
              {{ svc.responseMs }}ms
            </span>
            <span
              class="px-2 py-0.5 text-xs rounded-full"
              :class="svc.status === 'up' ? 'bg-green-500/10 text-green-600' : 'bg-red-500/10 text-red-600'"
            >
              {{ statusText(svc.status) }}
            </span>
          </div>
        </div>

        <div v-if="svc.status === 'up' && (svc.version || svc.database || svc.connections !== undefined || svc.url)" class="mt-3 pt-3 border-t border-border/50 grid grid-cols-2 gap-2 text-sm">
          <div v-if="svc.version" class="flex items-center gap-2">
            <span class="text-muted-foreground">{{ t('settings.version') }}:</span>
            <span class="truncate" :title="String(svc.version)">{{ svc.version }}</span>
          </div>
          <div v-if="svc.database" class="flex items-center gap-2">
            <span class="text-muted-foreground">{{ t('settings.database') }}:</span>
            <span>{{ svc.database }}</span>
          </div>
          <div v-if="svc.size" class="flex items-center gap-2">
            <span class="text-muted-foreground">{{ t('settings.dbSize') }}:</span>
            <span>{{ svc.size }}</span>
          </div>
          <div v-if="svc.connections !== undefined" class="flex items-center gap-2">
            <span class="text-muted-foreground">{{ t('settings.connections') }}:</span>
            <span>{{ svc.connections }}</span>
          </div>
          <div v-if="svc.url" class="col-span-2 flex items-center gap-2">
            <span class="text-muted-foreground">URL:</span>
            <span class="truncate text-xs" :title="svc.url">{{ svc.url }}</span>
          </div>
          <div v-if="svc.details" class="col-span-2 mt-1">
            <details class="text-xs">
              <summary class="cursor-pointer text-muted-foreground hover:text-foreground">{{ t('settings.details') }}</summary>
              <pre class="mt-1 p-2 rounded bg-muted/50 overflow-x-auto text-xs">{{ svc.details }}</pre>
            </details>
          </div>
        </div>

        <div v-if="svc.status === 'down' && svc.error" class="mt-2 text-sm text-destructive">
          {{ svc.error }}
        </div>
      </div>
    </div>
  </div>
</template>
