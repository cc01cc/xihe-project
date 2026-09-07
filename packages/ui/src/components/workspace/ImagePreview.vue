<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  content: string
  fileName: string
}>()

const showLightbox = ref(false)
const scale = ref(1)

function zoomIn() { scale.value = Math.min(3, scale.value + 0.25) }
function zoomOut() { scale.value = Math.max(0.25, scale.value - 0.25) }
function resetZoom() { scale.value = 1 }
</script>

<template>
  <div data-testid="workspace-image-preview" class="flex flex-col items-center justify-center p-4 h-full">
    <img
      :src="content"
      :alt="fileName"
      class="max-w-full max-h-[70vh] object-contain rounded-lg cursor-pointer hover:ring-2 hover:ring-primary transition-all"
      :style="{ transform: `scale(${scale})` }"
      @click="showLightbox = true"
    />
    <div class="flex items-center gap-2 mt-3 text-xs text-muted-foreground">
      <button class="px-2 py-1 rounded hover:bg-accent" @click="zoomOut">−</button>
      <span class="w-12 text-center">{{ Math.round(scale * 100) }}%</span>
      <button class="px-2 py-1 rounded hover:bg-accent" @click="zoomIn">+</button>
      <button class="px-2 py-1 rounded hover:bg-accent ml-2" @click="resetZoom">Reset</button>
    </div>

    <Teleport to="body">
      <div
        v-if="showLightbox"
        class="fixed inset-0 z-50 bg-black/80 flex items-center justify-center cursor-pointer"
        @click="showLightbox = false"
      >
        <img :src="content" class="max-w-[95vw] max-h-[95vh] object-contain" />
      </div>
    </Teleport>
  </div>
</template>
