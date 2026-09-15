<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Sheet from '../ui/sheet/Sheet.vue'
import SheetContent from '../ui/sheet/SheetContent.vue'
import SheetHeader from '../ui/sheet/SheetHeader.vue'
import SheetTitle from '../ui/sheet/SheetTitle.vue'
import SheetDescription from '../ui/sheet/SheetDescription.vue'
import WorkspaceChangesPanel from './WorkspaceChangesPanel.vue'

/**
 * Mobile entry for the dual-diff panel (PLAN-0328 M3 T3.8): the desktop auxiliary panel becomes
 * a right-side sheet so the same two tabs stay reachable with the existing sheet pattern.
 */
withDefaults(defineProps<{
  open: boolean
  sessionId?: string | null
  workspaceId: string
}>(), {
  open: false,
  sessionId: null,
})

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()

function handleOpenChange(open: boolean) {
  if (!open) emit('close')
}
</script>

<template>
  <Sheet :open="open" @update:open="handleOpenChange">
    <SheetContent side="right" class="p-0 gap-0 md:hidden" data-testid="mobile-changes-sheet">
      <SheetHeader class="px-4 pt-4 pb-2 text-left">
        <SheetTitle>{{ t('workspace.panelChanges') }}</SheetTitle>
        <SheetDescription>{{ t('workspace.diffDifferenceNote') }}</SheetDescription>
      </SheetHeader>
      <div class="flex-1 min-h-0 overflow-hidden">
        <WorkspaceChangesPanel :session-id="sessionId" :workspace-id="workspaceId" @close="emit('close')" />
      </div>
    </SheetContent>
  </Sheet>
</template>
