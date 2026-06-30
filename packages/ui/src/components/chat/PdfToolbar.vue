<script setup lang="ts">
defineProps<{
  pageNum: number
  totalPages: number
  scale: number
}>()

const emit = defineEmits<{
  prev: []
  next: []
  'update:scale': [value: number]
}>()
</script>

<template>
  <div class="flex items-center gap-3 text-sm">
    <button
      class="px-2 py-1 rounded hover:bg-muted disabled:opacity-30"
      :disabled="pageNum <= 1"
      @click="emit('prev')"
    >◀</button>
    <span>{{ pageNum }} / {{ totalPages }}</span>
    <button
      class="px-2 py-1 rounded hover:bg-muted disabled:opacity-30"
      :disabled="pageNum >= totalPages"
      @click="emit('next')"
    >▶</button>
    <select
      :value="scale"
      class="text-xs border rounded px-1 py-0.5"
      @change="emit('update:scale', Number(($event.target as HTMLSelectElement).value))"
    >
      <option :value="0.5">50%</option>
      <option :value="0.75">75%</option>
      <option :value="1.0">100%</option>
      <option :value="1.5">150%</option>
      <option :value="2.0">200%</option>
    </select>
  </div>
</template>
