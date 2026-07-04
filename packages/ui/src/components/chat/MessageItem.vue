<script setup lang="ts">
import { computed } from 'vue'
import type { Message } from '../../types'
import MarkdownRenderer from './MarkdownRenderer.vue'
import ToolCallCard from './ToolCallCard.vue'
import VoiceOutput from '../multimodal/VoiceOutput.vue'
import { Bot, User } from '@lucide/vue'
import {
  Message as MessageRoot,
  MessageAvatar,
  MessageContent,
} from '@/components/ui/message'
import {
  Bubble,
  BubbleContent,
} from '@/components/ui/bubble'

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

const bubbleVariant = computed(() => {
  if (isUser.value) {
    return 'default'
  }
  if (isSystem.value) {
    return 'outline'
  }
  return 'muted'
})

const content = computed(() => {
  if (props.isStreaming) {
    return props.message.content + '▊'
  }
  return props.message.content
})
</script>

<template>
  <MessageRoot
    :align="isUser ? 'end' : 'start'"
    class="px-3 py-1.5"
  >
    <MessageAvatar v-if="!isUser">
      <div class="flex size-8 items-center justify-center rounded-full bg-primary/10">
        <Bot class="size-4 text-primary" />
      </div>
    </MessageAvatar>

    <MessageContent class="max-w-[85%] md:max-w-[75%] min-w-0">
      <Bubble :variant="bubbleVariant">
        <BubbleContent>
          <MarkdownRenderer
            v-if="!isUser && !isSystem"
            :content="content"
            :is-streaming="isStreaming"
          />
          <p v-else-if="isUser" class="whitespace-pre-wrap text-sm">{{ content }}</p>
          <p v-else class="text-sm">{{ content }}</p>
        </BubbleContent>
      </Bubble>

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
        class="invisible mt-0.5 flex items-center gap-2 opacity-0 transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
        :class="isUser ? 'justify-end' : 'justify-start'"
      >
        <span class="px-1 text-[10px] text-muted-foreground">{{ timestamp }}</span>
        <VoiceOutput
          v-if="!isUser && !isSystem"
          :text="message.content"
        />
      </div>
    </MessageContent>

    <MessageAvatar v-if="isUser">
      <div class="flex size-8 items-center justify-center rounded-full bg-secondary">
        <User class="size-4 text-secondary-foreground" />
      </div>
    </MessageAvatar>
  </MessageRoot>
</template>
