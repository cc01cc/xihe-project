<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { api, type ApiBindingRow, type ApiOrgUnitMember } from "../../../composables/api";
import { logger } from "../../../lib/logger";
import { useAuthStore } from "../../../stores/auth";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "../../../components/ui/select";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "../../../components/ui/sheet";

/**
 * PLAN-0773 M3-3 / task-43：组织成员**详情面**（只读）。
 *
 * <p>三段**数据来源必须分开**，因为它们是三条不同的轴 —— 合并成一个「角色」字段是下一个人
 * 必然踩的坑（Lead 2026-11-15 裁定 ③「两段都在」）：</p>
 * <ol>
 *   <li>工作区成员角色 = `MemberView.role`（`GET /workspaces/{id}/members`，可由
 *       `PATCH /workspaces/{id}/members/{userId}` 改）；</li>
 *   <li>访问角色绑定 = `role_bindings`（`GET /bindings?scopeType=instance`，`MANAGE_ROLES` 门，
 *       实例级）—— 与 ① 是不同的授予轴；</li>
 *   <li>权限原子 = **不在本页展示**：`openapi.yaml:6170-6171` 明文「a subject's atoms are
 *       visible only through `GET /api/v1/me/permissions` for that subject's own caller」
 *       ⇒ 他人原子**没有读面**。本页只陈述事实 + 「未展示 ≠ 无权限」，**禁止**从 ①② 推断原子。</li>
 * </ol>
 *
 * <p><b>为什么 B 形态要写死那两句话</b>（Lead 2026-11-15 裁定 ①）：B 的已知代价是回答不了
 * 「他能干什么」，但让用户把「没显示」读成「没权限」是更坏的代价。正解是新端点（task-52）。</p>
 *
 * <p><b>所属单元的代价写清</b>（卡面裁定 ④）：本卡只显示成员**直接挂载**的单元
 * （`OrgUnitMemberView.orgUnitId` 自带，0 次额外请求）。往上到根需要逐级查询（每级 1 次），
 * 故**不推算链路**，并在界面上写明。</p>
 */
const props = defineProps<{
    member: ApiOrgUnitMember | null;
    open: boolean;
    /** 成员直接挂载单元的名字：调用方从树节点注册表解析；解析不到由调用方回退传 id。 */
    unitName: string;
}>();
const emit = defineEmits<{ "update:open": [boolean] }>();

const { t } = useI18n();
const auth = useAuthStore();

/**
 * 段① 的代价上限，**写死并显示给用户**：逐个工作区拉成员表是 N 次请求、且每次都可能 403，
 * 不设上限就是一个打不完的面（卡面裁定 ④ 要求写清代价与上限）。
 */
const WORKSPACE_PROBE_CAP = 5;

type WorkspaceRoleRow = {
    workspaceId: string;
    workspaceName: string;
    role: string | null;
    denied: boolean;
};

const wsRows = ref<WorkspaceRoleRow[]>([]);
const wsChecked = ref(0);
const wsState = ref<"idle" | "loading" | "done" | "error">("idle");

async function loadWorkspaceRoles() {
    const member = props.member;
    if (!member || member.memberKind !== "human" || wsState.value === "loading") return;
    wsState.value = "loading";
    wsRows.value = [];
    wsChecked.value = 0;
    let workspaces;
    try {
        workspaces = await api.listWorkspaces();
    } catch (cause) {
        logger.warn("Failed to list workspaces for the member detail sheet: " + String(cause));
        wsState.value = "error";
        return;
    }
    for (const workspace of workspaces.slice(0, WORKSPACE_PROBE_CAP)) {
        wsChecked.value += 1;
        let row: WorkspaceRoleRow;
        try {
            const members = await api.listWorkspaceMembers(workspace.id);
            const hit = members.find((candidate) => candidate.userId === member.memberId);
            row = {
                workspaceId: workspace.id,
                workspaceName: workspace.name,
                role: hit?.role ?? null,
                denied: false,
            };
        } catch (cause) {
            // 逐个容错：某个工作区 403 不能把整段打成错误 —— 「无权查看」与「查不到」是两件事。
            logger.warn(
                "Failed to read members of workspace " + workspace.id + ": " + String(cause),
            );
            row = {
                workspaceId: workspace.id,
                workspaceName: workspace.name,
                role: null,
                denied: true,
            };
        }
        wsRows.value = [...wsRows.value, row];
    }
    wsState.value = "done";
}

/**
 * 段② 的判据是**能力原子**（`auth.canManageRoles` = `MANAGE_ROLES`），**不是**角色名或
 * `isInstanceAdmin` 能力位：CP 的门就是 `@PreAuthorize("@requesterAuthority.holdsActionAtom('MANAGE_ROLES')")`
 * （`RoleController.java:52-53`）。三态纪律（task-420 / D-1254）：投影**没读到 / 读失败**时
 * 不能渲染成「你没有这个原子」，否则加载中会闪一个确定性的拒绝。
 */
const accessRows = ref<ApiBindingRow[]>([]);
const accessState = ref<
    "idle" | "pending" | "unread" | "gated" | "loading" | "ready" | "error" | "agent"
>("idle");

async function loadAccessRoles() {
    const member = props.member;
    accessRows.value = [];
    if (!member) {
        accessState.value = "idle";
        return;
    }
    if (member.memberKind !== "human") {
        accessState.value = "agent";
        return;
    }
    accessState.value = "pending";
    const projectionReady = await auth.ensureSelfPermissions();
    if (!projectionReady) {
        accessState.value = "unread";
        return;
    }
    if (!auth.canManageRoles) {
        accessState.value = "gated";
        return;
    }
    accessState.value = "loading";
    try {
        const set = await api.getBindings("instance");
        accessRows.value = set.bindings.filter((row) => row.subjectId === member.memberId);
        accessState.value = "ready";
    } catch (cause) {
        logger.warn(
            "Failed to read instance bindings for the member detail sheet: " + String(cause),
        );
        accessState.value = "error";
    }
}

/**
 * task-44（`D-1440` / A 方案）：**智能体的三段都不在本页**。
 *
 * <p>权限（`effective-cap`）要工作区路径参数、技能绑定的 scope 由工作区决定、记忆开关对
 * 工作区级主体缺上下文直接 409 ⇒ 它们只能在工作区里读。所以本页对智能体**不渲染第二份
 * 实现**，只做两件事：说明为什么不在本页，然后把人送到 `/workspace/{id}?agent=<pid>`。</p>
 *
 * <p><b>为什么用就地选择而不是二级弹层</b>：弹层要再套一层 focus trap 并与 Sheet 抢 Esc；
 * 而"去哪"是一维选择、选项通常 1–3 个，原生 `select` 就够。另：切换工作区**不会丢已选主体**
 * —— 主体来自 `member` prop，选择只改"去哪"，落地后由面板负责展开。</p>
 */
const router = useRouter();
type WorkspaceChoice = { id: string; name: string };
const workspaceChoices = ref<WorkspaceChoice[]>([]);
const workspaceChoiceState = ref<"idle" | "loading" | "ready" | "error">("idle");
/** **不预选**：预选第一个工作区会让一次误点直接落进别人的工作区；按钮保持禁用直到用户选。 */
const selectedWorkspaceId = ref("");

async function loadWorkspaceChoices() {
    if (props.member?.memberKind !== "agent_principal") return;
    workspaceChoiceState.value = "loading";
    workspaceChoices.value = [];
    selectedWorkspaceId.value = "";
    try {
        const workspaces = await api.listWorkspaces();
        workspaceChoices.value = workspaces.map((entry) => ({ id: entry.id, name: entry.name }));
        workspaceChoiceState.value = "ready";
    } catch (cause) {
        logger.warn("Failed to list workspaces for the agent deep link: " + String(cause));
        workspaceChoiceState.value = "error";
    }
}

function openAgentInWorkspace() {
    const target = props.member;
    if (!target || target.memberKind !== "agent_principal" || !selectedWorkspaceId.value) return;
    void router.push({
        path: `/workspace/${selectedWorkspaceId.value}`,
        query: { agent: target.memberId },
    });
    emit("update:open", false);
}

watch(
    () => [props.open, props.member?.memberKind, props.member?.memberId] as const,
    ([open]) => {
        wsRows.value = [];
        wsChecked.value = 0;
        wsState.value = "idle";
        accessRows.value = [];
        accessState.value = "idle";
        workspaceChoices.value = [];
        workspaceChoiceState.value = "idle";
        selectedWorkspaceId.value = "";
        if (!open) return;
        void loadAccessRoles();
        void loadWorkspaceChoices();
    },
    { immediate: true },
);

const kindLabel = computed(() =>
    props.member?.memberKind === "human" ? t("orgMembers.kindHuman") : t("orgMembers.kindAgent"),
);

const wsCapParams = computed(() => ({ checked: wsChecked.value, cap: WORKSPACE_PROBE_CAP }));
</script>

<template>
    <Sheet :open="open" @update:open="(value: boolean) => emit('update:open', value)">
        <SheetContent side="right" class="w-full overflow-y-auto sm:max-w-lg">
            <SheetHeader>
                <SheetTitle data-testid="org-member-detail-title">
                    {{ t("orgMembers.detailTitle") }}
                </SheetTitle>
                <SheetDescription>{{ t("orgMembers.detailDesc") }}</SheetDescription>
            </SheetHeader>

            <div
                v-if="member"
                class="flex flex-col gap-5 px-4 pb-8"
                data-testid="org-member-detail"
            >
                <!-- 身份 + 所属单元：0 次额外请求（orgUnitId 由成员视图自带） -->
                <section data-testid="org-member-detail-identity">
                    <p class="text-base font-semibold" data-testid="org-member-detail-name">
                        {{ member.displayName ?? "—" }}
                    </p>
                    <p class="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{{ t("orgMembers.detailKindLabel") }}</span>
                        <Badge variant="secondary" data-testid="org-member-detail-kind">
                            {{ kindLabel }}
                        </Badge>
                    </p>
                    <p class="mt-1 text-xs text-muted-foreground">
                        {{ t("orgMembers.detailIdLabel") }}:
                        <span class="font-mono" data-testid="org-member-detail-id">{{
                            member.memberId
                        }}</span>
                    </p>
                </section>

                <section class="border-t pt-4" data-testid="org-member-detail-unit">
                    <h3 class="text-sm font-semibold">{{ t("orgMembers.detailUnitLabel") }}</h3>
                    <p class="mt-1 text-sm" data-testid="org-member-detail-unit-name">
                        {{ unitName }}
                    </p>
                    <p
                        class="mt-1 text-xs text-muted-foreground"
                        data-testid="org-member-detail-unit-cost"
                    >
                        {{ t("orgMembers.detailUnitCost") }}
                    </p>
                </section>

                <!--
                    智能体：三段都在工作区里 ⇒ 本页**不重复实现**，只做深链（task-44 / D-1440 A 方案）。
                    用 vendored `Select`（reka）而不是原生 select：栈内控件优先，且焦点/键盘语义
                    与全站一致，不必为"一维选择"再手搓一遍。
                -->
                <section
                    v-if="member.memberKind === 'agent_principal'"
                    class="border-t pt-4"
                    data-testid="org-member-detail-agent-open"
                >
                    <h3 class="text-sm font-semibold">{{ t("orgMembers.agentOpenTitle") }}</h3>
                    <p
                        class="mt-1 text-xs text-muted-foreground"
                        data-testid="org-member-detail-agent-open-desc"
                    >
                        {{ t("orgMembers.agentOpenDesc") }}
                    </p>
                    <p
                        v-if="workspaceChoiceState === 'loading'"
                        class="mt-2 text-sm text-muted-foreground"
                        data-testid="org-member-detail-agent-open-loading"
                    >
                        {{ t("orgMembers.agentOpenLoading") }}
                    </p>
                    <p
                        v-else-if="workspaceChoiceState === 'error'"
                        class="mt-2 text-sm text-destructive"
                        data-testid="org-member-detail-agent-open-error"
                    >
                        {{ t("orgMembers.agentOpenError") }}
                    </p>
                    <p
                        v-else-if="workspaceChoiceState === 'ready' && !workspaceChoices.length"
                        class="mt-2 text-sm text-muted-foreground"
                        data-testid="org-member-detail-agent-open-empty"
                    >
                        {{ t("orgMembers.agentOpenEmpty") }}
                    </p>
                    <template v-else-if="workspaceChoiceState === 'ready'">
                        <Select v-model="selectedWorkspaceId">
                            <SelectTrigger
                                class="mt-2 w-full"
                                data-testid="org-member-detail-agent-open-picker"
                            >
                                <SelectValue :placeholder="t('orgMembers.agentOpenPickerLabel')" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem
                                    v-for="choice in workspaceChoices"
                                    :key="choice.id"
                                    :value="choice.id"
                                >
                                    {{ choice.name }}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                        <Button
                            variant="outline"
                            size="sm"
                            class="mt-2"
                            data-testid="org-member-detail-agent-open-button"
                            :disabled="!selectedWorkspaceId"
                            @click="openAgentInWorkspace()"
                        >
                            {{ t("orgMembers.agentOpenButton") }}
                        </Button>
                        <p
                            class="mt-2 text-xs text-muted-foreground"
                            data-testid="org-member-detail-agent-open-hint"
                        >
                            {{ t("orgMembers.agentOpenHint") }}
                        </p>
                    </template>
                    <p
                        class="mt-2 text-xs text-muted-foreground"
                        data-testid="org-member-detail-agent-open-cost"
                    >
                        {{ t("orgMembers.agentOpenCost") }}
                    </p>
                </section>

                <!-- 段①：工作区成员角色（MembersView.role，与访问角色是两条轴） -->
                <section class="border-t pt-4" data-testid="org-member-detail-workspace-role">
                    <h3 class="text-sm font-semibold">
                        {{ t("orgMembers.detailWorkspaceRoleTitle") }}
                    </h3>
                    <p class="mt-1 text-xs text-muted-foreground">
                        {{ t("orgMembers.detailWorkspaceRoleDesc") }}
                    </p>
                    <p
                        v-if="member.memberKind !== 'human'"
                        class="mt-2 text-sm text-muted-foreground"
                        data-testid="org-member-detail-workspace-role-agent"
                    >
                        {{ t("orgMembers.detailWorkspaceRoleAgent") }}
                    </p>
                    <template v-else>
                        <p
                            class="mt-1 text-xs text-muted-foreground"
                            data-testid="org-member-detail-workspace-role-cost"
                        >
                            {{ t("orgMembers.detailWorkspaceRoleCap", wsCapParams) }}
                        </p>
                        <Button
                            variant="outline"
                            size="sm"
                            class="mt-2"
                            data-testid="org-member-detail-workspace-role-load"
                            :disabled="wsState === 'loading'"
                            @click="void loadWorkspaceRoles()"
                        >
                            {{ t("orgMembers.detailWorkspaceRoleLoad") }}
                        </Button>
                        <p
                            v-if="wsState === 'loading'"
                            class="mt-2 text-sm text-muted-foreground"
                            data-testid="org-member-detail-workspace-role-loading"
                        >
                            {{ t("orgMembers.detailWorkspaceRoleLoading") }}
                        </p>
                        <p
                            v-else-if="wsState === 'error'"
                            class="mt-2 text-sm text-destructive"
                            data-testid="org-member-detail-workspace-role-error"
                        >
                            {{ t("orgMembers.detailWorkspaceRoleError") }}
                        </p>
                        <ul
                            v-else-if="wsState === 'done'"
                            class="mt-2 flex flex-col gap-1"
                            data-testid="org-member-detail-workspace-role-rows"
                        >
                            <li
                                v-for="row in wsRows"
                                :key="row.workspaceId"
                                class="flex items-center justify-between gap-2 text-sm"
                                :data-testid="'org-member-detail-workspace-role-' + row.workspaceId"
                            >
                                <span class="truncate">{{ row.workspaceName }}</span>
                                <Badge v-if="row.denied" variant="outline">
                                    {{ t("orgMembers.detailWorkspaceRoleDenied") }}
                                </Badge>
                                <span v-else-if="row.role" class="text-muted-foreground">
                                    {{ row.role }}
                                </span>
                                <span v-else class="text-muted-foreground">—</span>
                            </li>
                            <li
                                v-if="!wsRows.length"
                                class="text-sm text-muted-foreground"
                                data-testid="org-member-detail-workspace-role-empty"
                            >
                                {{ t("orgMembers.detailWorkspaceRoleEmpty") }}
                            </li>
                        </ul>
                        <p class="mt-2 text-xs text-muted-foreground">
                            {{ t("orgMembers.detailWorkspaceRoleEditHint") }}
                        </p>
                    </template>
                </section>

                <!-- 段②：访问角色绑定（实例级，MANAGE_ROLES 原子门） -->
                <section class="border-t pt-4" data-testid="org-member-detail-access-role">
                    <h3 class="text-sm font-semibold">
                        {{ t("orgMembers.detailAccessRoleTitle") }}
                    </h3>
                    <p class="mt-1 text-xs text-muted-foreground">
                        {{ t("orgMembers.detailAccessRoleDesc") }}
                    </p>
                    <p
                        v-if="accessState === 'agent'"
                        class="mt-2 text-sm text-muted-foreground"
                        data-testid="org-member-detail-access-role-agent"
                    >
                        {{ t("orgMembers.detailAccessRoleAgent") }}
                    </p>
                    <p
                        v-else-if="accessState === 'pending'"
                        class="mt-2 text-sm text-muted-foreground"
                        data-testid="org-member-detail-access-role-pending"
                    >
                        {{ t("orgMembers.detailAccessRolePending") }}
                    </p>
                    <p
                        v-else-if="accessState === 'unread'"
                        class="mt-2 text-sm text-muted-foreground"
                        data-testid="org-member-detail-access-role-unread"
                    >
                        {{ t("orgMembers.detailAccessRoleUnread") }}
                    </p>
                    <p
                        v-else-if="accessState === 'gated'"
                        class="mt-2 text-sm text-muted-foreground"
                        data-testid="org-member-detail-access-role-gated"
                    >
                        {{ t("orgMembers.detailAccessRoleGated") }}
                    </p>
                    <p
                        v-else-if="accessState === 'loading'"
                        class="mt-2 text-sm text-muted-foreground"
                        data-testid="org-member-detail-access-role-loading"
                    >
                        {{ t("orgMembers.detailAccessRoleLoading") }}
                    </p>
                    <p
                        v-else-if="accessState === 'error'"
                        class="mt-2 text-sm text-destructive"
                        data-testid="org-member-detail-access-role-error"
                    >
                        {{ t("orgMembers.detailAccessRoleError") }}
                    </p>
                    <template v-else-if="accessState === 'ready'">
                        <ul
                            class="mt-2 flex flex-col gap-1"
                            data-testid="org-member-detail-access-role-rows"
                        >
                            <li
                                v-for="row in accessRows"
                                :key="row.id"
                                class="flex items-center justify-between gap-2 text-sm"
                                :data-testid="'org-member-detail-access-role-' + row.id"
                            >
                                <span class="font-mono text-xs">{{ row.roleName }}</span>
                                <span class="text-xs text-muted-foreground">{{
                                    row.subjectType
                                }}</span>
                            </li>
                            <li
                                v-if="!accessRows.length"
                                class="text-sm text-muted-foreground"
                                data-testid="org-member-detail-access-role-empty"
                            >
                                {{ t("orgMembers.detailAccessRoleEmpty") }}
                            </li>
                        </ul>
                    </template>
                </section>

                <!-- 段③：权限原子（B 形态：只陈述「不在本页展示」+「未展示 ≠ 无权限」） -->
                <section class="border-t pt-4" data-testid="org-member-detail-atoms">
                    <h3 class="text-sm font-semibold">{{ t("orgMembers.detailAtomsTitle") }}</h3>
                    <p
                        class="mt-2 text-sm font-medium"
                        data-testid="org-member-detail-atoms-not-shown"
                    >
                        {{ t("orgMembers.detailAtomsNotShown") }}
                    </p>
                    <p class="mt-1 text-xs text-muted-foreground">
                        {{ t("orgMembers.detailAtomsWhy") }}
                    </p>
                    <p class="mt-2 text-sm" data-testid="org-member-detail-atoms-not-no-permission">
                        {{ t("orgMembers.detailAtomsNotNoPermission") }}
                    </p>
                    <a
                        class="mt-2 inline-block text-sm underline underline-offset-2"
                        href="/api/v1/me/permissions"
                        target="_blank"
                        rel="noreferrer"
                        data-testid="org-member-detail-atoms-self-link"
                    >
                        {{ t("orgMembers.detailAtomsLink") }}
                    </a>
                </section>

                <!-- 动作：本批写面未开放 ⇒ 一律禁用 + 两条原因都写出来 -->
                <section class="border-t pt-4" data-testid="org-member-detail-actions">
                    <h3 class="text-sm font-semibold">{{ t("orgMembers.detailActionsTitle") }}</h3>
                    <div class="mt-2 flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            disabled
                            data-testid="org-member-detail-change-role"
                            class="rounded-md border bg-muted/30 px-2 py-1 text-sm text-muted-foreground cursor-not-allowed"
                        >
                            {{ t("orgMembers.detailActionChangeRole") }}
                        </button>
                        <button
                            type="button"
                            disabled
                            data-testid="org-member-detail-remove"
                            class="rounded-md border bg-muted/30 px-2 py-1 text-sm text-muted-foreground cursor-not-allowed"
                        >
                            {{ t("orgMembers.detailActionRemove") }}
                        </button>
                    </div>
                    <p
                        class="mt-2 text-xs text-muted-foreground"
                        data-testid="org-member-detail-action-reason-batch"
                    >
                        {{ t("orgMembers.detailActionsBatchReason") }}
                    </p>
                    <p
                        class="mt-1 text-xs text-muted-foreground"
                        data-testid="org-member-detail-action-reason-admin"
                    >
                        {{ t("orgMembers.detailActionsAdminReason") }}
                    </p>
                </section>
            </div>

            <p
                v-else
                class="px-4 text-sm text-muted-foreground"
                data-testid="org-member-detail-empty"
            >
                {{ t("orgMembers.selectUnit") }}
            </p>
        </SheetContent>
    </Sheet>
</template>
