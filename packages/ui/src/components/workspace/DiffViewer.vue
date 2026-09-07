<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'

const props = defineProps<{
  original: string
  modified: string
  language?: string
}>()

const editorRef = ref<HTMLDivElement | null>(null)

async function renderDiff() {
  if (!editorRef.value) return
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
      original: monaco.editor.createModel(props.original, props.language),
      modified: monaco.editor.createModel(props.modified, props.language),
    })
  } catch { /* Monaco not available */ }
}

onMounted(renderDiff)
watch(() => [props.original, props.modified], renderDiff)
</script>

<template>
  <div ref="editorRef" data-testid="workspace-diff-viewer" class="h-full w-full border rounded-lg overflow-hidden" />
</template>
