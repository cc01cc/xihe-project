<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { useToast } from '../../composables/useToast'
import ConfirmModal from '../shared/ConfirmModal.vue'
import BaseModal from '../shared/BaseModal.vue'

const props = defineProps<{
  path: string
  x: number
  y: number
}>()

const emit = defineEmits<{
  close: []
}>()

const ws = useWorkspaceStore()
const { success, error } = useToast()
const isDir = ref(false)
const showDeleteModal = ref(false)
const showNewFileModal = ref(false)
const deleteLoading = ref(false)
const newFileName = ref('')

onMounted(() => {
  isDir.value = !props.path.includes('.')
  document.addEventListener('click', handleOutsideClick)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleOutsideClick)
})

function handleOutsideClick() {
  emit('close')
}

function handleDelete() {
  showDeleteModal.value = true
}

function confirmDelete() {
  deleteLoading.value = true
  try {
    ws.deleteNode(props.path)
    success(`Deleted "${props.path}"`)
  } catch {
    error(`Failed to delete "${props.path}"`)
  }
  deleteLoading.value = false
}

function handleCopyPath() {
  navigator.clipboard.writeText(props.path)
  emit('close')
}

function handleNewFile() {
  newFileName.value = ''
  showNewFileModal.value = true
}

function confirmNewFile() {
  const name = newFileName.value.trim()
  if (!name) return
  const parentDir = isDir.value ? props.path : props.path.substring(0, props.path.lastIndexOf('/'))
  ws.createFile(parentDir, name)
  success(`Created "${name}"`)
  showNewFileModal.value = false
  emit('close')
}
</script>

<template>
  <div
    class="fixed z-50 min-w-40 py-1 rounded-lg border bg-popover text-popover-foreground shadow-md text-sm"
    :style="{ left: `${x}px`, top: `${y}px` }"
  >
    <button
      v-if="isDir"
      class="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-accent text-left"
      @click="handleNewFile"
    >
      <span class="i-lucide-file-plus size-3.5" />
      New File
    </button>
    <button
      class="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-accent text-left"
      @click="handleCopyPath"
    >
      <span class="i-lucide-copy size-3.5" />
      Copy Path
    </button>
    <hr class="my-1 border-t" />
    <button
      class="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-accent text-destructive text-left"
      @click="handleDelete"
    >
      <span class="i-lucide-trash-2 size-3.5" />
      Delete
    </button>
  </div>

  <ConfirmModal
    title="Confirm Delete"
    :description="`Delete &quot;${props.path}&quot;? This action cannot be undone.`"
    :show="showDeleteModal"
    :loading="deleteLoading"
    confirm-label="Delete"
    destructive
    @confirm="confirmDelete"
    @close="showDeleteModal = false; emit('close')"
  />

  <BaseModal title="New File" :show="showNewFileModal" @close="showNewFileModal = false; emit('close')">
    <label class="text-sm text-muted-foreground">File name:</label>
    <input
      v-model="newFileName"
      class="w-full mt-1 px-2 py-1 text-sm rounded border bg-background"
      placeholder="e.g. index.ts"
      autofocus
      @keyup.enter="confirmNewFile"
    />
    <p v-if="newFileName.trim() === '' && newFileName !== ''" class="text-xs text-destructive mt-1">
      Name cannot be empty
    </p>
    <div class="flex justify-end gap-2 mt-4">
      <button class="px-3 py-1.5 text-sm rounded border hover:bg-accent" @click="showNewFileModal = false; emit('close')">Cancel</button>
      <button
        class="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
        :disabled="!newFileName.trim()"
        @click="confirmNewFile"
      >Create</button>
    </div>
  </BaseModal>
</template>
