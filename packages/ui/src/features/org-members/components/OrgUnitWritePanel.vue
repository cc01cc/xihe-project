<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { LoaderCircle } from "@lucide/vue";
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "../../../components/ui/select";
import {
    api,
    ApiError,
    type ApiOrgUnitMember,
    type ApiOrgUnitNode,
    type ApiPreset,
} from "../../../composables/api";
import { useAuthStore } from "../../../stores/auth";
import { orgUnitNames } from "../composables/useOrgUnitTree";
import {
    isOrgGovernanceRole,
    useOrgUnitWrites,
    type OrgWriteKind,
} from "../composables/useOrgUnitWrites";

/**
 * task-136：组织成员页的写面（六个操作的真实入口）。
 *
 * <p>分工：本组件只管「采集输入 + 渲染服务端原文」；契约调用、确认门（409
 * `ORG_UNIT_MOVE_CONFIRMATION_REQUIRED`）、错误原文的留存都在
 * `useOrgUnitWrites`。写成功后**不**在本地改树/改列表 —— 由父页 bump 刷新令牌重取
 * 读面（J5，task-43 已裁：不乐观插入）。</p>
 *
 * <p>三个刻意的「不做」：</p>
 * <ul>
 * <li><b>不预检环/重名</b>：本地树只是可见子集，预检等于替服务端判定，还会让
 * 422 `ORG_UNIT_CYCLE` / 409 `ORG_UNIT_NAME_CONFLICT` 变成死分支（J2 要求这些原文可见）。</li>
 * <li><b>不做整集角色勾选</b>：契约没有 GET preset-bindings 读面，整集提交会静默清掉既有绑定
 * （Lead 2026-11-21 裁定：只做逐条新增 + 单条解绑，先以空集建立基线）。</li>
 * <li><b>不把 409 里的计数当精确清单</b>：原文只有数字（无数组），本地派生会少报（服务端把 UI
 * 看不见的工作区也算进去）⇒ 界面上必须写「可能不全」。</li>
 * </ul>
 */
const props = defineProps<{ unit: ApiOrgUnitNode | null }>();
const emit = defineEmits<{ written: [kind: OrgWriteKind] }>();
const { t } = useI18n();
const auth = useAuthStore();

type WriteMode = "create" | "rename" | "move" | "add-member" | "remove-member" | "roles";

const mode = ref<WriteMode | null>(null),
    name = ref(""),
    parentChoice = ref("__top__"),
    memberKind = ref<ApiOrgUnitMember["memberKind"]>("human"),
    subjectQuery = ref(""),
    subjectOptions = ref<Array<{ id: string; label: string }>>([]),
    subjectLabels = ref<Record<string, string>>({}),
    subjectLoading = ref(false),
    subjectError = ref(""),
    /** R23（task-954）：成员可多选 —— 复选框绑定该数组，提交时逐个落位。 */
    subjectIds = ref<string[]>([]),
    /** R28（task-954）：写入前先显式确认一次，文案承诺的「需要你确认」必须真的发生。 */
    addConfirmPending = ref(false),
    /** 409 确认门期间暂存的剩余待放置主体；确认成功后接着逐个写入。 */
    addQueueRest = ref<string[]>([]),
    roleCatalog = ref<ApiPreset[]>([]),
    roleLoading = ref(false),
    roleError = ref(""),
    /** 本地基线：null = 未知（契约无读面）。非 null 时只由服务端响应体更新。 */
    baseline = ref<string[] | null>(null),
    roleAddId = ref(""),
    removeCandidates = ref<ApiOrgUnitMember[]>([]),
    removeLoading = ref(false),
    removeError = ref(""),
    notice = ref(""),
    /** 工具条提示的色调：成功走中性色，缺选中走警示色。 */
    noticeOk = ref(false);

const writes = useOrgUnitWrites({
    onWritten: (kind) => emit("written", kind),
    callerId: () => auth.user?.id ?? null,
});

const WRITE_ACTIONS: ReadonlyArray<{ testid: string; labelKey: string; mode: WriteMode }> = [
    { testid: "org-write-new-unit", labelKey: "orgMembers.writeNewUnit", mode: "create" },
    { testid: "org-write-rename", labelKey: "orgMembers.writeRename", mode: "rename" },
    { testid: "org-write-move", labelKey: "orgMembers.writeMove", mode: "move" },
    { testid: "org-write-add-member", labelKey: "orgMembers.writeAddMember", mode: "add-member" },
    {
        testid: "org-write-remove-member",
        labelKey: "orgMembers.writeRemoveMember",
        mode: "remove-member",
    },
    { testid: "org-write-change-role", labelKey: "orgMembers.writeChangeRole", mode: "roles" },
];

/** 父单元候选 = 树里已加载过的单元（不做额外请求，也不假装是全量）。 */
const unitChoices = computed(() => {
    const rows = Array.from(orgUnitNames.value.entries()).map(([id, label]) => ({ id, label }));
    rows.sort((a, b) => a.label.localeCompare(b.label));
    return rows;
});

const governanceRoles = computed(() =>
    roleCatalog.value.filter((role) => isOrgGovernanceRole(role.atoms)),
);

const addableRoles = computed(() => {
    const current = baseline.value ?? [];
    return governanceRoles.value.filter((role) => !current.includes(role.id));
});

const currentRoleNames = computed(() => {
    const current = baseline.value ?? [];
    return current.map((id) => roleCatalog.value.find((role) => role.id === id)?.displayName ?? id);
});

/** R23：已选主体清单（标签跟着选择记，搜索换页后不会退回裸 id）。 */
const selectedSubjects = computed(() =>
    subjectIds.value.map((id) => ({ id, label: subjectLabels.value[id] ?? id })),
);

const movePending = computed(() => writes.pendingMove.value);
const removalPending = computed(() => writes.pendingRemoval.value);
const busy = computed(() => writes.busy.value);
const problem = computed(() => writes.problem.value);

function resetTransient(): void {
    name.value = "";
    parentChoice.value = "__top__";
    memberKind.value = "human";
    subjectQuery.value = "";
    subjectOptions.value = [];
    subjectLabels.value = {};
    subjectError.value = "";
    subjectIds.value = [];
    addConfirmPending.value = false;
    addQueueRest.value = [];
    roleAddId.value = "";
    removeCandidates.value = [];
    removeError.value = "";
    notice.value = "";
    noticeOk.value = false;
    writes.clearProblem();
    writes.closeMemberMoveConfirmation();
    writes.closeMemberRemovalConfirmation();
}

async function open(target: WriteMode): Promise<void> {
    resetTransient();
    // R22（task-954）：toolbar 入口在没有选中单元时一律禁用；这里只防程序化调用。
    // `create` 例外是为了让「父单元：顶层」这一态可见（提交仍被 `!unit` 挡住，不发必然 403 的请求）。
    if (target !== "create" && !props.unit) {
        noticeOk.value = false;
        notice.value = t("orgMembers.writeNeedsSelection");
        return;
    }
    mode.value = target;
    if (target === "rename" && props.unit) name.value = props.unit.name;
    if (target === "move" && props.unit?.parentId) parentChoice.value = props.unit.parentId;
    if (target === "roles") await loadRoles();
    if (target === "remove-member") await loadRemovableMembers();
    if (target === "add-member") await loadSubjects();
}

function close(): void {
    mode.value = null;
    resetTransient();
}

async function loadRoles(): Promise<void> {
    roleLoading.value = true;
    roleError.value = "";
    try {
        roleCatalog.value = await api.listPresets();
    } catch (cause) {
        roleError.value =
            cause instanceof ApiError
                ? (cause.problem.detail ?? cause.problem.code)
                : String(cause);
    } finally {
        roleLoading.value = false;
    }
}

async function loadRemovableMembers(): Promise<void> {
    const unit = props.unit;
    if (!unit) return;
    removeLoading.value = true;
    removeError.value = "";
    try {
        // 只要直接成员：下级单元的成员属于别的单元，得从那一行改（否则「移出」会作用到看不到的单元）。
        removeCandidates.value = await api.listOrgUnitMembers(unit.id, {
            includeDescendants: false,
        });
    } catch (cause) {
        removeError.value =
            cause instanceof ApiError
                ? (cause.problem.detail ?? cause.problem.code)
                : String(cause);
    } finally {
        removeLoading.value = false;
    }
}

async function loadSubjects(): Promise<void> {
    subjectLoading.value = true;
    subjectError.value = "";
    try {
        if (memberKind.value === "agent_principal") {
            const rows = await api.listAgentPrincipals();
            // R23：智能体列表契约没有查询参数 ⇒ 拿到可见全集后本地按名称/ID 过滤；
            // 不做第二套「谁可见」的判定（能看见的才是列表里的，过滤只缩不放）。
            const needle = subjectQuery.value.trim().toLowerCase();
            subjectOptions.value = rows
                .filter(
                    (row) =>
                        !needle ||
                        row.name.toLowerCase().includes(needle) ||
                        row.principalId.toLowerCase().includes(needle),
                )
                .map((row) => ({ id: row.principalId, label: row.name }));
        } else {
            const rows = await api.listAdminUsers(subjectQuery.value);
            subjectOptions.value = rows.map((row) => ({
                id: row.id,
                label: row.name || row.username || row.email,
            }));
        }
        // 只合并、不清空：跨查询保留已选项，标签记在本地。
        for (const row of subjectOptions.value) subjectLabels.value[row.id] = row.label;
    } catch (cause) {
        subjectOptions.value = [];
        subjectError.value =
            cause instanceof ApiError
                ? (cause.problem.detail ?? cause.problem.code)
                : String(cause);
    } finally {
        subjectLoading.value = false;
    }
}

async function submitName(target: "create" | "rename"): Promise<void> {
    const trimmed = name.value.trim();
    if (!trimmed) return;
    const unit = props.unit;
    if (target === "create") {
        // R22：没有选中单元就没有父单元，建根需要更高权限 ⇒ 不发必然 403 的请求。
        if (!unit) {
            noticeOk.value = false;
            notice.value = t("orgMembers.writeNeedsSelection");
            return;
        }
        if (await writes.createUnit({ name: trimmed, parentId: unit.id })) finish();
        return;
    }
    const ok = unit ? await writes.renameUnit(unit.id, trimmed) : false;
    if (ok) finish();
}

async function submitMove(): Promise<void> {
    const unit = props.unit;
    if (!unit) return;
    const parentId = parentChoice.value === "__top__" ? null : parentChoice.value;
    if (await writes.moveUnit(unit.id, parentId)) finish();
}

/** R23：切换成员类型时清空已选项 —— human 的 id 不能当 agent_principal 提交。 */
async function onMemberKindChange(): Promise<void> {
    subjectIds.value = [];
    subjectLabels.value = {};
    await loadSubjects();
}

/**
 * R23：多选勾选（不用 `v-model` —— 这格是「主体选择器」，没有共享校验器规则；
 * 与 `WorkspaceAgentsPanel` 的能力勾选同一形态：`:checked` + `@change`）。
 */
function toggleSubject(row: { id: string; label: string }, checked: boolean): void {
    subjectLabels.value[row.id] = row.label;
    subjectIds.value = checked
        ? [...subjectIds.value, row.id]
        : subjectIds.value.filter((id) => id !== row.id);
}

/** R28 第一步：只落确认态，不发任何写请求。 */
function submitAddMember(): void {
    if (!props.unit || subjectIds.value.length === 0) return;
    addConfirmPending.value = true;
}

/**
 * R23/R28 第二步：确认后逐个落位。契约没有批量端点，所以是 N 个
 * `PUT …/members/{id}?memberKind=` —— 回执按 N 条调用计（不是一次批量写）。
 * 任一成员撞 409 就停在确认门，确认成功后从 `addQueueRest` 续跑。
 */
async function runAddQueue(ids: string[]): Promise<void> {
    const unit = props.unit;
    if (!unit) return;
    const queue = [...ids];
    while (queue.length > 0) {
        const memberId = queue[0];
        const outcome = await writes.requestMemberMove({
            unitId: unit.id,
            memberId,
            memberKind: memberKind.value,
            memberName: subjectLabels.value[memberId] ?? memberId,
        });
        if (outcome === "done") {
            queue.shift();
            continue;
        }
        if (outcome === "needs-confirmation") {
            // 409 已经把影响面摊在窗口里 ⇒ 不关窗，等用户按确认。
            addQueueRest.value = queue.slice(1);
            return;
        }
        // 失败：原文留在屏幕上，剩余队列作废（不让用户在半截状态里继续点）。
        addQueueRest.value = [];
        return;
    }
    finish();
}

async function confirmAddMember(): Promise<void> {
    addConfirmPending.value = false;
    await runAddQueue(subjectIds.value);
}

async function confirmMove(): Promise<void> {
    if (!(await writes.confirmMemberMove())) return;
    if (addQueueRest.value.length > 0) {
        const rest = addQueueRest.value;
        addQueueRest.value = [];
        await runAddQueue(rest);
        return;
    }
    finish();
}

function pickRemoval(member: ApiOrgUnitMember): void {
    const unit = props.unit;
    if (!unit) return;
    writes.requestMemberRemoval({
        unitId: unit.id,
        memberId: member.memberId,
        memberKind: member.memberKind,
        memberName: member.displayName ?? member.memberId,
        isSelf: !!auth.user?.id && auth.user.id === member.memberId,
    });
}

async function confirmRemoval(): Promise<void> {
    if (await writes.confirmMemberRemoval()) finish();
}

async function establishBaseline(): Promise<void> {
    const unit = props.unit;
    if (!unit) return;
    const result = await writes.replaceRoleBindings(unit.id, []);
    if (result.ok) baseline.value = result.roleIds ?? [];
}

async function addRole(): Promise<void> {
    const unit = props.unit;
    if (!unit || !baseline.value || !roleAddId.value) return;
    const result = await writes.replaceRoleBindings(unit.id, [...baseline.value, roleAddId.value]);
    if (result.ok) {
        baseline.value = result.roleIds ?? [];
        roleAddId.value = "";
    }
}

async function unbindRole(roleId: string): Promise<void> {
    const unit = props.unit;
    if (!unit || !baseline.value) return;
    const result = await writes.replaceRoleBindings(
        unit.id,
        baseline.value.filter((id) => id !== roleId),
    );
    if (result.ok) baseline.value = result.roleIds ?? [];
}

function finish(): void {
    // 成功才关窗：失败必须把原文留在屏幕上（J2），所以关窗与否由各 submit 决定。
    mode.value = null;
    writes.clearProblem();
    noticeOk.value = true;
    notice.value = t("orgMembers.writeOk");
}

function onDialogOpenChange(value: boolean): void {
    if (!value) close();
}

const dialogTitle = computed(() => {
    switch (mode.value) {
        case "create":
            return t("orgMembers.writeNewUnit");
        case "rename":
            return t("orgMembers.writeRename");
        case "move":
            return t("orgMembers.writeMove");
        case "add-member":
            return t("orgMembers.writeAddMember");
        case "remove-member":
            return t("orgMembers.writeRemoveMember");
        case "roles":
            return t("orgMembers.writeChangeRole");
        default:
            return "";
    }
});

const dialogDescription = computed(() => {
    switch (mode.value) {
        case "create":
            return t("orgMembers.writeNewUnitDesc");
        case "rename":
            return t("orgMembers.writeRenameDesc");
        case "move":
            return t("orgMembers.writeMoveDesc");
        case "add-member":
            return t("orgMembers.writeAddMemberDesc");
        case "remove-member":
            return t("orgMembers.writeRemoveDesc");
        case "roles":
            return t("orgMembers.writeRolesMirror");
        default:
            return "";
    }
});

/**
 * 成员行/详情面板的入口复用同一套窗口（「一个操作只有一处实现」）。
 * 带了 `member` 就在候选里预选那一行 —— 详情抽屉点「移除成员」时用户已经指过人了。
 */
async function openForMember(
    target: "remove-member" | "roles",
    member?: { memberId: string },
): Promise<void> {
    await open(target);
    if (target === "remove-member" && member) {
        const hit = removeCandidates.value.find((row) => row.memberId === member.memberId);
        if (hit) pickRemoval(hit);
    }
}

defineExpose({ open, openForMember });
</script>

<template>
    <div>
        <div class="flex flex-wrap items-center gap-2" data-testid="org-write-actions">
            <span
                v-for="action in WRITE_ACTIONS"
                :key="action.testid"
                :title="unit ? undefined : t('orgMembers.writeNeedsSelection')"
            >
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    :data-testid="action.testid"
                    :disabled="!unit"
                    @click="open(action.mode)"
                >
                    {{ t(action.labelKey) }}
                </Button>
            </span>
            <p class="w-full text-xs text-muted-foreground">{{ t("orgMembers.writeHint") }}</p>
            <p
                v-if="notice"
                class="w-full text-xs"
                :class="noticeOk ? 'text-muted-foreground' : 'text-destructive'"
                data-testid="org-write-notice"
            >
                {{ notice }}
            </p>
        </div>

        <Dialog :open="mode !== null" @update:open="onDialogOpenChange">
            <DialogContent width="form" data-testid="org-write-dialog">
                <DialogHeader>
                    <DialogTitle>{{ dialogTitle }}</DialogTitle>
                    <DialogDescription>{{ dialogDescription }}</DialogDescription>
                </DialogHeader>

                <div class="space-y-3">
                    <!-- 新建 / 改名：名称 -->
                    <div v-if="mode === 'create' || mode === 'rename'" class="space-y-2">
                        <Label for="org-write-name">{{ t("orgMembers.writeNameLabel") }}</Label>
                        <Input
                            id="org-write-name"
                            v-model="name"
                            data-testid="org-write-name"
                            maxlength="120"
                        />
                    </div>

                    <!-- R20：新建子单元时把「将挂在哪个单元」摆在界面上（只读，不可选） -->
                    <div
                        v-if="mode === 'create'"
                        class="space-y-1"
                        data-testid="org-write-create-parent"
                    >
                        <p class="text-sm">
                            <span class="text-muted-foreground"
                                >{{ t("orgMembers.writeParentLabel") }}：</span
                            >
                            <span class="font-medium" data-testid="org-write-create-parent-name">
                                {{ unit ? unit.name : t("orgMembers.writeParentTop") }}
                            </span>
                        </p>
                        <p class="text-xs text-muted-foreground">
                            {{ t("orgMembers.writeNewUnitDesc") }}
                        </p>
                    </div>

                    <!-- 搬移：新父单元 -->
                    <div v-if="mode === 'move'" class="space-y-2">
                        <Label for="org-write-parent">{{ t("orgMembers.writeParentLabel") }}</Label>
                        <Select v-model="parentChoice">
                            <SelectTrigger id="org-write-parent" data-testid="org-write-parent">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="__top__">{{
                                    t("orgMembers.writeParentTop")
                                }}</SelectItem>
                                <SelectItem
                                    v-for="row in unitChoices"
                                    :key="row.id"
                                    :value="row.id"
                                >
                                    {{ row.label }}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                        <p class="text-xs text-muted-foreground">
                            {{ t("orgMembers.writeParentScan") }}
                        </p>
                    </div>

                    <!-- 加成员：类型 + 主体 -->
                    <template v-if="mode === 'add-member' && !movePending">
                        <template v-if="!addConfirmPending">
                            <div class="space-y-2">
                                <Label for="org-write-member-kind">{{
                                    t("orgMembers.writeMemberKindLabel")
                                }}</Label>
                                <Select
                                    v-model="memberKind"
                                    @update:model-value="onMemberKindChange"
                                >
                                    <SelectTrigger
                                        id="org-write-member-kind"
                                        data-testid="org-write-member-kind"
                                    >
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="human">{{
                                            t("orgMembers.kindHuman")
                                        }}</SelectItem>
                                        <SelectItem value="agent_principal">
                                            {{ t("orgMembers.kindAgent") }}
                                        </SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div class="space-y-2">
                                <Label for="org-write-search">{{
                                    t("orgMembers.writeSubjectSearch")
                                }}</Label>
                                <Input
                                    id="org-write-search"
                                    v-model="subjectQuery"
                                    data-testid="org-write-search"
                                    :placeholder="
                                        memberKind === 'agent_principal'
                                            ? `${t('orgMembers.kindAgent')} · ${t('orgMembers.colName')}`
                                            : t('orgMembers.writeSubjectSearch')
                                    "
                                    @keyup.enter="loadSubjects"
                                />
                                <p
                                    v-if="memberKind === 'agent_principal'"
                                    class="text-xs text-muted-foreground"
                                >
                                    {{ t("orgMembers.writeSubjectAgents") }}
                                </p>
                            </div>
                            <div class="max-h-48 space-y-1 overflow-y-auto">
                                <p v-if="subjectLoading" class="text-xs text-muted-foreground">
                                    {{ t("orgMembers.writeSubjectSearching") }}
                                </p>
                                <p v-else-if="subjectError" class="text-xs text-destructive">
                                    {{ subjectError }}
                                </p>
                                <p
                                    v-else-if="subjectOptions.length === 0"
                                    class="text-xs text-muted-foreground"
                                >
                                    {{ t("orgMembers.writeSubjectEmpty") }}
                                </p>
                                <label
                                    v-for="row in subjectOptions"
                                    :key="row.id"
                                    class="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted"
                                    :data-testid="`org-write-subject-${row.id}`"
                                >
                                    <input
                                        type="checkbox"
                                        :checked="subjectIds.includes(row.id)"
                                        @change="
                                            toggleSubject(
                                                row,
                                                ($event.target as HTMLInputElement).checked,
                                            )
                                        "
                                    />
                                    <span>{{ row.label }}</span>
                                    <code
                                        class="ml-auto font-mono text-[10px] text-muted-foreground"
                                        >{{ row.id }}</code
                                    >
                                </label>
                            </div>
                        </template>

                        <!-- R28：提交前显式确认（文案承诺的「需要你确认」必须真的发生） -->
                        <div v-else class="space-y-2" data-testid="org-write-add-confirm-panel">
                            <Alert>
                                <AlertTitle>{{ t("orgMembers.writeAddMember") }}</AlertTitle>
                                <AlertDescription>
                                    {{ t("orgMembers.writeAddMemberDesc") }}
                                </AlertDescription>
                            </Alert>
                            <ul class="space-y-1 text-sm" data-testid="org-write-add-confirm-list">
                                <li
                                    v-for="row in selectedSubjects"
                                    :key="row.id"
                                    class="flex items-center gap-2 rounded bg-muted px-2 py-1"
                                    :data-testid="`org-write-add-confirm-${row.id}`"
                                >
                                    <span>{{ row.label }}</span>
                                    <code
                                        class="ml-auto font-mono text-[10px] text-muted-foreground"
                                        >{{ row.id }}</code
                                    >
                                </li>
                            </ul>
                        </div>
                    </template>

                    <!-- 加成员：409 确认门（确认后才真正写入） -->
                    <div v-if="mode === 'add-member' && movePending" class="space-y-2">
                        <Alert variant="destructive">
                            <AlertTitle>{{ t("orgMembers.writeConfirmMoveTitle") }}</AlertTitle>
                            <AlertDescription>
                                <p
                                    v-if="movePending.serverCount !== null"
                                    data-testid="org-write-affected-count"
                                >
                                    {{
                                        t("orgMembers.writeConfirmCount", {
                                            count: movePending.serverCount,
                                        })
                                    }}
                                </p>
                                <p v-else data-testid="org-write-affected-count">
                                    {{ t("orgMembers.writeConfirmCountUnknown") }}
                                </p>
                                <p
                                    class="mt-1 font-mono text-xs"
                                    data-testid="org-write-problem-detail"
                                >
                                    {{ movePending.detail }}
                                </p>
                            </AlertDescription>
                        </Alert>
                        <div class="text-xs text-muted-foreground">
                            <p class="font-medium text-foreground">
                                {{ t("orgMembers.writeConfirmDerivedTitle") }}
                            </p>
                            <p v-if="!movePending.derivable">
                                {{ t("orgMembers.writeConfirmDerivedNone") }}
                            </p>
                            <p v-else-if="movePending.derived.length === 0">
                                {{ t("orgMembers.writeConfirmDerivedEmpty") }}
                            </p>
                            <ul v-else class="list-disc pl-4" data-testid="org-write-affected-list">
                                <li v-for="row in movePending.derived" :key="row.id">
                                    {{ row.name }}
                                </li>
                            </ul>
                            <p class="mt-1" data-testid="org-write-affected-partial">
                                {{ t("orgMembers.writeConfirmDerivedPartial") }}
                            </p>
                        </div>
                        <p
                            v-if="movePending.isSelf"
                            class="text-xs text-destructive"
                            data-testid="org-write-self-risk"
                        >
                            {{ t("orgMembers.writeConfirmSelf") }}
                        </p>
                    </div>

                    <!-- 移除成员：先选成员，再确认 -->
                    <template v-if="mode === 'remove-member'">
                        <div v-if="!removalPending" class="max-h-56 space-y-1 overflow-y-auto">
                            <p v-if="removeLoading" class="text-xs text-muted-foreground">
                                {{ t("orgMembers.membersLoading") }}
                            </p>
                            <p v-else-if="removeError" class="text-xs text-destructive">
                                {{ removeError }}
                            </p>
                            <p
                                v-else-if="removeCandidates.length === 0"
                                class="text-xs text-muted-foreground"
                            >
                                {{ t("orgMembers.membersEmpty") }}
                            </p>
                            <button
                                v-for="member in removeCandidates"
                                :key="member.memberId"
                                type="button"
                                class="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-muted"
                                :data-testid="`org-write-remove-pick-${member.memberId}`"
                                @click="pickRemoval(member)"
                            >
                                <span>{{ member.displayName ?? member.memberId }}</span>
                                <code class="ml-auto font-mono text-[10px] text-muted-foreground">
                                    {{ member.memberKind }}
                                </code>
                            </button>
                        </div>
                        <div v-else class="space-y-2">
                            <Alert variant="destructive">
                                <AlertTitle>{{
                                    t("orgMembers.writeConfirmRemoveTitle")
                                }}</AlertTitle>
                                <AlertDescription>
                                    {{ t("orgMembers.writeConfirmRemoveOther") }}
                                </AlertDescription>
                            </Alert>
                            <p
                                v-if="removalPending.isSelf"
                                class="text-xs text-destructive"
                                data-testid="org-write-self-risk"
                            >
                                {{ t("orgMembers.writeConfirmRemoveSelf") }}
                            </p>
                        </div>
                    </template>

                    <!-- 改角色：逐条新增 / 单条解绑，整集提交由基线决定 -->
                    <template v-if="mode === 'roles'">
                        <Alert
                            v-if="baseline === null"
                            data-testid="org-write-role-baseline-unknown"
                        >
                            <AlertTitle>{{ t("orgMembers.writeRolesBaselineUnknown") }}</AlertTitle>
                            <AlertDescription>{{
                                t("orgMembers.writeRolesBaselineHint")
                            }}</AlertDescription>
                        </Alert>
                        <template v-else>
                            <p
                                class="text-xs text-muted-foreground"
                                data-testid="org-write-role-baseline"
                            >
                                {{ t("orgMembers.writeRolesBaseline", { count: baseline.length }) }}
                            </p>
                            <ul class="space-y-1">
                                <li
                                    v-for="roleId in baseline"
                                    :key="roleId"
                                    class="flex items-center gap-2 text-sm"
                                    :data-testid="`org-write-role-bound-${roleId}`"
                                >
                                    <span>{{
                                        roleCatalog.find((role) => role.id === roleId)
                                            ?.displayName ?? roleId
                                    }}</span>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        class="ml-auto"
                                        :data-testid="`org-write-role-unbind-${roleId}`"
                                        :disabled="busy"
                                        @click="unbindRole(roleId)"
                                    >
                                        {{ t("orgMembers.writeRolesUnbind") }}
                                    </Button>
                                </li>
                                <li
                                    v-if="baseline.length === 0"
                                    class="text-xs text-muted-foreground"
                                >
                                    {{ t("orgMembers.writeRolesNoCandidates") }}
                                </li>
                            </ul>
                            <div class="flex items-end gap-2">
                                <div class="flex-1 space-y-2">
                                    <Label for="org-write-role-add">{{
                                        t("orgMembers.writeRolesAdd")
                                    }}</Label>
                                    <Select v-model="roleAddId">
                                        <SelectTrigger
                                            id="org-write-role-add"
                                            data-testid="org-write-role-add"
                                        >
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem
                                                v-for="role in addableRoles"
                                                :key="role.id"
                                                :value="role.id"
                                            >
                                                {{ role.displayName }}
                                            </SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <Button
                                    type="button"
                                    data-testid="org-write-role-add-submit"
                                    :disabled="busy || !roleAddId"
                                    @click="addRole"
                                >
                                    {{ t("orgMembers.writeSubmit") }}
                                </Button>
                            </div>
                        </template>
                        <p v-if="roleLoading" class="text-xs text-muted-foreground">
                            {{ t("orgMembers.writeSubjectSearching") }}
                        </p>
                        <p v-if="roleError" class="text-xs text-destructive">{{ roleError }}</p>
                        <p
                            v-if="!roleLoading && !roleError && governanceRoles.length === 0"
                            class="text-xs text-muted-foreground"
                            data-testid="org-write-role-empty"
                        >
                            {{ t("orgMembers.writeRolesEmpty") }}
                        </p>
                        <p class="text-xs text-muted-foreground">
                            {{ t("orgMembers.writeRolesMirror") }}
                        </p>
                        <p v-if="currentRoleNames.length" class="text-xs text-muted-foreground">
                            {{ currentRoleNames.join(" / ") }}
                        </p>
                    </template>

                    <!-- 服务端原文：六条错误逐条可见（J2），不改写、不合并 -->
                    <Alert v-if="problem" variant="destructive" data-testid="org-write-problem">
                        <AlertTitle>{{ t("orgMembers.writeProblemTitle") }}</AlertTitle>
                        <AlertDescription>
                            <p class="font-mono text-xs">
                                {{ t("orgMembers.writeProblemStatus") }} {{ problem.status }}
                            </p>
                            <p class="font-mono text-xs" data-testid="org-write-problem-code">
                                {{ t("orgMembers.writeProblemCode") }}: {{ problem.code || "—" }}
                            </p>
                            <p
                                class="font-mono text-xs break-words"
                                data-testid="org-write-problem-detail"
                            >
                                {{ t("orgMembers.writeProblemDetail") }}:
                                {{ problem.detail || "—" }}
                            </p>
                            <p class="font-mono text-xs break-all">
                                {{ t("orgMembers.writeProblemRequest") }}:
                                {{ problem.requestId || "—" }}
                            </p>
                            <p v-if="!problem.code" class="text-xs">
                                {{ t("orgMembers.writeProblemNoCode") }}
                            </p>
                        </AlertDescription>
                    </Alert>
                </div>

                <DialogFooter>
                    <Button type="button" variant="ghost" :disabled="busy" @click="close">
                        {{ t("orgMembers.writeCancel") }}
                    </Button>
                    <Button
                        v-if="mode === 'create' || mode === 'rename'"
                        type="button"
                        data-testid="org-write-submit"
                        :disabled="busy || !name.trim() || (mode === 'create' && !unit)"
                        @click="submitName(mode)"
                    >
                        <LoaderCircle v-if="busy" class="mr-1 h-3 w-3 animate-spin" />
                        {{ busy ? t("orgMembers.writeBusy") : t("orgMembers.writeSubmit") }}
                    </Button>
                    <Button
                        v-else-if="mode === 'move'"
                        type="button"
                        data-testid="org-write-submit"
                        :disabled="busy"
                        @click="submitMove"
                    >
                        {{ busy ? t("orgMembers.writeBusy") : t("orgMembers.writeSubmit") }}
                    </Button>
                    <template v-else-if="mode === 'add-member'">
                        <Button
                            v-if="movePending"
                            type="button"
                            data-testid="org-write-confirm-move"
                            :disabled="busy"
                            @click="confirmMove"
                        >
                            {{
                                busy ? t("orgMembers.writeBusy") : t("orgMembers.writeConfirmMove")
                            }}
                        </Button>
                        <Button
                            v-else-if="addConfirmPending"
                            type="button"
                            data-testid="org-write-add-confirm"
                            :disabled="busy"
                            @click="confirmAddMember"
                        >
                            {{ busy ? t("orgMembers.writeBusy") : t("common.confirm") }}
                        </Button>
                        <Button
                            v-else
                            type="button"
                            data-testid="org-write-submit"
                            :disabled="busy || subjectIds.length === 0"
                            @click="submitAddMember"
                        >
                            {{ busy ? t("orgMembers.writeBusy") : t("orgMembers.writeSubmit") }}
                        </Button>
                    </template>
                    <template v-else-if="mode === 'remove-member'">
                        <Button
                            v-if="removalPending"
                            type="button"
                            variant="destructive"
                            data-testid="org-write-confirm-remove"
                            :disabled="busy"
                            @click="confirmRemoval"
                        >
                            {{
                                busy
                                    ? t("orgMembers.writeBusy")
                                    : t("orgMembers.writeConfirmRemove")
                            }}
                        </Button>
                    </template>
                    <Button
                        v-else-if="mode === 'roles' && baseline === null"
                        type="button"
                        data-testid="org-write-role-establish"
                        :disabled="busy"
                        @click="establishBaseline"
                    >
                        {{ busy ? t("orgMembers.writeBusy") : t("orgMembers.writeRolesEstablish") }}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    </div>
</template>
