<script setup lang="ts">
import { ref } from 'vue'
import { Check, LoaderCircle, Upload, X } from '@lucide/vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { formatFileSize } from '../../lib/fileSize'

const ws = useWorkspaceStore()
const targetDir = ref('')
const isDragOver = ref(false)
const splitPreference = ref(true)
const fileInput = ref<HTMLInputElement | null>(null)

const hasLargePdf = ref(false)

function handleFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files) {
    ws.addToUploadQueue(Array.from(input.files))
    checkLargePdf()
  }
}

function handleDrop(e: DragEvent) {
  isDragOver.value = false
  if (e.dataTransfer?.files) {
    ws.addToUploadQueue(Array.from(e.dataTransfer.files))
    checkLargePdf()
  }
}

function checkLargePdf() {
  hasLargePdf.value = ws.uploadQueue.some(
    item => item.name.toLowerCase().endsWith('.pdf') && item.size > 10 * 1024 * 1024,
  )
}

function removeItem(index: number) {
  ws.removeFromUploadQueue(index)
  checkLargePdf()
}

function handleImport() {
  ws.executeUpload(targetDir.value, splitPreference.value)
  ws.closeImportDialog()
}

function handleCancel() {
  ws.closeImportDialog()
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
       <div data-testid="workspace-import-dialog" class="w-full max-w-lg rounded-xl border bg-card p-6 shadow-lg">
         <h2 class="text-lg font-semibold mb-4">导入文件</h2>

        <div
          class="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors"
          :class="isDragOver ? 'border-primary bg-primary/5' : 'border-muted-foreground/20 hover:border-muted-foreground/40'"
          @dragover.prevent="isDragOver = true"
          @dragleave="isDragOver = false"
          @drop.prevent="handleDrop"
          @click="fileInput?.click()"
        >
           <Upload class="mx-auto mb-2 size-8 text-muted-foreground" aria-hidden="true" />
           <p class="text-sm text-muted-foreground">将文件拖到这里，或点击选择</p>
        </div>

        <input ref="fileInput" type="file" multiple class="hidden" @change="handleFileChange" />

        <div v-if="ws.uploadQueue.length > 0" class="mt-4 space-y-1 max-h-40 overflow-y-auto">
          <div
            v-for="(item, i) in ws.uploadQueue"
            :key="i"
            class="flex items-center gap-2 px-2 py-1 text-xs rounded bg-muted/50"
          >
            <span class="truncate flex-1">{{ item.name }}</span>
            <span class="text-muted-foreground">{{ formatFileSize(item.size) }}</span>
             <Check v-if="item.status === 'done'" class="size-3 text-green-600" aria-hidden="true" />
             <X v-else-if="item.status === 'error'" class="size-3 text-destructive" :title="item.error" aria-hidden="true" />
             <LoaderCircle v-else-if="item.status === 'uploading'" class="size-3 animate-spin" aria-hidden="true" />
            <button class="p-0.5 hover:text-destructive" aria-label="Remove file" @click="removeItem(i)">
               <X class="size-3" aria-hidden="true" />
            </button>
          </div>
        </div>

         <div class="mt-2">
           <label class="text-xs text-muted-foreground">目标目录（可选）：</label>
          <input
            v-model="targetDir"
            class="w-full mt-1 px-2 py-1 text-sm rounded border bg-background"
             placeholder="例如 src/docs"
          />
        </div>

        <div v-if="hasLargePdf" class="mt-2 flex items-center gap-2 text-xs">
          <input id="split-pdf" v-model="splitPreference" type="checkbox" class="accent-primary" />
          <label for="split-pdf" class="text-muted-foreground">
            Auto-split PDFs larger than 10MB into smaller chunks
          </label>
        </div>

        <div class="flex justify-end gap-2 mt-4">
          <button
            class="px-3 py-1.5 text-sm rounded border hover:bg-accent"
            @click="handleCancel"
          >
             取消
          </button>
          <button
            class="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
            :disabled="ws.uploadQueue.length === 0"
            @click="handleImport"
          >
             导入
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
