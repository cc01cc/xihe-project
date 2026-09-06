<script setup lang="ts">
import Sheet from '../ui/sheet/Sheet.vue'
import SheetContent from '../ui/sheet/SheetContent.vue'
import SheetHeader from '../ui/sheet/SheetHeader.vue'
import SheetTitle from '../ui/sheet/SheetTitle.vue'
import FileTreePanel from './FileTreePanel.vue'

withDefaults(defineProps<{
  open: boolean
}>(), {
  open: false,
})

const emit = defineEmits<{
  close: []
}>()

function handleOpenChange(open: boolean) {
  if (!open) emit('close')
}
</script>

<template>
  <Sheet :open="open" @update:open="handleOpenChange">
    <SheetContent side="left" class="p-0 gap-0 md:hidden" data-testid="mobile-files-sheet">
      <SheetHeader class="px-4 pt-4 pb-2 text-left">
        <SheetTitle>文件</SheetTitle>
      </SheetHeader>
      <div class="flex-1 min-h-0 overflow-hidden">
        <FileTreePanel />
      </div>
    </SheetContent>
  </Sheet>
</template>
