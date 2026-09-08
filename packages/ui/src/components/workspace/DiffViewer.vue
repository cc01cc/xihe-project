<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue'

export interface DiffFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  oldPath?: string
  contentHash?: string
}

export interface DiffLine {
  type: 'context' | 'add' | 'delete' | 'hunk'
  content: string
  oldLine?: number
  newLine?: number
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

const props = withDefaults(defineProps<{
  original?: string
  modified?: string
  language?: string
  files?: DiffFile[]
  hunks?: DiffHunk[]
}>(), {
  original: '',
  modified: '',
  files: undefined,
  hunks: undefined,
})

const editorRef = ref<HTMLDivElement | null>(null)

const isUnifiedMode = computed(() => props.files !== undefined || props.hunks !== undefined)

const statusLabel: Record<DiffFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
}

const statusColor: Record<DiffFile['status'], string> = {
  added: 'text-emerald-400',
  modified: 'text-amber-400',
  deleted: 'text-red-400',
  renamed: 'text-blue-400',
}

function lineClass(type: DiffLine['type']): string {
  switch (type) {
    case 'add': return 'bg-emerald-500/10 text-emerald-300'
    case 'delete': return 'bg-red-500/10 text-red-300'
    case 'hunk': return 'bg-blue-500/10 text-blue-300 font-semibold'
    default: return 'text-zinc-400'
  }
}

const totalAdded = computed(() => (props.hunks ?? []).reduce((n, h) => n + h.lines.filter((l) => l.type === 'add').length, 0))
const totalDeleted = computed(() => (props.hunks ?? []).reduce((n, h) => n + h.lines.filter((l) => l.type === 'delete').length, 0))

async function renderDiff() {
  if (!editorRef.value || isUnifiedMode.value) return
  try {
    const monaco = await import('monaco-editor')
    const diff = monaco.editor.createDiffEditor(editorRef.value, {
      renderSideBySide: true,
      originalEditable: false,
      fontSize: 13,
      minimap: { enabled: false },
      automaticLayout: true,
    })
    diff.setModel({
      original: monaco.editor.createModel(props.original ?? '', props.language),
      modified: monaco.editor.createModel(props.modified ?? '', props.language),
    })
  } catch { /* Monaco not available */ }
}

onMounted(renderDiff)
watch(() => [props.original, props.modified], renderDiff)
</script>

<template>
  <div data-testid="workspace-diff-viewer" class="h-full w-full border rounded-lg overflow-hidden">
    <template v-if="isUnifiedMode">
      <div class="flex flex-col h-full overflow-hidden text-sm font-mono bg-zinc-950">
        <div class="flex items-center gap-4 px-3 py-2 border-b border-zinc-800 text-zinc-500">
          <span class="text-emerald-400">+{{ totalAdded }}</span>
          <span class="text-red-400">-{{ totalDeleted }}</span>
          <span class="ml-auto">{{ (files ?? []).length }} file{{ (files ?? []).length !== 1 ? 's' : '' }}</span>
        </div>

        <div v-if="files?.length" class="border-b border-zinc-800">
          <div
            v-for="file in files"
            :key="file.path"
            class="flex items-center gap-2 px-3 py-1 hover:bg-zinc-900"
          >
            <span :class="['font-bold w-4', statusColor[file.status]]">{{ statusLabel[file.status] }}</span>
            <span class="text-zinc-300 truncate">{{ file.path }}</span>
            <span v-if="file.contentHash" class="ml-auto text-zinc-600 text-xs">{{ file.contentHash }}</span>
          </div>
        </div>

        <div class="flex-1 overflow-auto">
          <div v-for="(hunk, hi) in hunks" :key="hi">
            <div class="px-3 py-1 bg-zinc-900 border-b border-zinc-800 text-blue-400 text-xs">
              {{ hunk.header }}
            </div>
            <div v-for="(line, li) in hunk.lines" :key="li" :class="[lineClass(line.type), 'px-3 whitespace-pre']">
              <span v-if="line.type === 'add'" class="inline-block w-4 mr-2 select-none opacity-50">+</span>
              <span v-else-if="line.type === 'delete'" class="inline-block w-4 mr-2 select-none opacity-50">-</span>
              <span v-else class="inline-block w-4 mr-2 select-none opacity-50">&nbsp;</span>
              {{ line.content }}
            </div>
          </div>
          <div v-if="!hunks?.length" class="p-4 text-zinc-600 text-center">No diff data</div>
        </div>
      </div>
    </template>
    <template v-else>
      <div ref="editorRef" class="h-full w-full" />
    </template>
  </div>
</template>
