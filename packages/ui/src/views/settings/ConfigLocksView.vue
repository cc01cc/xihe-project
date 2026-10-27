<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ApiError, request } from "../../composables/api";
import { useAuthStore } from "../../stores/auth";
import { INSTANCE_DOMAINS, type ConfigDomain } from "../../stores/config";

/**
 * PLAN-0556: the admin-only lock page. Ordinary config pages only render the
 * resulting badge; locking lives here exclusively.
 */
interface ConfigLockKey {
    key: string;
    lockable: boolean;
    notLockableReason: string | null;
    locked: boolean;
    reason: string | null;
    mode: string | null;
    updatedBy: string | null;
    updatedAt: string | null;
    revision: number;
    valuePresent: boolean;
}

interface ConfigLockCatalog {
    domain: string | null;
    revision: number;
    keys: ConfigLockKey[];
}

const { t } = useI18n();
const auth = useAuthStore();
const isAdmin = computed(() => auth.isAdmin);

const domains = INSTANCE_DOMAINS;
const domain = ref<ConfigDomain>("rag");
const catalog = ref<ConfigLockCatalog | null>(null);
const values = ref<Record<string, string>>({});
const loading = ref(false);
const error = ref("");
const notice = ref("");

const selected = ref("");
const formValue = ref("");
const formReason = ref("");
const clearValue = ref(false);
const saving = ref(false);

const selectedKey = computed(
    () => catalog.value?.keys.find((row) => row.key === selected.value) ?? null,
);
const lockedCount = computed(() => catalog.value?.keys.filter((row) => row.locked).length ?? 0);

async function load() {
    if (!isAdmin.value) return;
    loading.value = true;
    error.value = "";
    try {
        const [nextCatalog, nextValues] = await Promise.all([
            request<ConfigLockCatalog>(`/config-locks?domain=${domain.value}`),
            request<Record<string, string>>(`/config/${domain.value}?layer=instance`),
        ]);
        catalog.value = nextCatalog;
        values.value = nextValues;
        if (selected.value && !nextCatalog.keys.some((row) => row.key === selected.value)) {
            selected.value = "";
        }
    } catch (cause) {
        error.value = describe(cause);
    } finally {
        loading.value = false;
    }
}

function describe(cause: unknown): string {
    if (cause instanceof ApiError) {
        return `${cause.problem.code}: ${cause.problem.detail ?? ""}`.trim();
    }
    return cause instanceof Error ? cause.message : String(cause);
}

function pick(row: ConfigLockKey) {
    selected.value = row.key;
    formValue.value = values.value[row.key] ?? "";
    formReason.value = row.reason ?? "";
    clearValue.value = false;
    error.value = "";
    notice.value = "";
}

function notLockableText(row: ConfigLockKey): string {
    if (!row.notLockableReason) return "";
    return t(`settings.configLockReason${row.notLockableReason}`, row.notLockableReason);
}

async function saveLock() {
    const row = selectedKey.value;
    if (!row || saving.value) return;
    saving.value = true;
    error.value = "";
    notice.value = "";
    try {
        await request(`/config-locks/${domain.value}/${row.key}`, {
            method: "PUT",
            body: JSON.stringify({
                mode: "enforce_value",
                reason: formReason.value,
                value: formValue.value,
                revision: row.revision,
            }),
        });
        notice.value = t("settings.configLockSaved");
        await load();
    } catch (cause) {
        error.value = describe(cause);
    } finally {
        saving.value = false;
    }
}

async function unlock() {
    const row = selectedKey.value;
    if (!row || saving.value) return;
    saving.value = true;
    error.value = "";
    notice.value = "";
    try {
        await request(
            `/config-locks/${domain.value}/${row.key}?revision=${row.revision}&clearValue=${clearValue.value}`,
            { method: "DELETE" },
        );
        notice.value = t("settings.configLockRemoved");
        selected.value = "";
        await load();
    } catch (cause) {
        error.value = describe(cause);
    } finally {
        saving.value = false;
    }
}

onMounted(load);
watch(domain, () => {
    selected.value = "";
    notice.value = "";
    void load();
});
</script>

<template>
    <div data-testid="config-locks-view" class="max-w-5xl">
        <template v-if="!isAdmin">
            <div
                data-testid="config-locks-forbidden"
                class="max-w-md mx-auto mt-16 border rounded-xl bg-card p-6 text-center"
            >
                <div
                    class="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-rose-500/50 bg-rose-500/10 text-rose-600"
                    aria-hidden="true"
                >
                    <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <rect x="4" y="10" width="16" height="10" rx="2" />
                        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
                    </svg>
                </div>
                <h1 class="text-base font-semibold">
                    {{ t("settings.configLockForbiddenTitle") }}
                </h1>
                <p class="mt-1 text-sm text-muted-foreground">
                    {{ t("settings.configLockForbiddenBody") }}
                </p>
            </div>
        </template>

        <template v-else>
            <header class="mb-4">
                <h1 class="text-lg font-semibold">{{ t("settings.configLockTitle") }}</h1>
                <p class="mt-1 text-sm text-muted-foreground">
                    {{ t("settings.configLockSubtitle") }}
                </p>
            </header>

            <div class="mb-3 flex flex-wrap items-center gap-2">
                <label class="text-xs text-muted-foreground" for="config-lock-domain">
                    {{ t("settings.configLockDomain") }}
                </label>
                <select
                    id="config-lock-domain"
                    v-model="domain"
                    data-testid="config-lock-domain"
                    class="rounded border bg-background px-2 py-1 text-sm"
                >
                    <option v-for="item in domains" :key="item" :value="item">{{ item }}</option>
                </select>
                <span class="text-xs text-muted-foreground">
                    {{ t("settings.configLockCount", { count: lockedCount }) }}
                </span>
                <button
                    type="button"
                    class="ml-auto rounded border px-2 py-1 text-xs"
                    :disabled="loading"
                    data-testid="config-lock-refresh"
                    @click="load"
                >
                    {{ t("settings.configLockRefresh") }}
                </button>
            </div>

            <p
                v-if="error"
                data-testid="config-lock-error"
                class="mb-3 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-700"
            >
                {{ error }}
            </p>
            <p
                v-if="notice"
                data-testid="config-lock-notice"
                class="mb-3 rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700"
            >
                {{ notice }}
            </p>

            <div class="overflow-x-auto border rounded-lg">
                <table class="w-full text-sm" data-testid="config-lock-table">
                    <thead class="bg-muted/60 text-xs text-muted-foreground">
                        <tr>
                            <th class="px-3 py-2 text-left font-medium">
                                {{ t("settings.configLockKey") }}
                            </th>
                            <th class="px-3 py-2 text-left font-medium">
                                {{ t("settings.configLockValue") }}
                            </th>
                            <th class="px-3 py-2 text-left font-medium">
                                {{ t("settings.configLockState") }}
                            </th>
                            <th class="px-3 py-2 text-left font-medium">
                                {{ t("settings.configLockAction") }}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr
                            v-for="row in catalog?.keys ?? []"
                            :key="row.key"
                            :data-testid="`config-lock-row-${row.key}`"
                            class="border-t align-top"
                        >
                            <td class="px-3 py-2 font-mono text-xs break-all">{{ row.key }}</td>
                            <td class="px-3 py-2">
                                <span v-if="values[row.key]" class="font-mono text-xs break-all">{{
                                    values[row.key]
                                }}</span>
                                <span v-else class="text-xs text-muted-foreground">{{
                                    t("settings.configLockNoValue")
                                }}</span>
                            </td>
                            <td class="px-3 py-2">
                                <div class="flex flex-col items-start gap-1">
                                    <span
                                        v-if="row.locked"
                                        :data-testid="`config-lock-badge-${row.key}`"
                                        class="rounded border border-rose-500/50 bg-rose-500/10 px-1.5 py-0.5 text-[10px] text-rose-700"
                                    >
                                        {{ t("settings.adminLockedBadge") }}
                                    </span>
                                    <span
                                        v-else-if="row.lockable"
                                        class="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                                    >
                                        {{ t("settings.configLockUnlocked") }}
                                    </span>
                                    <span
                                        v-else
                                        :data-testid="`config-lock-not-lockable-${row.key}`"
                                        class="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                                    >
                                        {{ notLockableText(row) }}
                                    </span>
                                    <span
                                        v-if="row.locked && row.reason"
                                        class="text-[11px] break-all"
                                    >
                                        {{ row.reason }}
                                    </span>
                                    <span
                                        v-if="row.locked && row.updatedBy"
                                        class="text-[10px] text-muted-foreground"
                                    >
                                        {{ row.updatedBy }} · {{ row.updatedAt }}
                                    </span>
                                </div>
                            </td>
                            <td class="px-3 py-2">
                                <button
                                    v-if="row.lockable"
                                    type="button"
                                    class="rounded border px-2 py-1 text-xs"
                                    :data-testid="`config-lock-select-${row.key}`"
                                    @click="pick(row)"
                                >
                                    {{
                                        row.locked
                                            ? t("settings.configLockEdit")
                                            : t("settings.configLockLock")
                                    }}
                                </button>
                                <span v-else class="text-[11px] text-muted-foreground">—</span>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <section
                v-if="selectedKey"
                data-testid="config-lock-form"
                class="mt-4 border rounded-lg p-4 space-y-3"
            >
                <h2 class="text-sm font-semibold">
                    {{ t("settings.configLockFormTitle", { key: selectedKey.key }) }}
                </h2>
                <div class="flex flex-col gap-1">
                    <label class="text-xs text-muted-foreground" for="config-lock-value">
                        {{ t("settings.configLockValue") }}
                    </label>
                    <input
                        id="config-lock-value"
                        v-model="formValue"
                        data-testid="config-lock-value-input"
                        class="rounded border bg-background px-2 py-1 font-mono text-sm"
                    />
                    <span class="text-[11px] text-muted-foreground">
                        {{ t("settings.configLockValueHint") }}
                    </span>
                </div>
                <div class="flex flex-col gap-1">
                    <label class="text-xs text-muted-foreground" for="config-lock-reason">
                        {{ t("settings.configLockReason") }}
                    </label>
                    <textarea
                        id="config-lock-reason"
                        v-model="formReason"
                        rows="2"
                        maxlength="200"
                        data-testid="config-lock-reason-input"
                        class="rounded border bg-background px-2 py-1 text-sm"
                    />
                    <span class="text-[11px] text-amber-600">
                        {{ t("settings.configLockReasonHint") }}
                    </span>
                </div>
                <label v-if="selectedKey.locked" class="flex items-start gap-2 text-xs">
                    <input
                        v-model="clearValue"
                        type="checkbox"
                        data-testid="config-lock-clear-value"
                    />
                    <span>{{ t("settings.configLockClearValue") }}</span>
                </label>
                <div class="flex flex-wrap gap-2">
                    <button
                        type="button"
                        class="rounded border px-3 py-1 text-xs"
                        :disabled="saving"
                        data-testid="config-lock-save"
                        @click="saveLock"
                    >
                        {{ t("settings.configLockSave") }}
                    </button>
                    <button
                        v-if="selectedKey.locked"
                        type="button"
                        class="rounded border border-rose-500/60 px-3 py-1 text-xs text-rose-700"
                        :disabled="saving"
                        data-testid="config-lock-unlock"
                        @click="unlock"
                    >
                        {{ t("settings.configLockUnlock") }}
                    </button>
                    <button
                        type="button"
                        class="rounded px-3 py-1 text-xs text-muted-foreground"
                        data-testid="config-lock-cancel"
                        @click="selected = ''"
                    >
                        {{ t("settings.configLockCancel") }}
                    </button>
                </div>
            </section>
        </template>
    </div>
</template>
