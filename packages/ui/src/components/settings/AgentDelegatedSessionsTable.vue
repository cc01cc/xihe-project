<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { LoaderCircle } from "@lucide/vue";
import { api, ApiError, type DelegateSpawnSessions } from "../../composables/api";
import { presentCauseError } from "../../lib/errorMessages";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

/**
 * task-153 S3-a：一个 agent 主体在**某个工作区**里「委派的子会话」读面。
 *
 * <p>数据源只有 `GET /workspaces/{ws}/agents/{pid}/spawn-sessions`（CP 侧按
 * (workspace, PRIMARY agent principal) 服务端计算，D-1785）。**不用 `GET /sessions` 客户端过滤**：
 * 那是调用者可见集，多人工作区里别人会话中这个主体派出的子会话根本不出现，会静默少报。</p>
 *
 * <p>三条硬判据（api.ts 的类型注释 + 卡面 S3-a）：</p>
 * <ul>
 *   <li>**数字一律取 `counts`**，不许用 `sessions.length`（会被 limit 截断）。</li>
 *   <li>403 ⇒ 明说「看不到明细」，**不回落成 0**；解析失败 ⇒ 说「取不到」，也不补 0。</li>
 *   <li>`includeArchived` 与 `limit`（`truncated`）必须在界面上显式标注，不让读者以为看到的是全量。</li>
 * </ul>
 *
 * <p>列表项只放派生计数与必要标识（标题 / 层级 / 是否归档），**不放每个子会话的运行态**——
 * 那是 N+1 读面，且本读面本来就不保证覆盖可读集。</p>
 */
const props = defineProps<{
    principalId: string;
    /**
     * 候选工作区 = 主体已绑定的工作区（由绑定面板上报）。
     * 未绑定的工作区里这个主体不会被委派，列在那里只会产出一堆 0。
     */
    workspaces: Array<{ workspaceId: string; workspaceName: string }>;
}>();

const { t } = useI18n();

const selectedWorkspaceId = ref<string>("");
const includeArchived = ref(false);
const state = ref<"idle" | "loading" | "ready" | "forbidden" | "failed">("idle");
const data = ref<DelegateSpawnSessions | null>(null);
const failure = ref<string>("");
/** 在途请求代号：切工作区/切主体后旧响应必须作废，不覆盖新状态。 */
let generation = 0;

/** 有不可读行 ⇒ 明写「只显示数量」，别让列表看起来"只有这些"。 */
const hasRedacted = computed<boolean>(() =>
    (data.value?.sessions ?? []).some((row) => !row.readable),
);
const hasCandidates = computed<boolean>(() => props.workspaces.length > 0);

async function load(): Promise<void> {
    const workspaceId = selectedWorkspaceId.value;
    if (!workspaceId) return;
    const ticket = ++generation;
    state.value = "loading";
    failure.value = "";
    try {
        const result = await api.listWorkspaceAgentSpawnSessions(workspaceId, props.principalId, {
            includeArchived: includeArchived.value,
        });
        if (ticket !== generation) return;
        data.value = result;
        state.value = "ready";
    } catch (cause) {
        if (ticket !== generation) return;
        data.value = null;
        // 403 是权限面的结论（VIEWER 没有成员名册读面）：说「看不到明细」，绝不说「0 个」。
        if (cause instanceof ApiError && cause.problem.status === 403) {
            state.value = "forbidden";
            return;
        }
        state.value = "failed";
        failure.value = presentCauseError(t, cause, t("workspace.agentDelegatedUnavailable")).copy;
    }
}

watch(
    () => [props.principalId, props.workspaces.map((row) => row.workspaceId).join(",")] as const,
    () => {
        generation += 1;
        includeArchived.value = false;
        if (!props.workspaces.length) {
            selectedWorkspaceId.value = "";
            data.value = null;
            state.value = "idle";
            return;
        }
        if (!props.workspaces.some((row) => row.workspaceId === selectedWorkspaceId.value)) {
            selectedWorkspaceId.value = props.workspaces[0].workspaceId;
        }
        void load();
    },
    { immediate: true },
);

function onWorkspaceChange(value: unknown): void {
    selectedWorkspaceId.value = typeof value === "string" ? value : "";
    void load();
}

function toggleArchived(): void {
    includeArchived.value = !includeArchived.value;
    void load();
}
</script>

<template>
    <section class="flex min-h-0 flex-col gap-3" data-testid="agent-bindings-sessions">
        <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
                <h2 class="text-base font-semibold">{{ t("workspace.agentDelegatedTitle") }}</h2>
                <p class="mt-1 text-sm text-muted-foreground">
                    {{ t("agentBindings.sessionsDesc") }}
                </p>
            </div>
            <Select
                v-if="hasCandidates"
                :model-value="selectedWorkspaceId"
                :disabled="state === 'loading'"
                :data-testid="'agent-bindings-sessions-workspace'"
                @update:model-value="onWorkspaceChange"
            >
                <SelectTrigger
                    class="w-56"
                    :aria-label="t('agentBindings.sessionsWorkspace')"
                    data-testid="agent-bindings-sessions-workspace-trigger"
                >
                    <SelectValue :placeholder="t('agentBindings.sessionsWorkspace')" />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem
                        v-for="row in workspaces"
                        :key="row.workspaceId"
                        :value="row.workspaceId"
                    >
                        {{ row.workspaceName }}
                    </SelectItem>
                </SelectContent>
            </Select>
        </div>

        <!-- 未绑定任何工作区：不编 0，直接说清"没有可查的工作区"。 -->
        <p
            v-if="!hasCandidates"
            class="rounded-md border border-dashed p-4 text-sm text-muted-foreground"
            data-testid="agent-bindings-sessions-need-binding"
        >
            {{ t("agentBindings.sessionsNeedBinding") }}
        </p>

        <template v-else>
            <p
                v-if="state === 'loading'"
                class="flex items-center gap-2 text-sm text-muted-foreground"
                data-testid="agent-bindings-sessions-loading"
            >
                <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
                {{ t("workspace.agentDelegatedLoading") }}
            </p>

            <p
                v-else-if="state === 'forbidden'"
                class="rounded-md border border-dashed p-4 text-sm text-muted-foreground"
                data-testid="agent-bindings-sessions-forbidden"
            >
                {{ t("workspace.agentDelegatedForbidden") }}
            </p>

            <p
                v-else-if="state === 'failed'"
                class="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
                data-testid="agent-bindings-sessions-failed"
            >
                {{ failure || t("workspace.agentDelegatedUnavailable") }}
            </p>

            <template v-else-if="state === 'ready' && data">
                <div
                    class="flex flex-wrap items-center gap-2 text-xs"
                    data-testid="agent-bindings-sessions-summary"
                >
                    <span class="font-medium" data-testid="agent-bindings-sessions-count-all">
                        {{ t("workspace.agentDelegatedCount", { count: data.counts.all }) }}
                    </span>
                    <span
                        v-if="data.counts.direct > 0"
                        class="text-muted-foreground"
                        data-testid="agent-bindings-sessions-count-direct"
                    >
                        {{
                            t("workspace.agentDelegatedDirectCount", {
                                count: data.counts.direct,
                            })
                        }}
                    </span>
                    <span
                        v-if="data.truncated"
                        class="text-muted-foreground"
                        data-testid="agent-bindings-sessions-limit-note"
                    >
                        {{ t("workspace.agentDelegatedTruncated", { limit: data.limit }) }}
                    </span>
                    <button
                        type="button"
                        class="rounded-full border px-1.5 py-0.5 text-xs"
                        data-testid="agent-bindings-sessions-archived-toggle"
                        @click="toggleArchived"
                    >
                        {{
                            includeArchived
                                ? t("workspace.agentDelegatedExcludeArchived")
                                : t("workspace.agentDelegatedIncludeArchived")
                        }}
                    </button>
                </div>
                <p
                    v-if="!includeArchived"
                    class="text-xs text-muted-foreground"
                    data-testid="agent-bindings-sessions-archived-note"
                >
                    {{ t("workspace.agentDelegatedArchivedNote") }}
                </p>
                <p
                    v-if="hasRedacted"
                    class="text-xs text-muted-foreground"
                    data-testid="agent-bindings-sessions-redacted"
                >
                    {{ t("workspace.agentDelegatedRedactedHint") }}
                </p>

                <!-- 空态判据用 counts.all，不用 sessions.length：counts 是全量，sessions 会被 limit 截断。 -->
                <p
                    v-if="data.counts.all === 0"
                    class="rounded-md border border-dashed p-4 text-sm text-muted-foreground"
                    data-testid="agent-bindings-sessions-empty"
                >
                    {{ t("workspace.agentDelegatedEmpty") }}
                </p>
                <ul v-else class="space-y-1.5" data-testid="agent-bindings-sessions-list">
                    <li
                        v-for="row in data.sessions"
                        :key="row.id"
                        class="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs"
                        :data-testid="`agent-bindings-sessions-row-${row.id}`"
                    >
                        <span class="font-medium">
                            {{
                                row.readable
                                    ? row.title || t("workspace.agentDelegatedUntitled")
                                    : t("workspace.agentDelegatedTitleHidden")
                            }}
                        </span>
                        <span class="rounded-full border px-1.5 py-0.5">
                            {{ t("workspace.agentDelegatedDepth", { depth: row.depth }) }}
                        </span>
                        <span
                            v-if="row.archived"
                            class="rounded-full border px-1.5 py-0.5 text-muted-foreground"
                            :data-testid="`agent-bindings-sessions-row-archived-${row.id}`"
                        >
                            {{ t("workspace.agentDelegatedArchived") }}
                        </span>
                    </li>
                </ul>
            </template>
        </template>
    </section>
</template>
