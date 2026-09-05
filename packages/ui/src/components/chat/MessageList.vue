<script setup lang="ts">
import { ref, computed } from 'vue'
import type { Message } from '../../types'
import MessageItem from './MessageItem.vue'
import MessageSearch from './MessageSearch.vue'
import { Marker } from '@/components/ui/marker'
import {
  MessageScroller,
  MessageScrollerProvider,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from '@/components/ui/message-scroller'

const props = defineProps<{
  messages: Message[]
}>()

const emit = defineEmits<{
  approve: [id: string]
  reject: [id: string]
  delete: [id: string]
  retry: [id: string]
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

const entries = computed(() => {
  const result: Array<{ type: 'message'; msg: Message } | { type: 'date'; date: string; id: string }> = []
  let lastDate = ''

  for (const msg of filteredMessages.value) {
    const date = new Date(msg.timestamp).toLocaleDateString()
    if (date !== lastDate) {
      result.push({ type: 'date', date, id: `date-${date}` })
      lastDate = date
    }
    result.push({ type: 'message', msg })
  }

  return result
})
</script>

<template>
  <MessageScrollerProvider
    auto-scroll
    default-scroll-position="last-anchor"
  >
    <div class="relative flex flex-1 flex-col min-h-0">
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
            <template v-for="entry in entries" :key="entry.type === 'message' ? entry.msg.id : entry.id">
              <MessageScrollerItem
                v-if="entry.type === 'message'"
                :message-id="entry.msg.id"
                :scroll-anchor="entry.msg.role === 'user'"
              >
                <MessageItem
                  :message="entry.msg"
                  :is-streaming="entry.msg.isStreaming"
                  @approve="emit('approve', $event)"
                  @reject="emit('reject', $event)"
                  @delete="emit('delete', $event)"
                  @retry="emit('retry', $event)"
                />
              </MessageScrollerItem>

              <Marker
                v-else
                variant="separator"
                class="my-2"
              >
                {{ entry.date }}
              </Marker>
            </template>
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScroller>

      <MessageScrollerButton
        v-if="filteredMessages.length > 0"
        direction="end"
      />
    </div>
  </MessageScrollerProvider>
</template>
