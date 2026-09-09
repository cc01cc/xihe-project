<script setup lang="ts">
import { ref } from 'vue'
import Sheet from '../ui/sheet/Sheet.vue'
import SheetContent from '../ui/sheet/SheetContent.vue'
import SheetHeader from '../ui/sheet/SheetHeader.vue'
import SheetTitle from '../ui/sheet/SheetTitle.vue'
import SheetDescription from '../ui/sheet/SheetDescription.vue'
import ChatPanel from '../chat/ChatPanel.vue'
import { MessageCircle } from '@lucide/vue'

defineProps<{
  sessionId: string
}>()

const open = ref(false)

function toggle() {
  open.value = !open.value
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
      <SheetContent side="bottom" class="h-[75vh] p-0 gap-0" data-testid="mobile-chat-sheet">
        <SheetHeader class="px-4 pt-3 pb-2 text-left border-b">
          <SheetTitle>对话</SheetTitle>
          <SheetDescription>在当前 workspace 中与 Agent 对话。工具绑定当前 workspace。</SheetDescription>
        </SheetHeader>
        <div class="flex-1 min-h-0 flex flex-col">
          <ChatPanel v-if="open" :session-id="sessionId" tool-mode="workspace" />
        </div>
      </SheetContent>
    </Sheet>
  </div>
</template>
