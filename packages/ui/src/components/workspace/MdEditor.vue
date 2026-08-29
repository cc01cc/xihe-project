<script setup lang="ts">
import { ref, watch } from 'vue'
import MarkdownRender from 'markstream-vue'

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

function onInput() {
  emit('update:modelValue', text.value)
}
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="flex items-center gap-1 px-2 py-1.5 border-b bg-muted/30 shrink-0">
      <button
        class="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"
        :disabled="readonly"
        title="Bold"
        @click="text += '**bold**'"
      >
        <span class="i-lucide-bold size-3.5" />
      </button>
      <button
        class="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"
        :disabled="readonly"
        title="Italic"
        @click="text += '*italic*'"
      >
        <span class="i-lucide-italic size-3.5" />
      </button>
      <button
        class="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"
        :disabled="readonly"
        title="Heading"
        @click="text += '\n## heading'"
      >
        <span class="i-lucide-heading size-3.5" />
      </button>
      <button
        class="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"
        :disabled="readonly"
        title="Code"
        @click="text += '\n```\ncode\n```'"
      >
        <span class="i-lucide-code size-3.5" />
      </button>
      <button
        class="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"
        :disabled="readonly"
        title="Link"
        @click="text += '[text](url)'"
      >
        <span class="i-lucide-link size-3.5" />
      </button>
      <button
        class="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"
        :disabled="readonly"
        title="List"
        @click="text += '\n- item'"
      >
        <span class="i-lucide-list size-3.5" />
      </button>
      <div class="flex-1" />
      <button
        class="p-1 rounded hover:bg-accent text-muted-foreground text-xs"
        @click="showSource = !showSource"
      >
        {{ showSource ? 'Preview' : 'Source' }}
      </button>
    </div>

    <div v-if="showSource" class="flex-1 p-0">
      <textarea
        :value="text"
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
