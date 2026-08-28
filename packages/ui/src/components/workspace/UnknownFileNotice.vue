<script setup lang="ts">
import { apiRaw } from '../../composables/api'
const props = defineProps<{
  fileName: string
  filePath: string
}>()

function copyPath() {
  navigator.clipboard.writeText(props.filePath)
}

async function download() {
  // Downloads through CP proxy
  const url = `/api/v1/files/${encodeURIComponent(props.filePath)}`
  const response = await apiRaw(url)
  const blobUrl = URL.createObjectURL(await response.blob())
  const a = document.createElement('a')
  a.href = blobUrl
  a.download = props.fileName
  a.click()
  URL.revokeObjectURL(blobUrl)
}
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-3 p-8 h-full">
    <span class="i-lucide-file-question size-12 text-muted-foreground" />
    <p class="text-sm text-muted-foreground">
      Cannot preview <span class="font-mono font-medium text-foreground">{{ fileName }}</span>
    </p>
    <div class="flex gap-2 mt-2">
      <button
        class="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 flex items-center gap-1"
        @click="download"
      >
        <span class="i-lucide-download size-3.5" />
        Download
      </button>
      <button
        class="px-3 py-1.5 text-xs rounded border hover:bg-accent flex items-center gap-1"
        @click="copyPath"
      >
        <span class="i-lucide-copy size-3.5" />
        Copy Path
      </button>
    </div>
  </div>
</template>
