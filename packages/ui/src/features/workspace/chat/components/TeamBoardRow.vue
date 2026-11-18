<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Badge } from "../../../../components/ui/badge";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "../../../../components/ui/collapsible";
import { formatDate } from "../../../../lib/dateFormat";
import type { TeamBoardDisplayStatus, TeamBoardTaskView } from "../teamTasks";

/**
 * task-188 S2（MVP⑤）：任务板单行。**只读** —— 行内唯一可点的是「展开详情」与
 * 「依赖跳转」（读导航），零写控件（D-1821 面板只读裁定；反假绿 N8 钉死）。
 *
 * <p>展示口径（状态点映射 / label / 截断）全部来自 teamTasks.ts SSOT，本文件不复制判定。</p>
 */
const props = defineProps<{
    task: TeamBoardTaskView;
    /** taskId → taskNo（含已删任务 —— blockedBy 可能指向墓碑）。 */
    taskNoById: Record<string, number>;
    /** 板内跳转目标（blockedBy 点击）：强制展开并滚入视野。 */
    forceOpen?: boolean;
}>();

const emit = defineEmits<{
    /** 依赖任务跳转（父组件接 router；纯读导航）。 */
    navigate: [taskId: string];
}>();

const { t } = useI18n();
const K = "teamBoard.";

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);

// 板内依赖跳转（M2）：目标是行不是路由 ⇒ 展开 + 滚入视野。scrollIntoView 在 jsdom 不存在，
// 守卫跳过（spec 只断言展开）。
watch(
    () => props.forceOpen,
    (forced) => {
        if (!forced) return;
        open.value = true;
        void nextTick(() => rootEl.value?.scrollIntoView?.({ block: "nearest" }));
    },
);

const DOT_CLASS: Record<TeamBoardDisplayStatus, string> = {
    pending: "bg-muted-foreground/50",
    blocked: "bg-amber-500",
    in_progress: "bg-blue-500",
    completed: "bg-green-600",
};

const STATUS_LABEL_KEY: Record<TeamBoardDisplayStatus, string> = {
    pending: K + "legendPending",
    blocked: K + "legendBlocked",
    in_progress: K + "legendInProgress",
    completed: K + "legendCompleted",
};

const dotClass = computed(() => DOT_CLASS[props.task.displayStatus]);
const statusLabel = computed(() => t(STATUS_LABEL_KEY[props.task.displayStatus]));

/** blockedBy 的展示 label：已知 → task-<n>；指向已被挡/异常的任务 → 短 id 兜底（不静默丢）。 */
function blockedByLabel(taskId: string): string {
    const taskNo = props.taskNoById[taskId];
    return taskNo === undefined ? taskId.slice(0, 8) : "task-" + taskNo;
}

function isKnownTask(taskId: string): boolean {
    return props.taskNoById[taskId] !== undefined;
}
</script>

<template>
    <li
        ref="rootEl"
        class="border-t first:border-t-0"
        data-testid="team-board-row"
        :data-task-no="task.label"
        :data-status="task.displayStatus"
    >
        <Collapsible v-model:open="open">
            <div class="flex items-center gap-2 px-3 py-2">
                <span
                    class="size-2 shrink-0 rounded-full"
                    :class="dotClass"
                    :title="statusLabel"
                    data-testid="team-board-status"
                    :data-status="task.displayStatus"
                />
                <span
                    class="shrink-0 font-mono text-xs text-muted-foreground"
                    data-testid="team-board-task-no"
                >
                    {{ task.label }}
                </span>
                <CollapsibleTrigger as-child>
                    <button
                        type="button"
                        class="min-w-0 flex-1 truncate rounded text-left text-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        :aria-expanded="open"
                        :aria-label="t(K + 'expandAria', { label: task.label })"
                        data-testid="team-board-expand"
                    >
                        <span
                            class="truncate"
                            :title="task.subject"
                            data-testid="team-board-subject"
                        >
                            {{ task.subject }}
                        </span>
                    </button>
                </CollapsibleTrigger>
                <Badge
                    v-if="task.displayStatus === 'blocked'"
                    variant="outline"
                    class="shrink-0 border-amber-500/40 text-amber-700 dark:text-amber-300"
                    data-testid="team-board-blocked"
                >
                    {{ t(K + "blockedBadge") }}
                </Badge>
                <Badge
                    v-if="task.ownerName !== null"
                    variant="secondary"
                    class="shrink-0"
                    data-testid="team-board-owner"
                >
                    {{ task.ownerName }}
                </Badge>
                <Badge v-else variant="outline" class="shrink-0" data-testid="team-board-unowned">
                    {{ t(K + "unowned") }}
                </Badge>
            </div>
            <CollapsibleContent data-testid="team-board-detail">
                <dl class="grid gap-1.5 px-3 pb-3 pl-7 text-xs text-muted-foreground">
                    <div data-testid="team-board-description">
                        <dt class="sr-only">{{ t(K + "descriptionLabel") }}</dt>
                        <dd class="whitespace-pre-wrap break-words text-foreground/90">
                            {{ task.description ?? t(K + "noDescription") }}
                        </dd>
                    </div>
                    <div v-if="task.blockedBy.length > 0">
                        <dt>{{ t(K + "blockedByLabel") }}</dt>
                        <dd class="mt-0.5 flex flex-wrap gap-1.5">
                            <button
                                v-for="depId in task.blockedBy"
                                :key="depId"
                                type="button"
                                class="rounded border px-1.5 py-0.5 font-mono hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                :data-testid="'team-board-blocked-by-item-' + depId"
                                @click="emit('navigate', depId)"
                            >
                                {{ blockedByLabel(depId) }}
                            </button>
                            <span
                                v-for="depId in task.blockedBy.filter((id) => !isKnownTask(id))"
                                :key="depId + '-unknown'"
                                class="hidden"
                                :data-testid="'team-board-blocked-by-unknown-' + depId"
                            />
                        </dd>
                    </div>
                    <div v-if="task.writeScopeWarnings.length > 0">
                        <dt>{{ t(K + "scopeWarningsLabel") }}</dt>
                        <dd class="mt-0.5 space-y-0.5">
                            <p
                                v-for="(warning, index) in task.writeScopeWarnings"
                                :key="index"
                                data-testid="team-board-scope-warning"
                            >
                                {{ warning }}
                            </p>
                        </dd>
                    </div>
                    <div class="flex flex-wrap gap-x-3" data-testid="team-board-timestamps">
                        <span>{{
                            t(K + "createdAtLabel", { time: formatDate(task.createdAt) })
                        }}</span>
                        <span>{{
                            t(K + "updatedAtLabel", { time: formatDate(task.updatedAt) })
                        }}</span>
                    </div>
                </dl>
            </CollapsibleContent>
        </Collapsible>
    </li>
</template>
