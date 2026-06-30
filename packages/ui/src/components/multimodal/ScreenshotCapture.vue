<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { logger } from '../../lib/logger'

const emit = defineEmits<{
  capture: [blob: Blob]
}>()

const { t } = useI18n()
const isCapturing = ref(false)
const isSupported = typeof window !== 'undefined' && 'getDisplayMedia' in navigator.mediaDevices

async function capture() {
  if (!isSupported) return
  isCapturing.value = true
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
    const track = stream.getVideoTracks()[0]
    const imageCapture = new ImageCapture(track)
    const bitmap = await imageCapture.grabFrame()
    track.stop()
    stream.getTracks().forEach((t) => t.stop())

    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    ctx?.drawImage(bitmap, 0, 0)
    canvas.toBlob((blob) => {
      if (blob) emit('capture', blob)
    }, 'image/png')
  } catch {
    logger.debug('Screenshot capture cancelled or failed')
  } finally {
    isCapturing.value = false
  }
}
</script>

<template>
  <button
    v-if="isSupported"
    class="p-1.5 rounded-md hover:bg-accent text-muted-foreground transition-colors"
    :title="t('multimodal.captureScreen')"
    :disabled="isCapturing"
    @click="capture"
  >
    <span class="i-lucide-camera size-4" />
  </button>
</template>
