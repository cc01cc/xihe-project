<script setup lang="ts">
import { computed } from "vue";
import { ArrowLeft, Plus } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { MockDomain, MockLayer } from "../data/types";
import DomainCanvas from "./DomainCanvas.vue";

/**
 * 专用面板域的内容区（裁定 E / ③）：**两个状态**，一屏只呈现一个。
 *
 * - 列表态（默认）：资源列表 + 「新增 X」主行动
 * - 详情态（`?detail=1`）：选中一行后展开的编辑字段，直接复用 `DomainCanvas` 的字段渲染
 *
 * 为什么必须有详情态：产品的关键不是「有几个提供商」，而是「点进去能改什么」。只画列表等于没画重点。
 * 本组件是三方共用骨架件（llm-provider / embedding / agent-templates / api-request-templates）。
 */
const props = defineProps<{
    domain: MockDomain;
    currentLayer?: MockLayer;
    detail?: boolean;
    selectedRowId?: string;
}>();

const layer = computed<MockLayer>(() => props.currentLayer ?? "instance");
const panel = computed(() => props.domain.panel);
/** [裁定] 主行动形状：默认 add。pick 域的行是**可选中**的，且没有新建按钮。 */
type Action = {
    label: string;
    variant?: "default" | "outline" | "ghost" | "destructive";
    hint?: string;
};
const actions = computed<Action[]>(() => {
    const a = panel.value?.actions;
    if (!a) return [];
    if (Array.isArray(a)) return a;
    return [
        ...(a.save ? [{ label: a.save.label, variant: "default" as const }] : []),
        ...(a.clear
            ? [{ label: a.clear.label, variant: "outline" as const, hint: a.clear.hint }]
            : []),
    ];
});
const clearHint = computed(() => actions.value.find((x) => x.hint)?.hint ?? "");
const isPick = computed(() => panel.value?.primaryAction === "pick");
/** 层名中文化：英文 `user` 直接上屏是缺陷（用户层要读成「用户层」）。 */
const LAYER_NAME: Record<MockLayer, string> = {
    instance: "实例层",
    workspace: "工作区层",
    user: "用户层",
};
const selectedRow = computed(
    () => panel.value?.rows.find((row) => row.id === props.selectedRowId) ?? panel.value?.rows[0],
);
/** 详情态渲染用的伪域：字段来自 `panel.detail.groups`，标题沿用行名。 */
const detailDomain = computed<MockDomain>(() => ({
    id: props.domain.id + "-detail",
    label: selectedRow.value?.cells.name ?? props.domain.label,
    summary: panel.value?.detail.note ?? props.domain.summary,
    layout: "form",
    groups: panel.value?.detail.groups ?? [],
}));
</script>

<template>
    <div v-if="panel">
        <!-- 详情态 -->
        <template v-if="detail">
            <button
                class="mb-3 flex items-center gap-1 mk-caption text-muted-foreground hover:text-foreground"
                type="button"
            >
                <ArrowLeft class="size-3" aria-hidden="true" />返回{{ domain.label }}列表
            </button>
            <DomainCanvas :domain="detailDomain" :current-layer="layer" />
            <div v-if="actions.length" class="mt-6 flex items-center gap-2">
                <Button
                    v-for="action in actions"
                    :key="action.label"
                    size="sm"
                    :variant="action.variant ?? 'default'"
                    :title="action.hint ?? ''"
                    >{{ action.label }}</Button
                >
            </div>
            <p v-if="clearHint" class="mt-2 mk-caption text-muted-foreground">{{ clearHint }}</p>
        </template>

        <!-- 列表态 -->
        <div v-else>
            <div class="flex items-baseline gap-3">
                <h1 class="mk-title" data-single-line>{{ domain.label }}</h1>
                <!-- [裁定 ⑦] 量词统一：列表态写「· 3 个连接」（数字是派生值，单位来自 panel.unit） -->
                <span class="mk-caption text-muted-foreground" data-single-line
                    >· {{ panel.rows.length }} {{ panel.unit ?? "条目" }}</span
                >
                <span class="mk-caption text-muted-foreground" data-single-line
                    >当前层：{{ LAYER_NAME[layer] }}</span
                >
            </div>
            <p class="mt-1 mk-body text-muted-foreground">{{ domain.summary }}</p>

            <!-- 主行动两种形状（裁定）：add = 右上「新增」；pick = 没有新建，只能选一条候选 -->
            <div class="mt-5 flex items-center justify-between">
                <span class="mk-caption text-muted-foreground" data-single-line>
                    <template v-if="isPick"
                        >连接需要先在「LLM 提供商」里创建，这里挑一条用于向量化</template
                    >
                    <template v-else>选中一行可以查看并修改它的设置</template>
                </span>
                <Button v-if="!isPick" size="sm">
                    <Plus class="size-4" />
                    {{ panel.addLabel }}
                </Button>
                <Button v-else size="sm" variant="outline">{{ panel.addLabel }}</Button>
            </div>

            <div class="mt-3 overflow-hidden rounded-lg border border-border">
                <div
                    class="grid items-center gap-3 border-b border-border bg-muted/40 px-4 py-2 mk-caption text-muted-foreground"
                    :style="{
                        gridTemplateColumns: 'repeat(' + panel.columns.length + ', minmax(0, 1fr))',
                    }"
                >
                    <span v-for="column in panel.columns" :key="column.key" data-single-line>{{
                        column.label
                    }}</span>
                </div>
                <div
                    v-for="row in panel.rows"
                    :key="row.id"
                    class="grid items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0 hover:bg-muted/40"
                    :class="isPick && row.id === selectedRow?.id ? 'bg-muted/60' : ''"
                    :aria-selected="isPick ? row.id === selectedRow?.id : undefined"
                    :style="{
                        gridTemplateColumns: 'repeat(' + panel.columns.length + ', minmax(0, 1fr))',
                    }"
                >
                    <span
                        v-for="column in panel.columns"
                        :key="column.key"
                        class="truncate mk-body"
                        data-single-line
                        >{{ row.cells[column.key] ?? "—"
                        }}<Badge
                            v-if="row.state === 'gap' && column.key === panel.columns[0].key"
                            variant="outline"
                            class="ml-1 mk-caption align-middle"
                            >后端缺口</Badge
                        ></span
                    >
                </div>
            </div>
        </div>
    </div>
    <p class="mt-8 mk-caption text-muted-foreground" data-single-line>
        mock：按钮形态与反馈位，不发真实 PUT
    </p>
</template>
