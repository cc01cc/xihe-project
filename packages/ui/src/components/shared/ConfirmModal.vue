<script setup lang="ts">
import { ref } from 'vue'
import BaseModal from './BaseModal.vue'

defineProps<{
  title: string
  description?: string
  show: boolean
  loading?: boolean
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}>()

const emit = defineEmits<{
  confirm: []
  cancel: []
  close: []
}>()

const autoCloseTimer = ref<ReturnType<typeof setTimeout> | null>(null)
const succeeded = ref(false)

function onConfirm() {
  succeeded.value = true
  emit('confirm')
  autoCloseTimer.value = setTimeout(() => {
    emit('close')
    succeeded.value = false
  }, 1500)
}

function onCancel() {
  emit('cancel')
  emit('close')
}

function onClose() {
  if (autoCloseTimer.value) clearTimeout(autoCloseTimer.value)
  succeeded.value = false
  emit('close')
}
</script>

<template>
  <BaseModal :show="show" @close="onClose">
    <h3 class="text-base font-semibold mb-2">{{ title }}</h3>
    <p v-if="description" class="text-sm text-muted-foreground mb-4">{{ description }}</p>

    <div v-if="succeeded" class="flex items-center gap-2 text-sm text-green-600 dark:text-green-400 mb-4">
      <span class="i-lucide-check-circle size-4" />
      <span>Operation completed</span>
    </div>

    <div class="flex justify-end gap-2 pt-2">
      <button
        v-if="!succeeded"
        class="px-3 py-1.5 text-sm rounded border hover:bg-accent transition-colors"
        @click="onCancel"
      >
        {{ cancelLabel || 'Cancel' }}
      </button>
      <button
        v-if="!succeeded"
        class="px-3 py-1.5 text-sm rounded transition-colors"
        :class="destructive
          ? 'bg-destructive text-destructive-foreground hover:opacity-90'
          : 'bg-primary text-primary-foreground hover:opacity-90'"
        :disabled="loading"
        @click="onConfirm"
      >
        <span v-if="loading" class="i-lucide-loader-circle size-3 animate-spin inline-block mr-1" />
        {{ confirmLabel || 'Confirm' }}
      </button>
    </div>
  </BaseModal>
</template>
