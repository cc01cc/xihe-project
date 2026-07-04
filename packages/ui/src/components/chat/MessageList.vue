<script setup lang="ts">
import { ref, computed } from 'vue'
import type { Message } from '../../types'
import MessageItem from './MessageItem.vue'
import MessageSearch from './MessageSearch.vue'
import {
  MessageScroller,
  MessageScrollerProvider,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  useMessageScrollerScrollable,
} from '@/components/ui/message-scroller'

const props = defineProps<{
  messages: Message[]
}>()

const emit = defineEmits<{
  approve: [id: string]
  reject: [id: string]
}>()

const showSearch = ref(false)
const searchQuery = ref('')

const filteredMessages = computed(() => {
  if (!searchQuery.value) {
    return props.messages
  }

  const q = searchQuery.value.toLowerCase()
  return props.messages.filter((msg) => msg.content.toLowerCase().includes(q))
})

const scrollable = useMessageScrollerScrollable()
const isAtBottom = computed(() => scrollable.value.end)
</script>

<template>
  <MessageScrollerProvider
    auto-scroll
    default-scroll-position="last-anchor"
    class="flex-1"
  >
    <div class="relative flex flex-1 flex-col">
      <div
        v-if="showSearch"
        class="absolute right-2 top-2 z-10"
      >
        <MessageSearch
          v-model="searchQuery"
          @close="showSearch = false"
        />
      </div>

      <MessageScroller class="flex-1">
        <MessageScrollerViewport preserve-scroll-on-prepend>
          <MessageScrollerContent>
            <MessageScrollerItem
              v-for="msg in filteredMessages"
              :key="msg.id"
              :message-id="msg.id"
              :scroll-anchor="msg.role === 'user'"
            >
              <MessageItem
                :message="msg"
                :is-streaming="msg.isStreaming"
                @approve="emit('approve', $event)"
                @reject="emit('reject', $event)"
              />
            </MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScroller>

      <MessageScrollerButton
        v-if="!isAtBottom && filteredMessages.length > 0"
        direction="end"
      />
    </div>
  </MessageScrollerProvider>
</template>
