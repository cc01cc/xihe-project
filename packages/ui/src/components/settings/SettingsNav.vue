<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'

const { t } = useI18n()
const route = useRoute()

const tabs = [
  { name: 'settings-config', label: 'settings.configTab', path: '/settings/config' },
  { name: 'settings-knowledge', label: 'settings.knowledge', path: '/settings/knowledge' },
  { name: 'settings-data', label: 'settings.dataControls', path: '/settings/data' },
  { name: 'settings-monitoring', label: 'settings.monitoring', path: '/settings/monitoring' },
]
</script>

<template>
  <nav class="flex gap-1 overflow-x-auto border-b mb-4 px-1 whitespace-nowrap">
    <router-link
      v-for="tab in tabs"
      :key="tab.name"
      :to="tab.path"
      :data-testid="`settings-nav-${tab.name}`"
      class="px-3 py-2 text-sm border-b-2 transition-colors"
      :class="route?.name === tab.name
        ? 'border-primary text-foreground font-medium'
        : 'border-transparent text-muted-foreground hover:text-foreground'"
    >
      {{ t(tab.label) }}
    </router-link>
  </nav>
</template>
