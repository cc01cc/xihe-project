<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Sheet from '../ui/sheet/Sheet.vue'
import SheetContent from '../ui/sheet/SheetContent.vue'
import SheetHeader from '../ui/sheet/SheetHeader.vue'
import SheetTitle from '../ui/sheet/SheetTitle.vue'
import SheetDescription from '../ui/sheet/SheetDescription.vue'
import ChatPanel from '../chat/ChatPanel.vue'
import { MessageCircle } from '@lucide/vue'
import { useAgentStore } from '../../stores/agent'
import { useSessionStore } from '../../stores/session'

const props = defineProps<{
  sessionId: string
}>()

const agentStore = useAgentStore()
const sessionStore = useSessionStore()
const { t } = useI18n()
const open = ref(false)
const agentPrincipalId = computed(() => sessionStore.sessions
  .find((session) => session.id === props.sessionId)?.agentPrincipalId ?? null)

/**
 * PLAN-0342 审查修复: mirror ChatPanel's session-scoped filter. A pending
 * approval from another session must not disable this sheet's outside-click
 * dismissal — the approval modal only renders for this sheet's session.
 */
const approvalPending = computed(() =>
  agentStore.agentState.pendingApprovals.some(
    (approval) =>
      approval.sessionId === props.sessionId &&
      (approval.state === undefined ||
        approval.state === "pending" ||
        approval.state === "dispatch_unknown"),
  ),
)

function toggle() {
  open.value = !open.value
}

/**
 * PLAN-0342 decision #14: while an approval is pending the sheet must not be
 * dismissed by the approval modal's pointer-down. reka treats the teleported
 * modal as "outside" and would otherwise close the sheet, unmounting the
 * ChatPanel (and the modal) between mousedown and mouseup so the click never
 * fires — the approval could never be submitted on mobile.
 */
function onPointerDownOutside(event: Event) {
  if (approvalPending.value) event.preventDefault()
}

defineExpose({ toggle })
</script>

<template>
  <div class="md:hidden">
    <button
      class="fixed bottom-4 right-4 z-30 size-12 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center"
      title="Chat"
      aria-label="Open chat"
      @click="toggle"
    >
       <MessageCircle class="size-5" aria-hidden="true" />
    </button>
    <Sheet :open="open" @update:open="(v) => open = v">
      <SheetContent
        side="bottom"
        class="h-[75vh] p-0 gap-0"
        data-testid="mobile-chat-sheet"
        @pointer-down-outside="onPointerDownOutside"
      >
        <SheetHeader class="px-4 pt-3 pb-2 text-left border-b">
          <div class="flex min-w-0 items-center gap-2">
            <SheetTitle>对话</SheetTitle>
            <span
              data-testid="mobile-session-agent"
              class="max-w-44 truncate rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground"
              :title="agentPrincipalId ?? t('workspace.agentUnbound')"
            >
              {{ agentPrincipalId ? `${t('workspace.activeAgent')} · ${agentPrincipalId.slice(0, 8)}` : t('workspace.agentUnbound') }}
            </span>
          </div>
          <SheetDescription>在当前 workspace 中与 Agent 对话。工具绑定当前 workspace。</SheetDescription>
        </SheetHeader>
        <div class="flex-1 min-h-0 flex flex-col">
          <ChatPanel v-if="open" :session-id="sessionId" tool-mode="workspace" />
        </div>
      </SheetContent>
    </Sheet>
  </div>
</template>
