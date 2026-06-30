<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

export interface DomainField {
  key: string
  label: string
  type: 'text' | 'password' | 'select' | 'number'
  options?: { label: string; value: string }[]
}

const props = defineProps<{
  domain: string
  title: string
  entries: Record<string, string>
  readonly?: boolean
  admin?: boolean
  summary?: string
  schema: DomainField[]
}>()

const emit = defineEmits<{
  save: [body: Record<string, string>]
  reset: [key: string]
}>()

const expanded = ref(false)
const editing = ref<Record<string, string>>({})

function toggle() {
  expanded.value = !expanded.value
  if (expanded.value) {
    const init: Record<string, string> = {}
    for (const field of props.schema) {
      init[field.key] = props.entries[field.key] ?? ''
    }
    editing.value = init
  }
}

function handleSave() {
  emit('save', { ...editing.value })
}

function handleReset(key: string) {
  emit('reset', key)
}
</script>

<template>
  <div class="border rounded-lg mb-2 overflow-hidden">
    <button
      class="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50 transition-colors"
      @click="toggle"
    >
      <span class="truncate">{{ title }}</span>
      <span class="flex items-center gap-2 shrink-0">
        <span v-if="!expanded && summary" class="text-xs text-muted-foreground truncate max-w-[200px]">{{ summary }}</span>
        <span class="text-muted-foreground">{{ expanded ? '▾' : '▸' }}</span>
      </span>
    </button>
    <div v-if="expanded" class="px-4 pb-3 space-y-2">
      <div v-for="field in schema" :key="field.key" class="flex items-center gap-2">
        <span class="text-xs text-muted-foreground w-1/3 truncate">{{ field.label }}</span>

        <select
          v-if="!readonly && field.type === 'select'"
          v-model="editing[field.key]"
          class="flex-1 px-2 py-1 text-sm border rounded bg-background"
        >
          <option
            v-for="opt in field.options ?? []"
            :key="opt.value"
            :value="opt.value"
          >
            {{ opt.label }}
          </option>
        </select>

        <input
          v-else-if="!readonly"
          v-model="editing[field.key]"
          class="flex-1 px-2 py-1 text-sm border rounded bg-background"
          :type="field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'"
        />

        <span v-else class="flex-1 text-sm truncate">
          {{ field.type === 'password'
            ? editing[field.key] ? editing[field.key].substring(0, 3) + '****' + editing[field.key].slice(-4) : t('settings.notSet')
            : editing[field.key] || t('settings.empty') }}
        </span>

        <button
          v-if="admin && !readonly"
          class="text-xs text-muted-foreground hover:text-foreground px-1"
          :title="t('settings.resetToDefault')"
          @click="handleReset(field.key)"
        >
          ↺
        </button>
      </div>
      <div v-if="!readonly" class="flex justify-end pt-1">
        <button
          class="px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:opacity-90"
          @click="handleSave"
        >
          {{ t('common.save') }}
        </button>
      </div>
    </div>
  </div>
</template>
