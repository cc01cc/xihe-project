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
import Input from "../../../components/ui/input/Input.vue";
import { Button } from "../../../components/ui/button";
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
        readonly?: boolean;
    }>(),
    { readonly: false },
);

const { t } = useI18n();

const members = ref<ApiWorkspaceMember[]>([]),
    loading = ref(false),
    loadError = ref("");

const addUsername = ref(""),
    addRole = ref<MemberAssignableRole>("EDITOR"),
    adding = ref(false),
    addError = ref("");

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
    const username = addUsername.value.trim();
    if (!username || adding.value || props.readonly) return;
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
                        <select
                            class="text-xs border rounded px-2 py-1 bg-background disabled:opacity-50"
                            :data-testid="`ws-members-role-${member.userId}`"
                            :value="member.role"
                            :disabled="isRoleLocked(member) || roleBusyUserIds.has(member.userId)"
                            @change="
                                handleRoleChange(
                                    member,
                                    ($event.target as HTMLSelectElement)
                                        .value as MemberAssignableRole,
                                )
                            "
                        >
                            <option v-for="role in ['EDITOR', 'VIEWER']" :key="role" :value="role">
                                {{ roleLabel(role) }}
                            </option>
                        </select>
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

        <div
            v-if="!props.readonly"
            class="border rounded-lg p-4 space-y-3"
            data-testid="ws-members-add"
        >
            <div class="text-sm font-medium">{{ t("workspace.membersAddTitle") }}</div>
            <div class="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                <Input
                    v-model="addUsername"
                    :placeholder="t('workspace.membersAddUsernamePlaceholder')"
                    maxlength="32"
                    data-testid="ws-members-add-input"
                    @keyup.enter="() => void handleAdd()"
                />
                <select
                    v-model="addRole"
                    class="text-sm border rounded px-2 py-1 bg-background"
                    data-testid="ws-members-add-role"
                >
                    <option value="EDITOR">{{ t("workspace.membersRoleEditor") }}</option>
                    <option value="VIEWER">{{ t("workspace.membersRoleViewer") }}</option>
                </select>
                <Button
                    :disabled="adding || !addUsername.trim()"
                    data-testid="ws-members-add-btn"
                    @click="() => void handleAdd()"
                >
                    <LoaderCircle v-if="adding" class="mr-1 inline-block size-3 animate-spin" />
                    {{ adding ? t("workspace.membersAdding") : t("workspace.membersAddSubmit") }}
                </Button>
            </div>
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
