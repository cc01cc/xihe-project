<script setup lang="ts">
/**
 * PLAN-0659 T1.4：右栏**委派 DAG**（升级 PLAN-0655 的会话树投影）。
 *
 * 只做三件事：把 `sessions` 投影成父→子图（`delegationGraph.ts` 纯函数）、给"可能是父"的
 * 节点补一次 derived-state（拿子节点状态）、根节点补一次 delegation-usage（拿预算）。
 * SVG 边自绘，**不引图库**（design 决策：能自绘就不加依赖）。
 *
 * 请求是**读投影**、失败可重试：拉不到就保留结构图并显式报错，不把"未知"画成"没有子会话"。
 * 不做轮询：derived-state 由 ChatPanel 的 SSE 提示驱动；本面板只在打开/切会话/手动刷新时拉。
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RefreshCw } from "@lucide/vue";
import { useSessionStore } from "../../../../stores/session";
import { api, type DelegationUsageView } from "../../../../composables/api";
import { logger } from "../../../../lib/logger";
import type { SessionDerivedStateResponse } from "../../../../types";
import {
    buildDelegationGraph,
    delegationStatusIsActive,
    delegationStatusLabelKey,
    type DelegationNode,
    type DelegationNodeStatus,
} from "../delegationGraph";

const props = defineProps<{ sessionId: string }>();
const { t } = useI18n();
const sessionStore = useSessionStore();

const statusBySessionId = ref(new Map<string, DelegationNodeStatus>());
const rootBudget = ref<DelegationUsageView | null>(null);
const loading = ref(false);
const error = ref(false);
let loadGeneration = 0;

const graph = computed(() =>
    buildDelegationGraph({
        sessions: sessionStore.sessions,
        currentSessionId: props.sessionId,
        statusBySessionId: statusBySessionId.value,
    }),
);
const hasChildren = computed(() => graph.value.edges.length > 0);

// —— 布局（纯几何，单位 px；与判据无关，测试只钉 DOM/testid） ——
// PLAN-0659 T1.4 缺陷修复（A 类，2026-11-04）：480px 右栏下 `(maxDepth+1)×COL_W` + `p-3`
// 内边距超过可用宽度 ⇒ 面板出现横向滚动条（`(232×2)+24 > 456`）。`COL_W` 232→224 且滚动
// 容器 `p-3`→`p-2`：两层 depth 时画布 448px，可用宽 ≈464px，留 16px 余量；比例几乎不变。
const ROW_H = 44;
const COL_W = 224;
const NODE_W = 200;
const NODE_H = 34;
interface PositionedNode {
    node: DelegationNode;
    x: number;
    y: number;
}
const rows = computed<PositionedNode[]>(() =>
    graph.value.nodes.map((node, index) => ({
        node,
        x: node.depth * COL_W,
        y: index * ROW_H,
    })),
);
const canvas = computed(() => ({
    width: Math.max(1, graph.value.maxDepth + 1) * COL_W,
    height: Math.max(rows.value.length, 1) * ROW_H,
}));

function edgePath(from: string, to: string): string {
    const parent = rows.value.find((row) => row.node.sessionId === from),
        child = rows.value.find((row) => row.node.sessionId === to);
    if (!parent || !child) return "";
    const x1 = parent.x + NODE_W,
        y1 = parent.y + NODE_H / 2,
        x2 = child.x,
        y2 = child.y + NODE_H / 2,
        midX = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${midX} ${y1} ${midX} ${y2} ${x2} ${y2}`;
}

function statusLabel(node: DelegationNode): string {
    const key = delegationStatusLabelKey(node.status);
    return key ? t(key) : "";
}

function statusTone(node: DelegationNode): string {
    if (delegationStatusIsActive(node.status)) return "bg-primary";
    if (node.status?.terminal === "error") return "bg-destructive";
    if (node.status?.terminal) return "bg-muted-foreground/60";
    return "bg-border";
}

/**
 * 拉状态/预算。`generation` 防竞态：切会话后旧请求回来直接丢弃（不覆盖新会话的图）。
 */
async function load(): Promise<void> {
    const generation = ++loadGeneration;
    const sessionId = props.sessionId;
    if (!sessionId) return;
    loading.value = true;
    error.value = false;
    try {
        if (sessionStore.sessions.length === 0) await sessionStore.loadSessions();
        if (generation !== loadGeneration) return;

        const structure = buildDelegationGraph({
            sessions: sessionStore.sessions,
            currentSessionId: sessionId,
        });
        // 只有"可能是父"的节点才值得拉 derived-state（叶子的状态由父的那次响应给出）。
        const parentIds = [...new Set(structure.edges.map((edge) => edge.from))];
        if (structure.nodes.length > 1 && !parentIds.includes(structure.rootSessionId)) {
            parentIds.push(structure.rootSessionId);
        }

        const next = new Map<string, DelegationNodeStatus>();
        let failedParents = 0;
        const results = await Promise.all(
            parentIds.map(async (parentId) => {
                try {
                    return [parentId, await api.getSessionDerivedState(parentId)] as const;
                } catch (cause) {
                    logger.warn("failed to read delegation child state", { parentId, cause });
                    failedParents += 1;
                    return [parentId, null] as const;
                }
            }),
        );
        if (generation !== loadGeneration) return;
        for (const derived of results.map(([, value]) => value)) {
            if (derived) collectStatuses(derived, next);
        }
        statusBySessionId.value = next;
        // 子状态部分失败 ⇒ 结构照常显示，但显式告知（不把「未知」画成「没有子任务」）。
        if (failedParents > 0) error.value = true;

        try {
            rootBudget.value = await api.delegationUsage(structure.rootSessionId);
        } catch (cause) {
            logger.warn("failed to read delegation usage", cause);
            rootBudget.value = null;
        }
        if (generation !== loadGeneration) return;
    } catch (cause) {
        logger.error("failed to load delegation graph", cause);
        error.value = true;
    } finally {
        if (generation === loadGeneration) loading.value = false;
    }
}

function collectStatuses(
    derived: SessionDerivedStateResponse,
    target: Map<string, DelegationNodeStatus>,
): void {
    for (const child of derived.activeChildren ?? []) {
        target.set(child.childSessionId, {
            runId: child.runId,
            active: child.status,
            ...(child.name ? { name: child.name } : {}),
        });
    }
    for (const notice of derived.terminalNotices ?? []) {
        target.set(notice.childSessionId, {
            runId: notice.runId,
            terminal: notice.state,
            ...(notice.name ? { name: notice.name } : {}),
        });
    }
}

watch(
    () => [props.sessionId, sessionStore.sessions.length] as const,
    () => void load(),
    { immediate: true },
);
</script>

<template>
    <section
        class="flex h-full min-h-0 flex-col"
        data-testid="delegation-dag"
        :aria-label="t('chat.delegation.dagTitle')"
    >
        <header class="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
            <div class="min-w-0">
                <h2 class="truncate text-xs font-medium text-foreground">
                    {{ t("chat.delegation.dagTitle") }}
                </h2>
                <p
                    v-if="rootBudget"
                    class="truncate text-[10px] text-muted-foreground"
                    data-testid="delegation-dag-budget"
                >
                    {{
                        t("chat.delegation.dagBudget", {
                            used: rootBudget.usedSessions,
                            max: rootBudget.maxCount,
                            depth: rootBudget.currentDepth,
                            maxDepth: rootBudget.maxDepth,
                        })
                    }}
                </p>
            </div>
            <button
                type="button"
                class="shrink-0 rounded border border-border p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :aria-label="t('chat.delegation.dagRefresh')"
                :title="t('chat.delegation.dagRefresh')"
                :disabled="loading"
                data-testid="delegation-dag-refresh"
                @click="load"
            >
                <RefreshCw
                    class="size-3.5"
                    :class="loading ? 'animate-spin' : ''"
                    aria-hidden="true"
                />
            </button>
        </header>

        <p
            v-if="error"
            class="mx-3 mt-2 rounded border border-destructive/40 bg-destructive/5 px-2 py-1 text-[11px] text-destructive"
            role="status"
            data-testid="delegation-dag-error"
        >
            {{ t("chat.delegation.dagError") }}
        </p>

        <p
            v-if="graph.truncated"
            class="mx-3 mt-2 text-[11px] text-muted-foreground"
            data-testid="delegation-dag-truncated"
        >
            {{ t("chat.delegation.dagTruncated", { count: graph.nodes.length }) }}
        </p>

        <p
            v-if="!hasChildren && !loading"
            class="px-3 py-6 text-center text-xs text-muted-foreground"
            data-testid="delegation-dag-empty"
        >
            {{ t("chat.delegation.dagEmpty") }}
        </p>

        <div v-else class="min-h-0 flex-1 overflow-auto p-2">
            <div
                class="relative"
                :style="{ width: `${canvas.width}px`, height: `${canvas.height}px` }"
            >
                <svg
                    class="pointer-events-none absolute inset-0"
                    :width="canvas.width"
                    :height="canvas.height"
                    aria-hidden="true"
                >
                    <path
                        v-for="edge in graph.edges"
                        :key="`${edge.from}->${edge.to}`"
                        :d="edgePath(edge.from, edge.to)"
                        fill="none"
                        class="stroke-border"
                        stroke-width="1.5"
                        data-testid="delegation-edge"
                    />
                </svg>
                <div
                    v-for="row in rows"
                    :key="row.node.sessionId"
                    class="absolute flex items-center gap-1.5 overflow-hidden rounded-md border border-border/70 bg-muted/20 px-2 text-xs"
                    :class="
                        row.node.sessionId === props.sessionId
                            ? 'border-primary/40 bg-accent/30'
                            : ''
                    "
                    :style="{
                        left: `${row.x}px`,
                        top: `${row.y}px`,
                        width: `${NODE_W}px`,
                        height: `${NODE_H}px`,
                    }"
                    :title="row.node.title"
                    data-testid="delegation-node"
                    :data-session-id="row.node.sessionId"
                    :data-depth="row.node.depth"
                    :data-node-active="
                        delegationStatusIsActive(row.node.status) ? 'true' : undefined
                    "
                    :data-node-terminal="row.node.status?.terminal ?? undefined"
                >
                    <span
                        class="size-1.5 shrink-0 rounded-full"
                        :class="statusTone(row.node)"
                        aria-hidden="true"
                        data-testid="delegation-node-dot"
                    />
                    <span class="min-w-0 truncate text-foreground">{{ row.node.title }}</span>
                    <span
                        v-if="row.node.depth > 0"
                        class="shrink-0 rounded border border-border px-1 text-[9px] text-muted-foreground"
                        data-testid="delegation-node-badge"
                        >{{ t("chat.delegation.badge") }}</span
                    >
                    <span
                        v-if="statusLabel(row.node)"
                        class="ml-auto shrink-0 text-[10px] text-muted-foreground"
                        data-testid="delegation-node-status"
                        >{{ statusLabel(row.node) }}</span
                    >
                </div>
            </div>
        </div>
    </section>
</template>
