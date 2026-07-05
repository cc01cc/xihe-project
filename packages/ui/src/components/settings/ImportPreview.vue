<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { logger } from '../../lib/logger'
import BaseModal from '../shared/BaseModal.vue'

const props = defineProps<{
  file?: File | null
}>()

const emit = defineEmits<{
  confirm: [data: ImportData]
  cancel: []
}>()

export interface ImportData {
  file: File
  chatCount: number
  messageCount: number
}

const { t } = useI18n()
const showModal = ref(false)
const importData = ref<ImportData | null>(null)
const previewError = ref<string | null>(null)
const parsing = ref(false)

watch(() => props.file, (file) => {
  if (!file) return
  parseFile(file)
}, { immediate: true })

async function parseFile(file: File) {
  parsing.value = true
  previewError.value = null
  try {
    const text = await file.text()
    const json = JSON.parse(text)
    const chats = json.chats
    if (!Array.isArray(chats)) throw new Error('Invalid import format: missing chats array')
    let messageCount = 0
    for (const chat of chats) {
      messageCount += (chat.messages?.length ?? 0)
    }
    importData.value = { file, chatCount: chats.length, messageCount }
    showModal.value = true
  } catch (e) {
    logger.warn('Import file parse failed: ' + (e instanceof Error ? e.message : String(e)))
    previewError.value = e instanceof Error ? e.message : 'Failed to parse file'
  }
  parsing.value = false
}

function handleConfirm() {
  if (!importData.value) return
  emit('confirm', importData.value)
  showModal.value = false
  importData.value = null
}

function handleCancel() {
  showModal.value = false
  importData.value = null
  emit('cancel')
}
</script>

<template>
  <div>
    <template v-if="parsing">
      <p class="text-xs text-muted-foreground">Parsing...</p>
    </template>
    <p v-else-if="previewError" class="text-xs text-destructive">{{ previewError }}</p>

    <BaseModal :show="showModal" :title="t('settings.importPreview')" @close="handleCancel">
      <div v-if="importData" class="space-y-2 text-sm">
        <div class="flex justify-between">
          <span class="text-muted-foreground">File</span>
          <span>{{ importData.file.name }}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-muted-foreground">Size</span>
          <span>{{ (importData.file.size / 1024).toFixed(1) }} KB</span>
        </div>
        <div class="border-t my-2" />
        <div class="flex justify-between">
          <span class="text-muted-foreground">Chat sessions</span>
          <span>{{ importData.chatCount }}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-muted-foreground">Messages</span>
          <span>{{ importData.messageCount }}</span>
        </div>
      </div>

      <div class="flex justify-end gap-2 pt-4">
        <button
          class="px-3 py-1.5 rounded text-xs border bg-background hover:bg-muted transition-colors"
          @click="handleCancel"
        >{{ t('common.cancel') }}</button>
        <button
          class="px-3 py-1.5 rounded text-xs bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          @click="handleConfirm"
        >{{ t('common.confirm') }}</button>
      </div>
    </BaseModal>
  </div>
</template>
