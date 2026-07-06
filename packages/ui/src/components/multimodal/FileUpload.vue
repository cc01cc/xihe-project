<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const emit = defineEmits<{
  upload: [files: File[]]
}>()

const { t } = useI18n()
const fileInput = ref<HTMLInputElement | null>(null)
const isDragOver = ref(false)

function handleInputChange(e: Event) {
  const target = e.target as HTMLInputElement
  if (target.files?.length) {
    emit('upload', Array.from(target.files))
    target.value = ''
  }
}

function handleDrop(e: DragEvent) {
  isDragOver.value = false
  if (e.dataTransfer?.files.length) {
    emit('upload', Array.from(e.dataTransfer.files))
  }
}
</script>

<template>
  <div
    class="relative"
    @dragover.prevent="isDragOver = true"
    @dragleave="isDragOver = false"
    @drop.prevent="handleDrop"
  >
    <button
      class="p-1.5 rounded-md hover:bg-accent text-muted-foreground transition-colors"
      :title="t('chat.attachFile')"
      @click="fileInput?.click()"
    >
      <span class="i-lucide-paperclip size-4" />
    </button>
    <input
      ref="fileInput"
      type="file"
      multiple
      class="hidden"
      data-testid="file-upload-input"
      @change="handleInputChange"
    />
  </div>
</template>
