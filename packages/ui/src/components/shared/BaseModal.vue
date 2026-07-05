<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'

defineProps<{
  title?: string
  show: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="show" data-testid="modal-backdrop" class="fixed inset-0 z-50 flex items-center justify-center" @click.self="emit('close')">
        <div data-testid="modal-overlay" class="fixed inset-0 bg-black/50" />
        <div data-testid="modal-content" class="relative z-10 w-full max-w-md rounded-xl border bg-card p-6 shadow-lg">
          <div v-if="title" class="flex items-center justify-between mb-4">
            <h2 class="text-lg font-semibold">{{ title }}</h2>
            <button class="p-1 rounded hover:bg-accent" aria-label="Close" @click="emit('close')">
              <span class="i-lucide-x size-4" />
            </button>
          </div>
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-enter-active {
  transition: all 0.2s ease-out;
}
.modal-leave-active {
  transition: all 0.15s ease-in;
}
.modal-enter-from {
  opacity: 0;
}
.modal-enter-from > .relative {
  transform: scale(0.95);
}
.modal-leave-to {
  opacity: 0;
}
.modal-leave-to > .relative {
  transform: scale(0.95);
}
</style>
