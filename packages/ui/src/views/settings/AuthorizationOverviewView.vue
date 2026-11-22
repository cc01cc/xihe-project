<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import SettingsErrorSurface from "../../components/settings/SettingsErrorSurface.vue";
import { grantSourceLabelKey } from "../../i18n/grantSourceLabels";
import {
    api,
    ApiError,
    type AgentRoleBinding,
    type ApiBindingRow,
    type AuthorizationExplainView,
    type PermissionAtomSourceView,
    type PermissionAtomView,
    type SelfPermissionsView,
    type WorkspaceAgentBinding,
    type WorkspaceAgentEffectiveCap,
} from "../../composables/api";

/**
 * task-8（DSD-1516 收窄后）：授权总览 = **已登录者视角**。
 *
 * <p>为什么是「自己的」而不是「按主体列六来源」：六来源里四个（spawn / template /
 * credential_binding / plugin_binding）**没有按主体读的读面**——按主体读是新增 CP 端点 =
 * 新增产品能力，不在 Lead 代裁范围内（证据档
 * `internal/A03-xihe/evidence/2026-11-21-task8-grant-readface/README.md` 有逐来源端点表）。
 * 所以本页三层：</p>
 * <ol>
 *   <li>**我的生效授权**：`GET /api/v1/me/permissions`——CP 的权威投影，每个 atom 都带
 *       `sources[]`（wire 实抓 2026-11-21：122/122 atom 带来源行），按 `source` 分四组；</li>
 *   <li>**六来源读面表**：逐来源写清「有读面 / 仅反向读面 / 当前无读面」，缺读面的来源
 *       **不展示任何推断数据**；</li>
 *   <li>**以当前身份查询**：`POST /api/v1/authorization/explain`，主体由 CP 从租户上下文取。</li>
 * </ol>
 *
 * <p>**不许把缺口伪装成空态**：没有读面的来源写「当前无读面」，不写「暂无数据」；
 * 观测到的来源里没有行就写「该来源没有命中」，不写「加载中」。</p>
 */

const { t } = useI18n();

/** 六来源闭集（CP `policy/GrantSources.java`），顺序即页面顺序。 */
const READFACE_SOURCES = [
    "role",
    "credential_binding",
    "agent_default",
    "plugin_binding",
    "spawn",
    "template",
] as const;
type ReadfaceSource = (typeof READFACE_SOURCES)[number];

/** 投影里**可能**出现的四类：另外两类（spawn / template）全仓无写面。 */
const OBSERVABLE_SOURCES = [
    "role",
    "credential_binding",
    "agent_default",
    "plugin_binding",
] as const;
type ObservableSource = (typeof OBSERVABLE_SOURCES)[number];

/** 每页 20 条硬上限（DSD-1471）：纯前端切页，wire 上没有 page 参数。 */
const PAGE_SIZE = 20;

// ---------------- 我的生效授权 ----------------
const self = ref<SelfPermissionsView | null>(null),
    selfLoading = ref(false),
    selfCause = ref<unknown | null>(null),
    pages = ref<Record<string, number>>({});

async function loadSelf(): Promise<void> {
    selfLoading.value = true;
    selfCause.value = null;
    try {
        self.value = await api.getSelfPermissions();
        pages.value = {};
    } catch (e) {
        self.value = null;
        selfCause.value = e;
    } finally {
        selfLoading.value = false;
    }
}

/** 一条 atom 的一个来源行；`key` 只用于列表 key，不参与展示。 */
interface SourceRow {
    key: string;
    atom: PermissionAtomView;
    source: PermissionAtomSourceView;
    scopeType: string;
    scopeId: string | null;
}

/**
 * 把投影拍平成「按来源分组的行」。
 *
 * <p>instance 与 workspace 两处的 atom 都算：同一 atom 在两个 scope 下是**两条**授权，
 * 合并会让人以为工作区权限是实例权限。`sources` 缺失（旧 fixture）⇒ 该 atom 不进任何组，
 * 不当成「无来源」。</p>
 */
function rowsForSource(source: ObservableSource): SourceRow[] {
    const rows: SourceRow[] = [],
        push = (atom: PermissionAtomView, scopeType: string, scopeId: string | null): void => {
            for (const [index, s] of (atom.sources ?? []).entries()) {
                if (s.source !== source) continue;
                rows.push({
                    key: `${scopeId ?? "instance"}:${atom.actionClass}:${atom.resource}:${index}`,
                    atom,
                    source: s,
                    scopeType,
                    scopeId,
                });
            }
        };
    for (const atom of self.value?.instancePermissions ?? []) push(atom, "instance", null);
    for (const w of self.value?.workspaces ?? []) {
        for (const atom of w.permissions ?? []) push(atom, "workspace", w.workspaceId);
    }
    return rows.sort((a, b) =>
        `${a.atom.actionClass}${a.atom.resource}${a.scopeId ?? ""}`.localeCompare(
            `${b.atom.actionClass}${b.atom.resource}${b.scopeId ?? ""}`,
        ),
    );
}

const rowsBySource = computed<Record<ObservableSource, SourceRow[]>>(() => {
    const out = {} as Record<ObservableSource, SourceRow[]>;
    for (const source of OBSERVABLE_SOURCES) out[source] = rowsForSource(source);
    return out;
});

function pageOf(source: ObservableSource): number {
    const total = totalPages(source),
        raw = pages.value[source] ?? 1;
    return Math.min(Math.max(raw, 1), total);
}
function totalPages(source: ObservableSource): number {
    return Math.max(1, Math.ceil(rowsBySource.value[source].length / PAGE_SIZE));
}
function pageRows(source: ObservableSource): SourceRow[] {
    const page = pageOf(source);
    return rowsBySource.value[source].slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
}
function goPage(source: ObservableSource, delta: number): void {
    pages.value = { ...pages.value, [source]: pageOf(source) + delta };
}

/** 某来源在投影里命中的行数（徽标用；与分页无关）。 */
function countOf(source: ObservableSource): number {
    return rowsBySource.value[source].length;
}

function scopeText(row: SourceRow): string {
    return row.scopeType === "workspace"
        ? t("settings.authorizationOverview.scopeWorkspace", { id: shortId(row.scopeId) })
        : t("settings.authorizationOverview.scopeInstance");
}

/** grant id / scope id 只显示前 8 位：定位用，不占版面。 */
function shortId(value: string | null | undefined): string {
    if (!value) return "—";
    return value.length > 8 ? value.slice(0, 8) : value;
}

// ---------------- 六来源读面表 ----------------
type ReadfaceTier = "a" | "b" | "c";

/** 读面三档：a 有读面、b 仅反向读面、c 当前无读面（判据见证据档 §逐来源端点表）。 */
const READFACE_TIER: Record<ReadfaceSource, ReadfaceTier> = {
    role: "a",
    credential_binding: "b",
    agent_default: "b",
    plugin_binding: "b",
    spawn: "c",
    template: "c",
};

function tierLabel(tier: ReadfaceTier): string {
    return t(`settings.authorizationOverview.readface.tier${tier.toUpperCase()}`);
}

function tierVariant(tier: ReadfaceTier): "secondary" | "outline" | "destructive" {
    return tier === "a" ? "secondary" : tier === "b" ? "outline" : "destructive";
}

/** 有入口的来源给链接（不存在的入口不给假链接）。 */
function readfaceLink(source: ReadfaceSource): string | null {
    switch (source) {
        case "role":
            return "/settings/presets";
        case "credential_binding":
            return "/resources/credentials";
        default:
            return null;
    }
}

// ---------------- 按主体（读面能到的部分） ----------------
const activeWorkspaceId = ref<string | null>(null),
    agents = ref<WorkspaceAgentBinding[]>([]),
    agentsLoading = ref(false),
    agentsCause = ref<unknown | null>(null),
    activePrincipalId = ref<string | null>(null),
    detailRoles = ref<AgentRoleBinding[] | null>(null),
    detailRolesCause = ref<unknown | null>(null),
    detailCap = ref<WorkspaceAgentEffectiveCap | null>(null),
    detailCapCause = ref<unknown | null>(null),
    detailLoading = ref(false);

const workspaceOptions = computed(() =>
    (self.value?.workspaces ?? []).map((w) => ({
        id: w.workspaceId,
        atomCount: (w.permissions ?? []).length,
    })),
);

async function selectWorkspace(workspaceId: string): Promise<void> {
    activeWorkspaceId.value = workspaceId;
    activePrincipalId.value = null;
    detailRoles.value = null;
    detailCap.value = null;
    detailRolesCause.value = null;
    detailCapCause.value = null;
    agents.value = [];
    agentsCause.value = null;
    agentsLoading.value = true;
    try {
        agents.value = await api.getWorkspaceAgents(workspaceId);
    } catch (e) {
        agentsCause.value = e;
    } finally {
        agentsLoading.value = false;
    }
}

async function selectPrincipal(principalId: string): Promise<void> {
    const workspaceId = activeWorkspaceId.value;
    if (!workspaceId) return;
    activePrincipalId.value = principalId;
    detailRoles.value = null;
    detailCap.value = null;
    detailRolesCause.value = null;
    detailCapCause.value = null;
    detailLoading.value = true;
    const [roles, cap] = await Promise.allSettled([
        api.getAgentRoles(workspaceId, principalId),
        api.getWorkspaceAgentEffectiveCap(workspaceId, principalId),
    ]);
    if (roles.status === "fulfilled") detailRoles.value = roles.value;
    else detailRolesCause.value = roles.reason;
    if (cap.status === "fulfilled") detailCap.value = cap.value;
    else detailCapCause.value = cap.reason;
    detailLoading.value = false;
}

const activeAgent = computed(
    () => agents.value.find((agent) => agent.principalId === activePrincipalId.value) ?? null,
);

// user 主体绑定（instance scope）：有 MANAGE_ROLES 才拿得到 200，否则 403 显式呈现。
const userBindings = ref<ApiBindingRow[] | null>(null),
    userBindingsDeniedRaw = ref<string | null>(null),
    userBindingsCause = ref<unknown | null>(null),
    userBindingsLoading = ref(false);

async function loadUserBindings(): Promise<void> {
    userBindingsLoading.value = true;
    userBindingsDeniedRaw.value = null;
    userBindingsCause.value = null;
    bindingPage.value = 1;
    try {
        const set = await api.getBindings("instance");
        userBindings.value = set.bindings ?? [];
    } catch (e) {
        userBindings.value = null;
        if (e instanceof ApiError && e.problem.status === 403) {
            // 403 的原子名只从响应体取，不自编：缺哪个 atom 由 CP 说。
            userBindingsDeniedRaw.value = e.problem.detail ?? e.problem.code ?? e.message;
        } else {
            userBindingsCause.value = e;
        }
    } finally {
        userBindingsLoading.value = false;
    }
}

/**
 * 列表徽标用的 cap 模式：来自 `WorkspaceAgentBinding.capSource`（baseline / explicit），
 * **不是** effective-cap 的 `capSource.binding`（binding-snapshot / role-binding）——两个字段两种枚举，
 * 混用会拼出不存在的 i18n key（真栈实测 agent 行capSource=baseline）。
 */
const CAP_MODES = ["baseline", "explicit", "none"] as const;

function capModeLabel(mode = "none"): string {
    if ((CAP_MODES as readonly string[]).includes(mode)) {
        return t(`settings.authorizationOverview.subjects.capMode.${mode}`);
    }
    // 未知取值原样显示：宁可露出 wire 真值，也不让页面上出现裸 i18n key。
    return mode;
}

/** effective-cap 的命中来源（`capSource.binding`）翻成短标签，同样未知值原样显示。 */
const CAP_BINDINGS = ["binding-snapshot", "role-binding"] as const;

function capBindingLabel(binding: string): string {
    if ((CAP_BINDINGS as readonly string[]).includes(binding)) {
        return t(`settings.authorizationOverview.subjects.capSource.${binding}`);
    }
    return binding;
}

/**
 * task-91：`provenance.grantSources` 的来源分布摘要。按两个 id 数组的并集计数，
 * 所以「有 grant 行但缺 source 键」的行会落进「来源未知」而不是从摘要里消失；
 * 词表外的值原样显示 + 标「来源未知」，不回落成默认来源。
 */
function capSourcesSummary(cap: WorkspaceAgentEffectiveCap): string {
    const ids = [
        ...new Set([...cap.provenance.principalGrantIds, ...cap.provenance.bindingGrantIds]),
    ];
    if (ids.length === 0) return t("settings.authorizationOverview.subjects.capSourcesNone");
    const unknown = t("workspace.agentEffectiveCapSource.unknown");
    const counts = new Map<string, number>();
    for (const id of ids) {
        const raw = cap.provenance.grantSources[id];
        const key = raw === undefined ? null : grantSourceLabelKey(raw);
        const label = raw === undefined ? unknown : key ? t(key) : `${raw} · ${unknown}`;
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()].map(([label, count]) => `${label} ×${count}`).join(" · ");
}

/** user 主体绑定也 20/页：真栈这一栈有 476 条，不分页等于把整表塞进 DOM。 */
const BINDING_PAGE_SIZE = PAGE_SIZE;
const bindingPage = ref(1);
const bindingTotalPages = computed(() =>
    Math.max(1, Math.ceil((userBindings.value ?? []).length / BINDING_PAGE_SIZE)),
);
const bindingPageRows = computed(() => {
    const page = Math.min(Math.max(bindingPage.value, 1), bindingTotalPages.value);
    return (userBindings.value ?? []).slice(
        (page - 1) * BINDING_PAGE_SIZE,
        page * BINDING_PAGE_SIZE,
    );
});

function goBindingPage(delta: number): void {
    bindingPage.value = Math.min(Math.max(bindingPage.value, 1), bindingTotalPages.value) + delta;
}

// ---------------- 以当前身份查询 ----------------
const explainActionClass = ref(""),
    explainResource = ref(""),
    explainLoading = ref(false),
    explainResult = ref<AuthorizationExplainView | null>(null),
    explainCause = ref<unknown | null>(null),
    explainInvalid = ref(false);

const explainMissing = computed(() => explainResult.value?.missingAtom ?? null);
const explainMatched = computed(() => explainResult.value?.matchedGrantRefs ?? []);
const explainLevels = computed(() => explainResult.value?.evaluatedLevels ?? []);

async function runExplain(): Promise<void> {
    const actionClass = explainActionClass.value.trim();
    explainInvalid.value = actionClass.length === 0;
    if (explainInvalid.value) return;
    explainLoading.value = true;
    explainCause.value = null;
    explainResult.value = null;
    try {
        // 只传 actionClass / resource：请求体里没有任何主体参数（主体 = 登录者，CP 侧取）。
        explainResult.value = await api.explainAuthorization(actionClass, explainResource.value);
    } catch (e) {
        explainCause.value = e;
    } finally {
        explainLoading.value = false;
    }
}

onMounted(async () => {
    await Promise.all([loadSelf(), loadUserBindings()]);
    const first = workspaceOptions.value[0]?.id;
    if (first) await selectWorkspace(first);
});
</script>

<template>
    <div class="space-y-6" data-testid="authorization-overview">
        <header class="space-y-1">
            <!-- task-189/task-63：页面标题必须是 h2 —— 层标题（SettingsLayerHeader）是唯一 h1。 -->
            <h2 class="text-lg font-semibold text-foreground">
                {{ t("settings.authorizationOverview.title") }}
            </h2>
            <p class="text-sm text-muted-foreground">
                {{ t("settings.authorizationOverview.description") }}
            </p>
        </header>

        <!-- 口径句：照 task-8 裁定原文，不许改写成「部分来源暂未支持」这类模糊话。 -->
        <p
            class="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground"
            data-testid="authorization-overview-scope-note"
        >
            {{ t("settings.authorizationOverview.scopeNote") }}
        </p>

        <!-- ① 我的生效授权 -->
        <section class="space-y-3" data-testid="authorization-self-section">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
                <h2 class="text-sm font-semibold text-foreground">
                    {{ t("settings.authorizationOverview.selfTitle") }}
                </h2>
                <p class="text-xs text-muted-foreground">
                    {{ t("settings.authorizationOverview.selfHint") }}
                </p>
            </div>

            <p
                v-if="selfLoading"
                class="text-xs text-muted-foreground"
                data-testid="authorization-self-loading"
            >
                {{ t("settings.authorizationOverview.loading") }}
            </p>
            <SettingsErrorSurface
                v-else-if="selfCause"
                :cause="selfCause"
                :retry="loadSelf"
                retry-key="settings.errorSurface.retry"
            />

            <template v-else>
                <div
                    v-for="source in OBSERVABLE_SOURCES"
                    :key="source"
                    class="rounded-md border border-border"
                    :data-testid="`authorization-source-${source}`"
                >
                    <div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                        <code class="font-mono text-xs text-foreground">{{ source }}</code>
                        <Badge variant="secondary" data-testid="authorization-source-count">
                            {{ countOf(source) }}
                        </Badge>
                        <span class="text-xs text-muted-foreground">
                            {{ t(`settings.authorizationOverview.source.${source}`) }}
                        </span>
                    </div>

                    <p
                        v-if="countOf(source) === 0"
                        class="px-3 py-2 text-xs text-muted-foreground"
                        :data-testid="`authorization-source-${source}-empty`"
                    >
                        {{ t("settings.authorizationOverview.sourceEmpty") }}
                    </p>
                    <template v-else>
                        <ul class="divide-y divide-border">
                            <li
                                v-for="row in pageRows(source)"
                                :key="row.key"
                                class="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 text-xs"
                                data-testid="authorization-atom-row"
                            >
                                <code class="font-mono text-[11px] text-foreground">
                                    {{ row.atom.actionClass }}
                                </code>
                                <span class="font-mono text-[11px] text-muted-foreground">
                                    {{ row.atom.resource }}
                                </span>
                                <span
                                    v-if="row.source.roleName"
                                    class="text-muted-foreground"
                                    data-testid="authorization-atom-role-name"
                                >
                                    {{ row.source.roleName }}
                                </span>
                                <span
                                    class="text-muted-foreground"
                                    data-testid="authorization-atom-scope"
                                >
                                    {{ scopeText(row) }}
                                </span>
                                <span
                                    v-if="row.source.grantId"
                                    class="font-mono text-[11px] text-muted-foreground/80"
                                    data-testid="authorization-atom-grant-id"
                                >
                                    {{ shortId(row.source.grantId) }}
                                </span>
                            </li>
                        </ul>
                        <div
                            v-if="totalPages(source) > 1"
                            class="flex items-center justify-between gap-2 px-3 py-1.5"
                            :data-testid="`authorization-source-${source}-pager`"
                        >
                            <p class="text-xs text-muted-foreground">
                                {{ pageOf(source) }} / {{ totalPages(source) }}
                            </p>
                            <div class="flex gap-1">
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    :disabled="pageOf(source) <= 1"
                                    :data-testid="`authorization-source-${source}-prev`"
                                    @click="goPage(source, -1)"
                                >
                                    {{ t("settings.authorizationOverview.pagerPrev") }}
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    :disabled="pageOf(source) >= totalPages(source)"
                                    :data-testid="`authorization-source-${source}-next`"
                                    @click="goPage(source, 1)"
                                >
                                    {{ t("settings.authorizationOverview.pagerNext") }}
                                </Button>
                            </div>
                        </div>
                    </template>
                </div>
            </template>
        </section>

        <!-- ② 六来源读面表 -->
        <section class="space-y-3" data-testid="authorization-readface-section">
            <div class="space-y-1">
                <h2 class="text-sm font-semibold text-foreground">
                    {{ t("settings.authorizationOverview.readface.title") }}
                </h2>
                <p class="text-xs text-muted-foreground">
                    {{ t("settings.authorizationOverview.readface.hint") }}
                </p>
            </div>
            <ul class="space-y-2">
                <li
                    v-for="source in READFACE_SOURCES"
                    :key="source"
                    class="rounded-md border border-border px-3 py-2"
                    :data-testid="`authorization-readface-${source}`"
                >
                    <div class="flex flex-wrap items-center gap-2">
                        <code class="font-mono text-xs text-foreground">{{ source }}</code>
                        <Badge :variant="tierVariant(READFACE_TIER[source])">
                            {{ tierLabel(READFACE_TIER[source]) }}
                        </Badge>
                        <router-link
                            v-if="readfaceLink(source)"
                            :to="readfaceLink(source)!"
                            class="text-xs text-primary underline-offset-4 hover:underline"
                            data-testid="authorization-readface-link"
                        >
                            {{ t("settings.authorizationOverview.readface.open") }}
                        </router-link>
                    </div>
                    <p class="mt-1 text-xs leading-5 text-muted-foreground">
                        {{ t(`settings.authorizationOverview.readface.${source}`) }}
                    </p>
                </li>
            </ul>
            <p
                class="text-xs text-muted-foreground"
                data-testid="authorization-readface-no-inference"
            >
                {{ t("settings.authorizationOverview.readface.noInference") }}
            </p>
        </section>

        <!-- ③ 按主体（读面能到的部分） -->
        <section class="space-y-3" data-testid="authorization-subjects-section">
            <h2 class="text-sm font-semibold text-foreground">
                {{ t("settings.authorizationOverview.subjects.title") }}
            </h2>

            <div class="space-y-2">
                <p class="text-xs text-muted-foreground">
                    {{ t("settings.authorizationOverview.subjects.workspaceHint") }}
                </p>
                <div class="flex flex-wrap gap-1" data-testid="authorization-workspace-tabs">
                    <Button
                        v-for="ws in workspaceOptions"
                        :key="ws.id"
                        size="sm"
                        :variant="activeWorkspaceId === ws.id ? 'secondary' : 'ghost'"
                        :data-testid="`authorization-workspace-tab-${shortId(ws.id)}`"
                        @click="selectWorkspace(ws.id)"
                    >
                        {{ shortId(ws.id) }}
                    </Button>
                </div>

                <p
                    v-if="!activeWorkspaceId"
                    class="text-xs text-muted-foreground"
                    data-testid="authorization-agents-idle"
                >
                    {{ t("settings.authorizationOverview.subjects.pickWorkspace") }}
                </p>
                <p
                    v-else-if="agentsLoading"
                    class="text-xs text-muted-foreground"
                    data-testid="authorization-agents-loading"
                >
                    {{ t("settings.authorizationOverview.loading") }}
                </p>
                <SettingsErrorSurface
                    v-else-if="agentsCause"
                    :cause="agentsCause"
                    :retry="() => selectWorkspace(activeWorkspaceId!)"
                    retry-key="settings.errorSurface.retry"
                />
                <template v-else>
                    <p
                        v-if="agents.length === 0"
                        class="text-xs text-muted-foreground"
                        data-testid="authorization-agents-empty"
                    >
                        {{ t("settings.authorizationOverview.subjects.agentsEmpty") }}
                    </p>
                    <ul v-else class="divide-y divide-border rounded-md border border-border">
                        <li v-for="agent in agents" :key="agent.principalId">
                            <Button
                                variant="ghost"
                                class="h-auto w-full justify-start gap-2 rounded-none px-3 py-2 text-left"
                                :data-testid="`authorization-subject-agent-${agent.principalId}`"
                                @click="selectPrincipal(agent.principalId)"
                            >
                                <span class="text-xs font-medium text-foreground">{{
                                    agent.name
                                }}</span>
                                <code class="font-mono text-[11px] text-muted-foreground">
                                    {{ shortId(agent.principalId) }}
                                </code>
                                <Badge
                                    variant="outline"
                                    data-testid="authorization-subject-cap-mode"
                                >
                                    {{ capModeLabel(agent.capSource ?? "none") }}
                                </Badge>
                                <span class="text-xs text-muted-foreground">
                                    {{
                                        t("settings.authorizationOverview.subjects.snapshotAtoms", {
                                            count: agent.permissionsSnapshot.length,
                                        })
                                    }}
                                </span>
                            </Button>
                        </li>
                    </ul>

                    <div
                        v-if="activePrincipalId"
                        class="space-y-2 rounded-md border border-border px-3 py-2"
                        data-testid="authorization-subject-detail"
                    >
                        <p class="text-xs font-medium text-foreground">
                            {{ activeAgent?.name ?? shortId(activePrincipalId) }}
                        </p>
                        <p v-if="detailLoading" class="text-xs text-muted-foreground">
                            {{ t("settings.authorizationOverview.loading") }}
                        </p>
                        <template v-else>
                            <div class="space-y-1" data-testid="authorization-subject-roles">
                                <p class="text-xs text-muted-foreground">
                                    {{ t("settings.authorizationOverview.subjects.roles") }}
                                </p>
                                <p
                                    v-if="detailRolesCause"
                                    class="text-xs text-muted-foreground"
                                    data-testid="authorization-subject-roles-error"
                                >
                                    {{
                                        t(
                                            "settings.authorizationOverview.subjects.rolesUnavailable",
                                        )
                                    }}
                                </p>
                                <p
                                    v-else-if="(detailRoles ?? []).length === 0"
                                    class="text-xs text-muted-foreground"
                                >
                                    {{ t("settings.authorizationOverview.subjects.rolesEmpty") }}
                                </p>
                                <ul v-else class="space-y-1">
                                    <li
                                        v-for="role in detailRoles ?? []"
                                        :key="role.bindingId"
                                        class="flex flex-wrap items-center gap-2 text-xs"
                                        data-testid="authorization-subject-role-row"
                                    >
                                        <span class="text-foreground">{{
                                            role.displayName || role.name
                                        }}</span>
                                        <code class="font-mono text-[11px] text-muted-foreground">
                                            {{ shortId(role.bindingId) }}
                                        </code>
                                        <span class="text-muted-foreground">{{
                                            role.scopeType
                                        }}</span>
                                    </li>
                                </ul>
                            </div>

                            <div class="space-y-1" data-testid="authorization-subject-cap">
                                <p class="text-xs text-muted-foreground">
                                    {{ t("settings.authorizationOverview.subjects.cap") }}
                                </p>
                                <p
                                    v-if="detailCapCause"
                                    class="text-xs text-muted-foreground"
                                    data-testid="authorization-subject-cap-error"
                                >
                                    {{
                                        t("settings.authorizationOverview.subjects.capUnavailable")
                                    }}
                                </p>
                                <template v-else-if="detailCap">
                                    <div class="flex flex-wrap gap-1">
                                        <Badge
                                            v-for="atom in detailCap.effectiveCap"
                                            :key="`${atom.actionClass}:${atom.resource}`"
                                            variant="outline"
                                        >
                                            {{ atom.actionClass }}
                                        </Badge>
                                    </div>
                                    <p
                                        class="text-xs text-muted-foreground"
                                        data-testid="authorization-subject-cap-note"
                                    >
                                        {{
                                            t("settings.authorizationOverview.subjects.capNote", {
                                                binding: capBindingLabel(
                                                    detailCap.capSource.binding,
                                                ),
                                                count: detailCap.provenance.principalGrantIds
                                                    .length,
                                                sources: capSourcesSummary(detailCap),
                                            })
                                        }}
                                    </p>
                                </template>
                            </div>
                        </template>
                    </div>
                </template>
            </div>

            <div
                class="space-y-2 rounded-md border border-border px-3 py-2"
                data-testid="authorization-user-bindings"
            >
                <p class="text-xs text-muted-foreground">
                    {{ t("settings.authorizationOverview.subjects.userBindings") }}
                </p>
                <p v-if="userBindingsLoading" class="text-xs text-muted-foreground">
                    {{ t("settings.authorizationOverview.loading") }}
                </p>
                <SettingsErrorSurface
                    v-else-if="userBindingsCause"
                    :cause="userBindingsCause"
                    :retry="loadUserBindings"
                    retry-key="settings.errorSurface.retry"
                />
                <p
                    v-else-if="userBindingsDeniedRaw"
                    class="text-xs text-muted-foreground"
                    data-testid="authorization-user-bindings-denied"
                >
                    {{ t("settings.authorizationOverview.subjects.userBindingsDenied") }}
                    <code
                        class="ml-1 font-mono text-[11px] text-foreground"
                        data-testid="authorization-user-bindings-denied-atom"
                    >
                        {{ userBindingsDeniedRaw }}
                    </code>
                </p>
                <p
                    v-else-if="(userBindings ?? []).length === 0"
                    class="text-xs text-muted-foreground"
                    data-testid="authorization-user-bindings-empty"
                >
                    {{ t("settings.authorizationOverview.subjects.userBindingsEmpty") }}
                </p>
                <template v-else>
                    <ul class="space-y-1">
                        <li
                            v-for="binding in bindingPageRows"
                            :key="binding.id"
                            class="flex flex-wrap items-center gap-2 text-xs"
                            data-testid="authorization-user-binding-row"
                        >
                            <span class="text-foreground">{{
                                binding.roleName || binding.roleId
                            }}</span>
                            <code class="font-mono text-[11px] text-muted-foreground">
                                {{ shortId(binding.subjectId) }}
                            </code>
                            <span class="text-muted-foreground">{{ binding.subjectType }}</span>
                        </li>
                    </ul>
                    <div
                        v-if="bindingTotalPages > 1"
                        class="flex items-center justify-between gap-2"
                        data-testid="authorization-user-bindings-pager"
                    >
                        <p class="text-xs text-muted-foreground">
                            {{ bindingPage }} / {{ bindingTotalPages }}
                        </p>
                        <div class="flex gap-1">
                            <Button
                                size="sm"
                                variant="ghost"
                                :disabled="bindingPage <= 1"
                                data-testid="authorization-user-bindings-prev"
                                @click="goBindingPage(-1)"
                            >
                                {{ t("settings.authorizationOverview.pagerPrev") }}
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                :disabled="bindingPage >= bindingTotalPages"
                                data-testid="authorization-user-bindings-next"
                                @click="goBindingPage(1)"
                            >
                                {{ t("settings.authorizationOverview.pagerNext") }}
                            </Button>
                        </div>
                    </div>
                </template>
            </div>
        </section>

        <!-- ④ 以当前身份查询 -->
        <section class="space-y-3" data-testid="authorization-explain-section">
            <h2 class="text-sm font-semibold text-foreground">
                {{ t("settings.authorizationOverview.explain.title") }}
            </h2>
            <p class="text-xs text-muted-foreground" data-testid="authorization-explain-note">
                {{ t("settings.authorizationOverview.explain.note") }}
            </p>

            <form class="flex flex-wrap items-end gap-2" @submit.prevent="runExplain">
                <label class="space-y-1">
                    <span class="block text-xs text-muted-foreground">
                        {{ t("settings.authorizationOverview.explain.actionClass") }}
                    </span>
                    <Input
                        v-model="explainActionClass"
                        data-testid="authorization-explain-action-class"
                        class="w-56"
                        :placeholder="
                            t('settings.authorizationOverview.explain.actionClassExample')
                        "
                    />
                </label>
                <label class="space-y-1">
                    <span class="block text-xs text-muted-foreground">
                        {{ t("settings.authorizationOverview.explain.resource") }}
                    </span>
                    <Input
                        v-model="explainResource"
                        data-testid="authorization-explain-resource"
                        class="w-56"
                        placeholder="*"
                    />
                </label>
                <Button
                    type="submit"
                    size="sm"
                    :disabled="explainLoading"
                    data-testid="authorization-explain-submit"
                >
                    {{ t("settings.authorizationOverview.explain.submit") }}
                </Button>
            </form>

            <p
                v-if="explainInvalid"
                class="text-xs text-destructive"
                data-testid="authorization-explain-invalid"
            >
                {{ t("settings.authorizationOverview.explain.needActionClass") }}
            </p>

            <SettingsErrorSurface v-if="explainCause" :cause="explainCause" />

            <div
                v-else-if="explainResult"
                class="space-y-2 rounded-md border border-border px-3 py-2"
                data-testid="authorization-explain-result"
            >
                <div class="flex flex-wrap items-center gap-2">
                    <Badge :variant="explainResult.allowed ? 'secondary' : 'destructive'">
                        {{
                            explainResult.allowed
                                ? t("settings.authorizationOverview.explain.allowed")
                                : t("settings.authorizationOverview.explain.denied")
                        }}
                    </Badge>
                    <span
                        v-if="!explainResult.allowed && explainResult.deepestMissingLevel"
                        class="text-xs text-muted-foreground"
                        data-testid="authorization-explain-deepest-level"
                    >
                        {{ explainResult.deepestMissingLevel }}
                    </span>
                </div>

                <div
                    v-if="!explainResult.allowed && explainMissing"
                    class="space-y-1"
                    data-testid="authorization-explain-missing-atom"
                >
                    <p class="text-xs text-muted-foreground">
                        {{ t("settings.authorizationOverview.explain.missingAtom") }}
                    </p>
                    <div class="flex flex-wrap items-center gap-2 text-xs">
                        <code class="font-mono text-[11px] text-foreground">{{
                            explainMissing.actionClass
                        }}</code>
                        <code class="font-mono text-[11px] text-muted-foreground">{{
                            explainMissing.resource
                        }}</code>
                        <span v-if="explainMissing.levelLabel" class="text-muted-foreground">
                            {{ explainMissing.levelLabel }}
                        </span>
                        <span v-if="explainMissing.reason" class="text-muted-foreground">
                            {{ explainMissing.reason }}
                        </span>
                    </div>
                </div>

                <div class="space-y-1" data-testid="authorization-explain-levels">
                    <p class="text-xs text-muted-foreground">
                        {{ t("settings.authorizationOverview.explain.evaluated") }}
                    </p>
                    <ul class="space-y-0.5">
                        <li
                            v-for="level in explainLevels"
                            :key="level.level"
                            class="flex flex-wrap items-center gap-2 text-xs"
                            data-testid="authorization-explain-level-row"
                        >
                            <span class="text-foreground">{{ level.label || level.level }}</span>
                            <span class="text-muted-foreground"
                                >{{ level.matched }} / {{ level.atomCount }}</span
                            >
                        </li>
                    </ul>
                </div>

                <div class="space-y-1" data-testid="authorization-explain-matched">
                    <p class="text-xs text-muted-foreground">
                        {{ t("settings.authorizationOverview.explain.matched") }}
                    </p>
                    <p
                        v-if="explainMatched.length === 0"
                        class="text-xs text-muted-foreground"
                        data-testid="authorization-explain-matched-empty"
                    >
                        {{ t("settings.authorizationOverview.explain.noMatch") }}
                    </p>
                    <ul v-else class="space-y-0.5">
                        <li
                            v-for="ref in explainMatched"
                            :key="`${ref.level}:${ref.grantId}:${ref.actionClass}`"
                            class="flex flex-wrap items-center gap-2 text-xs"
                            data-testid="authorization-explain-matched-row"
                        >
                            <code class="font-mono text-[11px] text-foreground">{{
                                ref.actionClass
                            }}</code>
                            <code class="font-mono text-[11px] text-muted-foreground">{{
                                ref.grantSource
                            }}</code>
                            <span class="font-mono text-[11px] text-muted-foreground/80">
                                {{ shortId(ref.grantId) }}
                            </span>
                        </li>
                    </ul>
                </div>
            </div>
        </section>
    </div>
</template>
