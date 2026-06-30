<script setup lang="ts">
import { computed, ref } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import type { OpenFile } from '../../types'
import EditorTabBar from './EditorTabBar.vue'
import MdEditor from './MdEditor.vue'
import CodeEditor from './CodeEditor.vue'
import ImagePreview from './ImagePreview.vue'
import PdfViewer from '../chat/PdfViewer.vue'
import DiffViewer from './DiffViewer.vue'
import UnknownFileNotice from './UnknownFileNotice.vue'

const ws = useWorkspaceStore()
const diffMode = ref(false)

const activeFile = computed<OpenFile | null>(() => ws.activeFile)
const isImage = computed(() => {
  const f = activeFile.value
  if (!f) return false
  const ext = f.path.split('.').pop()?.toLowerCase()
  return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext || '')
})
const isMarkdown = computed(() => activeFile.value?.path.endsWith('.md') ?? false)
const isPdf = computed(() => activeFile.value?.path.toLowerCase().endsWith('.pdf') ?? false)
const isCode = computed(() => {
  const f = activeFile.value
  if (!f) return false
  const ext = f.path.split('.').pop()?.toLowerCase()
  return ['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'java', 'go', 'vue', 'css', 'html', 'json', 'yaml', 'yml', 'sql', 'xml', 'sh', 'bash', 'toml', 'c', 'cpp', 'h', 'txt', 'log', 'csv'].includes(ext || '')
})

function handleContentUpdate(content: string) {
  const f = activeFile.value
  if (f) ws.updateFileContent(f.path, content)
}

function handleSave() {
  const f = activeFile.value
  if (f) ws.saveFile(f.path)
}

function toggleDiff() {
  diffMode.value = !diffMode.value
}

function handlePdfSplit() {
  const f = activeFile.value
  if (f) ws.splitPdf(f.path)
}

function handleChunkIndexChange(index: number) {
  const f = activeFile.value
  if (f) {
    f.chunkIndex = index
  }
}

function handleLoadFullContent() {
  const f = activeFile.value
  if (f) ws.loadFullContent(f.path)
}
</script>

<template>
  <div class="flex flex-col h-full">
    <EditorTabBar
      :open-files="ws.openFileList"
      :active-path="ws.activeFilePath"
      @select="ws.openFile($event)"
      @close="ws.closeFile($event)"
    />

    <div v-if="!activeFile" class="flex-1 flex items-center justify-center">
      <div class="text-center">
        <span class="i-lucide-file-text size-12 text-muted-foreground/30 mx-auto" />
        <p class="mt-2 text-sm text-muted-foreground">Select a file from the tree</p>
      </div>
    </div>

    <div v-else-if="isPdf" class="flex-1 overflow-auto">
      <PdfViewer
        :src="activeFile.content"
        :chunks="activeFile.chunks ?? null"
        :chunk-index="activeFile.chunkIndex ?? 0"
        :file-name="activeFile.name"
        @split="handlePdfSplit"
        @update:chunk-index="handleChunkIndexChange"
      />
    </div>

    <div v-else-if="isImage" class="flex-1 overflow-auto">
      <ImagePreview :content="activeFile.content" :file-name="activeFile.name" />
    </div>

    <div v-else-if="isMarkdown" class="flex-1 overflow-hidden flex flex-col">
      <div class="flex items-center justify-between px-3 py-1 border-b bg-muted/20 shrink-0">
        <span class="text-xs text-muted-foreground">{{ activeFile.path }}</span>
        <button
          class="px-2 py-0.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-30"
          :disabled="!activeFile.modified"
          @click="handleSave"
        >
          {{ activeFile.modified ? 'Save' : 'Saved' }}
        </button>
      </div>
      <!-- Truncation banner -->
      <div
        v-if="activeFile.truncated"
        class="flex items-center justify-between px-3 py-1.5 text-xs bg-amber-50 text-amber-900 border-b"
      >
        <span>Content truncated. Only part of the file is shown.</span>
        <button
          class="px-2 py-0.5 rounded bg-amber-600 text-white hover:bg-amber-700"
          @click="handleLoadFullContent"
        >
          Load Full
        </button>
      </div>
      <div class="flex-1 overflow-hidden">
        <MdEditor :model-value="activeFile.content" @update:model-value="handleContentUpdate" />
      </div>
    </div>

    <div v-else-if="isCode" class="flex-1 overflow-hidden flex flex-col">
      <div class="flex items-center justify-between px-3 py-1 border-b bg-muted/20 shrink-0">
        <span class="text-xs text-muted-foreground">{{ activeFile.path }}</span>
        <div class="flex gap-1">
          <button
            v-if="activeFile.modified"
            class="px-2 py-0.5 text-xs rounded border hover:bg-muted transition-colors"
            @click="toggleDiff"
          >
            {{ diffMode ? 'Edit' : 'Diff' }}
          </button>
          <button
            class="px-2 py-0.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-30"
            :disabled="!activeFile.modified"
            @click="handleSave"
          >
            {{ activeFile.modified ? 'Save' : 'Saved' }}
          </button>
        </div>
      </div>
      <!-- Truncation banner -->
      <div
        v-if="activeFile.truncated"
        class="flex items-center justify-between px-3 py-1.5 text-xs bg-amber-50 text-amber-900 border-b"
      >
        <span>Content truncated. Only part of the file is shown.</span>
        <button
          class="px-2 py-0.5 rounded bg-amber-600 text-white hover:bg-amber-700"
          @click="handleLoadFullContent"
        >
          Load Full
        </button>
      </div>
      <div v-if="diffMode && activeFile" class="flex-1 overflow-hidden">
        <DiffViewer :original="activeFile.originalContent" :modified="activeFile.content" :language="activeFile.language" />
      </div>
      <div v-else class="flex-1 overflow-hidden">
        <CodeEditor :model-value="activeFile.content" :language="activeFile.language" @update:model-value="handleContentUpdate" />
      </div>
    </div>

    <div v-else class="flex-1 overflow-auto flex flex-col">
      <div class="flex items-center justify-between px-3 py-1 border-b bg-muted/20 shrink-0">
        <span class="text-xs text-muted-foreground">{{ activeFile.path }}</span>
      </div>
      <!-- Truncation banner -->
      <div
        v-if="activeFile.truncated"
        class="flex items-center justify-between px-3 py-1.5 text-xs bg-amber-50 text-amber-900 border-b"
      >
        <span>Content truncated. Only part of the file is shown.</span>
        <button
          class="px-2 py-0.5 rounded bg-amber-600 text-white hover:bg-amber-700"
          @click="handleLoadFullContent"
        >
          Load Full
        </button>
      </div>
      <div class="flex-1">
        <UnknownFileNotice :file-name="activeFile.name" :file-path="activeFile.path" />
      </div>
    </div>
  </div>
</template>
