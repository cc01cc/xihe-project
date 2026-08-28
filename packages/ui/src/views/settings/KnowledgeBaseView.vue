<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { logger } from '../../lib/logger'
import { apiDelete, apiGet, apiPost } from '../../composables/api'
import SettingsNav from '../../components/settings/SettingsNav.vue'
import BackToChatButton from '../../components/settings/BackToChatButton.vue'

const { t } = useI18n()
const files = ref<File[]>([])
const uploading = ref(false)
const loading = ref(false)
const loadError = ref<string | null>(null)
const documents = ref<Array<{ id: string; filename: string; chunks: number }>>([])

onMounted(async () => {
  await loadDocuments()
})

async function loadDocuments() {
  loading.value = true
  loadError.value = null
  try {
    const data = await apiGet<{ documents?: Array<{ id: string; filename: string; chunks: number }> }>('/rag/stats')
    documents.value = data.documents ?? []
  } catch (e) {
    logger.warn('Failed to load documents: ' + (e instanceof Error ? e.message : String(e)))
    loadError.value = e instanceof Error ? e.message : 'Failed to load documents'
  }
  loading.value = false
}

async function handleUpload() {
  if (!files.value.length) return
  uploading.value = true
  try {
    const form = new FormData()
    form.append('file', files.value[0])
    await apiPost('/rag/ingest', form)
    files.value = []
    await loadDocuments()
  } catch (e) {
    logger.warn('Document upload failed: ' + (e instanceof Error ? e.message : String(e)))
    loadError.value = e instanceof Error ? e.message : 'Upload failed'
  }
  uploading.value = false
}

async function removeDoc(id: string) {
  try {
    await apiDelete(`/rag/documents/${id}`)
    await loadDocuments()
  } catch (e) {
    logger.warn('Document delete failed: ' + (e instanceof Error ? e.message : String(e)))
    loadError.value = e instanceof Error ? e.message : 'Delete failed'
  }
}
</script>

<template>
  <BackToChatButton />
  <SettingsNav />
  <div class="space-y-4">
    <h3 data-testid="settings-knowledge-heading" class="font-medium">{{ t('settings.knowledgeBase') }}</h3>

    <div v-if="loading" class="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
      <span class="i-lucide-loader-circle size-4 animate-spin" />
      Loading documents...
    </div>

    <div v-else-if="loadError" class="flex flex-col items-center gap-2 py-8 text-sm text-destructive">
      <span class="i-lucide-alert-circle size-6" />
      <p>{{ loadError }}</p>
      <button class="text-xs text-primary hover:underline" @click="loadDocuments">Retry</button>
    </div>

    <div v-else>
      <div
        class="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:border-primary transition-colors"
        @click="($refs.fileInput as HTMLInputElement)?.click()"
      >
        <input
          ref="fileInput"
          type="file"
          accept=".pdf,.txt,.md"
          class="hidden"
          @change="files = Array.from(($event.target as HTMLInputElement).files || [])"
        />
        <svg class="w-8 h-8 mx-auto mb-2 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>
        <p class="text-sm text-muted-foreground">拖拽文件到此处或 <span class="text-primary underline">浏览</span></p>
        <p class="text-xs text-muted-foreground mt-1">支持 PDF / TXT / Markdown</p>
      </div>
      <button
        v-if="files.length"
        class="w-full px-3 py-2 rounded bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
        :disabled="uploading"
        @click="handleUpload"
      >
        {{ uploading ? t('common.uploading') : t('common.upload') }}
      </button>

      <div v-if="documents.length" class="space-y-1">
        <div v-for="doc in documents" :key="doc.id" class="flex items-center justify-between py-1 px-3 rounded bg-muted/50 text-sm">
          <span>{{ doc.filename }} ({{ doc.chunks }} chunks)</span>
          <button class="text-xs text-destructive hover:underline" @click="removeDoc(doc.id)">{{ t('common.delete') }}</button>
        </div>
      </div>
      <p v-else-if="!loading" class="text-xs text-muted-foreground text-center py-8">{{ t('settings.noDocuments') }}</p>
    </div>
  </div>
</template>
