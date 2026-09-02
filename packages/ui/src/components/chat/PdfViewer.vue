<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { usePdfDocument } from '../../composables/usePdfDocument'
import { api } from '../../composables/api'
import { formatFileSize } from '../../lib/fileSize'
import { logger } from '../../lib/logger'
import { useAuthStore } from '../../stores/auth'
import PdfToolbar from './PdfToolbar.vue'
import PdfPageCanvas from './PdfPageCanvas.vue'

const props = defineProps<{
  src: string | ArrayBuffer | null
  chunks?: string[] | null
  chunkIndex?: number
  fileName?: string
  fileSize?: number
}>()

const emit = defineEmits<{
  'split': []
  'update:chunkIndex': [index: number]
}>()

const pageNum = ref(1)
const scale = ref(1.0)
const chunkLoading = ref(false)
const chunkError = ref<string | null>(null)
const chunkContent = ref<string | ArrayBuffer | null>(null)
const authStore = useAuthStore()

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function normalizeData(src: string | ArrayBuffer | null): string | ArrayBuffer | null {
  if (typeof src === 'string') {
    try {
      return base64ToUint8Array(src).buffer as ArrayBuffer
    } catch {
      logger.warn('PDF src is not valid base64, falling back to raw string')
      return src
    }
  }
  return src
}

const displaySrc = computed(() => {
  if (chunkContent.value !== null) return chunkContent.value
  return props.src
})

const { pdfDoc, numPages: totalPages, loading, error: pdfError } = usePdfDocument(() => normalizeData(displaySrc.value))

watch(() => props.src, () => {
  pageNum.value = 1
  scale.value = 1.0
  chunkContent.value = null
  chunkError.value = null
})

watch(() => props.chunkIndex, async (index) => {
  if (index === undefined || index === null || !props.chunks || !props.chunks[index]) {
    chunkContent.value = null
    return
  }
  if (!authStore.currentWorkspaceId) {
    chunkError.value = 'Workspace context is required'
    return
  }
  chunkLoading.value = true
  chunkError.value = null
  try {
    const res = await api.readFile(props.chunks[index], authStore.currentWorkspaceId)
    chunkContent.value = res.content
    pageNum.value = 1
  } catch (e) {
    chunkError.value = 'Failed to load chunk: ' + (e as Error).message
  } finally {
    chunkLoading.value = false
  }
}, { immediate: true })

const isSplitPromptVisible = computed(() => {
  if (!props.fileName?.toLowerCase().endsWith('.pdf')) return false
  if (props.chunks && props.chunks.length > 0) return false
  if (props.fileSize === undefined) return false
  return props.fileSize > 10 * 1024 * 1024
})

function prevChunk() {
  if (props.chunkIndex !== undefined && props.chunkIndex > 0) {
    emit('update:chunkIndex', props.chunkIndex - 1)
  }
}

function nextChunk() {
  if (props.chunks && props.chunkIndex !== undefined && props.chunkIndex < props.chunks.length - 1) {
    emit('update:chunkIndex', props.chunkIndex + 1)
  }
}
</script>

<template>
  <div class="flex flex-col items-center gap-2 p-4 border rounded-lg bg-background min-h-[200px]">
    <!-- Split prompt for unsplit large PDF -->
    <div
      v-if="isSplitPromptVisible"
      class="w-full p-3 rounded border bg-amber-50 text-amber-900 text-sm flex items-center justify-between"
    >
      <span>
        File is large ({{ fileSize ? formatFileSize(fileSize) : 'unknown' }}).
        Split into smaller chunks for preview?
      </span>
      <div class="flex gap-2 shrink-0">
        <button
          class="px-3 py-1 text-xs rounded bg-amber-600 text-white hover:bg-amber-700"
          @click="emit('split')"
        >
          Split
        </button>
        <a
          v-if="fileName"
          :href="`/api/v1/files/${fileName}`"
          class="px-3 py-1 text-xs rounded border border-amber-300 hover:bg-amber-100"
          download
        >
          Download
        </a>
      </div>
    </div>

    <!-- Chunk navigation -->
    <div
      v-if="chunks && chunks.length > 1"
      class="w-full flex items-center justify-between px-2 py-1 text-xs text-muted-foreground"
    >
      <button
        class="p-1 rounded hover:bg-accent disabled:opacity-30"
        :disabled="chunkIndex === undefined || chunkIndex <= 0"
        @click="prevChunk"
      >
        ◀
      </button>
      <span>
        Chunk {{ chunkIndex !== undefined ? chunkIndex + 1 : 1 }} / {{ chunks.length }}
        ({{ chunkIndex !== undefined && chunks[chunkIndex] ? chunks[chunkIndex] : '' }})
      </span>
      <button
        class="p-1 rounded hover:bg-accent disabled:opacity-30"
        :disabled="chunks === null || chunkIndex === undefined || chunkIndex >= chunks.length - 1"
        @click="nextChunk"
      >
        ▶
      </button>
    </div>

    <div v-if="chunkLoading" class="text-sm text-muted-foreground">Loading chunk…</div>
    <div v-else-if="chunkError" class="text-sm text-destructive">{{ chunkError }}</div>
    <div v-else-if="loading" class="text-sm text-muted-foreground">Loading PDF…</div>
    <div v-else-if="pdfError" class="text-sm text-destructive">Failed to load PDF</div>
    <div v-else-if="!pdfDoc" class="text-sm text-muted-foreground">No PDF loaded</div>
    <template v-else>
      <PdfToolbar
        :page-num="pageNum"
        :total-pages="totalPages"
        :scale="scale"
        @prev="pageNum--"
        @next="pageNum++"
        @update:scale="scale = $event"
      />
      <PdfPageCanvas
        :pdf-doc="pdfDoc"
        :page-num="pageNum"
        :scale="scale"
      />
    </template>
  </div>
</template>
