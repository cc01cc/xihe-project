<script setup lang="ts">
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ClipboardList } from "@lucide/vue";
import { logger } from "@/lib/logger";
import { Alert, AlertDescription, AlertTitle } from "../../../../components/ui/alert";
import { Button } from "../../../../components/ui/button";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from "../../../../components/ui/empty";
import { ScrollArea } from "../../../../components/ui/scroll-area";
import { Skeleton } from "../../../../components/ui/skeleton";
import { countBoardTasks, type TeamBoardDisplayStatus, type TeamBoardTaskView } from "../teamTasks";
import type { TeamTasksDropped } from "../../../../stores/teamTasks";
import TeamBoardRow from "./TeamBoardRow.vue";

/**
 * task-188 S2（MVP⑤）：TeamBoard 只读板（D-1821：零写控件，写走既有命令/审批原语）。
 *
 * <p>展示三态互斥（反假绿 N1/N10 钉死）：loading（Skeleton，⑨ 类 H-06 教训 —— 禁 11px
 * 灰字加载）/ error（Alert + 重试，失败不许静默成空列表）/ ready（行或 Empty）。
 * 数据归一化在 teamTasks.ts（SSOT）+ stores/teamTasks.ts，本组件只吃视图行。</p>
 */
const props = withDefaults(
    defineProps<{
        /** teamTasks.ts normalize 后的视图行（已过滤 deleted/foreign）。 */
        tasks: TeamBoardTaskView[];
        taskNoById: Record<string, number>;
        dropped: TeamTasksDropped;
        loading: boolean;
        /** 已解析的用户文案（null = 无错误）。 */
        error: string | null;
        /** 板内依赖跳转目标行：该行走「强制展开 + 滚入视野」。 */
        highlightedTaskId?: string | null;
    }>(),
    {
        tasks: () => [],
        taskNoById: () => ({}),
        dropped: () => ({ malformed: 0, foreign: 0, deleted: 0 }),
        loading: false,
        error: null,
        highlightedTaskId: null,
    },
);

const emit = defineEmits<{
    retry: [];
    /** 依赖任务跳转（父组件接 router；纯读导航）。 */
    navigate: [taskId: string];
}>();

const { t } = useI18n();
const K = "teamBoard.";

const counts = computed(() => countBoardTasks(props.tasks));

const LEGEND: TeamBoardDisplayStatus[] = ["pending", "blocked", "in_progress", "completed"];

const LEGEND_LABEL_KEY: Record<TeamBoardDisplayStatus, string> = {
    pending: K + "legendPending",
    blocked: K + "legendBlocked",
    in_progress: K + "legendInProgress",
    completed: K + "legendCompleted",
};

const LEGEND_DOT_CLASS: Record<TeamBoardDisplayStatus, string> = {
    pending: "bg-muted-foreground/50",
    blocked: "bg-amber-500",
    in_progress: "bg-blue-500",
    completed: "bg-green-600",
};

// 挡了要说（WorkspaceSkillsPanel 纪律）：过滤计数变化时 debug 一条，与 store 的日志互为印证。
watch(
    () => props.dropped,
    (next) => {
        if (next.malformed + next.foreign + next.deleted > 0) {
            logger.debug("team_board_dropped_rows", next);
        }
    },
    { deep: true },
);
</script>

<template>
    <section
        class="mx-auto mb-3 w-full max-w-(--chat-column-max) rounded-xl border bg-card px-3 py-2.5"
        :aria-label="t(K + 'title')"
        data-testid="team-board"
    >
        <header class="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div class="flex min-w-0 items-baseline gap-2">
                <h2 class="shrink-0 text-xs font-semibold">{{ t(K + "title") }}</h2>
                <span
                    v-if="!loading && !error"
                    class="truncate text-xs text-muted-foreground"
                    data-testid="team-board-counts"
                >
                    {{
                        t(K + "counts", {
                            completed: counts.completed,
                            inProgress: counts.inProgress,
                            pending: counts.pending,
                        })
                    }}
                </span>
            </div>
            <span
                v-if="!loading && !error"
                class="inline-flex items-center gap-2 text-[11px] text-muted-foreground"
                data-testid="team-board-legend"
            >
                <span v-for="status in LEGEND" :key="status" class="inline-flex items-center gap-1">
                    <span class="size-1.5 rounded-full" :class="LEGEND_DOT_CLASS[status]" />
                    {{ t(LEGEND_LABEL_KEY[status]) }}
                </span>
            </span>
        </header>

        <div v-if="loading" class="space-y-2" data-testid="team-board-loading">
            <Skeleton class="h-6 w-full" />
            <Skeleton class="h-6 w-5/6" />
            <Skeleton class="h-6 w-4/6" />
        </div>

        <Alert v-else-if="error" variant="destructive" data-testid="team-board-error">
            <AlertTitle>{{ t(K + "errorTitle") }}</AlertTitle>
            <AlertDescription class="flex flex-wrap items-center justify-between gap-2">
                <span>{{ error }}</span>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="team-board-retry"
                    @click="emit('retry')"
                >
                    {{ t(K + "retry") }}
                </Button>
            </AlertDescription>
        </Alert>

        <Empty v-else-if="tasks.length === 0" data-testid="team-board-empty" class="py-4">
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <ClipboardList class="size-4" aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>{{ t(K + "emptyTitle") }}</EmptyTitle>
                <EmptyDescription>{{ t(K + "emptyDesc") }}</EmptyDescription>
            </EmptyHeader>
        </Empty>

        <ScrollArea v-else class="max-h-72">
            <ul>
                <TeamBoardRow
                    v-for="task in tasks"
                    :key="task.taskId"
                    :task="task"
                    :task-no-by-id="taskNoById"
                    :force-open="task.taskId === highlightedTaskId"
                    @navigate="emit('navigate', $event)"
                />
            </ul>
        </ScrollArea>

        <footer
            v-if="!loading && !error"
            class="mt-1 text-[11px] text-muted-foreground"
            data-testid="team-board-readonly-note"
        >
            {{ t(K + "readonlyNote") }}
        </footer>
    </section>
</template>
