<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { logger } from '../../lib/logger'
import SettingsNav from '../../components/settings/SettingsNav.vue'
import BackToChatButton from '../../components/settings/BackToChatButton.vue'
import ImportPreview, { type ImportData } from '../../components/settings/ImportPreview.vue'
import { apiRaw } from '../../composables/api'

const { t } = useI18n()
const exporting = ref(false)
const importing = ref(false)
const importFile = ref<File | null>(null)
const showImportPreview = ref(false)
const result = ref<string | null>(null)

async function exportSettings() {
  exporting.value = true
  try {
    const res = await apiRaw('/config/export')
    const blob = await res.blob()
    downloadBlob(blob, 'xihe-settings.json')
  } catch (e) {
    logger.error(`Settings export failed: ${e instanceof Error ? e.message : String(e)}`)
    result.value = 'Export failed'
  }
  exporting.value = false
}

async function exportChats() {
  exporting.value = true
  try {
    const res = await apiRaw('/config/export')
    const blob = await res.blob()
    downloadBlob(blob, 'xihe-chats.json')
  } catch (e) {
    logger.error(`Chats export failed: ${e instanceof Error ? e.message : String(e)}`)
    result.value = 'Export failed'
  }
  exporting.value = false
}

function handleFileSelected(e: Event) {
  const files = (e.target as HTMLInputElement).files
  if (!files?.length) return
  importFile.value = files[0]
  showImportPreview.value = true
}

async function handleConfirmImport(data: ImportData) {
  importing.value = true
  try {
    const text = await data.file.text()
    const res = await apiRaw('/config/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: text,
    })
    const resultData = await res.json()
    result.value = `Imported: ${resultData.imported}, Skipped: ${resultData.skipped}`
  } catch (e) {
    logger.error(`Chats import failed: ${e instanceof Error ? e.message : String(e)}`)
    result.value = 'Import failed'
  }
  importing.value = false
  showImportPreview.value = false
}

function handleCancelImport() {
  showImportPreview.value = false
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <BackToChatButton />
  <SettingsNav />
  <div class="space-y-4">
    <h3 data-testid="settings-data-heading" class="font-medium">{{ t('settings.dataControls') }}</h3>

    <div class="space-y-2">
      <button
        class="w-full px-3 py-2 rounded text-xs border bg-background hover:bg-muted text-left transition-colors"
        :disabled="exporting"
        @click="exportSettings"
      >
        {{ t('settings.exportSettings') }}
      </button>
      <button
        class="w-full px-3 py-2 rounded text-xs border bg-background hover:bg-muted text-left transition-colors"
        :disabled="exporting"
        @click="exportChats"
      >
        {{ t('settings.exportChats') }}
      </button>
    </div>

    <div class="border-t pt-3 space-y-2">
      <button
        class="px-3 py-2 rounded text-xs border bg-background hover:bg-muted transition-colors"
        @click="($refs.fileInput as HTMLInputElement)?.click()"
      >
        {{ t('settings.import') }}
      </button>
      <input
        ref="fileInput"
        type="file"
        accept=".json"
        class="hidden"
        @change="handleFileSelected"
      />

      <ImportPreview
        v-if="showImportPreview"
        :file="importFile"
        @confirm="handleConfirmImport"
        @cancel="handleCancelImport"
      />
    </div>

    <p v-if="result" class="text-xs text-muted-foreground">{{ result }}</p>
  </div>
</template>
