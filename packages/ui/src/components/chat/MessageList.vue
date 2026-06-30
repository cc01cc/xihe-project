<script setup lang="ts">
import {
  ref,
  computed,
  onMounted,
  onUpdated,
  onUnmounted,
  watch,
  nextTick,
} from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import type { Message } from '../../types'
import MessageItem from './MessageItem.vue'
import MessageSearch from './MessageSearch.vue'

const props = defineProps<{
  messages: Message[]
  streamingContent?: string
}>()

const emit = defineEmits<{
  approve: [id: string]
  reject: [id: string]
}>()

const scrollRef = ref<HTMLDivElement | null>(null)
const sentinelRef = ref<HTMLDivElement | null>(null)
const showSearch = ref(false)
const searchQuery = ref('')
const itemEls = ref<HTMLDivElement[]>([])
const autoScroll = ref(true)

let sentinelObserver: IntersectionObserver | null = null

const allEntries = computed(() => {
  const entries: Array<
    | { type: 'message'; msg: Message }
    | { type: 'streaming'; content: string }
  > = []
  for (const msg of props.messages) {
    entries.push({ type: 'message', msg })
  }
  if (props.streamingContent !== undefined) {
    entries.push({ type: 'streaming', content: props.streamingContent })
  }
  return entries
})

const filteredEntries = computed(() => {
  if (!searchQuery.value) return allEntries.value
  const q = searchQuery.value.toLowerCase()
  return allEntries.value.filter(
    (e) => e.type === 'message' && e.msg.content.toLowerCase().includes(q),
  )
})

const virtualizer = useVirtualizer(
  computed(() => ({
    count: filteredEntries.value.length,
    getScrollElement: () => scrollRef.value,
    estimateSize: () => 120,
    overscan: 5,
    getItemKey: (index: number) => {
      const entry = filteredEntries.value[index]
      return entry?.type === 'message' ? entry.msg.id : `streaming-${index}`
    },
  })),
)

function measureAll() {
  for (const el of itemEls.value) {
    virtualizer.value?.measureElement(el)
  }
}

function scrollToLatest() {
  const count = filteredEntries.value.length
  if (count > 0) {
    virtualizer.value?.scrollToIndex(count - 1, { align: 'end' })
  }
}

onMounted(() => {
  measureAll()
  if (scrollRef.value && sentinelRef.value) {
    sentinelObserver = new IntersectionObserver(
      ([entry]) => {
        autoScroll.value = entry.isIntersecting
      },
      {
        root: scrollRef.value,
        threshold: 0,
      },
    )
    sentinelObserver.observe(sentinelRef.value)
  }
})

onUpdated(measureAll)

onUnmounted(() => {
  sentinelObserver?.disconnect()
})

watch(
  () => [filteredEntries.value.length, props.streamingContent],
  async () => {
    await nextTick()
    measureAll()
    if (autoScroll.value) {
      scrollToLatest()
    }
  },
  { flush: 'post' },
)

function resumeAutoScroll() {
  autoScroll.value = true
  scrollToLatest()
}
</script>

<template>
  <div class="flex-1 flex flex-col relative">
    <div
      v-if="showSearch"
      class="absolute top-2 right-2 z-10"
    >
      <MessageSearch
        v-model="searchQuery"
        @close="showSearch = false"
      />
    </div>

    <div
      ref="scrollRef"
      class="flex-1 overflow-y-auto pb-4"
    >
      <div
        class="relative"
        :style="{ height: virtualizer.getTotalSize() + 'px' }"
      >
        <div
          v-for="vrow in virtualizer.getVirtualItems()"
          :key="String(vrow.key)"
          ref="itemEls"
          class="absolute left-0 w-full"
          :style="{ transform: `translateY(${vrow.start}px)` }"
        >
          <MessageItem
            v-if="filteredEntries[vrow.index]?.type === 'message'"
            :message="(filteredEntries[vrow.index] as { type: 'message'; msg: Message }).msg"
            @approve="emit('approve', $event)"
            @reject="emit('reject', $event)"
          />
          <MessageItem
            v-else
            :message="{
              id: 'streaming',
              sessionId: '',
              role: 'assistant',
              content: (filteredEntries[vrow.index] as { type: 'streaming'; content: string }).content,
              timestamp: new Date().toISOString(),
            }"
            :is-streaming="true"
          />
        </div>

        <div
          ref="sentinelRef"
          class="absolute left-0 w-full h-1 pointer-events-none"
          :style="{ top: virtualizer.getTotalSize() + 'px' }"
        />
      </div>
    </div>

    <button
      v-if="!autoScroll && filteredEntries.length > 0"
      class="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-1.5 rounded-full bg-primary text-primary-foreground text-xs shadow-lg hover:bg-primary/90 transition-colors"
      @click="resumeAutoScroll"
    >
      ↓ Latest
    </button>
  </div>
</template>
