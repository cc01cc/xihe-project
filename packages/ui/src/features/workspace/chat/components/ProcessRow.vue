<script setup lang="ts">
/**
 * 2026-11-04 用户裁定（DSH 式过程渲染，Step 1）：思考 / 推理 / 工具调用 / refusal 统一成
 * **单行可折叠 chip** —— `[icon] label ｜ 截断摘要 ｜ 右侧耗时徽标 + 状态文字 + chevron`。
 *
 * - 默认折叠；只有给了默认 slot（展开体）且 `expandable` 才渲染 chevron 与可点行为；
 * - 失败态（failed / refused）在**折叠行上**就有颜色 + 文字（`failed` ⇒ 红色 label + `data-failed`），
 *   不必展开才知道；
 * - 纯展示组件：不做 i18n、不碰业务状态；`expanded` 可 v-model 受控（ToolCallCard 用它保留
 *   "有 diagnostics 时自动展开" 的 PLAN-0349/0649 行为）。
 *
 * 前瞻（Step 2 已落地）：`actor` = 该过程行的产出主体（PLAN-0659 T1.2），由主线程按
 * 「线程是否混主体」决定传不传（单主体线程不重复刷身份）；徽标颜色中立，靠首字母 + 名字。
 */
import { computed, useSlots } from "vue";
import { ChevronDown } from "@lucide/vue";
import type { Component } from "vue";

export interface ProcessRowActor {
    name: string;
    initials: string;
    /** 主体类型：过程行只用于 DOM 断言/图标语义，不靠颜色区分（颜色中立裁定）。 */
    kind?: "HUMAN" | "AGENT";
    /** 参与者 id（仅供 `data-actor-principal-id` 断言/排障；UUID 不上屏）。 */
    principalId?: string;
}

const props = withDefaults(
    defineProps<{
        /** 过程类型：进 `data-process-kind`，供样式与矩阵断言区分。 */
        kind: "thinking" | "reasoning" | "tool" | "refusal";
        label: string;
        /** 单行截断摘要（参数首行 / 推理首行等）。 */
        summary?: string;
        /** 右侧耗时徽标（如 `0.4s`），tabular-nums。 */
        meta?: string;
        /** 右侧状态文字（如《已完成》《已拒绝》），与 `tone` 一起着色。 */
        status?: string;
        /** 状态/图标 tone（Tailwind text-* class）。 */
        tone?: string;
        icon?: Component;
        iconClass?: string;
        /** 失败/拒绝：折叠行红色 + `data-failed`（不展开也可见）。 */
        failed?: boolean;
        /** 是否有展开体（无 slot 时也可显式关闭）。 */
        expandable?: boolean;
        /** 容器 testid（默认 `process-row`）。 */
        testid?: string;
        /** 折叠按钮 testid（默认 `process-row-toggle`；ToolCallCard 传 `tool-card-toggle`）。 */
        toggleTestid?: string;
        /** PLAN-0659 T1.2：产出主体徽标（首字母 + 名字）。缺省 = 不标注（单主体线程）。 */
        actor?: ProcessRowActor;
    }>(),
    {
        // Vue 会把「缺省的 Boolean prop」cast 成 false，所以这里必须显式默认 true。
        expandable: true,
        testid: "process-row",
        toggleTestid: "process-row-toggle",
    },
);

const expanded = defineModel<boolean>("expanded", { default: false });
const slots = useSlots();

const canExpand = computed(() => props.expandable && Boolean(slots.default));

function toggle(): void {
    if (canExpand.value) expanded.value = !expanded.value;
}
</script>

<template>
    <div
        class="my-1 overflow-hidden rounded-md border border-border/60 bg-muted/20"
        :data-testid="testid"
        :data-process-kind="kind"
        :data-failed="failed ? 'true' : undefined"
        :data-has-actor="actor ? 'true' : undefined"
    >
        <button
            type="button"
            class="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs transition-colors"
            :class="canExpand ? 'hover:bg-accent/40' : 'cursor-default'"
            :aria-expanded="canExpand ? expanded : undefined"
            :data-testid="toggleTestid"
            @click="toggle"
        >
            <component
                :is="icon"
                v-if="icon"
                class="size-3.5 shrink-0"
                :class="[iconClass ?? tone ?? 'text-muted-foreground']"
                aria-hidden="true"
            />
            <span
                class="shrink-0 font-medium"
                :class="failed ? 'text-destructive' : 'text-foreground'"
                >{{ label }}</span
            >
            <span
                v-if="summary"
                class="min-w-0 flex-1 truncate text-muted-foreground"
                data-testid="process-row-summary"
                >{{ summary }}</span
            >
            <span v-else class="min-w-0 flex-1" />
            <!--
                PLAN-0659 T1.2：产出主体徽标。颜色中立（不新增色值）：首字母圆点 + 名字，
                `kind`/`principalId` 只进 data-* 供断言与排障；名字用 `title` 兜住截断。
            -->
            <span
                v-if="actor"
                class="flex min-w-0 shrink items-center gap-1"
                :title="actor.name"
                data-testid="process-row-actor"
                :data-actor-principal-id="actor.principalId"
                :data-actor-kind="actor.kind"
            >
                <span
                    class="flex size-3.5 shrink-0 items-center justify-center rounded-full border bg-muted text-xs leading-none font-medium text-foreground"
                    aria-hidden="true"
                    data-testid="process-row-actor-initials"
                    >{{ actor.initials }}</span
                >
                <span class="max-w-24 truncate text-xs text-muted-foreground">{{
                    actor.name
                }}</span>
            </span>
            <span
                v-if="meta"
                class="shrink-0 tabular-nums text-xs text-muted-foreground"
                data-testid="process-row-meta"
                >{{ meta }}</span
            >
            <span v-if="status" class="shrink-0 text-xs" :class="tone">{{ status }}</span>
            <ChevronDown
                v-if="canExpand"
                class="size-3.5 shrink-0 text-muted-foreground transition-transform"
                :class="expanded ? 'rotate-180' : ''"
                aria-hidden="true"
                data-testid="process-row-chevron"
            />
        </button>
        <!-- 常驻行（如 tool-call-waiting-on）：折叠态也可见，不参与展开体。 -->
        <slot name="extra" />
        <div v-if="canExpand && expanded" class="border-t border-border/60 px-2 py-1.5 text-xs">
            <slot />
        </div>
    </div>
</template>
