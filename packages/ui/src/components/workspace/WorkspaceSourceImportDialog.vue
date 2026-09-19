<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { api } from '../../composables/api'

const props = defineProps<{ open: boolean; workspaceId: string }>()
const emit = defineEmits<{ close: []; completed: [] }>()

const path = ref('')
const entries = ref<Array<{ name: string; kind: string; readable: boolean; size: number }>>([])
const error = ref<string | null>(null)
const loading = ref(false)
const importing = ref(false)
const importId = ref<string | null>(null)
const status = ref<string | null>(null)
let pollTimer: ReturnType<typeof setTimeout> | undefined

async function browse(nextPath = path.value) {
  if (!nextPath.trim()) return
  loading.value = true
  error.value = null
  try {
    const result = await api.listImportSources(nextPath.trim())
    path.value = result.path
    entries.value = result.entries
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '目录不可读取'
  } finally {
    loading.value = false
  }
}

function openEntry(entry: { name: string; kind: string }) {
  if (entry.kind === 'directory') void browse(`${path.value.replace(/[\\/]$/, '')}/${entry.name}`)
}

async function startImport() {
  if (!path.value || importing.value) return
  importing.value = true
  error.value = null
  status.value = 'queued'
  try {
    const result = await api.startWorkspaceImport(props.workspaceId, {
      sourcePath: path.value,
      idempotencyKey: crypto.randomUUID(),
    })
    importId.value = String(result.importId)
    await poll()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '导入启动失败'
    importing.value = false
  }
}

async function poll() {
  if (!importId.value) return
  const result = await api.getWorkspaceImport(importId.value)
  status.value = String(result.status ?? 'unknown')
  if (['completed', 'cancelled', 'failed'].includes(status.value)) {
    importing.value = false
    if (status.value === 'completed') emit('completed')
    return
  }
  pollTimer = setTimeout(() => void poll(), 1000)
}

function close() {
  if (!importing.value) emit('close')
}

watch(() => props.open, (open) => {
  if (open) {
    error.value = null
    status.value = null
    importId.value = null
  }
})

onBeforeUnmount(() => {
  if (pollTimer) clearTimeout(pollTimer)
})
</script>

<template>
  <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
    <section class="w-full max-w-xl rounded-lg border bg-background p-5 shadow-xl" role="dialog" aria-modal="true">
      <div class="flex items-center justify-between">
        <h2 class="text-base font-semibold">导入工作区目录</h2>
        <button type="button" class="text-muted-foreground" :disabled="importing" @click="close">关闭</button>
      </div>
      <div class="mt-4 flex gap-2">
        <input v-model="path" class="min-w-0 flex-1 rounded border bg-background px-2 py-1.5 text-sm" placeholder="Runtime 可访问的目录路径" :disabled="importing" />
        <button type="button" class="rounded border px-3 py-1.5 text-sm" :disabled="loading || importing || !path" @click="browse()">读取</button>
      </div>
      <p v-if="error" class="mt-3 text-sm text-destructive">{{ error }}</p>
      <div class="mt-3 max-h-48 overflow-auto rounded border text-sm">
        <button v-for="entry in entries" :key="entry.name" type="button" class="block w-full border-b px-3 py-2 text-left last:border-0 hover:bg-muted/50" :disabled="importing || entry.kind !== 'directory'" @click="openEntry(entry)">
          {{ entry.kind === 'directory' ? '📁' : '📄' }} {{ entry.name }}
        </button>
        <p v-if="entries.length === 0" class="p-3 text-muted-foreground">请输入并读取目录</p>
      </div>
      <div class="mt-4 flex items-center justify-between">
        <span v-if="status" class="text-xs text-muted-foreground">状态：{{ status }}</span>
        <span v-else />
        <button type="button" class="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50" :disabled="!path || importing" @click="startImport">开始导入</button>
      </div>
    </section>
  </div>
</template>
