<script setup lang="ts">
import { computed } from 'vue'
import type { Message } from '../../types'
import MarkdownRenderer from './MarkdownRenderer.vue'
import ToolCallCard from './ToolCallCard.vue'
import VoiceOutput from '../multimodal/VoiceOutput.vue'
import { Bot, User } from '@lucide/vue'

const props = defineProps<{
  message: Message
  isStreaming?: boolean
}>()

const emit = defineEmits<{
  approve: [id: string]
  reject: [id: string]
}>()

const isUser = computed(() => props.message.role === 'user')
const isSystem = computed(() => props.message.role === 'system')

const timestamp = computed(() => {
  const d = new Date(props.message.timestamp)
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
})
</script>

<template>
  <div
    class="group flex gap-2 px-3 py-1.5"
    :class="isUser ? 'justify-end' : 'justify-start'"
  >
    <div
      v-if="!isUser"
      class="flex-shrink-0 size-8 rounded-full bg-primary/10 flex items-center justify-center"
    >
      <Bot class="size-4 text-primary" />
    </div>

    <div
      class="max-w-[85%] md:max-w-[75%] min-w-0 flex flex-col relative"
      :class="isUser ? 'items-end' : 'items-start'"
    >
      <div
        class="inline-block rounded-2xl px-3 py-2"
        :class="isUser
          ? 'bg-primary text-primary-foreground rounded-br-md'
          : isSystem
            ? 'bg-muted/50 text-muted-foreground text-sm italic'
            : 'bg-card border rounded-bl-md'"
      >
        <MarkdownRenderer
          v-if="!isUser && !isSystem"
          :content="message.content + (isStreaming ? '▊' : '')"
          :is-streaming="isStreaming"
        />
        <p
          v-else-if="isUser"
          class="text-sm whitespace-pre-wrap">{{ message.content }}</p>
        <p
          v-else
          class="text-sm">{{ message.content }}</p>
      </div>

      <div
        v-if="message.toolCalls?.length"
        class="mt-1.5 w-full space-y-1"
      >
        <ToolCallCard
          v-for="tc in message.toolCalls"
          :key="tc.id"
          :tool-call="tc"
          @approve="emit('approve', $event)"
          @reject="emit('reject', $event)"
        />
      </div>

      <div
        class="absolute top-full mt-0.5 flex items-center gap-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity z-10"
        :class="isUser ? 'right-0' : 'left-0'"
      >
        <span class="text-[10px] text-muted-foreground px-1">{{ timestamp }}</span>
        <VoiceOutput
          v-if="!isUser && !isSystem"
          :text="message.content"
        />
      </div>
    </div>

    <div
      v-if="isUser"
      class="flex-shrink-0 size-8 rounded-full bg-secondary flex items-center justify-center"
    >
      <User class="size-4 text-secondary-foreground" />
    </div>
  </div>
</template>
