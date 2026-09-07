<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  modelValue: string
  language: string
  readonly?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const text = ref(props.modelValue)
let debounceTimer: ReturnType<typeof setTimeout> | null = null

watch(() => props.modelValue, (v) => { text.value = v })

function onInput(event: Event) {
  text.value = (event.target as HTMLTextAreaElement).value
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    emit('update:modelValue', text.value)
  }, 300)
}
</script>

<template>
  <div data-testid="workspace-code-editor" class="flex flex-col h-full">
    <div class="flex items-center justify-between px-3 py-1 border-b bg-muted/30 shrink-0">
      <span class="text-[10px] font-mono text-muted-foreground uppercase">{{ language }}</span>
      <span class="text-[10px] text-muted-foreground">{{ text.split('\n').length }} lines</span>
    </div>
    <div class="flex-1">
      <textarea
        :value="text"
        class="w-full h-full p-4 font-mono text-sm leading-relaxed bg-background resize-none focus:outline-none"
        :class="{ 'text-muted-foreground': readonly }"
        :readonly="readonly"
        spellcheck="false"
        @input="onInput"
      />
    </div>
  </div>
</template>
