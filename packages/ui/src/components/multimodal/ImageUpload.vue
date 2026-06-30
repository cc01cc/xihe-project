<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { logger } from '../../lib/logger'

const emit = defineEmits<{
  upload: [files: File[]]
}>()

const { t } = useI18n()
const isDragOver = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

function maxDimension(file: File, maxSize: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      let { width, height } = img
      if (width <= maxSize && height <= maxSize) {
        resolve(file)
        return
      }
      if (width > height) {
        height = (height / width) * maxSize
        width = maxSize
      } else {
        width = (width / height) * maxSize
        height = maxSize
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) { resolve(file); return }
      ctx.drawImage(img, 0, 0, width, height)
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else resolve(file)
      }, file.type, 0.85)
    }
    img.onerror = () => reject(new Error('Image load failed'))
    img.src = url
  })
}

async function handleFiles(files: FileList | File[]) {
  const imageFiles: File[] = []
  for (const file of Array.from(files)) {
    if (file.type.startsWith('image/')) {
      try {
        const compressed = await maxDimension(file, 2048)
        imageFiles.push(new File([compressed], file.name, { type: file.type }))
      } catch {
        logger.warn('Image resize failed, using original: ' + file.name)
        imageFiles.push(file)
      }
    } else {
      imageFiles.push(file)
    }
  }
  emit('upload', imageFiles)
}

function handleDrop(e: DragEvent) {
  isDragOver.value = false
  if (e.dataTransfer?.files.length) {
    handleFiles(e.dataTransfer.files)
  }
}

function handleInputChange(e: Event) {
  const target = e.target as HTMLInputElement
  if (target.files?.length) {
    handleFiles(target.files)
    target.value = ''
  }
}
</script>

<template>
  <div>
    <div
      class="relative"
      @dragover.prevent="isDragOver = true"
      @dragleave="isDragOver = false"
      @drop.prevent="handleDrop"
    >
      <button
        class="p-1.5 rounded-md hover:bg-accent text-muted-foreground transition-colors"
        :title="t('chat.image')"
        @click="fileInput?.click()"
      >
        <span class="i-lucide-image size-4" />
      </button>
      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        multiple
        class="hidden"
        @change="handleInputChange"
      />
    </div>

    <div
      v-if="isDragOver"
      class="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
    >
      <div class="p-8 rounded-2xl border-2 border-dashed border-primary bg-card">
        <p class="text-lg font-medium">{{ t('multimodal.dropImage') }}</p>
      </div>
    </div>
  </div>
</template>
