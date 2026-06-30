<script setup lang="ts">
import { ref, computed } from 'vue'
import Sidebar from '../components/sidebar/Sidebar.vue'

const sidebarOpen = ref(true)
const isMobile = ref(false)
const sidebarWidth = ref(280)

const mainMargin = computed(() => {
  if (isMobile.value) return '0'
  return sidebarOpen.value ? `${sidebarWidth.value}px` : '0'
})
</script>

<template>
  <div class="flex h-screen overflow-hidden bg-background text-foreground">
    <Sidebar
      v-model:open="sidebarOpen"
      v-model:width="sidebarWidth"
      :is-mobile="isMobile"
    />
    <main
      class="flex-1 overflow-hidden transition-[margin] duration-300"
      :style="{ marginLeft: mainMargin }"
    >
      <router-view />
    </main>
  </div>
</template>
