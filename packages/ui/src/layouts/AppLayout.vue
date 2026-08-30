<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { PanelLeftOpen } from '@lucide/vue'
import Sidebar from '../components/sidebar/Sidebar.vue'

const mobileMediaQuery = typeof window === 'undefined'
  ? null
  : window.matchMedia('(max-width: 767px)')
const isMobile = ref(mobileMediaQuery?.matches ?? false)
const sidebarOpen = ref(!isMobile.value)
const sidebarWidth = ref(280)
const route = useRoute()

const mainMargin = computed(() => {
  if (isMobile.value) return '0'
  return sidebarOpen.value ? `${sidebarWidth.value}px` : '0'
})

function updateViewport() {
  const nextIsMobile = mobileMediaQuery?.matches ?? false
  if (nextIsMobile === isMobile.value) return

  isMobile.value = nextIsMobile
  sidebarOpen.value = !nextIsMobile
}

watch(
  () => route.fullPath,
  () => {
    if (isMobile.value) sidebarOpen.value = false
  },
)

onMounted(() => {
  if (!mobileMediaQuery) return
  if (typeof mobileMediaQuery.addEventListener === 'function') {
    mobileMediaQuery.addEventListener('change', updateViewport)
  } else {
    mobileMediaQuery.addListener(updateViewport)
  }
})

onUnmounted(() => {
  if (!mobileMediaQuery) return
  if (typeof mobileMediaQuery.removeEventListener === 'function') {
    mobileMediaQuery.removeEventListener('change', updateViewport)
  } else {
    mobileMediaQuery.removeListener(updateViewport)
  }
})
</script>

<template>
  <div class="flex h-screen overflow-hidden bg-background text-foreground">
    <Sidebar
      v-model:open="sidebarOpen"
      v-model:width="sidebarWidth"
      :is-mobile="isMobile"
    />
    <button
      v-if="!sidebarOpen"
      type="button"
      data-testid="mobile-sidebar-toggle"
      aria-label="Open navigation"
      title="Open navigation"
      class="fixed right-3 top-3 z-30 inline-flex size-9 items-center justify-center rounded-md border bg-background/90 text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-accent"
      @click="sidebarOpen = true"
    >
      <PanelLeftOpen class="size-4" />
    </button>
    <main
      class="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto transition-[margin] duration-300"
      :style="{ marginLeft: mainMargin }"
    >
      <router-view />
    </main>
  </div>
</template>
