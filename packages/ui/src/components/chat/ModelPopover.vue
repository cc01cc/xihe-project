<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxInput,
  ComboboxContent,
  ComboboxViewport,
  ComboboxItem,
  ComboboxGroup,
  ComboboxLabel,
  ComboboxEmpty,
  ComboboxPortal,
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsibleContent,
} from 'reka-ui'
import { useConfigStore } from '../../stores/config'
import { useSessionStore } from '../../stores/session'
import { ApiError } from '../../composables/api'
import { logger } from '../../lib/logger'
import { toast } from 'vue-sonner'
import { getProviderInfo, getModelTags, getModelContextWindow } from '../../types/provider'

const { t } = useI18n()
const router = useRouter()
const configStore = useConfigStore()
const sessionStore = useSessionStore()

const open = ref(false)
const searchTerm = ref('')
const collapsedProviders = ref<Set<string>>(new Set())

watch(open, (isOpen) => {
  if (isOpen) {
    void nextTick(() => {
      searchTerm.value = ''
    })
  }
})

watch(
  () => configStore.modelError,
  (val) => {
    if (val) {
      toast.error(val)
      configStore.modelError = null
    }
  },
)

const currentBinding = computed(() => {
  const sessionId = sessionStore.currentSessionId
  if (!sessionId) return undefined
  return configStore.getEffectiveModel(sessionId)
})

const currentValue = computed(() => {
  const binding = currentBinding.value
  return binding ? `${binding.provider}/${binding.model}` : undefined
})

const triggerLabel = computed(() => {
  const binding = currentBinding.value
  if (!binding) return t('chat.modelSelectorPlaceholder')
  const info = getProviderInfo(binding.provider)
  const providerName = info?.name ?? binding.provider
  return `${binding.model} · ${providerName}`
})

const hasProviders = computed(() => {
  return Object.keys(configStore.modelCache.providers ?? {}).length > 0
})

const hasConfiguredProvider = computed(() => {
  const llmConfig = configStore.mergedConfig['llm-provider'] ?? {}
  return !!(
    llmConfig.defaultProvider
    || llmConfig.deepseekApiKey
    || llmConfig.openaiApiKey
    || llmConfig.xiaomiApiKey
    || llmConfig.anthropicApiKey
  )
})

const searchQuery = computed(() => searchTerm.value.toLowerCase().trim())

const providerGroups = computed(() => {
  const models = Object.fromEntries(
    Object.keys(configStore.modelCache.providers ?? {}).map((provider) => [
      provider,
      configStore.getChatModels(provider),
    ]),
  )
  const q = searchQuery.value
  return Object.entries(models)
    .filter(([, modelIds]) => modelIds.length > 0)
    .map(([provider, modelIds]) => {
      const info = getProviderInfo(provider)
      const filtered = q
        ? modelIds.filter((model) => matchModel(provider, model, q))
        : modelIds
      return {
        provider,
        name: info?.name ?? provider,
        models: filtered,
      }
    })
    .filter((g) => g.models.length > 0)
})

const filteredFavorites = computed(() => {
  const favs = configStore.modelFavorites
  if (favs.length === 0) return []
  const q = searchQuery.value
  return favs
    .filter((favorite) => configStore.isChatModelAvailable(favorite.provider, favorite.model))
    .filter((favorite) => !q || matchModel(favorite.provider, favorite.model, q))
})

const hasAnyModels = computed(
  () => providerGroups.value.length > 0 || filteredFavorites.value.length > 0,
)

const hasAnyUnfilteredModels = computed(() => {
  return Object.keys(configStore.modelCache.providers ?? {}).some(
    (provider) => configStore.getChatModels(provider).length > 0,
  )
})

function matchModel(provider: string, model: string, q: string): boolean {
  const info = getProviderInfo(provider)
  const text = `${model} ${info?.name ?? provider} ${getModelTags(provider, model).join(' ')}`.toLowerCase()
  return text.includes(q)
}

function isGroupCollapsed(provider: string): boolean {
  if (searchQuery.value) return false
  return collapsedProviders.value.has(provider)
}

function setGroupCollapsed(provider: string, collapsed: boolean) {
  if (searchQuery.value) return
  if (collapsed) {
    collapsedProviders.value.add(provider)
  } else {
    collapsedProviders.value.delete(provider)
  }
}

function toggleGroup(provider: string) {
  setGroupCollapsed(provider, !isGroupCollapsed(provider))
}

async function selectModel(value: string) {
  const slash = value.indexOf('/')
  if (slash < 0) return
  const provider = value.slice(0, slash)
  const model = value.slice(slash + 1)
  const sessionId = sessionStore.currentSessionId
  if (sessionId && !configStore.isChatModelAvailable(provider, model)) {
    toast.error('Selected model is not currently available for chat')
    return
  }
  if (sessionId) {
    try {
      const updated = await sessionStore.updateSession(sessionId, {
        modelProvider: provider,
        modelName: model,
      })
      configStore.setSessionModel(
        sessionId,
        updated.modelProvider ?? provider,
        updated.modelName ?? model,
      )
    } catch (cause: unknown) {
      const message = cause instanceof ApiError ? cause.message : 'Failed to persist model binding'
      logger.warn('Persist model binding failed', cause)
      toast.error(message)
      return
    }
  }
  open.value = false
  searchTerm.value = ''
}

function toggleFav(provider: string, model: string) {
  configStore.toggleFavorite(provider, model)
}

function goToSettings() {
  open.value = false
  router.push('/settings/config')
}

function handleSelect(event: { detail: { value?: string } }) {
  const value = event.detail.value
  if (value) void selectModel(value)
}

function formatContext(ctx?: number): string {
  return ctx ? `${ctx}K` : ''
}

onMounted(() => {
  configStore.fetchModels()
})
</script>

<template>
  <ComboboxRoot
    :model-value="currentValue"
    v-model:open="open"
    ignore-filter
    class="relative inline-block"
  >
    <ComboboxTrigger as-child>
      <button
        data-testid="model-popover-trigger"
        class="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-dashed bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors max-w-[240px] truncate"
      >
        <span class="i-lucide-cpu size-3 shrink-0" />
        <span class="truncate">{{ triggerLabel }}</span>
        <span class="i-lucide-chevron-up size-3 shrink-0 opacity-50" />
      </button>
    </ComboboxTrigger>

    <ComboboxPortal>
      <ComboboxContent
        position="popper"
        side="top"
        align="start"
        :side-offset="4"
        class="z-50 min-w-[260px] max-w-[420px] max-h-[420px] overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
      >
        <ComboboxViewport class="max-h-[400px] overflow-y-auto">
          <div
            v-if="!hasProviders && !hasConfiguredProvider"
            class="px-3 py-4 text-center"
          >
            <button
              class="text-xs text-muted-foreground underline hover:text-foreground"
              @click="goToSettings"
            >
              {{ t('chat.noProvidersConfigured') }}
            </button>
          </div>

          <div
            v-else-if="!hasProviders && hasConfiguredProvider"
            class="px-3 py-4 text-center space-y-2"
          >
            <div class="text-xs text-muted-foreground">
              {{ t('chat.providersNoModels') }}
            </div>
            <button
              class="text-xs text-primary underline hover:text-primary/80"
              @click="configStore.fetchModels()"
            >
              {{ t('chat.retryFetchModels') }}
            </button>
          </div>

          <div
            v-else-if="!hasAnyUnfilteredModels"
            class="px-3 py-4 text-center text-xs text-muted-foreground"
          >
            {{ t('chat.providersNoModels') }}
          </div>

          <template v-else>
            <div class="px-2 pb-1 sticky top-0 bg-popover z-10">
              <ComboboxInput
                v-model="searchTerm"
                data-testid="model-popover-search"
                class="w-full px-2 py-1 text-xs rounded border bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                :placeholder="t('chat.searchModels')"
                @focus="searchTerm = ''"
              />
            </div>

            <ComboboxEmpty
              v-if="!hasAnyModels"
              class="px-3 py-4 text-center text-xs text-muted-foreground"
            >
              {{ t('chat.noSearchResults') }}
            </ComboboxEmpty>

            <ComboboxGroup
              v-if="filteredFavorites.length > 0"
              class="py-1"
            >
              <ComboboxLabel class="px-2 py-1 text-xs font-medium text-muted-foreground flex items-center gap-1">
                <span class="i-lucide-star size-3" />
                {{ t('chat.favorites') }}
              </ComboboxLabel>
              <ComboboxItem
                v-for="fav in filteredFavorites"
                :key="`fav-${fav.provider}-${fav.model}`"
                :value="`${fav.provider}/${fav.model}`"
                :text-value="`${fav.model} ${getProviderInfo(fav.provider)?.name ?? fav.provider}`"
                :data-testid="`model-item-${fav.provider}/${fav.model}`"
                class="w-full flex items-center justify-between px-2 py-1 text-xs rounded hover:bg-accent data-[highlighted]:bg-accent data-[state=checked]:bg-accent outline-none cursor-pointer"
                @select="handleSelect"
              >
                <span class="truncate">{{ fav.model }} · {{ getProviderInfo(fav.provider)?.name ?? fav.provider }}</span>
                <button
                  class="size-5 flex items-center justify-center shrink-0 rounded hover:bg-background"
                  :data-testid="`model-favorite-${fav.provider}/${fav.model}`"
                  :aria-label="configStore.isFavorite(fav.provider, fav.model) ? 'Unfavorite' : 'Favorite'"
                  @click.stop.prevent="toggleFav(fav.provider, fav.model)"
                  @pointerdown.stop
                >
                  <span
                    :class="configStore.isFavorite(fav.provider, fav.model) ? 'i-lucide-star text-yellow-500' : 'i-lucide-star-off opacity-30'"
                    class="size-3"
                  />
                </button>
              </ComboboxItem>
            </ComboboxGroup>

            <template
              v-for="group in providerGroups"
              :key="group.provider"
            >
              <CollapsibleRoot
                :open="!isGroupCollapsed(group.provider)"
                :unmount-on-hide="false"
                :data-testid="`model-group-${group.provider}`"
                @update:open="setGroupCollapsed(group.provider, !$event)"
              >
                <ComboboxGroup class="py-1">
                  <ComboboxLabel class="px-2 py-1 text-xs font-medium text-muted-foreground">
                    <CollapsibleTrigger as-child>
                      <button
                        class="w-full flex items-center gap-1 hover:text-foreground transition-colors"
                        @click.stop="toggleGroup(group.provider)"
                      >
                        <span
                          :class="isGroupCollapsed(group.provider) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
                          class="size-3"
                        />
                        <span>{{ group.name }}</span>
                        <span class="text-[10px] opacity-60 ml-auto">{{ group.models.length }}</span>
                      </button>
                    </CollapsibleTrigger>
                  </ComboboxLabel>

                  <CollapsibleContent>
                    <ComboboxItem
                      v-for="model in group.models"
                      :key="`${group.provider}-${model}`"
                      :value="`${group.provider}/${model}`"
                      :text-value="`${model} ${group.name} ${getModelTags(group.provider, model).join(' ')}`"
                      :data-testid="`model-item-${group.provider}/${model}`"
                      class="w-full flex items-center justify-between px-2 py-1 pl-6 text-xs rounded hover:bg-accent data-[highlighted]:bg-accent data-[state=checked]:bg-accent outline-none cursor-pointer"
                      @select="handleSelect"
                    >
                      <div class="min-w-0 flex items-center gap-2">
                        <span class="truncate">{{ model }}</span>
                        <span
                          v-for="tag in getModelTags(group.provider, model)"
                          :key="tag"
                          class="inline-flex items-center px-1 rounded text-[10px] bg-muted text-muted-foreground"
                        >
                          {{ tag }}
                        </span>
                        <span
                          v-if="getModelContextWindow(model)"
                          class="text-[10px] text-muted-foreground"
                        >
                          {{ formatContext(getModelContextWindow(model)) }}
                        </span>
                      </div>
                      <button
                        class="size-5 flex items-center justify-center shrink-0 rounded hover:bg-background"
                        :data-testid="`model-favorite-${group.provider}/${model}`"
                        :aria-label="configStore.isFavorite(group.provider, model) ? 'Unfavorite' : 'Favorite'"
                        @click.stop.prevent="toggleFav(group.provider, model)"
                        @pointerdown.stop
                      >
                        <span
                          :class="configStore.isFavorite(group.provider, model) ? 'i-lucide-star text-yellow-500' : 'i-lucide-star-off opacity-30'"
                          class="size-3"
                        />
                      </button>
                    </ComboboxItem>
                  </CollapsibleContent>
                </ComboboxGroup>
              </CollapsibleRoot>
            </template>
          </template>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>
