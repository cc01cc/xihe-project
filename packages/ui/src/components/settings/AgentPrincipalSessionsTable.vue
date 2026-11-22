<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { LoaderCircle } from "@lucide/vue";
import {
    api,
    ApiError,
    type AgentPrincipalSessionRole,
    type AgentPrincipalSessionRow,
    type AgentPrincipalSessionsResponse,
} from "../../composables/api";
import { DATE_FALLBACK, formatDateTime } from "../../lib/dateFormat";
import { presentCauseError } from "../../lib/errorMessages";
import { Badge } from "../ui/badge";

/**
 * task-721：一个 Agent 主体**参与过的会话**读面
 * （`GET /agent-principals/{principalId}/sessions?workspaceId=…`）。
 *
 * <p>三条硬判据：</p>
 * <ul>
 *   <li>数字一律取 `counts`（全量 cohort），不用 `sessions.length`（会被 `limit` 截断）。</li>
 *   <li>`readable=false` 的行仍计数；标题位置显示「该会话对你不可见」，不用空串冒充。</li>
 *   <li>403 是权限结论（VIEWER），明说看不到，不回落成 0；解析/网络失败说取不到。</li>
 * </ul>
 */
const props = defineProps<{
    principalId: string;
    /** 授权上下文 = cohort 过滤条件；空串表示还没选中可查工作区。 */
    workspaceId: string;
}>();

const { t } = useI18n();

const includeArchived = ref(false);
const state = ref<"idle" | "loading" | "ready" | "forbidden" | "failed">("idle");
const data = ref<AgentPrincipalSessionsResponse | null>(null);
const failure = ref("");
/** 在途请求代号：切主体/工作区后旧响应必须作废，不覆盖新状态。 */
let generation = 0;

const hasRedacted = computed<boolean>(() =>
    (data.value?.sessions ?? []).some((row) => !row.readable),
);

async function load(): Promise<void> {
    const workspaceId = props.workspaceId;
    if (!workspaceId) {
        data.value = null;
        state.value = "idle";
        failure.value = "";
        return;
    }
    const ticket = ++generation;
    state.value = "loading";
    failure.value = "";
    try {
        const result = await api.listAgentPrincipalSessions(props.principalId, workspaceId, {
            includeArchived: includeArchived.value,
        });
        if (ticket !== generation) return;
        data.value = result;
        state.value = "ready";
    } catch (cause) {
        if (ticket !== generation) return;
        data.value = null;
        if (cause instanceof ApiError && cause.problem.status === 403) {
            state.value = "forbidden";
            return;
        }
        state.value = "failed";
        failure.value = presentCauseError(
            t,
            cause,
            t("agentBindings.principalSessionsUnavailable"),
        ).copy;
    }
}

watch(
    () => [props.principalId, props.workspaceId] as const,
    () => {
        generation += 1;
        includeArchived.value = false;
        void load();
    },
    { immediate: true },
);

function toggleArchived(): void {
    includeArchived.value = !includeArchived.value;
    void load();
}

function roleLabel(role: AgentPrincipalSessionRole): string {
    if (role === "PRIMARY") return t("agentBindings.principalSessionsRolePrimary");
    if (role === "MEMBER") return t("agentBindings.principalSessionsRoleMember");
    return t("agentBindings.principalSessionsRoleGuard");
}

function titleLabel(row: AgentPrincipalSessionRow): string {
    if (!row.readable) return t("agentBindings.principalSessionsTitleHidden");
    return row.title?.trim() ? row.title : t("agentBindings.principalSessionsUntitled");
}
</script>

<template>
    <section class="flex min-h-0 flex-col gap-3" data-testid="agent-principal-sessions">
        <p
            v-if="!workspaceId"
            class="rounded-md border border-dashed p-4 text-sm text-muted-foreground"
            data-testid="agent-principal-sessions-need-workspace"
        >
            {{ t("agentBindings.principalSessionsNeedWorkspace") }}
        </p>

        <template v-else>
            <p
                v-if="state === 'loading'"
                class="flex items-center gap-2 text-sm text-muted-foreground"
                data-testid="agent-principal-sessions-loading"
            >
                <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
                {{ t("agentBindings.principalSessionsLoading") }}
            </p>

            <p
                v-else-if="state === 'forbidden'"
                class="rounded-md border border-dashed p-4 text-sm text-muted-foreground"
                data-testid="agent-principal-sessions-forbidden"
            >
                {{ t("agentBindings.principalSessionsForbidden") }}
            </p>

            <p
                v-else-if="state === 'failed'"
                class="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
                data-testid="agent-principal-sessions-failed"
            >
                {{ failure || t("agentBindings.principalSessionsUnavailable") }}
            </p>

            <template v-else-if="state === 'ready' && data">
                <div
                    class="flex flex-wrap items-center gap-2 text-xs"
                    data-testid="agent-principal-sessions-summary"
                >
                    <span class="font-medium" data-testid="agent-principal-sessions-count-all">
                        {{
                            t("agentBindings.principalSessionsCountAll", { count: data.counts.all })
                        }}
                    </span>
                    <span
                        class="text-muted-foreground"
                        data-testid="agent-principal-sessions-count-primary"
                    >
                        {{
                            t("agentBindings.principalSessionsCountPrimary", {
                                count: data.counts.primary,
                            })
                        }}
                    </span>
                    <span
                        class="text-muted-foreground"
                        data-testid="agent-principal-sessions-count-member"
                    >
                        {{
                            t("agentBindings.principalSessionsCountMember", {
                                count: data.counts.member,
                            })
                        }}
                    </span>
                    <span
                        class="text-muted-foreground"
                        data-testid="agent-principal-sessions-count-guard"
                    >
                        {{
                            t("agentBindings.principalSessionsCountGuard", {
                                count: data.counts.guard,
                            })
                        }}
                    </span>
                    <span
                        v-if="data.truncated"
                        class="text-muted-foreground"
                        data-testid="agent-principal-sessions-limit-note"
                    >
                        {{ t("agentBindings.principalSessionsTruncated", { limit: data.limit }) }}
                    </span>
                    <button
                        type="button"
                        class="rounded-full border px-1.5 py-0.5 text-xs"
                        data-testid="agent-principal-sessions-archived-toggle"
                        @click="toggleArchived"
                    >
                        {{
                            includeArchived
                                ? t("agentBindings.principalSessionsExcludeArchived")
                                : t("agentBindings.principalSessionsIncludeArchived")
                        }}
                    </button>
                </div>
                <p
                    v-if="hasRedacted"
                    class="text-xs text-muted-foreground"
                    data-testid="agent-principal-sessions-redacted"
                >
                    {{ t("agentBindings.principalSessionsRedactedHint") }}
                </p>

                <p
                    v-if="data.counts.all === 0"
                    class="rounded-md border border-dashed p-4 text-sm text-muted-foreground"
                    data-testid="agent-principal-sessions-empty"
                >
                    {{ t("agentBindings.principalSessionsEmpty") }}
                </p>
                <div
                    v-else
                    class="overflow-x-auto rounded-md border"
                    data-testid="agent-principal-sessions-table"
                >
                    <table class="w-full border-collapse text-sm">
                        <thead class="bg-muted/50 text-left text-xs text-muted-foreground">
                            <tr>
                                <th scope="col" class="px-3 py-2 font-medium">
                                    {{ t("agentBindings.principalSessionsColumnTitle") }}
                                </th>
                                <th scope="col" class="px-3 py-2 font-medium">
                                    {{ t("agentBindings.principalSessionsColumnRole") }}
                                </th>
                                <th scope="col" class="px-3 py-2 font-medium">
                                    {{ t("agentBindings.principalSessionsColumnArchived") }}
                                </th>
                                <th scope="col" class="px-3 py-2 font-medium">
                                    {{ t("agentBindings.principalSessionsColumnUpdatedAt") }}
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="row in data.sessions"
                                :key="row.id"
                                class="border-t"
                                :data-testid="`agent-principal-sessions-row-${row.id}`"
                            >
                                <td
                                    class="px-3 py-2 font-medium break-all"
                                    :data-testid="`agent-principal-sessions-title-${row.id}`"
                                >
                                    {{ titleLabel(row) }}
                                </td>
                                <td
                                    class="px-3 py-2"
                                    :data-testid="`agent-principal-sessions-role-${row.id}`"
                                >
                                    {{ roleLabel(row.role) }}
                                </td>
                                <td
                                    class="px-3 py-2"
                                    :data-testid="`agent-principal-sessions-archived-${row.id}`"
                                >
                                    <Badge v-if="row.archived" variant="outline">
                                        {{ t("agentBindings.principalSessionsArchived") }}
                                    </Badge>
                                    <span v-else class="text-muted-foreground">{{
                                        DATE_FALLBACK
                                    }}</span>
                                </td>
                                <td
                                    class="px-3 py-2 text-muted-foreground"
                                    :data-testid="`agent-principal-sessions-updated-${row.id}`"
                                >
                                    {{ formatDateTime(row.updatedAt) }}
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </template>
        </template>
    </section>
</template>
