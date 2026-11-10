<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import type { ConfigDomain, ConfigKeyMeta } from "../../stores/config";
import { settingsDomainPath } from "../../lib/settingsIa";
import ConfigDomainSummary from "./ConfigDomainSummary.vue";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { FieldControl, FieldError, FieldRoot } from "reka-ui";

const { t } = useI18n();

export interface DomainField {
    key: string;
    label: string;
    type: "text" | "password" | "select" | "number" | "json" | "textarea";
    options?: { label: string; value: string }[];
    /** Upper bound for `number` fields (e.g. systemToolTimeoutS ≤ 30, PLAN-0308 T3.1). */
    max?: number;
    /** Written by the instance layer only (e.g. agent-runtime.instructions, decision #17). */
    instanceOnly?: boolean;
    /**
     * PLAN-0503: candidates computed at render time from a sibling field's
     * editing value (e.g. defaultModel options filtered by defaultProvider).
     */
    optionsFor?: (dependencyValue: string) => { label: string; value: string }[];
    /** PLAN-0503: sibling field whose editing value feeds `optionsFor`. */
    optionsDependsOn?: string;
    /**
     * PLAN-0503: select keeps out-of-candidate values (drift) and offers a
     * free-text escape, so a directory outage never blocks manual input.
     */
    allowCustom?: boolean;
}

const props = defineProps<{
    domain: string;
    title: string;
    entries: Record<string, string>;
    readonly?: boolean;
    summary?: string;
    schema: DomainField[];
    /** domain key -> env-effective value when an env overlay wins (decision #22). */
    envLocked?: Record<string, string>;
    /** PLAN-0503: optional directory-freshness line (revision / verifiedAt). */
    note?: string;
    /** PLAN-0554: per-key provenance for this layer/domain. */
    meta?: Record<string, ConfigKeyMeta>;
    /** PLAN-0554: current layer, used for inheritance wording. */
    layer?: "instance" | "user" | "workspace";
}>();

const emit = defineEmits<{
    save: [body: Record<string, string>];
    reset: [key: string];
}>();

/**
 * PLAN-0752 / BL-542：只有**实例层**能真正「删掉本层覆盖」。
 *
 * <p>证据：CP 只有 `DELETE /api/v1/config/instance/{domain}/{key}`（`ConfigController.java:350-351`，
 * 原子 `WRITE_INSTANCE_CONTENT`）；user/workspace 层没有删除端点，同款按钮会走
 * `PUT {key: ""}`，而通用写入路径把空串**原样入库**（`ConfigService.java:1374-1405`，只有
 * `llm-provider`/`embedding` 有空值=删行特例）⇒ 不回退继承，而是把该键钉成空串。</p>
 *
 * <p>因此这是**层的属性**，不由调用方传：传了就能传错（旧实现传的是 `layer !== 'user'`，
 * 于是 workspace 层也显示了假的 ↺）。将来 CP 给非实例层补删除语义时，改这一处即可。</p>
 */
const canDeleteOverride = computed(() => props.layer === "instance");

const expanded = ref(false),
    editing = ref<Record<string, string>>({});

function toggle() {
    expanded.value = !expanded.value;
    if (expanded.value) {
        const init: Record<string, string> = {};
        for (const field of props.schema) {
            init[field.key] = props.entries[field.key] ?? "";
        }
        editing.value = init;
    }
}

function isLocked(key: string): boolean {
    return (
        (!!props.envLocked && key in props.envLocked) ||
        !!props.meta?.[key]?.locked ||
        !!props.meta?.[key]?.adminLocked
    );
}

/** PLAN-0556: administrator lock (distinct from the deployment env overlay). */
function isAdminLocked(key: string): boolean {
    return !!props.meta?.[key]?.adminLocked && !props.meta?.[key]?.locked;
}

/** PLAN-0554: server-judged writability; absent meta keeps the legacy behaviour. */
function isWritable(key: string): boolean {
    const item = props.meta?.[key];
    return !item || item.writable;
}

/**
 * PLAN-0752 T3.2「同域内不同键不同层」——逐键层属不是整域一个徽标。
 *
 * 判定来源是 CP 的 `ConfigService`，UI 不复制键清单：
 * - 实例层：`GET /config/{domain}/meta?layer=instance` 的 `overridable` 为 false 就是「只在实例层生效」
 *   （`ConfigService.java:580-583`：`overridable = instanceLayer && !isInstanceOnlyKey(...) && ...`）。
 *   这会同时覆盖「逐键实例专属」（`INSTANCE_ONLY_KEYS` 12 键）与「整域实例专属」
 *   （`INSTANCE_ONLY_DOMAINS` / 非 user/workspace 可写域）。
 * - 非实例层：CP `ConfigService.java:564-566` 直接 `continue`，这些键根本不在 meta 里，所以退回本表单
 *   的 `instanceOnly` 标记（schema 侧与 CP 的 8 个键一一对应）。
 */
function isInstanceOnlyField(field: DomainField): boolean {
    if (props.layer === "instance") {
        const item = props.meta?.[field.key];
        if (item) return item.overridable === false;
        return field.instanceOnly === true;
    }
    return field.instanceOnly === true;
}

/** 非实例层里实例专属键是只读行（PLAN-0752 design §5.1：不隐藏该行，只禁用 + 徽标解释原因）。 */
function isLayerReadonly(field: DomainField): boolean {
    return props.layer !== "instance" && isInstanceOnlyField(field);
}

function isLayerReadonlyKey(key: string): boolean {
    const field = props.schema.find((item) => item.key === key);
    return field ? isLayerReadonly(field) : false;
}

/**
 * 行级只读：整域只读（readonly prop）或该键在本层不可写（实例专属键落到下层）。
 * 只用于「禁用控件 / 隐藏写操作按钮」，**不**用来切换输入控件与纯文本 —— 控件仍渲染并置灰，
 * 用户才看得出「这一行存在、但你不能改」（design §5.1 只读态）。
 */
function fieldReadonly(field: DomainField): boolean {
    return props.readonly === true || isLayerReadonly(field);
}

function sourceText(key: string): string {
    switch (props.meta?.[key]?.source) {
        case "env":
            return t("settings.configSourceEnv");
        case "workspace":
            return t("settings.configSourceWorkspace");
        case "user":
            return t("settings.configSourceUser");
        case "instance":
            return t("settings.configSourceInstance");
        case "code":
            return t("settings.configSourceCode");
        case "none":
            return t("settings.configSourceNone");
        default:
            return "";
    }
}

function sourceHint(key: string): string {
    const item = props.meta?.[key];
    if (!item) return "";
    if (item.locked) return t("settings.configSourceEnv");
    if (item.adminLocked) {
        return t("settings.adminLockReason", { reason: item.lockReason ?? "" });
    }
    if (props.layer === "instance") {
        return item.overridable
            ? t("settings.configSourceOverridable")
            : t("settings.configSourceInstanceOnly");
    }
    if (item.source === "none") return t("settings.configSourceNone");
    if (props.layer && item.source !== props.layer) {
        return t("settings.configSourceInherited", { source: sourceText(key) });
    }
    if (!item.writable) return t("settings.configSourceReadonly");
    return "";
}

function lockedValue(key: string): string {
    const envValue = props.envLocked?.[key] ?? "";
    // PLAN-0556: an admin lock shows the pinned instance value on the instance
    // layer; other layers only know the lock, not the value (the lock table
    // never stores values). Non-instance layers must not pass their own layer
    // entry off as the locked value (PLAN-0560 T2.5).
    const adminValue =
        !envValue && props.layer === "instance" && isAdminLocked(key)
            ? (props.entries?.[key] ?? "")
            : "";
    const value = envValue || adminValue;
    if (value && isPasswordKey(key)) {
        return value.length > 8 ? `${value.substring(0, 3)}****${value.slice(-4)}` : "****";
    }
    return value;
}

/**
 * PLAN-0752 T2.4（task-133）：继承层徽标可点 + 锚点落地。
 *
 * <p>design.md:24 —— 被覆盖的继承层以浅色**可点**文字展示，点击跳到对应层同一条目并**短暂高亮**
 * （锚点 `#<setting-key>`）。「生效层」与「继承层」是两类：只有 `meta.source` 是**另一层**时才可点；
 * 生效层、`env`、`code` 都保持纯文本 —— 它们陈述事实，不是目的地。</p>
 *
 * <p>目标层只有 instance / user：它们是真实路由 `/settings/<layer>/<domain>`。</p>
 *
 * <p>**workspace 不是目标层（task-138 关闭的依据）**：CP `ConfigService.meta()` 只在 `layer=workspace`
 * 视图里加载 workspace 行，`sourceFor()` 因此只在该视图返回 `workspace`（`ConfigService.java:531-533,616-627`），
 * 而那里 workspace 是**生效层**、不该可点 ⇒ 真实世界不存在「继承自 workspace」的徽标。
 * 不要给它补跳转分支：一个永不执行的分支会让后来人以为「用户层能看到工作区覆盖」。</p>
 */
function jumpLayer(key: string): "instance" | "user" | null {
    const item = props.meta?.[key];
    if (!item || !props.layer) return null;
    if (item.source !== "instance" && item.source !== "user") return null;
    return item.source === props.layer ? null : item.source;
}

function jumpToSource(key: string): void {
    const targetLayer = jumpLayer(key);
    if (!targetLayer) return;
    void router.push({
        path: settingsDomainPath(targetLayer, props.domain as ConfigDomain),
        hash: `#${key}`,
    });
}

const route = useRoute();
const router = useRouter();
const anchorHighlight = ref("");
const rowRefs = new Map<string, HTMLElement>();
let highlightTimer: ReturnType<typeof setTimeout> | undefined;

function setRowRef(key: string, el: unknown): void {
    if (el instanceof HTMLElement) rowRefs.set(key, el);
    else rowRefs.delete(key);
}

const anchoredKey = computed(() => {
    const hash = route.hash;
    return hash.startsWith("#") ? decodeURIComponent(hash.slice(1)) : "";
});

/**
 * 等目标行**真的能收焦点**。域页在层配置落定前是 `v-show` 隐藏 + `inert`（task-121/VW-31），
 * 隐藏子树里的 `focus()` 会被浏览器静默忽略 —— 当场聚焦会「高亮出现但焦点留在 body」。
 * 所以这里重试到聚焦成功为止（≤2 s），页面离开或一直不可聚焦就放弃，不假装成功。
 */
async function focusRowWhenReady(row: HTMLElement): Promise<boolean> {
    for (let attempt = 0; attempt < 33; attempt += 1) {
        if (!row.isConnected) return false;
        row.focus({ preventScroll: true });
        if (document.activeElement === row) return true;
        await new Promise((resolve) => setTimeout(resolve, 60));
    }
    return false;
}

/**
 * 锚点落地 = 展开域卡（行只在展开后存在）→ 等到可聚焦 → 滚动 → **聚焦** → 短暂高亮（1.6 s 后撤）。
 * 同页二次跳转靠 watch(route.hash) 生效：只挂 onMounted 会漏掉「已经在本页，再点另一个徽标」。
 */
async function applyAnchor(): Promise<void> {
    const key = anchoredKey.value;
    if (!key || !props.schema.some((field) => field.key === key)) return;
    if (!expanded.value) toggle();
    await nextTick();
    const row = rowRefs.get(key);
    if (!row) return;
    if (!(await focusRowWhenReady(row))) return;
    // jsdom 无布局引擎、没有 scrollIntoView：单测里跳过滚动，但聚焦与高亮照常执行。
    if (typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "center" });
    anchorHighlight.value = key;
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => {
        anchorHighlight.value = "";
    }, 1600);
}

watch(
    () => [route.hash, props.domain] as const,
    () => {
        void applyAnchor();
    },
    { flush: "post" },
);
onMounted(() => {
    void applyAnchor();
});
onBeforeUnmount(() => {
    if (highlightTimer) clearTimeout(highlightTimer);
});

function isPasswordKey(key: string): boolean {
    const normalized = key.toLowerCase();
    return (
        normalized.includes("apikey") ||
        normalized.includes("secret") ||
        normalized.includes("password")
    );
}

/** Sentinel option value that flips a select into free-text mode (PLAN-0503). */
const CUSTOM_OPTION = "__custom__";

const customMode = ref<Record<string, boolean>>({});

function fieldCandidates(field: DomainField): { label: string; value: string }[] {
    if (field.optionsFor) {
        const dependency = field.optionsDependsOn
            ? (editing.value[field.optionsDependsOn] ?? "")
            : "";
        return field.optionsFor(dependency);
    }
    return field.options ?? [];
}

/**
 * PLAN-0503 I3 / design「目录更新处置矩阵」: any select whose stored value is
 * outside the current candidate set must be annotated (catalog removal must not
 * leave a blank, unlabelled field). The free-text escape stays allowCustom-only.
 */
function isDrifted(field: DomainField): boolean {
    if (field.type !== "select") return false;
    const value = editing.value[field.key] ?? "";
    if (!value || customMode.value[field.key]) return false;
    return !fieldCandidates(field).some((option) => option.value === value);
}

function onSelectChange(field: DomainField, value: string) {
    if (field.allowCustom && value === CUSTOM_OPTION) {
        customMode.value = { ...customMode.value, [field.key]: true };
        return;
    }
    editing.value[field.key] = value;
}

function exitCustomMode(field: DomainField) {
    customMode.value = { ...customMode.value, [field.key]: false };
}

/**
 * PLAN-0753 M2: per-number-field rule fed to reka FieldRoot. `max` comes from the field
 * schema, so the rule is generated per field and only mounted when the row is editable
 * (locked / read-only / inherited rows skip the rule).
 */
function numberRule(field: DomainField): ((value: unknown) => string | null) | undefined {
    if (field.type !== "number" || field.max === undefined) return undefined;
    const limit = field.max;
    return (value: unknown) => {
        const raw = typeof value === "string" ? value : "";
        if (raw === "") return null;
        const num = Number(raw);
        return Number.isInteger(num) && num >= 1 && num <= limit ? null : `${field.label} ≤ ${limit}`;
    };
}

function handleSave() {
    const body = Object.fromEntries(
        Object.entries(editing.value).filter(
            ([key, value]) =>
                value !== "" && !isLocked(key) && isWritable(key) && !isLayerReadonlyKey(key),
        ),
    );
    emit("save", body);
}

function handleReset(key: string) {
    // 乐观清空该键草稿：重置 = 删掉本层覆盖（父组件 DELETE 后整层 reload），但 `editing` 只在展开
    // 那一刻初始化（`toggle()`），`props.entries` 变了草稿不重算 ⇒ 输入框会留着刚被删掉的旧值
    // （task-74 B1 浏览器量测实测：DELETE 已发出、回读已完成，输入框仍显示 1234 = "点了重置没反应"）。
    // 这里只清这一个键，不动其它键的未保存编辑。
    editing.value[key] = "";
    emit("reset", key);
}
</script>

<template>
    <div :data-testid="`config-domain-${domain}`" class="border rounded-lg mb-2 overflow-hidden">
        <button
            class="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50 transition-colors"
            @click="toggle"
        >
            <span class="truncate">{{ title }}</span>
            <span class="flex min-w-0 items-center gap-2 shrink-0">
                <span
                    v-if="!expanded && summary"
                    class="text-xs text-muted-foreground truncate max-w-[200px]"
                    >{{ summary }}</span
                >
                <span class="text-muted-foreground">{{ expanded ? "▾" : "▸" }}</span>
            </span>
        </button>
        <!-- PLAN-0752 T3.5：域级摘要行（数字来自 CP meta，UI 不自己算） -->
        <ConfigDomainSummary
            v-if="layer && meta && Object.keys(meta).length > 0"
            :domain="domain"
            :layer="layer"
            :meta="meta"
        />
        <div v-if="expanded" class="px-4 pb-3 space-y-2">
            <p
                v-if="note"
                :data-testid="`config-domain-note-${domain}`"
                class="text-[11px] text-muted-foreground"
            >
                {{ note }}
            </p>
            <div
                v-for="field in schema"
                :key="field.key"
                :ref="(el) => setRowRef(field.key, el)"
                :data-testid="`config-field-${domain}-${field.key}`"
                :tabindex="-1"
                class="flex min-w-0 items-center gap-2 outline-none"
                :class="
                    anchorHighlight === field.key
                        ? 'rounded ring-2 ring-primary ring-offset-1 ring-offset-background'
                        : ''
                "
            >
                <div class="min-w-0 w-1/3 text-muted-foreground">
                    <span class="flex items-center gap-1">
                        <span class="block text-xs text-muted-foreground truncate">{{
                            field.label
                        }}</span>
                        <span
                            v-if="isInstanceOnlyField(field)"
                            :data-testid="`config-key-layer-badge-${domain}-${field.key}`"
                            class="shrink-0 rounded border border-border px-1 py-0.5 text-[10px] tracking-wide text-muted-foreground"
                            :title="t('settings.configKeyInstanceOnlyHint')"
                            :aria-label="t('settings.configKeyInstanceOnlyHint')"
                            >{{ t("settings.configKeyInstanceOnlyBadge") }}</span
                        >
                    </span>
                    <span
                        v-if="meta?.[field.key]"
                        :data-testid="`config-source-${domain}-${field.key}`"
                        class="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground"
                    >
                        <!-- T2.4：继承层可点（跳到目标层同一条目并聚焦）；生效层保持纯文本 -->
                        <button
                            v-if="jumpLayer(field.key)"
                            type="button"
                            :data-testid="`config-source-jump-${domain}-${field.key}`"
                            :aria-label="
                                t('settings.configSourceInherited', {
                                    source: sourceText(field.key),
                                })
                            "
                            class="shrink-0 rounded border border-border px-1 py-0.5 underline decoration-dotted underline-offset-2 hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary"
                            @click="jumpToSource(field.key)"
                        >
                            {{ sourceText(field.key) }}
                        </button>
                        <span
                            v-else
                            class="shrink-0 rounded border border-border px-1 py-0.5"
                            :aria-label="sourceText(field.key)"
                        >
                            {{ sourceText(field.key) }}
                        </span>
                        <span v-if="sourceHint(field.key)" class="min-w-0 truncate">
                            {{ sourceHint(field.key) }}
                        </span>
                    </span>
                </div>

                <template v-if="isLocked(field.key)">
                    <span
                        :data-testid="`config-env-lock-${domain}-${field.key}`"
                        class="min-w-0 flex-1 truncate px-2 py-1 text-sm border rounded bg-muted text-muted-foreground"
                        :title="t('settings.envLockedHint')"
                        :aria-label="t('settings.configSourceEnv')"
                    >
                        {{
                            lockedValue(field.key) ||
                            (isAdminLocked(field.key)
                                ? t("settings.adminLockValueAtInstance")
                                : t("settings.empty"))
                        }}
                    </span>
                    <span
                        class="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border"
                        :class="
                            isAdminLocked(field.key)
                                ? 'border-rose-500/60 text-rose-600'
                                : 'border-amber-500/60 text-amber-600'
                        "
                        :title="
                            isAdminLocked(field.key)
                                ? t('settings.adminLockReason', {
                                      reason: meta?.[field.key]?.lockReason ?? '',
                                  })
                                : t('settings.envLockedHint')
                        "
                        :data-testid="
                            isAdminLocked(field.key)
                                ? `config-admin-lock-${domain}-${field.key}`
                                : `config-env-lock-chip-${domain}-${field.key}`
                        "
                        >{{
                            isAdminLocked(field.key) ? t("settings.adminLockedBadge") : "env"
                        }}</span
                    >
                </template>

                <template v-else-if="!readonly && field.type === 'select'">
                    <input
                        v-if="field.allowCustom && customMode[field.key]"
                        v-model="editing[field.key]"
                        :data-testid="`config-custom-${domain}-${field.key}`"
                        :disabled="!isWritable(field.key) || isLayerReadonly(field)"
                        class="min-w-0 flex-1 px-2 py-1 text-sm border rounded bg-background"
                        :placeholder="t('settings.customPlaceholder')"
                    />
                    <Select
                        v-else
                        :model-value="
                            field.allowCustom && !editing[field.key]
                                ? '__unset__'
                                : editing[field.key]
                        "
                        :disabled="!isWritable(field.key) || isLayerReadonly(field)"
                        @update:model-value="
                            (value) =>
                                onSelectChange(
                                    field,
                                    value === '__unset__' ? '' : String(value ?? ''),
                                )
                        "
                    >
                        <SelectTrigger
                            :data-testid="`config-select-${domain}-${field.key}`"
                            class="min-w-0 flex-1 px-2 py-1 text-sm border rounded bg-background"
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem v-if="field.allowCustom" value="__unset__">{{
                                t("settings.notSet")
                            }}</SelectItem>
                            <SelectItem
                                v-if="isDrifted(field) && editing[field.key] !== ''"
                                :value="editing[field.key]"
                            >
                                {{ t("settings.driftedOption", { value: editing[field.key] }) }}
                            </SelectItem>
                            <SelectItem
                                v-for="opt in fieldCandidates(field).filter(
                                    (candidate) => candidate.value !== '',
                                )"
                                :key="opt.value"
                                :value="opt.value"
                            >
                                {{ opt.label }}
                            </SelectItem>
                            <SelectItem v-if="field.allowCustom" :value="CUSTOM_OPTION">
                                {{ t("settings.customOption") }}
                            </SelectItem>
                        </SelectContent>
                    </Select>
                </template>

                <textarea
                    v-else-if="!readonly && (field.type === 'json' || field.type === 'textarea')"
                    v-model="editing[field.key]"
                    rows="3"
                    :disabled="!isWritable(field.key) || isLayerReadonly(field)"
                    class="min-w-0 flex-1 px-2 py-1 text-sm border rounded bg-background"
                    :class="field.type === 'json' ? 'font-mono' : ''"
                    :placeholder="field.type === 'json' ? 'JSON' : ''"
                />

                <FieldRoot
                    v-else-if="!readonly && field.type === 'number'"
                    :name="`config-number-${domain}-${field.key}`"
                    class="contents"
                    :validate="numberRule(field)"
                    :disabled="!isWritable(field.key) || isLayerReadonly(field)"
                    validation-mode="onChange"
                >
                    <FieldControl
                        v-model="editing[field.key]"
                        as="input"
                        :disabled="!isWritable(field.key) || isLayerReadonly(field)"
                        class="min-w-0 flex-1 px-2 py-1 text-sm border rounded bg-background"
                        type="number"
                        :max="field.max"
                        :title="field.max ? `≤ ${field.max}` : undefined"
                        :data-testid="`config-number-${domain}-${field.key}`"
                    />
                    <FieldError
                        class="shrink-0 text-xs text-destructive"
                        :data-testid="`config-number-error-${domain}-${field.key}`"
                    />
                </FieldRoot>
                <input
                    v-else-if="!readonly"
                    v-model="editing[field.key]"
                    :disabled="!isWritable(field.key) || isLayerReadonly(field)"
                    class="min-w-0 flex-1 px-2 py-1 text-sm border rounded bg-background"
                    :type="field.type === 'password' ? 'password' : 'text'"
                />

                <span v-else class="min-w-0 flex-1 text-sm truncate">
                    {{
                        field.type === "password"
                            ? editing[field.key]
                                ? editing[field.key].substring(0, 3) +
                                  "****" +
                                  editing[field.key].slice(-4)
                                : t("settings.notSet")
                            : editing[field.key] || t("settings.empty")
                    }}
                </span>

                <span
                    v-if="isDrifted(field)"
                    :data-testid="`config-drift-${domain}-${field.key}`"
                    class="shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-amber-500/60 text-amber-600"
                    :title="t('settings.driftedHint')"
                    >{{ t("settings.driftedBadge") }}</span
                >
                <!-- 漂移清理与 ↺ 调的是同一个 handler（父层对非实例层发 PUT {key:""}），
                     所以同样只在能真正删覆盖的实例层出现；徽标保留，用户仍看得到「值不在候选集」，
                     逃生路径是直接选一个合法值再保存。 -->
                <button
                    v-if="
                        canDeleteOverride &&
                        isDrifted(field) &&
                        !fieldReadonly(field) &&
                        !isLocked(field.key)
                    "
                    class="shrink-0 text-xs text-muted-foreground hover:text-foreground px-1"
                    :data-testid="`config-drift-clear-${domain}-${field.key}`"
                    :title="t('settings.driftedClear')"
                    @click="handleReset(field.key)"
                >
                    {{ t("settings.driftedClear") }}
                </button>
                <button
                    v-if="field.allowCustom && customMode[field.key] && !fieldReadonly(field)"
                    class="shrink-0 text-xs text-muted-foreground hover:text-foreground px-1"
                    :data-testid="`config-custom-exit-${domain}-${field.key}`"
                    @click="exitCustomMode(field)"
                >
                    {{ t("settings.customBack") }}
                </button>

                <button
                    v-if="
                        canDeleteOverride &&
                        !fieldReadonly(field) &&
                        !isLocked(field.key) &&
                        isWritable(field.key)
                    "
                    class="text-xs text-muted-foreground hover:text-foreground px-1"
                    :title="t('settings.resetToDefault')"
                    @click="handleReset(field.key)"
                >
                    ↺
                </button>
            </div>
            <div v-if="!readonly" class="flex justify-end pt-1">
                <button
                    class="px-3 py-1 text-xs bg-action text-action-foreground rounded hover:opacity-90 disabled:opacity-50"
                    :disabled="
                        !schema.some((field) => isWritable(field.key) && !isLocked(field.key))
                    "
                    @click="handleSave"
                >
                    {{ t("common.save") }}
                </button>
            </div>
        </div>
    </div>
</template>
