<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import type { ConfigDomain, ConfigKeyMeta, ConfigLayer } from "../../stores/config";
import { isInstanceOnlyForUser, settingsDomainPath } from "../../lib/settingsIa";
import ConfigDomainSummary from "./ConfigDomainSummary.vue";
import JsonFieldEditor from "./JsonFieldEditor.vue";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { FieldControl, FieldError, FieldRoot } from "reka-ui";
import { FieldDescription, FieldLabel } from "../ui/field";

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
    /** PLAN-0554: current layer, used for inheritance wording. task-253：只剩实例/用户两层。 */
    layer?: ConfigLayer;
    /**
     * task-31：**当前查看者的 user 层原始行**（同一域），只用于在实例层派生「被个人层覆盖」。
     * 不传 = 未加载 —— 面板据此**不画**徽标，而不是画成「没有覆盖」（见 userOverrideActive）。
     */
    userEntries?: Record<string, string>;
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

/**
 * task-225（用户 2026-11-13：「默认都是合拢的，用户还得多次点击」）：域卡**默认展开**，
 * 折叠只保留为用户的显式动作（能力不删，用户仍可收起）。
 *
 * <p>草稿 `editing` 的初始化原先写在 `toggle()` 里（展开那一刻从 `entries` 取一次）；默认展开后
 * 那条路径不再触发，必须改成 `watch(expanded, …, { immediate: true })`，否则首屏输入框全空 ——
 * 那比折叠更糟：看起来像「本域没有配置」。语义与原来一致（每次**展开**时重取一次），只是多了一次
 * 挂载时的初始化。</p>
 */
const expanded = ref(true),
    editing = ref<Record<string, string>>({});

function initDraft(): Record<string, string> {
    const init: Record<string, string> = {};
    for (const field of props.schema) {
        init[field.key] = props.entries[field.key] ?? "";
    }
    return init;
}

watch(
    expanded,
    (open) => {
        if (open) editing.value = initDraft();
    },
    { immediate: true },
);

function toggle() {
    expanded.value = !expanded.value;
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
 * PLAN-0762 T1.5：字段块改走 `Field` 组件族。
 *
 * <p>**分工**（实测，不是取舍）：`src/components/ui/field` 是 shadcn-vue 的静态展示族，
 * 导出 `Field`/`FieldLabel`/`FieldDescription`/`FieldError` 等，**没有** `FieldRoot`/`FieldControl`；
 * 带 value 绑定与校验上下文的 `FieldRoot`/`FieldControl`/`FieldError` 只有 `reka-ui` 提供。
 * 所以标签用 vendor `FieldLabel`（`<label>`，`for` 指向控件）、描述用 vendor
 * `FieldDescription`，number 字段那套 reka 校验链**原样保留**（行为与 `config-number-error-*`
 * testid 都不动）。可寻址性不变：`config-field-*` / `config-source-*` / `config-source-jump-*`
 * 全部保号，文案不改。
 */

/** 该字段这一行是否真的渲染了可交互控件（只读/锁定态只有一个取值 span）。 */
function hasControl(field: DomainField): boolean {
    return !props.readonly && !isLocked(field.key);
}

/** 控件 id —— `FieldLabel` 的 `for` 指向它，点标签即聚焦控件（PLAN-0762 T1.5）。 */
function controlId(field: DomainField): string {
    return `config-ctl-${props.domain}-${field.key}`;
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

/**
 * task-23 / P2-6：JSON / textarea 类字段是**多行值**，只读态不能按单行截断。
 *
 * <p>实测（`evidence/2026-11-11-settings-p2/p02-probe.json`）：同一字段在可编辑态是
 * `<textarea rows="3">`（74 px、318 字符完整可见），但整域只读或实例专属键落到下层时，
 * `v-else` 分支用 `truncate` 的单行 span 呈现 ⇒ 200+ 字符的 JSON 只看得见第一行。
 * 所以只给这两类放开换行；其余类型保持单行截断（行高一致、表格不塌）。</p>
 */
function isMultilineValueField(field: DomainField): boolean {
    return field.type === "json" || field.type === "textarea";
}

/**
 * 来源词表：同一来源的两种「说法」。
 * `layer` = 层名（生效层徽标、`sourceText()` 既有语义）；`badge` = 继承行的**来源类型短语**
 * （对齐 PLAN-0554 design.md:110 词表：`instance 默认` / `workspace 覆盖` / `user 覆盖` / `code default`；
 *  `workspace-default` 词表无对应短语，按"工作区默认"短语化。`env` / `none` 两面同文但**继承分支不可达**
 *  （`locked` 与 `source==="none"` 都在继承分支之前返回）。
 */
const SOURCE_LABELS: Record<string, { layer: string; badge: string }> = {
    env: { layer: "settings.configSourceEnv", badge: "settings.configSourceEnv" },
    workspace: {
        layer: "settings.configSourceWorkspace",
        badge: "settings.configSourceWorkspaceOverride",
    },
    "workspace-default": {
        layer: "settings.configSourceWorkspaceDefault",
        badge: "settings.configSourceWorkspaceDefaultBadge",
    },
    user: { layer: "settings.configSourceUser", badge: "settings.configSourceUserOverride" },
    instance: {
        layer: "settings.configSourceInstance",
        badge: "settings.configSourceInstanceDefault",
    },
    code: { layer: "settings.configSourceCode", badge: "settings.configSourceCodeDefault" },
    none: { layer: "settings.configSourceNone", badge: "settings.configSourceNone" },
};

/** 来源文案；`face` 选「层名」还是「来源类型短语」—— 同一张词表，没有第二份 switch。 */
function sourceText(key: string, face: "layer" | "badge" = "layer"): string {
    const source = props.meta?.[key]?.source;
    const labels = source ? SOURCE_LABELS[source] : undefined;
    return labels ? t(labels[face]) : "";
}

/**
 * task-251 / D-1046：**唯一的来源判定** —— 这一行的 badge 文案、说明文案、以及要不要显示 badge。
 * 全组件只此一处条件链；改任一分支，徽标与说明同时变（没有第二份抄写）。
 *
 * 继承行（design.md:105 要求 badge + 继承说明**并存**，verify 复核后裁定走 ⓐ）：
 *   badge = 来源类型短语（实例默认 / 工作区覆盖 / 代码默认），
 *   hint  = 「继承自上层」（不复述源名）⇒ 两句各说一件事，无同词/近义重复。
 * 自有层 / 锁定 / env / 只读行的文案一字不动。
 */
function sourceDisplay(key: string): { badge: string; hint: string; showBadge: boolean } {
    const item = props.meta?.[key];
    if (!item) return { badge: "", hint: "", showBadge: false };
    const badge = sourceText(key);
    if (item.locked) return { badge, hint: t("settings.configSourceEnv"), showBadge: true };
    if (item.adminLocked) {
        return {
            badge,
            hint: t("settings.adminLockReason", { reason: item.lockReason ?? "" }),
            showBadge: true,
        };
    }
    if (props.layer === "instance") {
        return {
            badge,
            hint: item.overridable
                ? t("settings.configSourceOverridable")
                : t("settings.configSourceInstanceOnly"),
            showBadge: true,
        };
    }
    if (item.source === "none") {
        return { badge, hint: t("settings.configSourceNone"), showBadge: true };
    }
    if (props.layer && item.source !== props.layer) {
        return {
            badge: sourceText(key, "badge"),
            hint: t("settings.configSourceInheritedAbove"),
            showBadge: true,
        };
    }
    if (!item.writable) return { badge, hint: t("settings.configSourceReadonly"), showBadge: true };
    return { badge, hint: "", showBadge: true };
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

/**
 * task-31（用户复审「我改了用户层配置，实例层看不出被覆盖」）：**实例层的反向可见性**。
 *
 * <p>契约（`docs/api/openapi.yaml:3093-3094`）给的做法是「merged 读生效值 + 用 `layer=user`
 * 检测覆盖」—— `ConfigKeyMeta` 里**没有**覆盖人字段，所以这个徽标只能 UI 侧派生：
 * instance 层有这一行（本面板正在编辑它），且**当前查看者的用户层**对同一键有显式行
 * ⇒ 该实例默认值对这个用户不生效。</p>
 *
 * <p>语义边界（别把它写成更强的断言）：CP 只允许读自己的 user 层 ⇒ 徽标能说的是
 * 「**你**的个人层覆盖了它」，不是「被 N 个用户覆盖」。`userEntries === undefined` 表示
 * user 层还没加载完 —— 那时**不画**徽标；把"不知道"画成"没有覆盖"正是本卡要修的缺陷类。</p>
 */
function userOverrideActive(key: string): boolean {
    if (props.layer !== "instance" || !props.userEntries) return false;
    // 用户层没有这个域的路由（logging / approval-policy / job-policy 等实例专属域）⇒ 谈不上覆盖。
    if (isInstanceOnlyForUser(props.domain as ConfigDomain)) return false;
    return Object.prototype.hasOwnProperty.call(props.userEntries, key);
}

/** 跳到用户层同一条目（复用 jumpToSource 的锚点 + 高亮机制，不另造一套跳转）。 */
function jumpToUserOverride(key: string): void {
    void router.push({
        path: settingsDomainPath("user", props.domain as ConfigDomain),
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
        return Number.isInteger(num) && num >= 1 && num <= limit
            ? null
            : `${field.label} ≤ ${limit}`;
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

/** task-310：`<Input type="number">` 上的 `v-model` 会被 Vue 自动转成 number
 *  （`vModelText` 对 `type=number` 恒做 `castToNumber`），而本面板的编辑草稿**必须保持字符串**
 *  —— PLAN-0753 M2 起 save body 里所有值都是字符串，`ConfigDomainPanel.spec.ts` 的 TC8 钉的就是这条。
 *  所以这里手动绑定并显式 `String()`。**别改回 `v-model`**，那会静默把 8192 变成数字。 */
function onNumberDraft(key: string, v: string | number | null | undefined) {
    editing.value[key] = v === null || v === undefined || v === "" ? "" : String(v);
}
</script>

<template>
    <div :data-testid="`config-domain-${domain}`" class="border rounded-lg mb-2 overflow-hidden">
        <!--
            task-169 / F-10（用户审阅：「折叠卡只有一个远距箭头，页面像没加载」）：
            折叠态把箭头搬到标签**同行**（原先在 1080 px 卡的最右端，离标签 ~1000 px），
            并在标题下补一行**摘要**（有级联摘要显示摘要，没有就显示「展开查看全部设置」），
            让默认态先给内容线索再谈展开。计数徽标数的是**本卡字段数**（H4 行徽标口径）。
        -->
        <button
            :data-testid="`config-domain-toggle-${domain}`"
            :aria-expanded="expanded"
            class="w-full flex items-start gap-2 px-4 py-3 text-left text-sm font-medium hover:bg-muted/50 transition-colors"
            @click="toggle"
        >
            <span class="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true">{{
                expanded ? "▾" : "▸"
            }}</span>
            <span class="min-w-0 flex-1">
                <span class="flex items-center gap-2">
                    <span class="truncate">{{ title }}</span>
                    <span
                        v-if="!expanded && schema.length > 0"
                        :data-testid="`config-domain-field-count-${domain}`"
                        class="shrink-0 rounded border border-border px-1.5 py-0.5 text-xs font-normal text-muted-foreground"
                    >
                        {{ t("settings.configCardFieldCount", { count: schema.length }) }}
                    </span>
                </span>
                <span
                    v-if="!expanded"
                    :data-testid="`config-domain-preview-${domain}`"
                    class="mt-0.5 block truncate text-xs font-normal text-muted-foreground"
                >
                    {{ summary || t("settings.configCardExpandHint") }}
                </span>
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
                class="text-xs text-muted-foreground"
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
                <div class="min-w-0 w-1/3 text-foreground">
                    <FieldLabel
                        :for="hasControl(field) ? controlId(field) : undefined"
                        class="flex items-center gap-1 text-xs font-normal text-foreground"
                    >
                        <span class="block truncate">{{ field.label }}</span>
                        <span
                            v-if="isInstanceOnlyField(field)"
                            :data-testid="`config-key-layer-badge-${domain}-${field.key}`"
                            class="shrink-0 rounded border border-border px-1 py-0.5 text-xs tracking-wide text-muted-foreground"
                            :title="t('settings.configKeyInstanceOnlyHint')"
                            :aria-label="t('settings.configKeyInstanceOnlyHint')"
                            >{{ t("settings.configKeyInstanceOnlyBadge") }}</span
                        >
                    </FieldLabel>
                    <FieldDescription
                        v-if="meta?.[field.key]"
                        :data-testid="`config-source-${domain}-${field.key}`"
                        class="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
                    >
                        <!-- T2.4：继承层可点（跳到目标层同一条目并聚焦）；生效层保持纯文本 -->
                        <!-- task-251 / D-1043 B（verify 实读 design.md:105 后裁定 ⓐ）：
                             badge + 继承说明**必须并存**；缺陷对象只是「两半说同一个层名」。
                             ⇒ 继承行 badge = 来源类型短语（实例默认/工作区覆盖/代码默认），
                             hint = 「继承自上层」（不复述源名）。判定唯一出处 = sourceDisplay()（D-1046）。 -->
                        <template v-if="sourceDisplay(field.key).showBadge">
                            <button
                                v-if="jumpLayer(field.key)"
                                type="button"
                                :data-testid="`config-source-jump-${domain}-${field.key}`"
                                :aria-label="
                                    sourceDisplay(field.key).hint || sourceDisplay(field.key).badge
                                "
                                class="shrink-0 rounded border border-border px-1 py-0.5 underline decoration-dotted underline-offset-2 hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary"
                                @click="jumpToSource(field.key)"
                            >
                                {{ sourceDisplay(field.key).badge }}
                            </button>
                            <span
                                v-else
                                class="shrink-0 rounded border border-border px-1 py-0.5"
                                :aria-label="sourceDisplay(field.key).badge"
                            >
                                {{ sourceDisplay(field.key).badge }}
                            </span>
                        </template>
                        <!-- task-31：实例层「被个人层覆盖」——点它跳到用户层同一条目（复用锚点 + 高亮）。
                             只在「本层 = instance 且 user 层对同键有显式行」时出现；user 层未加载时不画，
                             避免把"不知道"画成"没有覆盖"。文案用层名（个人覆盖），不写"被 N 个用户覆盖"。 -->
                        <button
                            v-if="userOverrideActive(field.key)"
                            type="button"
                            :data-testid="`config-user-override-${domain}-${field.key}`"
                            :aria-label="t('settings.configSourceUser')"
                            :title="t('settings.configSourceUser')"
                            class="shrink-0 rounded border border-border px-1 py-0.5 underline decoration-dotted underline-offset-2 hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary"
                            @click="jumpToUserOverride(field.key)"
                        >
                            {{ t("settings.configSourceUserOverride") }}
                        </button>
                        <span v-if="sourceDisplay(field.key).hint" class="min-w-0 truncate">
                            {{ sourceDisplay(field.key).hint }}
                        </span>
                    </FieldDescription>
                </div>

                <template v-if="isLocked(field.key)">
                    <span
                        :data-testid="`config-env-lock-${domain}-${field.key}`"
                        class="min-w-0 flex-1 truncate px-2 py-1 text-sm border rounded bg-muted text-foreground"
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
                        class="text-xs tracking-wide px-1.5 py-0.5 rounded border"
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
                    <!-- task-310：形态回落 vendor `Input` 默认（h-8 / rounded-lg / px-2.5 py-1 / bg-transparent），
                         只保留描边覆盖 —— `--input` 在 5 调色板里 9/10 格不达 WCAG 1.4.11 的 3:1，
                         实测见 evidence/2026-11-13-config-domain-selects/README.md §3。 -->
                    <Input
                        v-if="field.allowCustom && customMode[field.key]"
                        v-model="editing[field.key]"
                        :id="controlId(field)"
                        :data-testid="`config-custom-${domain}-${field.key}`"
                        :disabled="!isWritable(field.key) || isLayerReadonly(field)"
                        class="min-w-0 flex-1"
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
                            :id="controlId(field)"
                            :data-testid="`config-select-${domain}-${field.key}`"
                            class="min-w-0 flex-1"
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

                <JsonFieldEditor
                    v-else-if="!readonly && field.type === 'json'"
                    v-model="editing[field.key]"
                    :control-id="controlId(field)"
                    :test-id="`config-json-${domain}-${field.key}`"
                    :disabled="!isWritable(field.key) || isLayerReadonly(field)"
                />

                <Textarea
                    v-else-if="!readonly && field.type === 'textarea'"
                    v-model="editing[field.key]"
                    rows="3"
                    :id="controlId(field)"
                    :disabled="!isWritable(field.key) || isLayerReadonly(field)"
                    class="min-w-0 flex-1"
                />

                <FieldRoot
                    v-else-if="!readonly && field.type === 'number'"
                    :name="`config-number-${domain}-${field.key}`"
                    class="contents"
                    :validate="numberRule(field)"
                    :disabled="!isWritable(field.key) || isLayerReadonly(field)"
                    validation-mode="onChange"
                >
                    <!-- as-child + vendor `Input`：FieldControl 的校验监听经 mergeProps 落到 input 上，
                         样式则整体回落 vendor 默认（不再逐个 pixel 手写）。 -->
                    <FieldControl as-child>
                        <Input
                            :model-value="editing[field.key]"
                            :id="controlId(field)"
                            :disabled="!isWritable(field.key) || isLayerReadonly(field)"
                            class="min-w-0 flex-1"
                            type="number"
                            @update:model-value="(v) => onNumberDraft(field.key, v)"
                            :max="field.max"
                            :title="field.max ? `≤ ${field.max}` : undefined"
                            :data-testid="`config-number-${domain}-${field.key}`"
                        />
                    </FieldControl>
                    <FieldError
                        class="shrink-0 text-xs text-destructive"
                        :data-testid="`config-number-error-${domain}-${field.key}`"
                    />
                </FieldRoot>
                <Input
                    v-else-if="!readonly"
                    v-model="editing[field.key]"
                    :id="controlId(field)"
                    :disabled="!isWritable(field.key) || isLayerReadonly(field)"
                    class="min-w-0 flex-1"
                    :type="field.type === 'password' ? 'password' : 'text'"
                />

                <!-- task-23 / P2-6：多行值（JSON/textarea）的只读取值不再单行截断；其余类型保持 truncate。 -->
                <span
                    v-else
                    class="min-w-0 flex-1 text-sm"
                    :class="
                        isMultilineValueField(field)
                            ? 'whitespace-pre-wrap break-all max-h-24 overflow-y-auto'
                            : 'truncate'
                    "
                >
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
                    class="shrink-0 text-xs tracking-wide px-1.5 py-0.5 rounded border border-amber-500/60 text-amber-600"
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
                    class="px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-50"
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
