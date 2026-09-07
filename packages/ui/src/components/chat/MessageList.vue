<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue'
import type { Message } from '../../types'
import MessageItem from './MessageItem.vue'
import MessageSearch from './MessageSearch.vue'
import { Search } from '@lucide/vue'
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

watch(searchQuery, async () => {
  await nextTick()
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
  const viewport = document.querySelector<HTMLElement>('[data-testid="message-scroller-viewport"]')
  if (viewport) viewport.scrollTop = 0
})

const entries = computed(() => {
  const result: Array<{ type: 'message'; msg: Message } | { type: 'date'; date: string; id: string }> = []
  let lastDate = ''

  for (const msg of filteredMessages.value) {
    const parsedDate = new Date(msg.timestamp)
    const date = Number.isNaN(parsedDate.getTime()) ? '' : parsedDate.toLocaleDateString()
    if (date && date !== lastDate) {
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
    <div data-testid="message-list" class="relative flex flex-1 flex-col min-h-0">
      <div
        v-if="showSearch"
        class="absolute right-12 top-2 z-10"
      >
        <MessageSearch
          v-model="searchQuery"
          @close="showSearch = false"
        />
      </div>
      <button
        v-else
        type="button"
        data-testid="message-search-toggle"
        aria-label="搜索消息"
        class="absolute right-2 top-2 z-10 rounded-md border bg-background/90 p-1.5 text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
        @click="showSearch = true"
      >
        <Search class="size-3.5" aria-hidden="true" />
      </button>

      <MessageScroller class="flex-1">
        <MessageScrollerViewport preserve-scroll-on-prepend>
           <MessageScrollerContent :class="showSearch ? 'pt-12' : undefined">
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
