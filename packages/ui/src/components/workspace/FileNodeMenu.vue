<script setup lang="ts">
import { ref, computed } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { toast } from 'vue-sonner'
import type { FileNode } from '../../types'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../ui/context-menu'
import { ClipboardCopy, CopyPlus, FilePlus, FolderInput, FolderPlus, Pencil, Trash2 } from '@lucide/vue'
import BaseModal from '../shared/BaseModal.vue'

const props = defineProps<{
  node: FileNode
}>()

const ws = useWorkspaceStore()
const showRenameModal = ref(false)
const showMoveModal = ref(false)
const showNewFileModal = ref(false)
const showNewDirModal = ref(false)
const showDeleteModal = ref(false)
const opLoading = ref(false)
const nameInput = ref('')
const moveTarget = ref('')
const opError = ref('')

const isDir = computed(() => props.node.type === 'directory')
const parentDir = computed(() => {
  const i = props.node.path.lastIndexOf('/')
  return i >= 0 ? props.node.path.substring(0, i) : ''
})

function resetOp() {
  nameInput.value = ''
  moveTarget.value = ''
  opError.value = ''
  opLoading.value = false
}

function openRename() {
  resetOp()
  nameInput.value = props.node.name
  showRenameModal.value = true
}

function openMove() {
  resetOp()
  moveTarget.value = parentDir.value
  showMoveModal.value = true
}

function openNewFile() {
  resetOp()
  showNewFileModal.value = true
}

function openNewDir() {
  resetOp()
  showNewDirModal.value = true
}

async function confirmRename() {
  const name = nameInput.value.trim()
  if (!name) return
  opLoading.value = true
  try {
    const ok = await ws.renameNode(props.node.path, name)
    if (ok) {
      toast.success(`Renamed to "${name}"`)
      showRenameModal.value = false
    } else {
      opError.value = ws.treeError ?? 'Rename failed'
    }
  } finally {
    opLoading.value = false
  }
}

async function confirmMove() {
  opLoading.value = true
  try {
    const ok = await ws.moveNode(props.node.path, moveTarget.value.trim())
    if (ok) {
      toast.success(`Moved to "${moveTarget.value.trim() || '/'}"`)
      showMoveModal.value = false
    } else {
      opError.value = ws.treeError ?? 'Move failed'
    }
  } finally {
    opLoading.value = false
  }
}

async function confirmDuplicate() {
  opLoading.value = true
  try {
    const ok = await ws.duplicateNode(props.node.path)
    if (ok) toast.success('Duplicated')
    else toast.error(ws.treeError ?? 'Duplicate failed')
  } finally {
    opLoading.value = false
  }
}

async function confirmNewFile() {
  const name = nameInput.value.trim()
  if (!name) return
  opLoading.value = true
  try {
    const ok = await ws.createFile(isDir.value ? props.node.path : parentDir.value, name)
    if (ok) {
      toast.success(`Created "${name}"`)
      showNewFileModal.value = false
    } else {
      opError.value = ws.treeError ?? 'Create failed'
    }
  } finally {
    opLoading.value = false
  }
}

async function confirmNewDir() {
  const name = nameInput.value.trim()
  if (!name) return
  opLoading.value = true
  try {
    const ok = await ws.createDirectory(isDir.value ? props.node.path : parentDir.value, name)
    if (ok) {
      toast.success(`Created directory "${name}"`)
      showNewDirModal.value = false
    } else {
      opError.value = ws.treeError ?? 'Create directory failed'
    }
  } finally {
    opLoading.value = false
  }
}

async function confirmDelete() {
  opLoading.value = true
  try {
    const ok = await ws.deleteNode(props.node.path)
    if (ok) {
      toast.success(`Deleted "${props.node.path}"`)
      showDeleteModal.value = false
    } else {
      opError.value = ws.treeError ?? 'Delete failed'
      toast.error(ws.treeError ?? 'Delete failed')
    }
  } finally {
    opLoading.value = false
  }
}

function copyPath() {
  navigator.clipboard.writeText(props.node.path)
}
</script>

<template>
  <ContextMenu>
    <ContextMenuTrigger as-child>
      <slot />
    </ContextMenuTrigger>
    <ContextMenuContent data-testid="file-context-menu">
      <template v-if="!isDir">
        <ContextMenuItem @select="openRename">
           <Pencil class="size-3.5" aria-hidden="true" />
          Rename
        </ContextMenuItem>
        <ContextMenuItem @select="openMove">
           <FolderInput class="size-3.5" aria-hidden="true" />
          Move to…
        </ContextMenuItem>
        <ContextMenuItem @select="() => void confirmDuplicate()">
           <CopyPlus class="size-3.5" aria-hidden="true" />
          Duplicate
        </ContextMenuItem>
        <ContextMenuSeparator />
      </template>
      <template v-else>
        <ContextMenuItem @select="openNewFile">
           <FilePlus class="size-3.5" aria-hidden="true" />
          New File
        </ContextMenuItem>
        <ContextMenuItem @select="openNewDir">
           <FolderPlus class="size-3.5" aria-hidden="true" />
          New Directory
        </ContextMenuItem>
        <ContextMenuItem @select="openRename">
           <Pencil class="size-3.5" aria-hidden="true" />
          Rename
        </ContextMenuItem>
        <ContextMenuItem @select="openMove">
           <FolderInput class="size-3.5" aria-hidden="true" />
          Move to…
        </ContextMenuItem>
        <ContextMenuSeparator />
      </template>
      <ContextMenuItem @select="copyPath">
         <ClipboardCopy class="size-3.5" aria-hidden="true" />
        Copy Path
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" @select="showDeleteModal = true">
         <Trash2 class="size-3.5" aria-hidden="true" />
        Delete…
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>

  <BaseModal title="Rename" :show="showRenameModal" @close="showRenameModal = false">
    <label class="text-sm text-muted-foreground">New name:</label>
    <input v-model="nameInput" class="w-full mt-1 px-2 py-1 text-sm rounded border bg-background" @keyup.enter="() => void confirmRename()" />
    <p v-if="opError" class="text-xs text-destructive mt-1">{{ opError }}</p>
    <div class="flex justify-end gap-2 mt-4">
      <button class="px-3 py-1.5 text-sm rounded border hover:bg-accent" @click="showRenameModal = false">Cancel</button>
      <button class="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50" :disabled="!nameInput.trim() || opLoading" @click="() => void confirmRename()">Rename</button>
    </div>
  </BaseModal>

  <BaseModal title="Move" :show="showMoveModal" @close="showMoveModal = false">
    <label class="text-sm text-muted-foreground">Target directory (empty = workspace root):</label>
    <input v-model="moveTarget" class="w-full mt-1 px-2 py-1 text-sm rounded border bg-background font-mono" placeholder="e.g. src/docs" @keyup.enter="() => void confirmMove()" />
    <p v-if="opError" class="text-xs text-destructive mt-1">{{ opError }}</p>
    <div class="flex justify-end gap-2 mt-4">
      <button class="px-3 py-1.5 text-sm rounded border hover:bg-accent" @click="showMoveModal = false">Cancel</button>
      <button class="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50" :disabled="opLoading" @click="() => void confirmMove()">Move</button>
    </div>
  </BaseModal>

  <BaseModal title="New File" :show="showNewFileModal" @close="showNewFileModal = false">
    <label class="text-sm text-muted-foreground">File name:</label>
    <input v-model="nameInput" class="w-full mt-1 px-2 py-1 text-sm rounded border bg-background" placeholder="e.g. index.ts" @keyup.enter="() => void confirmNewFile()" />
    <p v-if="opError" class="text-xs text-destructive mt-1">{{ opError }}</p>
    <div class="flex justify-end gap-2 mt-4">
      <button class="px-3 py-1.5 text-sm rounded border hover:bg-accent" @click="showNewFileModal = false">Cancel</button>
      <button class="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50" :disabled="!nameInput.trim() || opLoading" @click="() => void confirmNewFile()">Create</button>
    </div>
  </BaseModal>

  <BaseModal title="New Directory" :show="showNewDirModal" @close="showNewDirModal = false">
    <label class="text-sm text-muted-foreground">Directory name:</label>
    <input v-model="nameInput" class="w-full mt-1 px-2 py-1 text-sm rounded border bg-background" placeholder="e.g. assets" @keyup.enter="() => void confirmNewDir()" />
    <p v-if="opError" class="text-xs text-destructive mt-1">{{ opError }}</p>
    <div class="flex justify-end gap-2 mt-4">
      <button class="px-3 py-1.5 text-sm rounded border hover:bg-accent" @click="showNewDirModal = false">Cancel</button>
      <button class="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50" :disabled="!nameInput.trim() || opLoading" @click="() => void confirmNewDir()">Create</button>
    </div>
  </BaseModal>

  <BaseModal title="Confirm Delete" :show="showDeleteModal" @close="showDeleteModal = false">
    <p class="text-sm">Delete "{{ props.node.path }}"? This action cannot be undone.</p>
    <p v-if="opError" class="text-xs text-destructive mt-1">{{ opError }}</p>
    <div class="flex justify-end gap-2 mt-4">
      <button class="px-3 py-1.5 text-sm rounded border hover:bg-accent" @click="showDeleteModal = false">Cancel</button>
      <button class="px-3 py-1.5 text-sm rounded bg-destructive text-destructive-foreground hover:opacity-90 disabled:opacity-50" :disabled="opLoading" @click="() => void confirmDelete()">Delete</button>
    </div>
  </BaseModal>
</template>
