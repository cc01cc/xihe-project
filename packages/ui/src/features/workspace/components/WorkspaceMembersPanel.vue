<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { LoaderCircle } from "@lucide/vue";
import {
    api,
    ApiError,
    type ApiWorkspaceMember,
    type MemberAssignableRole,
} from "../../../composables/api";
import { logger } from "../../../lib/logger";
import { usernameError } from "../../../lib/principalName";
import Input from "../../../components/ui/input/Input.vue";
import { Button } from "../../../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import AlertDialog from "../../../components/ui/alert-dialog/AlertDialog.vue";
import AlertDialogContent from "../../../components/ui/alert-dialog/AlertDialogContent.vue";
import AlertDialogHeader from "../../../components/ui/alert-dialog/AlertDialogHeader.vue";
import AlertDialogTitle from "../../../components/ui/alert-dialog/AlertDialogTitle.vue";
import AlertDialogDescription from "../../../components/ui/alert-dialog/AlertDialogDescription.vue";
import AlertDialogFooter from "../../../components/ui/alert-dialog/AlertDialogFooter.vue";
import AlertDialogCancel from "../../../components/ui/alert-dialog/AlertDialogCancel.vue";

// PLAN-0565 T2.2-T2.4: workspace members panel. `readonly` mirrors the OWNER
// gate (EDITOR sees a read-only list per ruling #2; the page hides the tab for
// VIEWER entirely). CP stays authoritative on every mutation.
const props = withDefaults(
    defineProps<{
        workspaceId: string;
        /**
         * BL-344 残留：**三态**。`undefined` = 能力还没解析出来（首帧）——此时加人表单
         * **照样挂载但控件禁用**，绝不"先不渲染、解析后再挂载"：那会在 `fill()` 与 `click()`
         * 之间把 input/button 节点换掉（host E2E 的 4 次采样 3 失败正是这个首帧竞态）。
         */
        readonly?: boolean;
    }>(),
    { readonly: undefined },
);

/**
 * 表单是否可交互：只有"确定可管理"才启用；`undefined`（未解析）与 `true`（确定只读）都禁用。
 * 表单本身**永远挂载**（见模板：无 `v-if`）—— 这是本修复的核心：节点不随能力解析/列表刷新被替换。
 */
const addFormInteractive = computed(() => props.readonly === false);

const { t } = useI18n();

const members = ref<ApiWorkspaceMember[]>([]),
    loading = ref(false),
    loadError = ref("");

const addUsername = ref(""),
    addRole = ref<MemberAssignableRole>("EDITOR"),
    adding = ref(false),
    addError = ref("");

/**
 * 2026-11-04 用户裁定（v23 + v29）：工作区成员邀请按 username 寻址，字符规则与注册/主体名同一条
 * （`lib/principalName.ts#usernameError`，≤32）。对**原始输入**判定、不 trim —— CP 会拒掉含空格的
 * 原名，前端静默 trim 只会把「用户以为成功」拖到 CP 的 400。
 */
const addUsernameError = computed(() => usernameError(addUsername.value));

const addUsernameMessage = computed(() => {
    switch (addUsernameError.value) {
        case "required":
            return t("validation.principalNameRequired");
        case "whitespace":
            return t("validation.principalNameWhitespace");
        case "length":
            return t("validation.usernameTooLong");
        case "pattern":
            return t("validation.principalNamePattern");
        default:
            return "";
    }
});

const roleBusyUserIds = ref<Set<string>>(new Set()),
    actionError = ref("");

const removeTarget = ref<ApiWorkspaceMember | null>(null),
    removing = ref(false),
    removeError = ref("");

const ownerCount = computed(() => members.value.filter((m) => m.role === "OWNER").length);

function roleLabel(role: ApiWorkspaceMember["role"]): string {
    return t(
        role === "OWNER"
            ? "workspace.membersRoleOwner"
            : role === "EDITOR"
              ? "workspace.membersRoleEditor"
              : "workspace.membersRoleViewer",
    );
}

function isRoleLocked(member: ApiWorkspaceMember): boolean {
    // OWNER rows cannot be demoted/promoted through the API (ruling #4 defers
    // ownership transfer); the unique owner cannot be removed at all (spec §4).
    return member.role === "OWNER";
}

function isRemovalLocked(member: ApiWorkspaceMember): boolean {
    return member.role === "OWNER" && ownerCount.value <= 1;
}

function formatJoined(member: ApiWorkspaceMember): string {
    return member.createdAt ? new Date(member.createdAt).toLocaleString() : "—";
}

function memberMessage(cause: unknown, fallbackKey: string): string {
    const code = cause instanceof ApiError ? cause.problem.code : "";
    if (code === "USER_NOT_FOUND") return t("workspace.membersUserNotFound");
    if (code === "MEMBER_ALREADY_EXISTS") return t("workspace.membersAlreadyExists");
    if (code === "LAST_OWNER") return t("workspace.membersLastOwner");
    if (code === "WORKSPACE_FORBIDDEN" || code === "WORKSPACE_READ_ONLY") {
        return t("workspace.membersForbidden");
    }
    return cause instanceof Error && cause.message ? cause.message : t(fallbackKey);
}

async function load() {
    if (!props.workspaceId) return;
    loading.value = true;
    loadError.value = "";
    try {
        members.value = await api.listWorkspaceMembers(props.workspaceId);
    } catch (cause) {
        logger.warn("Failed to load workspace members", cause);
        loadError.value = memberMessage(cause, "workspace.membersLoadFailed");
    } finally {
        loading.value = false;
    }
}

async function handleAdd() {
    if (!addUsername.value || adding.value || props.readonly) return;
    if (addUsernameError.value) {
        // 前端能判定的非法名不发请求（含前后空格/连字符/数字开头/超 32）：
        // CP 也会 400，但没必要让用户等一个来回。
        addError.value = addUsernameMessage.value;
        return;
    }
    // 不再 trim：v29 规则已排除空格，静默 trim 会把非法输入伪装成成功。
    const username = addUsername.value;
    adding.value = true;
    addError.value = "";
    try {
        await api.addWorkspaceMember(props.workspaceId, {
            username,
            role: addRole.value,
        });
        toast.success(t("workspace.membersAdded"));
        addUsername.value = "";
        addRole.value = "EDITOR";
        await load();
    } catch (cause) {
        logger.warn("Failed to add workspace member", cause);
        const message = memberMessage(cause, "workspace.membersActionFailed");
        addError.value = message;
        toast.error(message);
    } finally {
        adding.value = false;
    }
}

async function handleRoleChange(member: ApiWorkspaceMember, role: MemberAssignableRole) {
    if (props.readonly || isRoleLocked(member) || role === member.role) return;
    if (roleBusyUserIds.value.has(member.userId)) return;
    const next = new Set(roleBusyUserIds.value);
    next.add(member.userId);
    roleBusyUserIds.value = next;
    actionError.value = "";
    try {
        await api.updateWorkspaceMemberRole(props.workspaceId, member.userId, role);
        toast.success(t("workspace.membersRoleUpdated"));
        await load();
    } catch (cause) {
        logger.warn("Failed to update member role", cause);
        const message = memberMessage(cause, "workspace.membersActionFailed");
        actionError.value = message;
        toast.error(message);
    } finally {
        const settled = new Set(roleBusyUserIds.value);
        settled.delete(member.userId);
        roleBusyUserIds.value = settled;
    }
}

function askRemove(member: ApiWorkspaceMember) {
    if (props.readonly || isRemovalLocked(member)) return;
    removeError.value = "";
    removeTarget.value = member;
}

async function handleRemove() {
    const target = removeTarget.value;
    if (!target || removing.value || props.readonly) return;
    removing.value = true;
    removeError.value = "";
    try {
        await api.removeWorkspaceMember(props.workspaceId, target.userId);
        toast.success(t("workspace.membersRemoved"));
        removeTarget.value = null;
        await load();
    } catch (cause) {
        logger.warn("Failed to remove workspace member", cause);
        const message = memberMessage(cause, "workspace.membersActionFailed");
        removeError.value = message;
        toast.error(message);
    } finally {
        removing.value = false;
    }
}

onMounted(() => {
    void load();
});
</script>

<template>
    <section data-testid="ws-members-panel">
        <div class="border rounded-lg mb-3 overflow-hidden">
            <div class="px-4 py-3 text-sm font-medium bg-muted/30">
                {{ t("workspace.membersTitle") }}
            </div>

            <p v-if="props.readonly" class="px-4 pt-3 text-xs text-muted-foreground">
                {{ t("workspace.membersReadOnlyHint") }}
            </p>

            <div v-if="loadError" class="px-4 py-3 text-sm text-destructive">
                {{ t("common.error") }}: {{ loadError }}
            </div>

            <div v-else-if="loading" class="px-4 py-6 text-sm text-muted-foreground">
                <LoaderCircle class="mr-1 inline-block size-3 animate-spin" />
                {{ t("workspace.membersLoading") }}
            </div>

            <div v-else class="px-4 py-3" data-testid="ws-members-list">
                <div
                    v-for="member in members"
                    :key="member.userId"
                    class="flex flex-wrap items-center gap-3 py-2 border-b last:border-b-0"
                    data-testid="ws-members-row"
                >
                    <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2">
                            <span class="font-medium truncate">{{ member.username }}</span>
                            <span
                                class="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
                                >{{ roleLabel(member.role) }}</span
                            >
                        </div>
                        <div class="text-xs text-muted-foreground truncate">
                            {{ member.name || "—" }} · {{ member.email }} ·
                            <span>{{ formatJoined(member) }}</span>
                        </div>
                    </div>
                    <template v-if="!props.readonly">
                        <Select
                            :model-value="member.role"
                            :disabled="
                                isRoleLocked(member) || roleBusyUserIds.has(member.userId)
                            "
                            @update:model-value="
                                (value) =>
                                    handleRoleChange(
                                        member,
                                        String(value) as MemberAssignableRole,
                                    )
                            "
                        >
                            <SelectTrigger
                                class="text-xs border rounded px-2 py-1 bg-background disabled:opacity-50"
                                :data-testid="`ws-members-role-${member.userId}`"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem
                                    v-for="role in ['EDITOR', 'VIEWER']"
                                    :key="role"
                                    :value="role"
                                >
                                    {{ roleLabel(role) }}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                        <Button
                            variant="destructive"
                            size="sm"
                            :data-testid="`ws-members-remove-${member.userId}`"
                            :disabled="
                                isRemovalLocked(member) || roleBusyUserIds.has(member.userId)
                            "
                            @click="askRemove(member)"
                        >
                            {{ t("workspace.membersRemove") }}
                        </Button>
                    </template>
                </div>
            </div>

            <p v-if="actionError" class="px-4 pb-3 text-sm text-destructive">
                {{ actionError }}
            </p>
        </div>

        <!-- BL-344 残留：加人表单**常驻挂载**（无 v-if），保证列表刷新与能力解析都不替换
             input/button 节点。可见性用 `hidden` 类而不是 `v-if`：
             - `readonly === true`（确定只读）⇒ 不可见但留在 DOM（只读用户不该看到一排禁用控件）；
             - `readonly === undefined`（未知/首帧）⇒ 可见但控件 disabled（未解析 ≠ 只读）。 -->
        <div
            class="border rounded-lg p-4 space-y-3"
            :class="{ hidden: props.readonly === true }"
            data-testid="ws-members-add"
        >
            <div class="text-sm font-medium">{{ t("workspace.membersAddTitle") }}</div>
            <div class="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                <Input
                    v-model="addUsername"
                    :disabled="!addFormInteractive"
                    :placeholder="t('workspace.membersAddUsernamePlaceholder')"
                    maxlength="32"
                    data-testid="ws-members-add-input"
                    @keyup.enter="() => void handleAdd()"
                />
                <Select v-model="addRole" :disabled="!addFormInteractive">
                    <SelectTrigger
                        class="text-sm border rounded px-2 py-1 bg-background disabled:opacity-50"
                        data-testid="ws-members-add-role"
                    >
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="EDITOR">{{
                            t("workspace.membersRoleEditor")
                        }}</SelectItem>
                        <SelectItem value="VIEWER">{{
                            t("workspace.membersRoleViewer")
                        }}</SelectItem>
                    </SelectContent>
                </Select>
                <Button
                    :disabled="!addFormInteractive || adding || !addUsername || !!addUsernameError"
                    data-testid="ws-members-add-btn"
                    @click="() => void handleAdd()"
                >
                    <LoaderCircle v-if="adding" class="mr-1 inline-block size-3 animate-spin" />
                    {{ adding ? t("workspace.membersAdding") : t("workspace.membersAddSubmit") }}
                </Button>
            </div>
            <!-- 实时规则提示（v29）：非法名直接禁用提交，不必等一次 CP 400。 -->
            <p
                v-if="addUsername && addUsernameError"
                class="text-sm text-destructive"
                data-testid="ws-members-add-username-error"
            >
                {{ addUsernameMessage }}
            </p>
            <p v-if="addError" class="text-sm text-destructive">{{ addError }}</p>
        </div>

        <AlertDialog
            :open="removeTarget !== null"
            @update:open="
                (v: boolean) => {
                    if (!v) removeTarget = null;
                }
            "
        >
            <AlertDialogContent data-testid="ws-members-remove-confirm">
                <AlertDialogHeader>
                    <AlertDialogTitle class="text-destructive">
                        {{ t("workspace.membersRemoveTitle") }}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {{ t("workspace.membersRemoveConfirmDesc") }}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <p v-if="removeError" class="text-sm text-destructive">{{ removeError }}</p>
                <AlertDialogFooter>
                    <AlertDialogCancel>{{ t("common.cancel") }}</AlertDialogCancel>
                    <Button
                        variant="destructive"
                        :disabled="removing"
                        data-testid="ws-members-remove-btn"
                        @click="() => void handleRemove()"
                    >
                        <LoaderCircle
                            v-if="removing"
                            class="mr-1 inline-block size-3 animate-spin"
                        />
                        {{ t("workspace.membersRemoveConfirmBtn") }}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    </section>
</template>
