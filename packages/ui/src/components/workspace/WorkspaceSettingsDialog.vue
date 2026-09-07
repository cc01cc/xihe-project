<script setup lang="ts">
import { ref, watch } from 'vue'
import { useAuthStore } from '../../stores/auth'
import { api, ApiError } from '../../composables/api'
import { logger } from '../../lib/logger'
import { toast } from 'vue-sonner'
import Dialog from '../ui/dialog/Dialog.vue'
import DialogContent from '../ui/dialog/DialogContent.vue'
import DialogHeader from '../ui/dialog/DialogHeader.vue'
import DialogTitle from '../ui/dialog/DialogTitle.vue'
import DialogDescription from '../ui/dialog/DialogDescription.vue'
import DialogFooter from '../ui/dialog/DialogFooter.vue'
import AlertDialog from '../ui/alert-dialog/AlertDialog.vue'
import AlertDialogContent from '../ui/alert-dialog/AlertDialogContent.vue'
import AlertDialogHeader from '../ui/alert-dialog/AlertDialogHeader.vue'
import AlertDialogTitle from '../ui/alert-dialog/AlertDialogTitle.vue'
import AlertDialogDescription from '../ui/alert-dialog/AlertDialogDescription.vue'
import AlertDialogFooter from '../ui/alert-dialog/AlertDialogFooter.vue'
import AlertDialogCancel from '../ui/alert-dialog/AlertDialogCancel.vue'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { LoaderCircle } from '@lucide/vue'

const props = withDefaults(defineProps<{
  open: boolean
}>(), {
  open: false,
})

const emit = defineEmits<{
  close: []
  deleted: []
}>()

const auth = useAuthStore()
const name = ref('')
const description = ref('')
const saving = ref(false)
const error = ref('')
const confirmDeleteOpen = ref(false)
const deleteConfirmName = ref('')
const deleting = ref(false)
const deleteError = ref('')

watch(() => props.open, (open) => {
  if (open) {
    name.value = auth.workspace?.name ?? ''
    description.value = auth.workspace?.description ?? ''
    error.value = ''
    deleteConfirmName.value = ''
    deleteError.value = ''
    confirmDeleteOpen.value = false
  }
})

const storageRef = () => auth.workspace?.storageRef ?? auth.workspace?.id ?? ''

async function handleSave() {
  const ws = auth.workspace
  if (!ws || saving.value) return
  saving.value = true
  error.value = ''
  try {
    const updated = await api.updateWorkspace(ws.id, {
      name: name.value.trim() || undefined,
      description: description.value.trim(),
    })
    auth.workspace = updated
    localStorage.setItem('xihe-workspace', JSON.stringify(updated))
    toast.success('Workspace updated')
    emit('close')
  } catch (cause) {
    const message = cause instanceof ApiError ? cause.message : 'Failed to update workspace'
    logger.error('Update workspace failed', cause)
    error.value = message
    toast.error(message)
  } finally {
    saving.value = false
  }
}

async function handleDelete() {
  const ws = auth.workspace
  if (!ws || deleting.value) return
  if (deleteConfirmName.value.trim() !== (ws.name ?? '')) {
    deleteError.value = '请输入完整的工作区名称以确认删除'
    return
  }
  deleting.value = true
  deleteError.value = ''
  try {
    await api.deleteWorkspace(ws.id)
    auth.workspace = null
    localStorage.removeItem('xihe-workspace')
    confirmDeleteOpen.value = false
    toast.success(`Workspace "${ws.name}" deleted. Storage directory is preserved on the host.`)
    emit('deleted')
    emit('close')
  } catch (cause) {
    const message = cause instanceof ApiError ? cause.message : 'Failed to delete workspace'
    logger.error('Delete workspace failed', cause)
    deleteError.value = message
    toast.error(message)
  } finally {
    deleting.value = false
  }
}

function handleOpenChange(open: boolean) {
  if (!open) emit('close')
}
</script>

<template>
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogContent data-testid="workspace-settings-dialog">
      <DialogHeader>
        <DialogTitle>Workspace settings</DialogTitle>
        <DialogDescription>修改 workspace 信息或执行逻辑删除。</DialogDescription>
      </DialogHeader>

      <div class="grid gap-4 py-2">
        <p class="font-mono text-xs text-muted-foreground break-all" data-testid="workspace-settings-id">
          {{ auth.workspace?.id ?? '' }}
        </p>
        <div class="grid gap-2">
          <label class="text-sm font-medium" for="ws-settings-name">名称</label>
          <Input id="ws-settings-name" v-model="name" maxlength="120" />
        </div>
        <div class="grid gap-2">
          <label class="text-sm font-medium" for="ws-settings-description">描述</label>
          <Input id="ws-settings-description" v-model="description" maxlength="500" />
        </div>
        <div class="grid gap-2">
          <span class="text-sm font-medium">物理目录（派生，只读）</span>
          <div class="flex items-center justify-between rounded-md border border-dashed px-3 py-2 font-mono text-xs text-muted-foreground">
            <span class="truncate">…\.xihe-workspaces\{{ storageRef() }}</span>
            <span title="宿主机可用系统文件操作直接访问">宿主机可直访</span>
          </div>
        </div>
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
      </div>

      <DialogFooter class="sm:justify-between">
        <Button variant="destructive" @click="confirmDeleteOpen = true">删除…</Button>
        <div class="flex gap-2">
          <Button variant="outline" @click="emit('close')">取消</Button>
          <Button :disabled="saving" @click="handleSave">
             <LoaderCircle v-if="saving" class="mr-1 inline-block size-3 animate-spin" aria-hidden="true" />
            保存
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <AlertDialog :open="confirmDeleteOpen" @update:open="(v) => confirmDeleteOpen = v">
    <AlertDialogContent data-testid="workspace-delete-confirm">
      <AlertDialogHeader>
        <AlertDialogTitle class="text-destructive">删除 workspace？</AlertDialogTitle>
        <AlertDialogDescription>
          「{{ auth.workspace?.name }}」将被逻辑删除。
        </AlertDialogDescription>
      </AlertDialogHeader>
      <div class="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-6 text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
        · Runtime Sandbox 容器将被停止并移除<br />
        · WorkspaceStorage 物理目录<b>保留</b>在宿主机，可手动备份<br />
        · 会话与消息随工作区一并失效
      </div>
      <div class="grid gap-2">
        <label class="text-sm font-medium" for="ws-delete-confirm">输入工作区名称以确认</label>
        <Input id="ws-delete-confirm" v-model="deleteConfirmName" :placeholder="auth.workspace?.name ?? ''" />
        <p v-if="deleteError" class="text-sm text-destructive">{{ deleteError }}</p>
      </div>
      <AlertDialogFooter>
        <AlertDialogCancel>取消</AlertDialogCancel>
        <!-- Plain Button (not AlertDialogAction): validation failures and API
             errors must keep the confirm dialog open; only success closes it. -->
        <Button
          variant="destructive"
          :disabled="deleting"
          data-testid="workspace-delete-confirm-btn"
          @click="() => void handleDelete()"
        >
           <LoaderCircle v-if="deleting" class="mr-1 inline-block size-3 animate-spin" aria-hidden="true" />
          确认删除
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
