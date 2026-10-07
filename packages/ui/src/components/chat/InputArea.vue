<script setup lang="ts">
import { ref, computed, markRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Send, Square, LoaderCircle } from '@lucide/vue'
import ImageUpload from '../multimodal/ImageUpload.vue'
import FileUpload from '../multimodal/FileUpload.vue'
import ScreenshotCapture from '../multimodal/ScreenshotCapture.vue'
import VoiceInput from '../multimodal/VoiceInput.vue'
import ModelPopover from './ModelPopover.vue'
import InputToolbar, { type ToolbarAction } from './InputToolbar.vue'
import { uploadAttachments, validateAttachment } from '../../services/attachmentService'
import type { AttachmentFile } from '../../types'

interface SlashCommand {
  key: string
  label: string
  description: string
  action: () => string
}

const URL = window.URL

const props = defineProps<{
  sessionId: string
  isStreaming?: boolean
  queueMode?: boolean
  queueFull?: boolean
  queuePaused?: boolean
  queueSubmitting?: boolean
  queueActionBusy?: boolean
}>()

const emit = defineEmits<{
  send: [content: string, attachments?: AttachmentFile[]]
  queue: [content: string, attachments?: AttachmentFile[]]
  stop: []
}>()

const { t } = useI18n()
const input = ref('')
const isComposing = ref(false)
const attachments = ref<File[]>([])
let uploadedByFile = new WeakMap<File, Map<string, AttachmentFile>>()
const attachmentErrors = ref<Record<string, string>>({})
const showSlashMenu = ref(false)
const slashFilter = ref('')
const selectedSlashIndex = ref(0)
const isUploading = ref(false)

const slashCommands: SlashCommand[] = [
  { key: '/search', label: '/search', description: 'Search messages', action: () => '' },
  { key: '/clear', label: '/clear', description: 'Clear conversation', action: () => '' },
  { key: '/export', label: '/export', description: 'Export chat history', action: () => 'Export the current conversation as JSON' },
  { key: '/help', label: '/help', description: 'Show available commands', action: () => 'Available commands: /search, /clear, /export, /help' },
]

const filteredCommands = computed(() => {
  if (!slashFilter.value) return slashCommands
  return slashCommands.filter((c) => c.key.includes(slashFilter.value.toLowerCase()))
})

const sendDisabled = computed(() => {
  if (props.queueMode) {
    return !input.value.trim()
      || Boolean(props.queueFull)
      || Boolean(props.queueSubmitting)
      || Boolean(props.queueActionBusy)
  }
  return !input.value.trim() && attachments.value.length === 0
})

const toolbarActions = computed<ToolbarAction[]>(() => [
  {
    key: 'model',
    position: 'left',
    component: markRaw(ModelPopover),
  },
  {
    key: 'image',
    position: 'left',
    component: markRaw(ImageUpload),
    props: { onUpload: addAttachment },
  },
  {
    key: 'file',
    position: 'left',
    component: markRaw(FileUpload),
    props: { onUpload: addAttachment },
  },
  {
    key: 'screenshot',
    position: 'left',
    component: markRaw(ScreenshotCapture),
    props: { onCapture: addAttachmentBlob },
  },
  {
    key: 'voice',
    position: 'left',
    component: markRaw(VoiceInput),
    props: { onTranscript: handleTranscript },
  },
  {
    key: props.isStreaming ? 'stop' : 'send',
    position: 'right',
    component: 'button',
    props: {
      class: 'shrink-0 size-8 flex items-center justify-center rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity',
      disabled: props.isStreaming ? false : sendDisabled.value,
      'data-testid': props.isStreaming ? 'chat-stop-button' : 'chat-send-button',
      'aria-label': props.isStreaming ? t('chat.stop') : t('chat.send'),
      onClick: props.isStreaming ? stopInput : handleSend,
    },
    icon: markRaw(props.isStreaming ? Square : Send),
    visible: props.isStreaming || !props.queueMode,
  },
])

async function handleSend() {
  const text = input.value.trim()
  if (sendDisabled.value || isUploading.value || props.queueSubmitting || props.queueActionBusy) return
  const uploadSessionId = props.sessionId

  if (attachments.value.length > 0) {
    const filesToUpload = attachments.value.filter((file) => !uploadedByFile.get(file)?.has(uploadSessionId))
    if (filesToUpload.length > 0) {
      isUploading.value = true
      attachmentErrors.value = {}
      try {
        const { success, failed } = await uploadAttachments(uploadSessionId, filesToUpload)
        if (props.sessionId !== uploadSessionId) return
        if (failed.length > 0) {
          for (const item of failed) {
            attachmentErrors.value[item.name] = item.reason
            toast.error(`${item.name}: ${item.reason}`)
          }
        }
        const matchedFiles = new Set<File>()
        for (const uploaded of success) {
          const file = filesToUpload.find((candidate) =>
            !matchedFiles.has(candidate)
            && candidate.name === uploaded.name
            && candidate.size === uploaded.size
            && candidate.type === uploaded.type)
            ?? filesToUpload.find((candidate) => !matchedFiles.has(candidate) && candidate.name === uploaded.name)
          if (file) {
            const bySession = uploadedByFile.get(file) ?? new Map<string, AttachmentFile>()
            bySession.set(uploadSessionId, uploaded)
            uploadedByFile.set(file, bySession)
            matchedFiles.add(file)
          }
        }
      } finally {
        isUploading.value = false
      }
    }
  }

  const uploaded = attachments.value
    .map((file) => uploadedByFile.get(file)?.get(uploadSessionId))
    .filter((attachment): attachment is AttachmentFile => attachment !== undefined)
  if (attachments.value.length > 0 && uploaded.length === 0) return
  if (props.queueMode) emit('queue', text, uploaded.length > 0 ? uploaded : undefined)
  else emit('send', text, uploaded.length > 0 ? uploaded : undefined)
}

function stopInput() {
  emit('stop')
}

function executeSlash(cmd: SlashCommand) {
  const result = cmd.action()
  showSlashMenu.value = false
  if (result) {
    handleSendText(result)
    return
  }
  if (cmd.key === '/clear') {
    input.value = ''
    showSlashMenu.value = false
  }
}

function handleSendText(text: string) {
  if (props.queueMode) emit('queue', text)
  else emit('send', text)
}

function handleKeydown(e: KeyboardEvent) {
  if (showSlashMenu.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectedSlashIndex.value = (selectedSlashIndex.value + 1) % filteredCommands.value.length
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectedSlashIndex.value = selectedSlashIndex.value > 0
        ? selectedSlashIndex.value - 1
        : filteredCommands.value.length - 1
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      if (filteredCommands.value[selectedSlashIndex.value]) {
        executeSlash(filteredCommands.value[selectedSlashIndex.value])
      }
      return
    }
    if (e.key === 'Escape') {
      showSlashMenu.value = false
      return
    }
  }

  if (e.key === 'Enter' && !e.shiftKey && !isComposing.value) {
    e.preventDefault()
    if (props.queueMode) {
      handleSend()
    } else if (props.isStreaming) {
      stopInput()
    } else {
      handleSend()
    }
  }
}

function handleInput() {
  const val = input.value
  if (val === '/') {
    showSlashMenu.value = true
    slashFilter.value = ''
    selectedSlashIndex.value = 0
  } else if (val.startsWith('/') && !val.includes(' ')) {
    showSlashMenu.value = true
    slashFilter.value = val.slice(1)
    selectedSlashIndex.value = 0
  } else if (val.includes(' ')) {
    showSlashMenu.value = false
  }
}

function addAttachment(files: File[]) {
  const validFiles: File[] = []
  for (const file of files) {
    const validation = validateAttachment(file)
    if (!validation.valid) {
      toast.error(`${file.name}: ${validation.reason}`)
      continue
    }
    validFiles.push(file)
  }
  attachments.value.push(...validFiles)
}

function addAttachmentBlob(blob: Blob) {
  const file = new File([blob], 'capture.png', { type: 'image/png' })
  addAttachment([file])
}

function removeAttachment(index: number) {
  const file = attachments.value[index]
  if (file) {
    const nextErrors = { ...attachmentErrors.value }
    delete nextErrors[file.name]
    attachmentErrors.value = nextErrors
  }
  attachments.value.splice(index, 1)
}

function handleTranscript(text: string) {
  input.value += text
}

function attachmentObjectUrl(file: File): string {
  return URL.createObjectURL(file)
}

function clearDraft() {
  input.value = ''
  attachments.value = []
  uploadedByFile = new WeakMap<File, Map<string, AttachmentFile>>()
  attachmentErrors.value = {}
}

defineExpose({ clearDraft })
</script>

<template>
  <div class="min-w-0 border-t bg-background px-4 py-3">
    <div class="mx-auto w-full max-w-4xl space-y-2">
      <p
        v-if="queueMode"
        class="px-2 text-[11px] text-muted-foreground"
        role="status"
        data-testid="follow-up-composer-notice"
      >
        {{ queueFull ? t('chat.followUpFullNotice') : queuePaused ? t('chat.followUpPausedNotice') : t('chat.followUpComposerNotice') }}
      </p>
      <div
        v-if="attachments.length"
        class="flex gap-2 flex-wrap"
      >
        <div
          v-for="(file, i) in attachments"
          :key="file.name + i"
          class="relative group"
          data-testid="selected-attachment"
        >
          <div
            class="relative flex h-16 w-16 items-center justify-center overflow-hidden rounded border bg-muted/30 text-xs text-muted-foreground"
            :class="attachmentErrors[file.name] ? 'border-destructive' : ''"
          >
            <img
              v-if="file.type.startsWith('image/')"
              :src="attachmentObjectUrl(file)"
              class="w-full h-full object-cover"
            />
            <span
              v-else
              class="p-1"
            >{{ file.name }}</span>
            <span
              v-if="attachmentErrors[file.name]"
              class="absolute inset-x-0 bottom-0 bg-destructive px-1 py-0.5 text-center text-[9px] font-medium text-destructive-foreground"
            >{{ t('multimodal.uploadFailed') }}</span>
          </div>
          <button
            class="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-destructive text-destructive-foreground text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
            data-testid="remove-attachment-button"
            @click="removeAttachment(i)"
          >×</button>
          <div
            v-if="attachmentErrors[file.name]"
            data-testid="attachment-upload-error"
            class="mt-1 w-16 space-y-1 text-[10px] text-destructive"
          >
            <span class="block truncate" :title="attachmentErrors[file.name]">{{ t('multimodal.uploadFailed') }}</span>
            <div class="flex gap-1">
              <button
                type="button"
                data-testid="attachment-retry-button"
                class="font-medium underline underline-offset-2 hover:no-underline"
                @click="handleSend"
              >{{ t('common.retry') }}</button>
              <button
                type="button"
                data-testid="attachment-error-remove-button"
                class="font-medium underline underline-offset-2 hover:no-underline"
                @click="removeAttachment(i)"
              >{{ t('settings.removeServer') }}</button>
            </div>
          </div>
        </div>
      </div>

      <div class="relative">
        <div
          v-if="showSlashMenu && filteredCommands.length"
          class="absolute bottom-full left-0 mb-2 w-56 rounded-lg border bg-popover shadow-lg overflow-hidden"
        >
          <div class="px-2 py-1 text-xs text-muted-foreground border-b">Commands</div>
          <button
            v-for="(cmd, i) in filteredCommands"
            :key="cmd.key"
            class="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent transition-colors"
            :class="i === selectedSlashIndex ? 'bg-accent' : ''"
            @click="executeSlash(cmd)"
          >
            <span class="font-medium">{{ cmd.key }}</span>
            <span class="text-xs text-muted-foreground ml-auto">{{ cmd.description }}</span>
          </button>
        </div>
      </div>

      <div
        class="rounded-2xl border bg-card p-2 shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-ring"
      >
        <textarea
          v-model="input"
          data-testid="chat-input"
          class="w-full min-h-[44px] max-h-[200px] px-2 py-2 bg-transparent resize-none text-sm placeholder:text-muted-foreground focus:outline-none field-sizing-content"
          :placeholder="queueMode ? t('chat.followUpPlaceholder') : t('chat.placeholder')"
          rows="1"
          :style="{ fieldSizing: 'content' }"
          @compositionstart="isComposing = true"
          @compositionend="isComposing = false"
          @keydown="handleKeydown"
          @input="handleInput"
        />
        <div class="flex items-center gap-2">
          <InputToolbar :actions="toolbarActions" />
          <LoaderCircle
            v-if="isUploading"
            data-testid="attachment-uploading-indicator"
            class="size-4 shrink-0 animate-spin text-muted-foreground"
          />
          <button
            v-if="queueMode"
            type="button"
            data-testid="chat-queue-button"
            :aria-label="t('chat.followUpEnqueue')"
            :disabled="sendDisabled || isUploading || queueSubmitting || queueActionBusy"
            class="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            :class="queuePaused ? 'border border-border bg-background text-foreground hover:bg-accent' : 'bg-primary text-primary-foreground hover:opacity-90'"
            @click="handleSend"
          >
            <LoaderCircle v-if="queueSubmitting" class="size-3.5 animate-spin" />
            <Send v-else class="size-3.5" />
            <span>{{ queueSubmitting ? t('chat.followUpEnqueuing') : t('chat.followUpEnqueue') }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
