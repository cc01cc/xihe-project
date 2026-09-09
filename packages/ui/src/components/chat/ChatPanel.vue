<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useChatStore } from '../../stores/chat'
import { useAgentStore } from '../../stores/agent'
import { ApiError, api } from '../../composables/api'
import { logger } from '../../lib/logger'
import type { AttachmentFile, Message } from '../../types'
import MessageList from './MessageList.vue'
import InputArea from './InputArea.vue'
import SSEStream from './SSEStream.vue'
import ApprovalModal from './ApprovalModal.vue'

const props = withDefaults(defineProps<{
  sessionId: string
  toolMode?: 'none' | 'workspace'
}>(), {
  toolMode: 'none',
})

const chatStore = useChatStore()
const agentStore = useAgentStore()

const suggestions = computed(() => props.toolMode === 'workspace'
  ? ['列出文件', '打开 README', '解释选中的文件', '查看工作区环境']
  : ['今天天气怎么样？', '帮我写一封邮件', '解释一下这个概念', '总结一下这段代码'])

const messages = computed(() => chatStore.getMessages(props.sessionId))
const isStreaming = computed(() => {
  return agentStore.agentState.status === 'thinking'
    || agentStore.agentState.status === 'executing'
    || agentStore.agentState.status === 'awaiting_approval'
})

const pendingApproval = computed(() => agentStore.agentState.pendingApprovals.find(
  (approval) => approval.sessionId === props.sessionId,
) ?? null)
const approvalDismissedFor = ref<string | null>(null)
const approvalSubmitting = ref(false)
const approvalError = ref<string | null>(null)
const showApproval = computed(() => pendingApproval.value !== null
  && pendingApproval.value.requestId !== approvalDismissedFor.value)

watch(() => pendingApproval.value?.requestId, (requestId) => {
  if (requestId !== approvalDismissedFor.value) {
    approvalDismissedFor.value = null
    approvalError.value = null
  }
})

const streamComponent = ref<InstanceType<typeof SSEStream> | null>(null)
const inputComponent = ref<InstanceType<typeof InputArea> | null>(null)

async function handleSend(content: string, attachments?: AttachmentFile[]) {
  const id = props.sessionId
  if (!id) return

  const fileIds = attachments
    ?.map((a) => a.fileId)
    .filter((fileId): fileId is string => fileId !== undefined)
  const result = await streamComponent.value?.sendMessage(content, {
    attachments: fileIds,
    toolMode: props.toolMode,
  })
  if (!result) return

  chatStore.addMessage(id, {
    id: result.messageId ?? crypto.randomUUID(),
    sessionId: id,
    role: 'user',
    content,
    timestamp: new Date().toISOString(),
    attachments,
    runId: result.runId,
    runStatus: result.status,
  })
  inputComponent.value?.clearDraft()
}

async function handleRetry(messageId: string) {
  const index = messages.value.findIndex((message) => message.id === messageId)
  if (index < 0) return
  let userMessage: Message | undefined
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (messages.value[cursor]?.role === 'user') {
      userMessage = messages.value[cursor]
      break
    }
  }
  if (!userMessage) return
  await handleSend(userMessage.content)
}

async function handleDeleteMessage(messageId: string) {
  try {
    await api.deleteMessage(props.sessionId, messageId)
    chatStore.deleteMessage(props.sessionId, messageId)
  } catch (err) {
    logger.error('Failed to delete message', err)
  }
}

function approveTool(toolId: string) {
  agentStore.approveTool(toolId)
}

function rejectTool(toolId: string) {
  agentStore.rejectTool(toolId)
}

function dismissApproval() {
  approvalDismissedFor.value = pendingApproval.value?.requestId ?? null
  approvalError.value = null
}

async function decideApproval(approved: boolean) {
  const approval = pendingApproval.value
  if (!approval || approvalSubmitting.value) return

  approvalSubmitting.value = true
  approvalError.value = null
  try {
    await api.decideChatApproval(approval.requestId, approved)
    agentStore.removeApprovalRequest(approval.requestId)
    approvalDismissedFor.value = null
  } catch (err) {
    const message = err instanceof ApiError
      ? `${err.problem.code}: ${err.problem.detail ?? err.message}`
      : 'Approval decision failed'
    approvalError.value = message
    logger.error('Failed to submit chat approval decision', err)
  } finally {
    approvalSubmitting.value = false
  }
}

function stopStreaming() {
  streamComponent.value?.stopStreaming?.()
}

// ── PLAN-292 M3 (C3): run recovery banner ────────────────────────────────
// A dead SSE or a page refresh hides what the run is doing. On mount, ask
// the CP for the last run's status and surface one of three honest states.
const runRecovery = computed(() => chatStore.runRecovery[props.sessionId] ?? null)

function recoverableRunId(): string | null {
  const msgs = chatStore.getMessages(props.sessionId)
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i]
    if (msg.role === 'assistant' && msg.runId && msg.runStatus !== 'succeeded') {
      return msg.runId
    }
  }
  return null
}

onMounted(() => {
  const runId = recoverableRunId()
  if (runId) void chatStore.refreshRunRecovery(props.sessionId, runId)
})

const recoveryBannerClass = computed(() => {
  switch (runRecovery.value?.state) {
    case 'resumed':
      return 'border-primary/40 bg-primary/10 text-foreground'
    case 'cancelled':
      return 'border-border bg-muted/40 text-muted-foreground'
    default:
      return 'border-destructive/40 bg-destructive/10 text-foreground'
  }
})
</script>

<template>
  <div class="flex flex-col h-full min-h-0 overflow-hidden">
    <div
      v-if="runRecovery"
      data-testid="run-recovery-banner"
      class="flex items-center justify-between gap-3 mx-4 mt-3 px-3 py-2 rounded-lg border text-sm"
      :class="recoveryBannerClass"
      role="status"
    >
      <span>{{ runRecovery.message }}</span>
      <button
        class="px-2 py-0.5 text-xs rounded border border-border hover:bg-accent shrink-0"
        data-testid="run-recovery-dismiss"
        @click="chatStore.dismissRunRecovery(props.sessionId)"
      >知道了</button>
    </div>

    <MessageList
      v-if="messages.length > 0"
      :messages="messages"
      @approve="approveTool"
      @reject="rejectTool"
      @delete="handleDeleteMessage"
      @retry="handleRetry"
    />

    <div v-else class="flex-1 flex flex-col items-center justify-center gap-4 px-4">
      <div class="text-2xl font-semibold text-muted-foreground">xihe</div>
      <p class="text-sm text-muted-foreground text-center max-w-md">你好，我是 xihe Agent。有什么我可以帮你的？</p>
      <div class="flex flex-wrap gap-2 justify-center max-w-md">
        <button
           v-for="suggestion in suggestions"
          :key="suggestion"
          class="px-3 py-1.5 text-xs rounded-full border border-border bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          @click="handleSend(suggestion)"
        >
          {{ suggestion }}
        </button>
      </div>
    </div>

    <InputArea
      ref="inputComponent"
      :session-id="sessionId"
      :is-streaming="isStreaming"
      @send="handleSend"
      @stop="stopStreaming"
    />

    <div
      v-if="pendingApproval && !showApproval"
      data-testid="approval-pending-banner"
      class="flex items-center justify-between gap-3 border-t bg-muted/40 px-4 py-2 text-sm"
    >
      <span>{{ $t('chat.approvalRequired') }}</span>
      <button class="text-primary underline" type="button" @click="approvalDismissedFor = null">
        {{ $t('chat.reviewApproval') }}
      </button>
    </div>

    <ApprovalModal
      :approval="pendingApproval"
      :show="showApproval"
      :busy="approvalSubmitting"
      :error="approvalError"
      @approve="decideApproval(true)"
      @reject="decideApproval(false)"
      @close="dismissApproval"
    />

    <SSEStream
      :session-id="sessionId"
      :tool-mode="toolMode"
      :active="true"
      ref="streamComponent"
    />
  </div>
</template>
