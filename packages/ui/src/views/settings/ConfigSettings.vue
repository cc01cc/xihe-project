<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { useConfigStore } from '../../stores/config'
import ConfigDomainPanel, { type DomainField } from '../../components/settings/ConfigDomainPanel.vue'
import SettingsNav from '../../components/settings/SettingsNav.vue'
import BackToChatButton from '../../components/settings/BackToChatButton.vue'
import { api, request } from '../../composables/api'

const { t } = useI18n()
const configStore = useConfigStore()

type LayerTab = 'system' | 'admin' | 'user'
const activeTab = ref<LayerTab>('admin')

const tabs: { key: LayerTab; label: string }[] = [
  { key: 'system', label: t('settings.tabSystem') },
  { key: 'admin', label: t('settings.tabAdmin') },
  { key: 'user', label: t('settings.tabUser') },
]

const domainLabels: Record<string, string> = {
  'infrastructure': t('settings.domainInfrastructure'),
  'logging': t('settings.domainLogging'),
  'llm-provider': t('settings.domainLlmProvider'),
  'embedding': t('settings.domainEmbedding'),
  'user-preference': t('settings.domainUserPreference'),
  'workspace-config': t('settings.domainWorkspaceConfig'),
  'mcp': t('settings.domainMcp'),
  'rag': t('settings.domainRag'),
}

const domainSchemas: Record<string, DomainField[]> = {
  'llm-provider': [
    { key: 'defaultProvider', label: t('settings.fieldDefaultProvider'), type: 'select', options: [
      { label: 'DeepSeek', value: 'deepseek' },
      { label: 'OpenAI', value: 'openai' },
      { label: 'Anthropic', value: 'anthropic' },
      { label: 'Xiaomi', value: 'xiaomi' },
    ]},
    { key: 'deepseekApiKey', label: t('settings.fieldDeepseekApiKey'), type: 'password' },
    { key: 'deepseekModel', label: t('settings.fieldDeepseekModel'), type: 'text' },
    { key: 'deepseekApiBase', label: t('settings.fieldDeepseekApiBase'), type: 'text' },
    { key: 'openaiApiKey', label: t('settings.fieldOpenaiApiKey'), type: 'password' },
    { key: 'xiaomiApiKey', label: t('settings.fieldXiaomiApiKey'), type: 'password' },
    { key: 'imageProvider', label: t('settings.fieldImageProvider'), type: 'select', options: [
      { label: 'DeepSeek', value: 'deepseek' },
      { label: 'OpenAI', value: 'openai' },
      { label: '', value: '' },
    ]},
  ],
  'logging': [
    { key: 'logLevel', label: t('settings.fieldLogLevel'), type: 'text' },
    { key: 'levelAgent', label: t('settings.fieldLevelAgent'), type: 'text' },
    { key: 'levelCp', label: t('settings.fieldLevelCp'), type: 'text' },
    { key: 'levelRuntime', label: t('settings.fieldLevelRuntime'), type: 'text' },
    { key: 'levelUi', label: t('settings.fieldLevelUi'), type: 'text' },
    { key: 'auditConsole', label: t('settings.fieldAuditConsole'), type: 'text' },
    { key: 'instructions', label: t('settings.fieldInstructions'), type: 'text' },
    { key: 'userName', label: t('settings.fieldUserName'), type: 'text' },
    { key: 'useRegistry', label: t('settings.fieldUseRegistry'), type: 'text' },
    { key: 'useSupervisor', label: t('settings.fieldUseSupervisor'), type: 'text' },
  ],
  'embedding': [
    { key: 'model', label: t('settings.fieldModel'), type: 'select', options: [
      { label: 'text-embedding-3-small', value: 'text-embedding-3-small' },
      { label: 'text-embedding-3-large', value: 'text-embedding-3-large' },
    ]},
    { key: 'dimensions', label: t('settings.fieldDimensions'), type: 'number' },
  ],
  'user-preference': [
    { key: 'defaultModel', label: t('settings.fieldDefaultModel'), type: 'text' },
    { key: 'maxTokens', label: t('settings.fieldMaxTokens'), type: 'number' },
    { key: 'temperature', label: t('settings.fieldTemperature'), type: 'number' },
    { key: 'timeout', label: t('settings.fieldTimeout'), type: 'number' },
    { key: 'theme', label: t('settings.fieldTheme'), type: 'select', options: [
      { label: t('settings.light'), value: 'light' },
      { label: t('settings.dark'), value: 'dark' },
      { label: t('settings.system'), value: 'system' },
    ]},
  ],
  'workspace-config': [
    { key: 'workspacePath', label: t('settings.fieldWorkspacePath'), type: 'text' },
    { key: 'workspaceId', label: t('settings.fieldWorkspaceId'), type: 'text' },
    { key: 'image', label: t('settings.fieldImage'), type: 'text' },
    { key: 'dockerImage', label: t('settings.fieldDockerImage'), type: 'text' },
    { key: 'profile', label: t('settings.fieldProfile'), type: 'text' },
  ],
  'rag': [
    { key: 'chunk_size', label: t('settings.fieldChunkSize'), type: 'number' },
    { key: 'top_k', label: t('settings.fieldTopK'), type: 'number' },
  ],
  'infrastructure': [
    { key: 'dbUrl', label: t('settings.fieldDbUrl'), type: 'password' },
    { key: 'jwtSecret', label: t('settings.fieldJwtSecret'), type: 'password' },
  ],
}

const adminDomains = ['llm-provider', 'mcp', 'rag', 'logging', 'embedding', 'workspace-config', 'user-preference']
const userDomains = adminDomains
const systemDomains = ['infrastructure', ...adminDomains]

const fetchError = ref(false)
const mcpJson = ref('')
const mcpError = ref('')
const mcpSaving = ref(false)

const mcpReadonly = computed(() => activeTab.value === 'system')

const builtInTools = [
  'read_file', 'write_file', 'list_directory', 'execute_command',
  'glob', 'grep', 'edit_file', 'delete_file',
  'read_file_range', 'create_directory', 'move_file',
  'search_code', 'web_fetch', 'list_files',
  'file_exists', 'get_file_info', 'zip_directory',
  'unzip_file', 'download_file',
]

onMounted(async () => {
  try {
    await configStore.loadAllDomains()
    await loadMcpConfig()
  } catch (e) {
    console.warn('Failed to load config domains', e)
    fetchError.value = true
    toast.error('Failed to load configuration')
  }
})

async function loadMcpConfig() {
  try {
    const resp = await api.getMcpConfig('default') as { mcpServers?: string }
    if (resp.mcpServers) {
      mcpJson.value = JSON.stringify(resp.mcpServers, null, 2)
    } else {
      mcpJson.value = JSON.stringify({ mcpServers: {} }, null, 2)
    }
  } catch (e) {
    console.warn('Failed to load MCP config, using empty default', e)
    mcpJson.value = JSON.stringify({ mcpServers: {} }, null, 2)
  }
}

async function saveMcpConfig() {
  mcpSaving.value = true
  mcpError.value = ''
  try {
    const parsed = JSON.parse(mcpJson.value)
    await api.saveMcpConfig('default', parsed.mcpServers)
    toast.success(t('common.saved'))
  } catch (e) {
    if (e instanceof SyntaxError) {
      mcpError.value = t('settings.invalidJson')
    } else {
      toast.error(t('settings.saveFailed'))
    }
  } finally {
    mcpSaving.value = false
  }
}

function generateSummary(domain: string): string {
  const entries = configStore.mergedConfig[domain] || {}
  if (Object.keys(entries).length === 0) return ''
  if (domain === 'llm-provider') {
    const provider = entries['defaultProvider'] || entries['deepseekApiKey'] ? 'DeepSeek' : ''
    return provider ? `${provider} (已配置)` : ''
  }
  if (domain === 'mcp') {
    const serverCount = mcpJson.value.includes('mcpServers') ? (mcpJson.value.match(/"command"/g) || []).length : 0
    return serverCount > 0 ? `${serverCount} 个服务器已配置` : ''
  }
  if (domain === 'rag') {
    const cs = entries['chunk_size']
    const tk = entries['top_k']
    return [cs && `chunk: ${cs}`, tk && `top_k: ${tk}`].filter(Boolean).join(', ')
  }
  if (domain === 'embedding') {
    const model = entries['model']
    const dims = entries['dimensions']
    return [model, dims && `(${dims}d)`].filter(Boolean).join(' ')
  }
  if (domain === 'logging') {
    const level = entries['logLevel'] || entries['levelAgent']
    return level ? `level: ${level}` : ''
  }
  if (domain === 'workspace-config') {
    const profile = entries['profile']
    return profile ? `profile: ${profile}` : ''
  }
  return ''
}

function visibleDomains(): string[] {
  if (activeTab.value === 'system') return systemDomains
  if (activeTab.value === 'admin') return adminDomains
  return userDomains
}

async function handleAdminSave(domain: string, body: Record<string, string>) {
  try {
    await configStore.putAdminConfig(domain, body)
    await configStore.loadAllDomains()
    toast.success(`${domainLabels[domain] || domain} ${t('common.saved')}`)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : `Failed to save ${domain}`)
  }
}

async function handleUserSave(domain: string, body: Record<string, string>) {
  try {
    await configStore.putUserConfig(domain, body)
    await configStore.loadAllDomains()
    toast.success(`${domainLabels[domain] || domain} ${t('common.saved')}`)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : `Failed to save ${domain}`)
  }
}

async function handleReset(domain: string, key: string) {
  try {
    await request(`/config/admin/${domain}`, {
      method: 'PUT',
      body: JSON.stringify({ [key]: '' }),
    })
    await configStore.loadAllDomains()
    toast.success(`${key} ${t('common.reset')}`)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Reset failed')
  }
}

</script>

<template>
  <div>
    <BackToChatButton />
    <SettingsNav />
    <div class="max-w-2xl mx-auto px-4 py-6">
      <h2 class="text-lg font-semibold mb-4">{{ t('settings.configTab') }}</h2>

      <div v-if="fetchError" class="mb-3 px-3 py-2 text-sm bg-red-100 text-red-800 rounded">
        {{ t('common.error') }}: {{ t('settings.saveFailed') }}
      </div>

      <div v-if="configStore.loading" class="text-sm text-muted-foreground">{{ t('common.loading') }}</div>

      <template v-else>
        <div class="flex gap-1 border-b mb-4">
          <button
            v-for="tab in tabs"
            :key="tab.key"
            class="px-4 py-2 text-sm border-b-2 transition-colors"
            :class="activeTab === tab.key
              ? 'border-primary text-foreground font-medium'
              : 'border-transparent text-muted-foreground hover:text-foreground'"
            @click="activeTab = tab.key"
          >
            {{ tab.label }}
          </button>
        </div>

        <div class="space-y-1">
          <template v-for="domain in visibleDomains()" :key="domain">
            <ConfigDomainPanel
              v-if="domain !== 'mcp'"
              :domain="domain"
              :title="domainLabels[domain] || domain"
              :entries="configStore.mergedConfig[domain] || {}"
              :readonly="activeTab === 'system'"
              :admin="activeTab === 'admin'"
              :summary="generateSummary(domain)"
              :schema="domainSchemas[domain] ?? []"
              @save="activeTab === 'user' ? handleUserSave(domain, $event) : handleAdminSave(domain, $event)"
              @reset="handleReset(domain, $event)"
            />
          </template>

          <div v-if="visibleDomains().includes('mcp')" class="border rounded-lg mb-2 overflow-hidden">
            <div class="px-4 py-3 text-sm font-medium bg-muted/30">
              {{ domainLabels['mcp'] }}
            </div>
            <div class="px-4 pb-3 space-y-3">
              <div v-if="activeTab === 'system'" class="text-sm text-muted-foreground">
                {{ t('settings.builtInTools') }}
              </div>
              <div v-if="activeTab === 'admin' || activeTab === 'user'" class="space-y-2">
                <div class="flex flex-wrap gap-2 mb-3">
                  <span
                    v-for="tool in builtInTools"
                    :key="tool"
                    class="text-xs px-2 py-1 rounded-full bg-primary/10 text-primary"
                  >
                    {{ tool }}
                  </span>
                </div>
                <textarea
                  v-model="mcpJson"
                  class="w-full h-48 px-4 py-3 rounded-lg border bg-background font-mono text-sm resize-y"
                  :disabled="mcpReadonly"
                />
                <p v-if="mcpError" class="text-xs text-destructive">{{ mcpError }}</p>
                <div v-if="!mcpReadonly" class="flex gap-2">
                  <button
                    class="px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-50"
                    :disabled="mcpSaving"
                    @click="saveMcpConfig"
                  >
                    {{ mcpSaving ? t('common.saving') : t('common.save') }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
