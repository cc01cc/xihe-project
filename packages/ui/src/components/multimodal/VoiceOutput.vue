<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Volume2, VolumeX } from '@lucide/vue'
import { logger } from '../../lib/logger'

const props = defineProps<{
  text: string
}>()

const { t } = useI18n()
const isSpeaking = ref(false)
let utterance: SpeechSynthesisUtterance | null = null
const isSupported = typeof window !== 'undefined' && 'speechSynthesis' in window

function speak() {
  if (!isSupported || !props.text) return
  window.speechSynthesis.cancel()
  utterance = new SpeechSynthesisUtterance(props.text)
  utterance.lang = 'zh-CN'
  utterance.rate = 1.0
  utterance.onstart = () => { isSpeaking.value = true }
  utterance.onend = () => { isSpeaking.value = false }
  utterance.onerror = (event: Event) => {
    logger.warn('TTS utterance failed: ' + (event instanceof SpeechSynthesisErrorEvent ? event.error : 'unknown'))
    isSpeaking.value = false
  }
  window.speechSynthesis.speak(utterance)
}

function stop() {
  window.speechSynthesis.cancel()
  isSpeaking.value = false
}
</script>

<template>
  <button
    v-if="isSupported && text"
    class="p-1.5 rounded-md hover:bg-accent text-muted-foreground transition-colors"
    :title="t('multimodal.speak')"
    @click="isSpeaking ? stop() : speak()"
  >
    <VolumeX v-if="isSpeaking" class="size-4" aria-hidden="true" />
    <Volume2 v-else class="size-4" aria-hidden="true" />
  </button>
</template>
