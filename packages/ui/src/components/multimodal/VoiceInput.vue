<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { logger } from '../../lib/logger'

const emit = defineEmits<{
  transcript: [text: string]
}>()

const { t } = useI18n()
const isRecording = ref(false)
const recognitionText = ref('')
let recognition: SpeechRecognition | null = null
let isSupported = typeof window !== 'undefined' && (window.SpeechRecognition !== undefined || window.webkitSpeechRecognition !== undefined)

watch(isRecording, (val) => {
  if (val) startRecording()
  else stopRecording()
})

function startRecording() {
  if (!isSupported) return
  const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition
  if (!SR) return
  recognition = new SR()
  recognition.lang = 'zh-CN'
  recognition.interimResults = true
  recognition.continuous = true

  recognition.onresult = (event: SpeechRecognitionEvent) => {
    let final = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        final += event.results[i][0].transcript
      }
    }
    if (final) {
      recognitionText.value = final
      emit('transcript', final)
    }
  }

  recognition.onerror = (event: Event) => {
    logger.error('Speech recognition error: ' + (event instanceof ErrorEvent ? event.message : 'unknown'))
    isRecording.value = false
  }

  recognition.onend = () => {
    isRecording.value = false
  }

  recognition.start()
}

function stopRecording() {
  recognition?.stop()
  recognition = null
}

function toggleRecording() {
  isRecording.value = !isRecording.value
}
</script>

<template>
  <div v-if="isSupported" class="relative">
    <button
      class="p-1.5 rounded-md transition-colors"
      :class="isRecording ? 'bg-destructive/10 text-destructive animate-pulse' : 'hover:bg-accent text-muted-foreground'"
      :title="t('chat.voice')"
      @click="toggleRecording"
      @touchstart.prevent="toggleRecording"
    >
      <span class="i-lucide-mic size-4" />
    </button>
  </div>
</template>
