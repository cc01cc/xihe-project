<script setup lang="ts">
import { ref, watch } from 'vue'
import MarkdownRender from 'markstream-vue'
import { Bold, Code, Heading, Italic, Link, List } from '@lucide/vue'

const props = defineProps<{
  modelValue: string
  readonly?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const text = ref(props.modelValue)
const showSource = ref(false)

watch(() => props.modelValue, (v) => { text.value = v })

function onInput(event: Event) {
  text.value = (event.target as HTMLTextAreaElement).value
  emit('update:modelValue', text.value)
}
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="flex items-center gap-1 px-2 py-1.5 border-b bg-muted/30 shrink-0">
      <button
        class="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"
        :disabled="readonly"
         title="粗体"
        @click="text += '**bold**'"
      >
         <Bold class="size-3.5" aria-hidden="true" />
      </button>
      <button
        class="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"
        :disabled="readonly"
         title="斜体"
        @click="text += '*italic*'"
      >
         <Italic class="size-3.5" aria-hidden="true" />
      </button>
      <button
        class="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"
        :disabled="readonly"
         title="标题"
        @click="text += '\n## heading'"
      >
         <Heading class="size-3.5" aria-hidden="true" />
      </button>
      <button
        class="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"
        :disabled="readonly"
         title="代码"
        @click="text += '\n```\ncode\n```'"
      >
         <Code class="size-3.5" aria-hidden="true" />
      </button>
      <button
        class="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"
        :disabled="readonly"
         title="链接"
        @click="text += '[text](url)'"
      >
         <Link class="size-3.5" aria-hidden="true" />
      </button>
      <button
        class="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"
        :disabled="readonly"
         title="列表"
        @click="text += '\n- item'"
      >
         <List class="size-3.5" aria-hidden="true" />
      </button>
      <div class="flex-1" />
      <button
        class="p-1 rounded hover:bg-accent text-muted-foreground text-xs"
        @click="showSource = !showSource"
      >
         {{ showSource ? '预览' : '源码' }}
      </button>
    </div>

    <div v-if="showSource" class="flex-1 p-0">
      <textarea
        :value="text"
        data-testid="workspace-markdown-source"
        class="w-full h-full p-4 font-mono text-sm bg-background resize-none focus:outline-none"
        :readonly="readonly"
        @input="onInput"
      />
    </div>
    <div v-else class="flex-1 overflow-y-auto p-4 prose prose-sm max-w-none">
      <MarkdownRender mode="chat" :content="text" :final="true" custom-id="xihe-workspace-md" />
    </div>

    <div class="px-3 py-1 text-[10px] text-muted-foreground border-t shrink-0 flex justify-between">
      <span>{{ text.split('\n').length }} lines</span>
      <span>{{ text.length }} chars</span>
    </div>
  </div>
</template>
