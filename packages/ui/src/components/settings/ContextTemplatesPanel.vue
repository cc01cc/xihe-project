<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { ConfigLayer } from '../../stores/config'

/**
 * PLAN-0414 M2: Context Template document editor (Markdown + typed component
 * instances), append-only revision save, and configuration-level build preview.
 * The preview never performs a provider build — full build diagnostics belong
 * to PLAN-0415's builder.
 */
const props = defineProps<{
  entries: Record<string, string>
  saving: boolean
  layer: ConfigLayer
}>()

const emit = defineEmits<{
  save: [entries: Record<string, string>]
}>()

const { t } = useI18n()

interface ComponentDef {
  instanceId: string
  type: string
  enabled: boolean
  config: Record<string, unknown>
}

interface TemplateDef {
  id: string
  version: number
  name: string
  description: string
  document: string
  components: ComponentDef[]
}

const CATALOG = [
  'text', 'system_prompt', 'root_agents_md', 'conversation_history', 'tool_history',
  'tool_definitions', 'workspace_tree', 'agents_md_tree', 'runtime_environment',
] as const

const CATALOG_LABEL_KEYS: Record<string, string> = {
  text: 'settings.contextTemplate.typeText',
  system_prompt: 'settings.contextTemplate.typeSystemPrompt',
  root_agents_md: 'settings.contextTemplate.typeRootAgentsMd',
  conversation_history: 'settings.contextTemplate.typeConversationHistory',
  tool_history: 'settings.contextTemplate.typeToolHistory',
  tool_definitions: 'settings.contextTemplate.typeToolDefinitions',
  workspace_tree: 'settings.contextTemplate.typeWorkspaceTree',
  agents_md_tree: 'settings.contextTemplate.typeAgentsMdTree',
  runtime_environment: 'settings.contextTemplate.typeRuntimeEnvironment',
}

function defaultConfig(type: string): Record<string, unknown> {
  switch (type) {
    case 'text': return { text: '', label: '' }
    case 'system_prompt': return { source: 'system', includeAgentPrompt: true }
    case 'root_agents_md': return { enabled: true, refreshPolicy: 'per_chat_run', maxBytes: 32768, missingPolicy: 'empty_with_status' }
    case 'conversation_history': return { selection: 'recent', maxTurns: 20, maxTokens: 8000, includeCompaction: true }
    case 'tool_history': return { selection: 'recent', maxTokens: 6000, resultMode: 'preview', includeFailedCalls: false, parameterPolicy: 'approved_redaction' }
    case 'tool_definitions': return { selection: 'all_authorized', includeDescriptions: true, includeSchemas: true, maxTools: 64, maxTokens: 4000 }
    case 'workspace_tree': return { root: 'session_workspace', maxDepth: 4, includeFiles: true, maxEntries: 2000 }
    case 'agents_md_tree': return { root: 'session_workspace', maxDepth: 4, fileNames: ['AGENTS.md'], maxEntries: 200 }
    case 'runtime_environment': return { fields: ['cwd', 'platform'], maxTokens: 500, sourceStatus: 'visible' }
    default: return {}
  }
}

const templates = ref<TemplateDef[]>([])
const selectedId = ref<string | null>(null)
const draft = reactive({
  name: '',
  description: '',
  document: '',
  components: [] as ComponentDef[],
})
const configTexts = ref<Record<string, string>>({})
const configErrors = ref<Record<string, string>>({})
const dirty = ref(false)
const insertTypeSelect = ref<HTMLSelectElement | null>(null)

function parseTemplates(raw: string | undefined): TemplateDef[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as TemplateDef[]) : []
  } catch {
    return []
  }
}

const grouped = computed(() => {
  const map = new Map<string, TemplateDef[]>()
  for (const template of templates.value) {
    const list = map.get(template.id) ?? []
    list.push(template)
    map.set(template.id, list)
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.version - b.version)
  }
  return map
})

const latestTemplates = computed(() =>
  [...grouped.value.entries()].map(([id, list]) => ({ id, latest: list[list.length - 1] })),
)

const selectedRevisions = computed(() =>
  selectedId.value ? (grouped.value.get(selectedId.value) ?? []) : [],
)

const selectedLatest = computed(() => {
  const revisions = selectedRevisions.value
  return revisions[revisions.length - 1] ?? null
})

function loadDraft(template: TemplateDef) {
  draft.name = template.name
  draft.description = template.description
  draft.document = template.document
  draft.components = template.components.map(component => ({
    ...component,
    config: { ...component.config },
  }))
  configTexts.value = Object.fromEntries(
    draft.components.map(component => [component.instanceId, JSON.stringify(component.config, null, 2)]),
  )
  configErrors.value = {}
  dirty.value = false
}

watch(() => props.entries.templates, (raw) => {
  templates.value = parseTemplates(raw)
  if (!selectedId.value || !grouped.value.has(selectedId.value)) {
    selectedId.value = latestTemplates.value[0]?.id ?? null
  }
  const latest = selectedLatest.value
  if (latest) loadDraft(latest)
}, { immediate: true })

function selectTemplate(id: string) {
  selectedId.value = id
  const latest = selectedLatest.value
  if (latest) loadDraft(latest)
}

function createTemplate() {
  const id = crypto.randomUUID()
  const template: TemplateDef = {
    id,
    version: 1,
    name: t('settings.contextTemplate.untitled'),
    description: '',
    document: '',
    components: [],
  }
  templates.value = [...templates.value, template]
  selectedId.value = id
  loadDraft(template)
  dirty.value = true
}

function insertComponent(type: string) {
  const component: ComponentDef = {
    instanceId: crypto.randomUUID(),
    type,
    enabled: true,
    config: defaultConfig(type),
  }
  draft.components = [...draft.components, component]
  configTexts.value = {
    ...configTexts.value,
    [component.instanceId]: JSON.stringify(component.config, null, 2),
  }
  const marker = `{{component:${component.instanceId}}}`
  draft.document = draft.document.trim() ? `${draft.document.trimEnd()}\n\n${marker}` : marker
  dirty.value = true
}

function insertSelectedComponent() {
  insertComponent(insertTypeSelect.value?.value ?? CATALOG[0])
}

function moveComponent(instanceId: string, direction: -1 | 1) {
  const index = draft.components.findIndex(component => component.instanceId === instanceId)
  const target = index + direction
  if (index < 0 || target < 0 || target >= draft.components.length) return
  const next = [...draft.components]
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved)
  draft.components = next
  dirty.value = true
}

function handleConfigInput(instanceId: string, event: Event) {
  updateComponentConfig(instanceId, (event.target as HTMLTextAreaElement).value)
}

function removeComponent(instanceId: string) {
  draft.components = draft.components.filter(component => component.instanceId !== instanceId)
  delete configTexts.value[instanceId]
  delete configErrors.value[instanceId]
  draft.document = draft.document
    .split(`{{component:${instanceId}}}`)
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  dirty.value = true
}

function updateComponentConfig(instanceId: string, text: string) {
  configTexts.value = { ...configTexts.value, [instanceId]: text }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object')
    }
    draft.components = draft.components.map(component =>
      component.instanceId === instanceId
        ? { ...component, config: parsed as Record<string, unknown> }
        : component,
    )
    const rest = { ...configErrors.value }
    delete rest[instanceId]
    configErrors.value = rest
  } catch {
    configErrors.value = {
      ...configErrors.value,
      [instanceId]: t('settings.contextTemplate.configInvalid'),
    }
  }
  dirty.value = true
}

function toggleComponent(instanceId: string, enabled: boolean) {
  draft.components = draft.components.map(component =>
    component.instanceId === instanceId ? { ...component, enabled } : component,
  )
  dirty.value = true
}

const MARKER = /\{\{component:([0-9a-fA-F-]{36})\}\}/g

const preview = computed(() => {
  const rows: Array<{ instanceId: string; type: string; status: 'ok' | 'unknown'; summary: string }> = []
  let match: RegExpExecArray | null
  MARKER.lastIndex = 0
  while ((match = MARKER.exec(draft.document)) !== null) {
    const instanceId = match[1].toLowerCase()
    const component = draft.components.find(item => item.instanceId.toLowerCase() === instanceId)
    if (!component) {
      rows.push({ instanceId, type: '—', status: 'unknown', summary: t('settings.contextTemplate.unknownComponent') })
      continue
    }
    rows.push({
      instanceId: component.instanceId,
      type: component.type,
      status: component.enabled ? 'ok' : 'unknown',
      summary: component.enabled ? configSummary(component) : t('settings.contextTemplate.disabledComponent'),
    })
  }
  const budget = draft.components
    .filter(component => component.enabled)
    .reduce((sum, component) => sum + (typeof component.config.maxTokens === 'number' ? component.config.maxTokens : 0), 0)
  return { rows, budget, componentCount: draft.components.length }
})

function configSummary(component: ComponentDef): string {
  const keys = ['maxTokens', 'maxBytes', 'maxTurns', 'maxDepth', 'maxEntries', 'maxTools', 'selection']
  return keys
    .filter(key => component.config[key] !== undefined)
    .map(key => `${key}=${String(component.config[key])}`)
    .join(' ')
}

function saveRevision() {
  const target = selectedLatest.value
  if (!target) return
  if (Object.keys(configErrors.value).length > 0) {
    toast.error(t('settings.contextTemplate.configInvalid'))
    return
  }
  const baseline = parseTemplates(props.entries.templates)
  const persisted = baseline.find(template => template.id === target.id && template.version === target.version)
  if (persisted) {
    const contentChanged =
      draft.name !== persisted.name ||
      draft.description !== persisted.description ||
      draft.document !== persisted.document ||
      JSON.stringify(draft.components) !== JSON.stringify(persisted.components)
    if (!contentChanged) {
      toast.info(t('settings.contextTemplate.noChanges'))
      return
    }
  }
  const next: TemplateDef = persisted
    ? {
        id: target.id,
        version: target.version + 1,
        name: draft.name,
        description: draft.description,
        document: draft.document,
        components: draft.components.map(component => ({
          ...component,
          config: { ...component.config },
        })),
      }
    : {
        ...target,
        name: draft.name,
        description: draft.description,
        document: draft.document,
        components: draft.components.map(component => ({
          ...component,
          config: { ...component.config },
        })),
      }
  const nextTemplates = templates.value.filter(template => !(template.id === next.id && template.version === next.version))
  nextTemplates.push(next)
  templates.value = nextTemplates
  emit('save', { ...props.entries, templates: JSON.stringify(nextTemplates) })
}

function layerLabel(layer: ConfigLayer): string {
  if (layer === 'instance') return t('settings.layerInstance')
  if (layer === 'workspace') return t('settings.layerWorkspace')
  return t('settings.layerUser')
}
</script>

<template>
  <div class="border rounded-lg mb-2 overflow-hidden" data-testid="context-templates-panel">
    <div class="px-4 py-3 flex items-center justify-between gap-2 bg-muted/30">
      <div class="text-sm font-medium">
        {{ t('settings.domainContextTemplates') }}
        <span class="ml-2 text-xs font-normal text-muted-foreground" data-testid="context-template-layer">{{ layerLabel(layer) }}</span>
      </div>
      <button
        type="button"
        data-testid="context-template-new"
        class="text-xs px-2 py-1 rounded border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :disabled="saving"
        @click="createTemplate"
      >
        {{ t('settings.contextTemplate.new') }}
      </button>
    </div>

    <div class="grid gap-0 md:grid-cols-[220px_1fr] border-t">
      <ul class="border-r max-h-96 overflow-y-auto py-1" data-testid="context-template-list">
        <li
          v-for="{ id, latest } in latestTemplates"
          :key="id"
        >
          <button
            type="button"
            class="w-full text-left px-3 py-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :class="{ 'bg-accent font-medium': selectedId === id }"
            :data-testid="`context-template-item-${id}`"
            @click="selectTemplate(id)"
          >
            <span class="block truncate">{{ latest.name || id }}</span>
            <span class="block text-[11px] text-muted-foreground">v{{ latest.version }} · {{ selectedRevisions.length }} {{ t('settings.contextTemplate.revisions') }}</span>
          </button>
        </li>
        <li v-if="latestTemplates.length === 0" class="px-3 py-2 text-xs text-muted-foreground" data-testid="context-template-empty">
          {{ t('settings.contextTemplate.empty') }}
        </li>
      </ul>

      <div v-if="selectedLatest" class="p-4 space-y-4">
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="space-y-1 text-xs">
            <span class="text-muted-foreground">{{ t('settings.contextTemplate.name') }}</span>
            <input
              v-model="draft.name"
              data-testid="context-template-name"
              class="w-full rounded-md border bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              @input="dirty = true"
            />
          </label>
          <label class="space-y-1 text-xs">
            <span class="text-muted-foreground">{{ t('settings.contextTemplate.description') }}</span>
            <input
              v-model="draft.description"
              data-testid="context-template-description"
              class="w-full rounded-md border bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              @input="dirty = true"
            />
          </label>
        </div>

        <div class="space-y-1 text-xs">
          <span class="text-muted-foreground">{{ t('settings.contextTemplate.document') }}</span>
          <textarea
            v-model="draft.document"
            data-testid="context-template-document"
            rows="10"
            spellcheck="false"
            class="w-full font-mono text-xs rounded-md border bg-background px-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            @input="dirty = true"
          />
        </div>

        <div class="space-y-2 text-xs">
          <div class="flex items-center justify-between gap-2">
            <span class="text-muted-foreground">{{ t('settings.contextTemplate.components') }}</span>
            <div class="flex items-center gap-1">
              <label class="sr-only" for="context-template-insert-type">{{ t('settings.contextTemplate.insert') }}</label>
              <select
                id="context-template-insert-type"
                ref="insertTypeSelect"
                data-testid="context-template-insert-select"
                class="rounded-md border bg-background px-2 py-1 text-xs"
              >
                <option v-for="type in CATALOG" :key="type" :value="type">{{ t(CATALOG_LABEL_KEYS[type]) }}</option>
              </select>
              <button
                type="button"
                data-testid="context-template-insert"
                class="px-2 py-1 rounded border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                @click="insertSelectedComponent"
              >
                {{ t('settings.contextTemplate.insert') }}
              </button>
            </div>
          </div>

          <div
            v-for="(component, index) in draft.components"
            :key="component.instanceId"
            class="border rounded-md p-2 space-y-2"
            :data-testid="`context-template-component-${index}`"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="font-medium">{{ t(CATALOG_LABEL_KEYS[component.type] ?? '') || component.type }}</span>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="px-1.5 py-0.5 rounded border text-[11px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  :data-testid="`context-template-component-move-up-${index}`"
                  :disabled="index === 0"
                  :aria-label="t('settings.contextTemplate.moveUp')"
                  @click="moveComponent(component.instanceId, -1)"
                >
                  ↑
                </button>
                <button
                  type="button"
                  class="px-1.5 py-0.5 rounded border text-[11px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  :data-testid="`context-template-component-move-down-${index}`"
                  :disabled="index === draft.components.length - 1"
                  :aria-label="t('settings.contextTemplate.moveDown')"
                  @click="moveComponent(component.instanceId, 1)"
                >
                  ↓
                </button>
                <label class="flex items-center gap-1">
                  <input
                    type="checkbox"
                    :checked="component.enabled"
                    :data-testid="`context-template-component-enabled-${index}`"
                    @change="toggleComponent(component.instanceId, ($event.target as HTMLInputElement).checked)"
                  />
                  <span class="text-muted-foreground">{{ t('settings.contextTemplate.enabled') }}</span>
                </label>
                <button
                  type="button"
                  class="px-2 py-0.5 rounded border text-[11px] hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  :data-testid="`context-template-component-remove-${index}`"
                  @click="removeComponent(component.instanceId)"
                >
                  {{ t('common.delete') }}
                </button>
              </div>
            </div>
            <textarea
              :value="configTexts[component.instanceId]"
              rows="4"
              spellcheck="false"
              class="w-full font-mono text-[11px] rounded-md border bg-background px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              :class="{ 'border-destructive': configErrors[component.instanceId] }"
              :data-testid="`context-template-component-config-${index}`"
              @input="handleConfigInput(component.instanceId, $event)"
            />
            <p v-if="component.type === 'root_agents_md'" class="text-muted-foreground" :data-testid="`context-template-refresh-help-${index}`">
              {{ t('settings.contextTemplate.rootRefreshHelp') }}
            </p>
            <p v-if="configErrors[component.instanceId]" class="text-destructive" :data-testid="`context-template-component-error-${index}`">
              {{ configErrors[component.instanceId] }}
            </p>
          </div>
        </div>

        <div class="border rounded-md p-3 space-y-2 bg-muted/20 text-xs" data-testid="context-template-preview">
          <div class="font-medium">{{ t('settings.contextTemplate.preview') }}</div>
          <p class="text-muted-foreground">{{ t('settings.contextTemplate.previewNote') }}</p>
          <ul class="space-y-1">
            <li
              v-for="(row, index) in preview.rows"
              :key="`${row.instanceId}-${index}`"
              class="flex items-center justify-between gap-2"
              :data-testid="`context-template-preview-row-${index}`"
            >
              <span class="truncate font-mono">{{ row.type }}</span>
              <span
                class="px-1.5 py-0.5 rounded text-[10px]"
                :class="row.status === 'ok' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-amber-500/15 text-amber-700 dark:text-amber-400'"
                :data-testid="`context-template-preview-status-${index}`"
              >
                {{ row.status === 'ok' ? t('settings.contextTemplate.statusOk') : t('settings.contextTemplate.statusUnknown') }}
              </span>
              <span class="truncate text-muted-foreground">{{ row.summary }}</span>
            </li>
            <li v-if="preview.rows.length === 0" class="text-muted-foreground" data-testid="context-template-preview-empty">
              {{ t('settings.contextTemplate.previewEmpty') }}
            </li>
          </ul>
          <div class="flex items-center justify-between border-t pt-2" data-testid="context-template-preview-budget">
            <span>{{ t('settings.contextTemplate.estimate') }}</span>
            <span class="font-medium">{{ preview.budget }} tokens · {{ preview.componentCount }} {{ t('settings.contextTemplate.components') }}</span>
          </div>
        </div>

        <div class="flex items-center justify-between gap-2">
          <div class="flex flex-wrap gap-1" data-testid="context-template-revisions">
            <span
              v-for="revision in selectedRevisions"
              :key="revision.version"
              class="px-1.5 py-0.5 rounded border text-[10px] text-muted-foreground"
              :class="{ 'border-primary text-primary': revision.version === selectedLatest?.version }"
            >
              v{{ revision.version }}
            </span>
          </div>
          <button
            type="button"
            data-testid="context-template-save"
            class="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            :disabled="saving || !dirty"
            @click="saveRevision"
          >
            {{ saving ? t('common.saving') : t('settings.contextTemplate.saveVersion') }}
          </button>
        </div>
      </div>
      <div v-else class="p-4 text-xs text-muted-foreground" data-testid="context-template-no-selection">
        {{ t('settings.contextTemplate.empty') }}
      </div>
    </div>
  </div>
</template>
