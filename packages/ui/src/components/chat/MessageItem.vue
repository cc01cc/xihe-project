<script setup lang="ts">
import { computed, onUnmounted } from 'vue'
import type { Message } from '../../types'
import MarkdownRenderer from './MarkdownRenderer.vue'
import ToolCallCard from './ToolCallCard.vue'
import VoiceOutput from '../multimodal/VoiceOutput.vue'
import {
  Attachment,
  AttachmentActions,
  AttachmentAction,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from '@/components/ui/attachment'
import {
  Marker,
  MarkerIcon,
  MarkerContent,
} from '@/components/ui/marker'
import { Download, Brain, LoaderCircle, Clock, Bot, User } from '@lucide/vue'
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
const isMarker = computed(() => props.message.marker !== undefined)

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

const statusIcon = computed(() => {
  switch (props.message.status) {
    case 'thinking':
      return Brain
    case 'executing':
      return LoaderCircle
    default:
      return Clock
  }
})

function isImage(type: string) {
  return type.startsWith('image/')
}

function downloadAttachment(url: string, name: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
}

onUnmounted(() => {
  props.message.attachments?.forEach((attachment) => {
    if (attachment.url.startsWith('blob:')) {
      URL.revokeObjectURL(attachment.url)
    }
  })
})
</script>

<template>
  <Marker
    v-if="isMarker"
    variant="default"
    :class="message.status === 'executing' ? 'shimmer' : ''"
  >
    <MarkerIcon>
      <component :is="statusIcon" class="size-4" />
    </MarkerIcon>
    <MarkerContent>
      {{ message.status === 'executing' ? 'Executing task...' : 'Thinking...' }}
    </MarkerContent>
  </Marker>

  <MessageRoot
    v-else
    :align="isUser ? 'end' : 'start'"
    class="px-3 py-1.5"
  >
    <MessageAvatar v-if="!isUser">
      <div class="flex size-8 items-center justify-center rounded-full bg-primary/10">
        <Bot class="size-4 text-primary" />
      </div>
    </MessageAvatar>

    <MessageContent class="max-w-[85%] min-w-0 md:max-w-[75%]">
      <AttachmentGroup v-if="message.attachments?.length">
        <Attachment
          v-for="attachment in message.attachments"
          :key="attachment.id"
          :class="isImage(attachment.type) ? 'w-32' : 'w-48'"
        >
          <AttachmentMedia v-if="isImage(attachment.type)">
            <img
              :src="attachment.url"
              :alt="attachment.name"
              class="size-full object-cover"
            />
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>{{ attachment.name }}</AttachmentTitle>
            <AttachmentDescription>{{ (attachment.size / 1024).toFixed(1) }} KB</AttachmentDescription>
          </AttachmentContent>
          <AttachmentActions>
            <AttachmentAction @click="downloadAttachment(attachment.url, attachment.name)">
              <Download class="size-4" />
            </AttachmentAction>
          </AttachmentActions>
        </Attachment>
      </AttachmentGroup>

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
