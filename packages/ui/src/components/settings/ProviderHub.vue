<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { toast } from 'vue-sonner'
import { logger } from '../../lib/logger'
import {
  createProviderConnection,
  deleteProviderConnection,
  listProviderCatalog,
  listProviderConnections,
  updateProviderConnection,
  verifyProviderConnection,
} from '../../services/providerConnectionService'
import type {
  ProviderConnection,
  ProviderConnectionInput,
  ProviderDefinition,
  ProviderScope,
} from '../../types/providerConnection'

const props = withDefaults(defineProps<{
  scope: Exclude<ProviderScope, 'SYSTEM'>
  readonly?: boolean
}>(), {
  readonly: false,
})

const providers = ref<ProviderDefinition[]>([])
const connections = ref<ProviderConnection[]>([])
const search = ref('')
const loading = ref(false)
const modalOpen = ref(false)
const formOpen = ref(false)
const selectedProvider = ref<ProviderDefinition | null>(null)
const editingConnection = ref<ProviderConnection | null>(null)
const formScope = ref<'USER' | 'WORKSPACE'>('USER')
const saving = ref(false)
const verifyingId = ref<string | null>(null)
const pickerSearch = ref('')

const form = reactive({
  label: '',
  apiKey: '',
  baseUrl: '',
  modelDiscovery: 'remote-models' as ProviderDefinition['modelDiscovery'],
  manualModels: '',
})

const connectedProviderIds = computed(() => new Set(connections.value.map((connection) => connection.providerId)))

function providerName(providerId: string): string {
  return providers.value.find((provider) => provider.id === providerId)?.displayName ?? providerId
}

function adapterLabel(provider: ProviderDefinition): string {
  return {
    'native-litellm': '原生适配',
    'openai-compatible': 'OpenAI 兼容',
    'manual-model': '手动模型',
  }[provider.adapter]
}

const selectableProviders = computed(() => {
  const query = pickerSearch.value.trim().toLowerCase()
  return providers.value
    .filter(() => !props.readonly)
    .filter((provider) => {
      if (!query) return true
      return `${provider.displayName} ${provider.id} ${provider.description ?? ''}`
        .toLowerCase().includes(query)
    })
})

function pickerGroupLabel(provider: ProviderDefinition): string {
  if (provider.category === 'recommended') return '推荐'
  if (provider.category === 'custom') return '本地与自定义'
  return '其他'
}

const pickerGroups = computed(() => {
  const groups: Array<{ label: string; items: ProviderDefinition[] }> = []
  const labels = ['推荐', '其他', '本地与自定义']
  for (const label of labels) {
    const items = selectableProviders.value.filter((provider) => pickerGroupLabel(provider) === label)
    if (items.length > 0) groups.push({ label, items })
  }
  return groups
})

function statusLabel(status: ProviderConnection['status']): string {
  return {
    READY: '已连接',
    VERIFYING: '验证中',
    INVALID_CREDENTIALS: '密钥无效',
    UNREACHABLE: '无法连接',
    DISABLED: '已停用',
    UNVERIFIED: '待验证',
  }[status]
}

function statusClass(status: ProviderConnection['status']): string {
  if (status === 'READY') return 'text-emerald-600 dark:text-emerald-400'
  if (status === 'VERIFYING') return 'text-amber-600 dark:text-amber-400'
  if (status === 'INVALID_CREDENTIALS' || status === 'UNREACHABLE') return 'text-red-600 dark:text-red-400'
  return 'text-muted-foreground'
}

function formatVerifiedAt(value?: string | null): string {
  if (!value) return '未验证'
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return '未验证'
  const diff = Date.now() - time.getTime()
  if (diff < 60_000) return '刚刚验证'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前验证`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前验证`
  return `${Math.floor(diff / 86_400_000)} 天前验证`
}

function resetForm(provider: ProviderDefinition, connection?: ProviderConnection) {
  selectedProvider.value = provider
  editingConnection.value = connection ?? null
  formScope.value = connection?.scope === 'WORKSPACE' ? 'WORKSPACE' : props.scope
  form.label = connection?.label ?? `${provider.displayName} 连接`
  form.apiKey = ''
  form.baseUrl = connection?.baseUrl ?? provider.defaultBaseUrl ?? ''
  form.modelDiscovery = provider.modelDiscovery
  form.manualModels = ''
}

function openPicker() {
  if (props.readonly) return
  pickerSearch.value = ''
  modalOpen.value = true
}

function openConnect(provider: ProviderDefinition) {
  modalOpen.value = false
  resetForm(provider)
  formOpen.value = true
}

function openManage(connection: ProviderConnection) {
  if (props.readonly) return
  const provider = providers.value.find((item) => item.id === connection.providerId)
  if (provider) {
    resetForm(provider, connection)
    formOpen.value = true
  }
}

function closeForm() {
  if (saving.value) return
  formOpen.value = false
  selectedProvider.value = null
  editingConnection.value = null
}

async function load() {
  loading.value = true
  try {
    const [catalog, connected] = await Promise.all([listProviderCatalog(), listProviderConnections()])
    providers.value = catalog.providers
    connections.value = connected.connections
  } catch (cause: unknown) {
    logger.warn('Provider Hub load failed', cause)
    toast.error(cause instanceof Error ? cause.message : 'Provider 配置加载失败')
  } finally {
    loading.value = false
  }
}

async function save() {
  const provider = selectedProvider.value
  if (!provider) return
  if (provider.credential.required && !editingConnection.value && !form.apiKey.trim()) {
    toast.error('请输入 API key')
    return
  }
  saving.value = true
  try {
    const input: ProviderConnectionInput = {
      providerId: provider.id,
      label: form.label.trim(),
      scope: formScope.value,
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      ...(form.baseUrl.trim() ? { baseUrl: form.baseUrl.trim() } : {}),
      modelDiscovery: form.modelDiscovery,
      manualModels: form.manualModels
        .split(/[,\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
    }
    const connection = editingConnection.value
      ? await updateProviderConnection(editingConnection.value.id, input)
      : await createProviderConnection(input)
    const verification = await verifyProviderConnection(connection.id)
    await load()
    if (verification.connection.status === 'READY') toast.success('Provider 已连接并验证')
    else toast.warning(`Provider ${statusLabel(verification.connection.status)}`)
    closeForm()
  } catch (cause: unknown) {
    logger.warn('Provider Hub save failed', cause)
    toast.error(cause instanceof Error ? cause.message : 'Provider 保存失败')
  } finally {
    saving.value = false
  }
}

async function verify(connection: ProviderConnection) {
  verifyingId.value = connection.id
  try {
    const result = await verifyProviderConnection(connection.id)
    await load()
    if (result.connection.status === 'READY') toast.success('Provider 验证成功')
    else toast.error(`Provider ${statusLabel(result.connection.status)}`)
  } catch (cause: unknown) {
    logger.warn('Provider Hub verification failed', cause)
    toast.error(cause instanceof Error ? cause.message : 'Provider 验证失败')
  } finally {
    verifyingId.value = null
  }
}

async function remove(connection: ProviderConnection) {
  if (!window.confirm(`删除 ${connection.label}？`)) return
  try {
    await deleteProviderConnection(connection.id)
    await load()
    toast.success('Provider 已删除')
  } catch (cause: unknown) {
    logger.warn('Provider Hub delete failed', cause)
    toast.error(cause instanceof Error ? cause.message : 'Provider 删除失败')
  }
}

onMounted(() => { void load() })
</script>

<template>
  <section
    data-testid="provider-hub"
    class="space-y-6 rounded-xl border bg-card p-5 sm:p-7"
  >
    <header>
      <div class="text-xs font-semibold uppercase tracking-widest text-primary">连接层</div>
      <h3 class="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">Providers</h3>
      <p class="mt-1.5 text-sm text-muted-foreground">
        连接模型服务。密钥由 Control Plane 加密保存，不写入浏览器存储。
      </p>
    </header>

    <div
      v-if="loading"
      class="py-10 text-center text-sm text-muted-foreground"
    >
      加载 Provider Catalog...
    </div>

    <template v-else>
      <div class="flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <label class="flex flex-1 items-center gap-2.5 rounded-lg border bg-background px-3.5 py-2.5">
          <span class="i-lucide-search size-4 shrink-0 text-muted-foreground" />
          <input
            v-model="search"
            data-testid="provider-connection-search"
            class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            placeholder="搜索已连接的 Provider"
          >
        </label>
        <button
          v-if="!props.readonly"
          data-testid="provider-hub-connect"
          class="shrink-0 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          :disabled="providers.length === 0"
          @click="openPicker"
        >＋ 连接 Provider</button>
      </div>

      <section>
        <div class="mb-2.5 flex items-center justify-between">
          <h4 class="text-sm font-semibold">已连接</h4>
          <span class="text-xs text-muted-foreground">{{ connections.length }} 个连接</span>
        </div>
        <div
          v-if="connections.length === 0"
          class="rounded-lg border border-dashed px-4 py-7 text-center text-sm text-muted-foreground"
        >
          尚未连接 Provider，点击右上角「连接 Provider」开始。
        </div>
        <div
          v-else
          class="space-y-2"
        >
          <article
            v-for="connection in connections"
            :key="connection.id"
            class="flex flex-wrap items-center gap-3.5 rounded-lg border bg-background p-4"
            :data-testid="`provider-connection-${connection.providerId}`"
          >
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-sm font-semibold">{{ connection.label }}</span>
                <span class="inline-flex items-center gap-1.5 text-xs font-semibold" :class="statusClass(connection.status)">
                  <span class="size-1.5 rounded-full bg-current" />{{ statusLabel(connection.status) }}
                </span>
              </div>
              <div class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                <span>{{ providerName(connection.providerId) }}</span>
                <span>{{ connection.hasKey ? (connection.maskedKey || '已配置 key') : '无 key' }}</span>
                <span v-if="connection.modelCount != null">{{ connection.modelCount }} 个模型</span>
                <span>{{ formatVerifiedAt(connection.lastVerifiedAt) }}</span>
              </div>
            </div>
            <div class="flex shrink-0 gap-1.5">
              <button
                class="rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-50"
                :disabled="verifyingId === connection.id || props.readonly"
                @click="verify(connection)"
              >
                {{ verifyingId === connection.id ? '验证中' : '验证' }}
              </button>
              <button
                class="rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-50"
                :disabled="props.readonly"
                @click="openManage(connection)"
              >管理</button>
              <button
                class="rounded-md border px-2.5 py-1.5 text-xs text-destructive transition-colors hover:border-destructive disabled:opacity-50"
                :disabled="props.readonly"
                @click="remove(connection)"
              >删除</button>
            </div>
          </article>
        </div>
      </section>

      <div class="flex items-start gap-3 rounded-lg border-l-[3px] border-primary bg-muted/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        <span class="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">i</span>
        <div>
          <strong class="font-semibold text-foreground">连接作用域</strong><br>
          个人连接对同一 Provider 优先于工作区共享连接。API key 由 Control Plane 加密存储，不会出现在浏览器存储或日志中。
        </div>
      </div>
    </template>

    <div
      v-if="modalOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 sm:p-6"
      data-testid="provider-picker-modal"
      @click.self="modalOpen = false"
    >
      <div class="flex max-h-[calc(100vh-48px)] w-full max-w-lg flex-col overflow-hidden rounded-xl border bg-card shadow-2xl">
        <header class="border-b px-5 py-4">
          <h3 class="text-lg font-semibold">选择 Provider</h3>
          <label class="mt-3 flex items-center gap-2.5 rounded-lg border bg-background px-3 py-2">
            <span class="i-lucide-search size-4 shrink-0 text-muted-foreground" />
            <input
              v-model="pickerSearch"
              data-testid="provider-picker-search"
              class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              placeholder="搜索名称、描述或 ID"
            >
          </label>
        </header>
        <div class="flex-1 overflow-y-auto px-2 py-2">
          <p
            v-if="selectableProviders.length === 0"
            class="px-3 py-8 text-center text-sm text-muted-foreground"
          >没有匹配的 Provider</p>
          <template
            v-for="group in pickerGroups"
            :key="group.label"
          >
            <div class="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {{ group.label }}
            </div>
            <button
              v-for="provider in group.items"
              :key="provider.id"
              class="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted"
              :data-testid="`provider-picker-${provider.id}`"
              @click="openConnect(provider)"
            >
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-medium">{{ provider.displayName }}</span>
                <span class="block truncate text-xs text-muted-foreground">
                  {{ provider.description || `${adapterLabel(provider)} · ${provider.modelDiscovery}` }}
                </span>
              </span>
              <span
                v-if="connectedProviderIds.has(provider.id)"
                class="shrink-0 text-[11px] text-muted-foreground"
              >已连接</span>
            </button>
          </template>
        </div>
        <footer class="flex items-center justify-between border-t px-5 py-3 text-xs text-muted-foreground">
          <span>{{ selectableProviders.length }} 个可连接</span>
          <button
            class="rounded-md border px-3 py-1.5 transition-colors hover:border-primary hover:text-foreground"
            @click="modalOpen = false"
          >取消</button>
        </footer>
      </div>
    </div>

    <div
      v-if="formOpen && selectedProvider"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 sm:p-6"
      data-testid="provider-connection-modal"
      @click.self="closeForm"
    >
      <form
        class="max-h-[calc(100vh-48px)] w-full max-w-xl overflow-y-auto rounded-xl border bg-card shadow-2xl"
        @submit.prevent="save"
      >
        <header class="flex items-center justify-between border-b px-5 py-4">
          <h3 class="text-lg font-semibold">{{ editingConnection ? '管理 Provider' : '连接 Provider' }}</h3>
          <button
            type="button"
            class="text-2xl leading-none text-muted-foreground transition-colors hover:text-foreground"
            aria-label="关闭"
            @click="closeForm"
          >×</button>
        </header>
        <div class="px-5 py-5">
          <div class="mb-5">
            <strong class="block text-sm">{{ selectedProvider.displayName }}</strong>
            <span class="text-xs text-muted-foreground">{{ adapterLabel(selectedProvider) }} · {{ selectedProvider.modelDiscovery }}</span>
          </div>

          <label class="block">
            <span class="mb-1.5 block text-xs font-semibold">连接名称</span>
            <input
              v-model="form.label"
              class="w-full rounded-md border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              required
              maxlength="128"
            >
          </label>
          <label class="mt-4 block">
            <span class="mb-1.5 block text-xs font-semibold">API key</span>
            <input
              v-model="form.apiKey"
              class="w-full rounded-md border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              type="password"
              :placeholder="editingConnection ? '留空表示不替换' : (selectedProvider.credential.placeholder || '可选')"
            >
            <span class="mt-1.5 block text-[11px] text-muted-foreground">密钥只提交一次，保存后不会回显。</span>
          </label>
          <label
            v-if="selectedProvider.supports.customBaseUrl"
            class="mt-4 block"
          >
            <span class="mb-1.5 block text-xs font-semibold">Base URL <span class="font-normal text-muted-foreground">可选</span></span>
            <input
              v-model="form.baseUrl"
              class="w-full rounded-md border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              type="url"
              :placeholder="selectedProvider.defaultBaseUrl || 'https://...'"
            >
          </label>
          <div class="mt-4">
            <span class="mb-1.5 block text-xs font-semibold">连接作用域</span>
            <div class="grid grid-cols-2 gap-2">
              <label
                v-for="option in ([{ value: 'USER', title: '个人', desc: '仅自己可使用。' }, { value: 'WORKSPACE', title: '工作区共享', desc: '工作区内授权用户可用。' }] as const)"
                :key="option.value"
                class="cursor-pointer"
              >
                <input
                  v-model="formScope"
                  type="radio"
                  name="provider-scope"
                  :value="option.value"
                  class="peer sr-only"
                >
                <span class="block h-full rounded-md border p-3 transition-colors peer-checked:border-primary peer-checked:bg-primary/5">
                  <strong class="block text-xs font-semibold">{{ option.title }}</strong>
                  <span class="text-[11px] text-muted-foreground">{{ option.desc }}</span>
                </span>
              </label>
            </div>
          </div>
          <label class="mt-4 block">
            <span class="mb-1.5 block text-xs font-semibold">模型发现</span>
            <select
              v-model="form.modelDiscovery"
              class="w-full rounded-md border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="remote-models">Provider /models</option>
              <option value="litellm-catalog">LiteLLM Catalog</option>
              <option value="curated">精选模型</option>
              <option value="manual">手动输入模型</option>
            </select>
            <span class="mt-1.5 block text-[11px] text-muted-foreground">XH 会先验证连接可用，再让模型进入选择器。</span>
          </label>
          <label
            v-if="form.modelDiscovery === 'manual'"
            class="mt-4 block"
          >
            <span class="mb-1.5 block text-xs font-semibold">模型列表</span>
            <textarea
              v-model="form.manualModels"
              class="min-h-20 w-full rounded-md border bg-background px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              placeholder="每行一个模型 ID"
            />
          </label>
        </div>
        <footer class="flex justify-end gap-2 border-t bg-muted/30 px-5 py-3.5">
          <button
            type="button"
            class="rounded-md border px-3.5 py-2 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
            @click="closeForm"
          >取消</button>
          <button
            type="submit"
            class="rounded-md bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            :disabled="saving"
          >{{ saving ? '保存中...' : '验证并保存' }}</button>
        </footer>
      </form>
    </div>
  </section>
</template>
