<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { LoaderCircle, RefreshCw } from "@lucide/vue";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import type { AgentRoleBinding } from "../../composables/api";
import { presentCauseError, type ErrorPresentation } from "../../lib/errorMessages";
import {
    useAgentBindings,
    type AgentRolesReadState,
    type WorkspaceBindingView,
} from "./useAgentBindings";

/**
 * task-153 S1：一个 agent 主体的「工作区绑定」面（整页宿主内的面板）。
 *
 * <p>为什么是整页而不是抽屉里的一段（Lead 2026-11-21 04:02 裁定 C1=B）：绑定面 = 工作区多选
 * × 每项角色，再加委派会话表，是两处数据密集面；塞进抽屉会让详情页变成「表单 + 表格混合体」，
 * 而 §17.8 的「弹窗/抽屉 ≤6 语义组」正是防这个。</p>
 *
 * <p>三条判据来自既有面、并由 `useAgentBindings` 承担：能不能管看原子、读不到不等于没绑、
 * 写后重取读面。本组件只负责把它们呈现出来，不重写规则。</p>
 */

const props = defineProps<{ principalId: string }>();
const { t } = useI18n();

/**
 * 把「已绑定的工作区」上报给宿主页：委派子会话表（S3-a）只查已绑工作区——
 * 未绑工作区里这个主体不会被委派，列在那里只会产出一堆 0。
 */
const emit = defineEmits<{
    "bound-workspaces": [rows: Array<{ workspaceId: string; workspaceName: string }>];
}>();

const bindings = useAgentBindings({ principalId: () => props.principalId });

/** 用户勾选态（`true`/`false` 与「未改动」区分开：没有条目 = 沿用读面值）。 */
const picked = ref<Record<string, boolean>>({});
const saving = ref(false);
const saved = ref(false);
const problem = ref<ErrorPresentation | null>(null);
/** 行内「设为默认 / 取消默认」的失败原文；与批量保存的 `problem` 分开，一次只影响那一行。 */
const rowProblem = ref<{ workspaceId: string; presentation: ErrorPresentation } | null>(null);

watch(
    () =>
        bindings.bindingViews.value
            .filter((row) => row.bound === true)
            .map((row) => `${row.workspaceId}|${row.workspaceName}`)
            .join(","),
    () => {
        emit(
            "bound-workspaces",
            bindings.bindingViews.value
                .filter((row) => row.bound === true)
                .map((row) => ({
                    workspaceId: row.workspaceId,
                    workspaceName: row.workspaceName,
                })),
        );
    },
    { immediate: true },
);

function isPicked(row: WorkspaceBindingView): boolean {
    return picked.value[row.workspaceId] ?? row.bound === true;
}

function toggle(row: WorkspaceBindingView) {
    // 读面失败的行走不了：不知道当前状态就不该发出「绑定/解绑」这种确定动作。
    if (row.bound === null || saving.value) return;
    picked.value = { ...picked.value, [row.workspaceId]: !isPicked(row) };
    saved.value = false;
}

const pending = computed(() =>
    bindings.bindingViews.value.filter((row) => isPicked(row) !== (row.bound === true)),
);

const canSave = computed(() => pending.value.length > 0 && !saving.value);

function discarding() {
    picked.value = {};
    saved.value = false;
    problem.value = null;
}

async function refresh() {
    problem.value = null;
    rowProblem.value = null;
    saved.value = false;
    picked.value = {};
    await bindings.load();
}

/** 角色读面（S2）：三态 + 原文都由 `useAgentBindings` 提供，这里只做呈现。 */
function rolesState(row: WorkspaceBindingView): AgentRolesReadState {
    return bindings.rolesFor(row.workspaceId).state;
}

function rolesList(row: WorkspaceBindingView): AgentRoleBinding[] {
    return bindings.rolesFor(row.workspaceId).roles;
}

/** 角色读失败 → 原文（含 code）。空数组走「没有角色」，两者不可互替（卡面 S2 反）。 */
function rolesProblem(row: WorkspaceBindingView): ErrorPresentation {
    return presentCauseError(
        t,
        bindings.rolesFor(row.workspaceId).cause,
        t("agentBindings.rolesFallback"),
    );
}

/** 设为 / 取消工作区默认：只对已绑行可点，成功后读面由 composable 重取。 */
async function toggleDefault(row: WorkspaceBindingView) {
    if (row.bound !== true || saving.value) return;
    rowProblem.value = null;
    saved.value = false;
    const ok = await bindings.setDefault(row.workspaceId, !row.isDefault);
    if (!ok) {
        rowProblem.value = {
            workspaceId: row.workspaceId,
            presentation: presentCauseError(
                t,
                bindings.lastCause.value,
                t("agentBindings.defaultFailed"),
            ),
        };
    }
}

async function save() {
    if (!canSave.value) return;
    saving.value = true;
    saved.value = false;
    problem.value = null;
    let failed: WorkspaceBindingView | null = null;
    for (const row of pending.value) {
        const ok = await bindings.setBound(row.workspaceId, isPicked(row));
        if (!ok) {
            failed = row;
            break;
        }
    }
    if (failed) {
        // 原文交给 presentCauseError（不手拼 `code: detail`）；失败不吞掉已成功的部分 ——
        // 每次 setBound 都已经各自重取过读面，所以界面上的状态始终是 CP 回包。
        problem.value = presentCauseError(
            t,
            bindings.lastCause.value,
            t("agentBindings.saveFailed"),
        );
    } else {
        picked.value = {};
        saved.value = true;
    }
    saving.value = false;
}

watch(
    () => props.principalId,
    () => {
        picked.value = {};
        saved.value = false;
        problem.value = null;
        rowProblem.value = null;
        void bindings.load();
    },
    { immediate: true },
);
</script>

<template>
    <!-- F2（DEV-011 §17.3）：外壳用 div 而非 section —— 本面板同时有「勾选攒批一次保存」的
         工作区勾选框和「一改即存」的默认开关，勾选区与提交区必须分成两个 section，
         否则同一个 section 里既有 Checkbox 又有 *-save，读的人会误判保存语义。 -->
    <div class="flex min-h-0 flex-col gap-4" data-testid="agent-bindings-panel">
        <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
                <h2 class="text-base font-semibold">{{ t("agentBindings.title") }}</h2>
                <p class="mt-1 text-sm text-muted-foreground">{{ t("agentBindings.desc") }}</p>
            </div>
            <Button
                type="button"
                variant="outline"
                size="sm"
                :disabled="saving"
                data-testid="agent-bindings-refresh"
                @click="refresh"
            >
                <RefreshCw class="size-4" aria-hidden="true" />
                {{ t("agentBindings.refresh") }}
            </Button>
        </div>

        <!-- 勾选区：勾选多个工作区后统一点下方「保存绑定」（攒批语义）。 -->
        <section
            class="flex min-h-0 flex-col gap-4"
            aria-label="工作区绑定"
            data-testid="agent-bindings-workspaces"
        >
            <p
                v-if="
                    bindings.capabilityState.value === 'loading' ||
                    bindings.readState.value === 'loading'
                "
                class="flex items-center gap-2 text-sm text-muted-foreground"
                data-testid="agent-bindings-loading"
            >
                <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
                {{ t("agentBindings.loading") }}
            </p>

            <!-- fail-closed：能力投影读不到 ⇒ 只说"读不到"，不说"你没权限"（读失败证明不了权限）。 -->
            <p
                v-else-if="bindings.capabilityState.value === 'failed'"
                class="rounded-md border border-dashed p-4 text-sm text-muted-foreground"
                data-testid="agent-bindings-read-failed"
            >
                {{ t("agentBindings.readFailed") }}
            </p>

            <p
                v-else-if="bindings.canManage.value === false"
                class="rounded-md border border-dashed p-4 text-sm text-muted-foreground"
                data-testid="agent-bindings-no-permission"
            >
                {{ t("agentBindings.noPermission") }}
            </p>

            <p
                v-else-if="bindings.bindingViews.value.length === 0"
                class="rounded-md border border-dashed p-4 text-sm text-muted-foreground"
                data-testid="agent-bindings-empty"
            >
                {{ t("agentBindings.empty") }}
            </p>

            <ul
                v-else
                class="divide-y divide-border rounded-md border"
                data-testid="agent-bindings-list"
            >
                <li
                    v-for="row in bindings.bindingViews.value"
                    :key="row.workspaceId"
                    class="flex items-start gap-3 px-4 py-3"
                    :data-testid="`agent-bindings-row-${row.workspaceId}`"
                >
                    <Checkbox
                        :id="`agent-bindings-check-${row.workspaceId}`"
                        :data-testid="`agent-bindings-check-${row.workspaceId}`"
                        class="mt-0.5"
                        :model-value="isPicked(row)"
                        :disabled="row.bound === null || saving"
                        @update:model-value="toggle(row)"
                    />
                    <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-2">
                            <label
                                :for="`agent-bindings-check-${row.workspaceId}`"
                                class="truncate text-sm font-medium"
                                >{{ row.workspaceName }}</label
                            >
                            <span
                                v-if="row.isDefault"
                                class="rounded border px-1.5 py-0.5 text-xs text-muted-foreground"
                                :data-testid="`agent-bindings-default-${row.workspaceId}`"
                                >{{ t("agentBindings.badgeDefault") }}</span
                            >
                        </div>
                        <!-- 三态必须分开写：读面失败是"不知道"，不是"未绑定"。 -->
                        <p
                            class="mt-1 text-xs text-muted-foreground"
                            :data-testid="`agent-bindings-state-${row.workspaceId}`"
                        >
                            <template v-if="row.bound === null">{{
                                t("agentBindings.stateUnreadable")
                            }}</template>
                            <template v-else-if="row.bound">{{
                                t("agentBindings.stateBound")
                            }}</template>
                            <template v-else>{{ t("agentBindings.stateUnbound") }}</template>
                        </p>
                        <!-- S2：已绑行显示角色；读失败显示 code 原文，绝不写成「没有角色」。 -->
                        <div v-if="row.bound === true" class="mt-1 space-y-1">
                            <p
                                v-if="rolesState(row) === 'loading'"
                                class="text-xs text-muted-foreground"
                                :data-testid="`agent-bindings-roles-loading-${row.workspaceId}`"
                            >
                                {{ t("agentBindings.rolesLoading") }}
                            </p>
                            <div
                                v-else-if="rolesState(row) === 'not-found'"
                                class="text-xs text-muted-foreground"
                                :data-testid="`agent-bindings-roles-not-found-${row.workspaceId}`"
                            >
                                <p>{{ t("agentBindings.rolesNotFound") }}</p>
                                <p class="mt-0.5">
                                    {{ t("errors.errorCodeLabel") }}
                                    <code
                                        class="select-all rounded border bg-muted/40 px-1 py-0.5 font-mono text-[11px]"
                                        :data-testid="`agent-bindings-roles-code-${row.workspaceId}`"
                                        >{{ rolesProblem(row).code }}</code
                                    >
                                </p>
                            </div>
                            <div
                                v-else-if="rolesState(row) === 'failed'"
                                class="text-xs text-muted-foreground"
                                :data-testid="`agent-bindings-roles-failed-${row.workspaceId}`"
                            >
                                <p>{{ rolesProblem(row).copy }}</p>
                                <p v-if="rolesProblem(row).code" class="mt-0.5">
                                    {{ t("errors.errorCodeLabel") }}
                                    <code
                                        class="select-all rounded border bg-muted/40 px-1 py-0.5 font-mono text-[11px]"
                                        :data-testid="`agent-bindings-roles-code-${row.workspaceId}`"
                                        >{{ rolesProblem(row).code }}</code
                                    >
                                </p>
                            </div>
                            <p
                                v-else-if="rolesList(row).length === 0"
                                class="text-xs text-muted-foreground"
                                :data-testid="`agent-bindings-roles-empty-${row.workspaceId}`"
                            >
                                {{ t("agentBindings.rolesNone") }}
                            </p>
                            <ul
                                v-else
                                class="flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground"
                                :data-testid="`agent-bindings-roles-${row.workspaceId}`"
                            >
                                <li
                                    v-for="role in rolesList(row)"
                                    :key="role.bindingId"
                                    :data-testid="`agent-bindings-role-${row.workspaceId}-${role.bindingId}`"
                                >
                                    {{ role.displayName || role.name }}
                                </li>
                            </ul>
                            <div class="flex flex-wrap items-center gap-2">
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    class="h-7 px-2 text-xs"
                                    :data-testid="`agent-bindings-default-toggle-${row.workspaceId}`"
                                    :disabled="saving || bindings.isBusy(row.workspaceId)"
                                    @click="toggleDefault(row)"
                                >
                                    {{
                                        row.isDefault
                                            ? t("agentBindings.defaultClear")
                                            : t("agentBindings.defaultSet")
                                    }}
                                </Button>
                                <p
                                    v-if="rowProblem?.workspaceId === row.workspaceId"
                                    class="text-xs text-destructive"
                                    :data-testid="`agent-bindings-default-error-${row.workspaceId}`"
                                >
                                    {{ rowProblem.presentation.copy }}
                                    <code
                                        v-if="rowProblem.presentation.code"
                                        class="select-all rounded border bg-muted/40 px-1 py-0.5 font-mono text-[11px]"
                                        >{{ rowProblem.presentation.code }}</code
                                    >
                                </p>
                            </div>
                        </div>
                    </div>
                </li>
            </ul>
        </section>

        <!-- 提交区：整页唯一的批量提交点，独立成 section（不跟勾选框同区）。 -->
        <section class="flex flex-wrap items-center gap-3" data-testid="agent-bindings-actions">
            <Button
                type="button"
                size="sm"
                :disabled="!canSave"
                data-testid="agent-bindings-save"
                @click="save"
            >
                <LoaderCircle v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
                {{ saving ? t("agentBindings.saving") : t("agentBindings.save") }}
            </Button>
            <Button
                type="button"
                variant="ghost"
                size="sm"
                :disabled="saving || pending.length === 0"
                data-testid="agent-bindings-discard"
                @click="discarding"
            >
                {{ t("agentBindings.discard") }}
            </Button>
            <span
                v-if="pending.length > 0"
                class="text-xs text-muted-foreground"
                data-testid="agent-bindings-pending"
                >{{ t("agentBindings.pendingCount", { count: pending.length }) }}</span
            >
            <span
                v-else-if="saved"
                class="text-xs text-muted-foreground"
                data-testid="agent-bindings-saved"
                >{{ t("agentBindings.saved") }}</span
            >
        </section>

        <div
            v-if="problem"
            class="rounded-md border border-destructive/40 bg-destructive/5 p-3"
            data-testid="agent-bindings-error"
        >
            <p class="text-sm text-destructive" data-testid="agent-bindings-error-copy">
                {{ problem.copy }}
            </p>
            <p
                v-if="problem.code"
                class="mt-1 text-xs text-muted-foreground"
                data-testid="agent-bindings-error-code"
            >
                {{ t("errors.errorCodeLabel") }}
                <code
                    class="select-all rounded border bg-muted/40 px-1 py-0.5 font-mono text-[11px]"
                    >{{ problem.code }}</code
                >
            </p>
            <Collapsible v-if="problem.technicalDetail">
                <CollapsibleTrigger as-child>
                    <button
                        type="button"
                        class="mt-1 text-xs text-muted-foreground underline underline-offset-2"
                        data-testid="agent-bindings-error-detail-toggle"
                    >
                        {{ t("errors.technicalDetail") }}
                    </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                    <pre
                        class="mt-1 max-h-40 overflow-auto rounded border bg-muted/40 p-2 font-mono text-[11px] break-all whitespace-pre-wrap text-muted-foreground"
                        data-testid="agent-bindings-error-detail-body"
                        >{{ problem.technicalDetail }}</pre>
                </CollapsibleContent>
            </Collapsible>
        </div>
    </div>
</template>
