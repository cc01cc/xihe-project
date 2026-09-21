<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
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
import { Button } from '../ui/button'
import { LoaderCircle } from '@lucide/vue'
import { Input } from '../ui/input'
import RadioGroup from '../ui/radio-group/RadioGroup.vue'
import RadioGroupItem from '../ui/radio-group/RadioGroupItem.vue'

const props = withDefaults(defineProps<{
  open: boolean
}>(), {
  open: false,
})

const emit = defineEmits<{
  close: []
  created: [workspaceId: string]
}>()
const { t } = useI18n()

const auth = useAuthStore()
const name = ref('')
const description = ref('')
const profile = ref<'strict' | 'coding' | 'isolated'>('coding')
const storageMode = ref<'managed_import' | 'direct_attach'>('managed_import')
const executionMode = ref<'windows-mxc' | 'windows-host'>('windows-mxc')
const hostPath = ref('')
const directoryInput = ref<HTMLInputElement | null>(null)
const idempotencyKey = ref<string | null>(null)
const saving = ref(false)
const error = ref('')

const IMAGE_READONLY = 'xihe/workspace:latest'

const isDocker = computed(() => storageMode.value === 'managed_import')
const canSubmit = computed(() => {
  return name.value.trim().length > 0 &&
    (isDocker.value || hostPath.value.trim().length > 0) &&
    !saving.value
})

function chooseDirectory() {
  directoryInput.value?.click()
}

function handleDirectorySelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] as (File & { path?: string }) | undefined
  const selectedPath = file?.path?.trim()
  if (!selectedPath) {
    error.value = t('workspace.directoryPickerUnavailable')
    hostPath.value = ''
    return
  }
  hostPath.value = selectedPath
  error.value = ''
}

async function handleCreate() {
  if (!canSubmit.value) return
  saving.value = true
  error.value = ''
  idempotencyKey.value ??= globalThis.crypto.randomUUID()
  try {
    const ws = await api.createWorkspace({
      name: name.value.trim(),
      description: description.value.trim() || null,
      ...(isDocker.value ? { profile: profile.value } : {}),
      storageMode: storageMode.value,
      idempotencyKey: idempotencyKey.value,
      ...(isDocker.value ? {} : { hostPath: hostPath.value.trim(), executionMode: executionMode.value }),
    })
    auth.workspace = ws
    localStorage.setItem('xihe-workspace', JSON.stringify(ws))
    toast.success(`Workspace "${ws.name}" created`)
    emit('created', ws.id)
    emit('close')
    name.value = ''
    description.value = ''
    profile.value = 'coding'
    storageMode.value = 'managed_import'
    executionMode.value = 'windows-mxc'
    hostPath.value = ''
    idempotencyKey.value = null
    if (directoryInput.value) directoryInput.value.value = ''
  } catch (cause) {
    const message = cause instanceof ApiError ? cause.message : 'Failed to create workspace'
    logger.error('Create workspace failed', cause)
    error.value = message
    toast.error(message)
  } finally {
    saving.value = false
  }
}

function handleOpenChange(open: boolean) {
  if (!open) emit('close')
}
</script>

<template>
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogContent data-testid="workspace-create-dialog">
      <DialogHeader>
        <DialogTitle>Create workspace</DialogTitle>
        <DialogDescription>
          Creates workspace metadata only. The host directory and Sandbox are
          created on first use or via Prepare on the environment page.
        </DialogDescription>
      </DialogHeader>

      <div class="grid gap-4 py-2">
        <div class="grid gap-2">
          <label class="text-sm font-medium" for="ws-create-name">名称</label>
          <Input id="ws-create-name" v-model="name" placeholder="My Workspace" maxlength="120" />
        </div>
        <div class="grid gap-2">
          <label class="text-sm font-medium" for="ws-create-description">描述（可选）</label>
          <Input id="ws-create-description" v-model="description" placeholder="用于什么项目…" maxlength="500" />
        </div>
        <div class="grid gap-2">
          <span class="text-sm font-medium">{{ t('workspace.addStorageMode') }}</span>
          <RadioGroup v-model="storageMode" class="grid grid-cols-2 gap-2">
            <div>
              <RadioGroupItem id="ws-storage-managed" value="managed_import" class="peer sr-only" />
              <label for="ws-storage-managed" class="flex cursor-pointer flex-col rounded-md border-2 border-muted bg-popover p-3 text-center text-xs hover:bg-accent peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary">
                <span class="font-semibold text-sm">{{ t('workspace.managedImport') }}</span>
                <span class="mt-1 text-muted-foreground">{{ t('workspace.managedImportDesc') }}</span>
              </label>
            </div>
            <div>
              <RadioGroupItem id="ws-storage-direct" value="direct_attach" class="peer sr-only" />
              <label for="ws-storage-direct" class="flex cursor-pointer flex-col rounded-md border-2 border-muted bg-popover p-3 text-center text-xs hover:bg-accent peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary">
                <span class="font-semibold text-sm">{{ t('workspace.directAttach') }}</span>
                <span class="mt-1 text-muted-foreground">{{ t('workspace.directAttachDesc') }}</span>
              </label>
            </div>
          </RadioGroup>
        </div>
        <div v-if="!isDocker" class="grid gap-3 rounded-md border border-amber-500/40 bg-amber-50/60 p-3 dark:bg-amber-950/30">
          <div class="grid gap-2">
            <span class="text-sm font-medium">{{ t('workspace.hostDirectory') }}</span>
            <div class="flex gap-2">
              <Input :model-value="hostPath" readonly :placeholder="t('workspace.chooseDirectoryPlaceholder')" class="font-mono text-xs" />
              <Button type="button" variant="outline" class="shrink-0" @click="chooseDirectory">{{ t('workspace.chooseDirectory') }}</Button>
              <input ref="directoryInput" class="hidden" type="file" webkitdirectory directory @change="handleDirectorySelected" />
            </div>
            <p class="text-xs text-muted-foreground">{{ t('workspace.directAttachRuntimeHint') }}</p>
          </div>
          <div class="grid gap-2">
            <span class="text-sm font-medium">{{ t('workspace.executionBackend') }}</span>
            <RadioGroup v-model="executionMode" class="grid grid-cols-2 gap-2">
              <div>
                <RadioGroupItem id="ws-exec-mxc" value="windows-mxc" class="peer sr-only" />
                <label for="ws-exec-mxc" class="flex cursor-pointer flex-col rounded-md border-2 border-muted bg-popover p-3 text-center text-xs hover:bg-accent peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary">
                  <span class="font-semibold text-sm">{{ t('workspace.mxcBackend') }}</span>
                  <span class="mt-1 text-muted-foreground">{{ t('workspace.mxcBackendDesc') }}</span>
                </label>
              </div>
              <div>
                <RadioGroupItem id="ws-exec-host" value="windows-host" class="peer sr-only" />
                <label for="ws-exec-host" class="flex cursor-pointer flex-col rounded-md border-2 border-muted bg-popover p-3 text-center text-xs hover:bg-accent peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary">
                  <span class="font-semibold text-sm">{{ t('workspace.hostBackend') }}</span>
                  <span class="mt-1 text-muted-foreground">{{ t('workspace.hostBackendDesc') }}</span>
                </label>
              </div>
            </RadioGroup>
          </div>
        </div>
        <div v-if="isDocker" class="grid gap-2">
          <span class="text-sm font-medium">{{ t('workspace.sandboxProfile') }}</span>
          <RadioGroup v-model="profile" class="grid grid-cols-3 gap-2">
            <div>
              <RadioGroupItem id="ws-profile-coding" value="coding" class="peer sr-only" />
              <label
                for="ws-profile-coding"
                class="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-3 text-center text-xs hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary cursor-pointer"
              >
                <span class="font-semibold text-sm">Coding</span>
                <span class="text-muted-foreground mt-1">容器 · 可联网 · 可执行命令</span>
              </label>
            </div>
            <div>
              <RadioGroupItem id="ws-profile-strict" value="strict" class="peer sr-only" />
              <label
                for="ws-profile-strict"
                class="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-3 text-center text-xs hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary cursor-pointer"
              >
                <span class="font-semibold text-sm">Strict</span>
                <span class="text-muted-foreground mt-1">无容器 · 断网 · 仅文件</span>
              </label>
            </div>
            <div>
              <RadioGroupItem id="ws-profile-isolated" value="isolated" class="peer sr-only" />
              <label
                for="ws-profile-isolated"
                class="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-3 text-center text-xs hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary cursor-pointer"
              >
                <span class="font-semibold text-sm">Isolated</span>
                <span class="text-muted-foreground mt-1">容器 · 只读系统盘</span>
              </label>
            </div>
          </RadioGroup>
        </div>
        <div v-if="isDocker" class="grid gap-2">
          <span class="text-sm font-medium">沙盒镜像（白名单管理）</span>
          <div class="flex items-center justify-between rounded-md border border-dashed px-3 py-2 font-mono text-xs text-muted-foreground">
            <span>{{ IMAGE_READONLY }}</span>
            <span title="Image is allowlisted by the server">🔒 只读</span>
          </div>
        </div>
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="emit('close')">取消</Button>
        <Button :disabled="!canSubmit" @click="handleCreate">
           <LoaderCircle v-if="saving" class="mr-1 inline-block size-3 animate-spin" aria-hidden="true" />
          创建
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
