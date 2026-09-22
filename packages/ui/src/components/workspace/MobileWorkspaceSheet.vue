<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Plus } from '@lucide/vue'
import Sheet from '../ui/sheet/Sheet.vue'
import SheetContent from '../ui/sheet/SheetContent.vue'
import SheetHeader from '../ui/sheet/SheetHeader.vue'
import SheetTitle from '../ui/sheet/SheetTitle.vue'
import SheetDescription from '../ui/sheet/SheetDescription.vue'
import FileTreePanel from './FileTreePanel.vue'

withDefaults(defineProps<{
  open: boolean
}>(), {
  open: false,
})

const emit = defineEmits<{
  close: []
  addWorkspace: []
}>()

const { t } = useI18n()

function handleOpenChange(open: boolean) {
  if (!open) emit('close')
}
</script>

<template>
  <Sheet :open="open" @update:open="handleOpenChange">
    <SheetContent side="left" class="p-0 gap-0 md:hidden" data-testid="mobile-files-sheet">
      <SheetHeader class="px-4 pt-4 pb-2 text-left">
        <SheetTitle>文件</SheetTitle>
        <SheetDescription>浏览和管理当前 workspace 的文件。</SheetDescription>
      </SheetHeader>
      <div class="flex items-center justify-end px-4 pb-2">
        <!-- PLAN-0384 T1.1: mobile creation entry (desktop toolbar can overflow on narrow viewports). -->
        <button
          type="button"
          data-testid="mobile-workspace-add"
          class="flex items-center gap-1 rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
          @click="emit('addWorkspace')"
        >
          <Plus class="size-3.5" aria-hidden="true" />
          {{ t('workspace.addWorkspace') }}
        </button>
      </div>
      <div class="flex-1 min-h-0 overflow-hidden">
        <FileTreePanel />
      </div>
    </SheetContent>
  </Sheet>
</template>
