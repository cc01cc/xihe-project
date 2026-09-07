<script setup lang="ts">
import { ref, computed } from 'vue'
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

const auth = useAuthStore()
const name = ref('')
const description = ref('')
const profile = ref<'strict' | 'coding' | 'isolated'>('coding')
const saving = ref(false)
const error = ref('')

const IMAGE_READONLY = 'xihe/workspace:latest'

const canSubmit = computed(() => name.value.trim().length > 0 && !saving.value)

async function handleCreate() {
  if (!canSubmit.value) return
  saving.value = true
  error.value = ''
  try {
    const ws = await api.createWorkspace({
      name: name.value.trim(),
      description: description.value.trim() || null,
      profile: profile.value,
    })
    auth.workspace = ws
    localStorage.setItem('xihe-workspace', JSON.stringify(ws))
    toast.success(`Workspace "${ws.name}" created`)
    emit('created', ws.id)
    emit('close')
    name.value = ''
    description.value = ''
    profile.value = 'coding'
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
          <span class="text-sm font-medium">隔离级别（Sandbox profile）</span>
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
        <div class="grid gap-2">
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
