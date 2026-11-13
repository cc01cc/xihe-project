<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
    api,
    type ApiRole,
    type ApiRoleCatalog,
    type ApiRoleWrite,
    type ApiWorkspace,
} from "../../composables/api";
import { useAuthStore } from "../../stores/auth";
import { logger } from "../../lib/logger";
import { roleErrorMessage } from "../../components/settings/roleErrorMessages";
import SettingsErrorSurface from "../../components/settings/SettingsErrorSurface.vue";
import RoleEditorDialog from "../../components/settings/RoleEditorDialog.vue";
import RoleBindingsPanel from "../../components/settings/RoleBindingsPanel.vue";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { LoaderCircle, Pencil, Plus, ShieldCheck, Trash2 } from "@lucide/vue";
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from "../../components/ui/empty";

/**
 * PLAN-0610 W5b: `/settings/roles` — the access-role definition surface plus the binding panel.
 *
 * <p>Two rules drive the whole page:</p>
 *
 * <ol>
 *   <li><b>The atom vocabulary is never hardcoded.</b> `GET /roles/catalog` is the only source; the
 *       editor renders whatever it returns and groups it by `scopeClass`.</li>
 *   <li><b>CP decides, the UI only mirrors.</b> A system role is not deletable and only its display
 *       name is editable; the page hides those affordances *and* localizes the refusal code if the
 *       server still says no (`SYSTEM_ROLE_IMMUTABLE` / `ROLE_IN_USE`).</li>
 * </ol>
 */
const { t } = useI18n();
const auth = useAuthStore();
/**
 * BL-393: CP gates this face on the `MANAGE_ROLES` action atom
 * (`RoleController:52-53`, `BindingController:35-36`), not on the `instance:admin` capability.
 * The guard therefore reads the same atom the settings nav uses (`auth.canManageRoles`) — a
 * custom role that holds the atom without the capability may open the page, while an
 * atom-less principal still gets the forbidden view instead of a page that would 403.
 */
const canManageRoles = computed(() => auth.canManageRoles);

type Tab = "roles" | "bindings";

const tab = ref<Tab>("roles"),
    roles = ref<ApiRole[]>([]),
    catalog = ref<ApiRoleCatalog | null>(null),
    workspaces = ref<ApiWorkspace[]>([]),
    loading = ref(false),
    error = ref(""),
    loadCause = ref<unknown | null>(null),
    notice = ref("");

const editorOpen = ref(false),
    editorRole = ref<ApiRole | null>(null),
    saving = ref(false);
const deleteTarget = ref<ApiRole | null>(null),
    deleting = ref(false);

function resetFeedback() {
    error.value = "";
    notice.value = "";
}

async function loadAll() {
    loading.value = true;
    loadCause.value = null;
    resetFeedback();
    try {
        const [loadedCatalog, loadedRoles] = await Promise.all([
            api.rolesCatalog(),
            api.listRoles(),
        ]);
        catalog.value = loadedCatalog;
        roles.value = loadedRoles;
    } catch (cause) {
        // task-168（F-18）：加载错误走统一错误面（缺口态给解释弹窗），不直渲 detail。
        loadCause.value = cause;
    } finally {
        loading.value = false;
    }
}

async function loadWorkspaces() {
    try {
        workspaces.value = await api.listWorkspaces();
    } catch (cause) {
        // The instance scope works without a workspace list; a failed read must not block the page.
        logger.warn("Failed to load workspaces for the bindings panel", cause);
        workspaces.value = [];
    }
}

function openCreate() {
    // task-189：目录未加载时打开编辑器只会得到一个无法完成的表单 —— 直接拦在入口。
    if (!catalog.value) return;
    resetFeedback();
    editorRole.value = null;
    editorOpen.value = true;
}

function openEdit(role: ApiRole) {
    resetFeedback();
    editorRole.value = role;
    editorOpen.value = true;
}

async function submitEditor(payload: ApiRoleWrite) {
    saving.value = true;
    resetFeedback();
    try {
        if (editorRole.value) {
            await api.updateRole(editorRole.value.id, payload);
            notice.value = t("settings.rolesSavedUpdated");
        } else {
            await api.createRole(payload);
            notice.value = t("settings.rolesSavedCreated");
        }
        editorOpen.value = false;
        await loadAll();
    } catch (cause) {
        error.value = roleErrorMessage(cause, t);
    } finally {
        saving.value = false;
    }
}

async function confirmDelete() {
    const target = deleteTarget.value;
    if (!target || deleting.value) return;
    deleting.value = true;
    resetFeedback();
    try {
        await api.deleteRole(target.id);
        notice.value = t("settings.rolesDeleted", { name: target.displayName || target.name });
        deleteTarget.value = null;
        await loadAll();
    } catch (cause) {
        // ROLE_IN_USE / SYSTEM_ROLE_IMMUTABLE stay on the page as localized copy — never the detail.
        error.value = roleErrorMessage(cause, t);
        deleteTarget.value = null;
    } finally {
        deleting.value = false;
    }
}

function atomSummary(role: ApiRole): string {
    return t("settings.rolesAtomCount", { count: role.atoms.length });
}

/**
 * task-416 P1-4（D-1314）：列表原来只有「N 个原子」，看不出这角色到底给了什么。
 * 补前 3 条**服务端已解析的** displayName（缺省回退 name），余量按服务端给的数组长度算，
 * **不本地重算原子词表**；含禁用原子的角色额外标一笔，避免用户拿去绑智能体才吃 409。
 */
const ROLE_ATOM_PREVIEW = 3;

function atomPreview(role: ApiRole): string {
    return role.atoms
        .slice(0, ROLE_ATOM_PREVIEW)
        .map((atom) => atom.displayName || atom.name)
        .join("、");
}

function atomRemainder(role: ApiRole): number {
    return Math.max(0, role.atoms.length - ROLE_ATOM_PREVIEW);
}

function hasForbiddenAtom(role: ApiRole): boolean {
    return role.atoms.some((atom) => atom.agentPrincipalForbidden);
}

onMounted(() => {
    // D-713/B7: the page is direct-linkable (/settings/roles), so it cannot rely on SettingsNav
    // having loaded the projection first. ensureSelfPermissions is idempotent (cached promise),
    // hence calling it here is cheap when the nav already did; the watch below loads the page
    // once the atom turns allowed (initial frame may be "unknown" = false).
    void auth.ensureSelfPermissions();
});

watch(
    canManageRoles,
    (allowed) => {
        if (!allowed) return;
        void loadAll();
        void loadWorkspaces();
    },
    { immediate: true },
);
</script>

<template>
    <div class="mx-auto w-full max-w-6xl px-6 py-6">
        <div data-testid="roles-view">
            <template v-if="!canManageRoles">
                <div
                    data-testid="roles-forbidden"
                    class="mx-auto mt-16 max-w-md rounded-xl border bg-card p-6 text-center"
                >
                    <h2 class="text-base font-semibold">{{ t("settings.rolesForbiddenTitle") }}</h2>
                    <p class="mt-1 text-sm text-muted-foreground">
                        {{ t("settings.rolesForbiddenBody") }}
                    </p>
                </div>
            </template>

            <template v-else>
                <header class="mb-4">
                    <!-- task-189：页面标题降为 h2（层标题 settings-layer-title 是唯一 h1）。 -->
                    <h2 data-testid="settings-page-title" class="text-lg font-semibold">
                        {{ t("settings.rolesTitle") }}
                    </h2>
                    <p class="mt-1 text-sm text-muted-foreground">
                        {{ t("settings.rolesSubtitle") }}
                    </p>
                </header>

                <div class="mb-3 flex gap-1 border-b">
                    <button
                        type="button"
                        data-testid="roles-tab-roles"
                        class="px-3 py-2 text-sm"
                        :class="
                            tab === 'roles'
                                ? 'border-b-2 border-primary font-medium'
                                : 'text-muted-foreground'
                        "
                        @click="tab = 'roles'"
                    >
                        {{ t("settings.rolesTabRoles") }}
                    </button>
                    <button
                        type="button"
                        data-testid="roles-tab-bindings"
                        class="px-3 py-2 text-sm"
                        :class="
                            tab === 'bindings'
                                ? 'border-b-2 border-primary font-medium'
                                : 'text-muted-foreground'
                        "
                        @click="tab = 'bindings'"
                    >
                        {{ t("settings.rolesTabBindings") }}
                    </button>
                </div>

                <SettingsErrorSurface
                    :cause="loadCause"
                    :retry="loadAll"
                    retry-key="settings.errorSurface.refresh"
                />
                <p
                    v-if="error"
                    data-testid="roles-error"
                    class="mb-3 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-700"
                >
                    {{ error }}
                </p>
                <p
                    v-if="notice"
                    data-testid="roles-notice"
                    class="mb-3 rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700"
                >
                    {{ notice }}
                </p>

                <!-- task-189：gap/error 与 empty 互斥 —— 加载失败时只留错误面，不渲染空态与新建入口。 -->
                <section
                    v-if="tab === 'roles' && !loadCause"
                    data-testid="roles-list-section"
                    class="space-y-3"
                >
                    <div class="flex items-center justify-between">
                        <p class="text-xs text-muted-foreground">
                            {{ t("settings.rolesListHint") }}
                        </p>
                        <Button
                            data-testid="roles-create"
                            :disabled="!catalog"
                            :title="
                                !catalog ? t('settings.rolesCreateDisabledNoCatalog') : undefined
                            "
                            @click="openCreate"
                        >
                            <Plus class="size-4" aria-hidden="true" />
                            {{ t("settings.rolesCreate") }}
                        </Button>
                    </div>

                    <div v-if="loading" class="text-xs text-muted-foreground">
                        {{ t("settings.rolesLoading") }}
                    </div>

                    <!-- task-169 / F-19：表格原先在 0 行时只剩表头 + 一片空白。空态给文案 + 出口。 -->
                    <Empty v-else-if="roles.length === 0" data-testid="roles-empty" class="mt-1">
                        <EmptyHeader>
                            <EmptyMedia variant="icon">
                                <ShieldCheck class="size-4" aria-hidden="true" />
                            </EmptyMedia>
                            <EmptyTitle>{{ t("settings.rolesEmptyTitle") }}</EmptyTitle>
                            <EmptyDescription>
                                {{ t("settings.rolesEmptyBody") }}
                            </EmptyDescription>
                        </EmptyHeader>
                        <EmptyContent>
                            <Button
                                data-testid="roles-empty-create"
                                :disabled="!catalog"
                                :title="
                                    !catalog
                                        ? t('settings.rolesCreateDisabledNoCatalog')
                                        : undefined
                                "
                                @click="openCreate"
                            >
                                <Plus class="size-4" aria-hidden="true" />
                                {{ t("settings.rolesCreate") }}
                            </Button>
                        </EmptyContent>
                    </Empty>

                    <table v-else class="w-full text-left text-sm" data-testid="roles-table">
                        <thead class="text-xs text-muted-foreground">
                            <tr>
                                <th class="py-1">{{ t("settings.rolesColumnName") }}</th>
                                <th class="py-1">{{ t("settings.rolesColumnAtoms") }}</th>
                                <th class="py-1">{{ t("settings.rolesColumnBindings") }}</th>
                                <th class="py-1 text-right">
                                    {{ t("settings.rolesColumnActions") }}
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="role in roles"
                                :key="role.id"
                                :data-testid="`role-row-${role.name}`"
                                class="border-t"
                            >
                                <td class="py-1">
                                    <span class="font-medium">{{
                                        role.displayName || role.name
                                    }}</span>
                                    <span class="ml-2 font-mono text-xs text-muted-foreground">
                                        {{ role.name }}
                                    </span>
                                    <Badge
                                        v-if="role.system"
                                        variant="secondary"
                                        data-testid="role-system-badge"
                                        class="ml-2"
                                    >
                                        {{ t("settings.rolesSystemBadge") }}
                                    </Badge>
                                </td>
                                <td class="py-1 text-xs">
                                    <span data-testid="role-atom-summary">{{
                                        atomPreview(role)
                                    }}</span>
                                    <span
                                        v-if="atomRemainder(role) > 0"
                                        class="ml-1 text-muted-foreground"
                                        data-testid="role-atom-more"
                                    >
                                        {{
                                            t("settings.rolesAtomMore", {
                                                count: atomRemainder(role),
                                            })
                                        }}
                                    </span>
                                    <span
                                        v-if="hasForbiddenAtom(role)"
                                        class="ml-1 text-muted-foreground"
                                        data-testid="role-atom-forbidden"
                                        :title="t('settings.rolesAtomForbiddenHint')"
                                    >
                                        {{ t("settings.rolesAtomForbidden") }}
                                    </span>
                                    <span class="ml-1 text-muted-foreground">{{
                                        atomSummary(role)
                                    }}</span>
                                </td>
                                <td class="py-1 text-xs" data-testid="role-binding-count">
                                    {{ role.bindingCount }}
                                </td>
                                <td class="space-x-1 py-1 text-right">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        :data-testid="`role-edit-${role.name}`"
                                        @click="openEdit(role)"
                                    >
                                        <Pencil class="size-3.5" aria-hidden="true" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        :disabled="role.system"
                                        :title="
                                            role.system
                                                ? t('settings.rolesSystemNotDeletable')
                                                : t('settings.rolesDelete')
                                        "
                                        :data-testid="`role-delete-${role.name}`"
                                        @click="deleteTarget = role"
                                    >
                                        <Trash2 class="size-3.5" aria-hidden="true" />
                                    </Button>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </section>

                <RoleBindingsPanel
                    v-else-if="!loadCause"
                    :roles="roles"
                    :workspaces="workspaces"
                    @notice="notice = $event"
                />

                <RoleEditorDialog
                    :open="editorOpen"
                    :role="editorRole"
                    :catalog="catalog"
                    :saving="saving"
                    @close="editorOpen = false"
                    @submit="submitEditor"
                />

                <AlertDialog
                    :open="deleteTarget !== null"
                    @update:open="(value: boolean) => !value && (deleteTarget = null)"
                >
                    <AlertDialogContent data-testid="role-delete-dialog">
                        <AlertDialogHeader>
                            <AlertDialogTitle>{{
                                t("settings.rolesDeleteTitle")
                            }}</AlertDialogTitle>
                            <AlertDialogDescription>
                                {{
                                    t("settings.rolesDeleteBody", {
                                        name: deleteTarget?.displayName || deleteTarget?.name || "",
                                    })
                                }}
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <Button variant="ghost" @click="deleteTarget = null">
                                {{ t("settings.rolesCancel") }}
                            </Button>
                            <Button
                                variant="destructive"
                                data-testid="role-delete-confirm"
                                :disabled="deleting"
                                @click="confirmDelete"
                            >
                                <LoaderCircle
                                    v-if="deleting"
                                    class="animate-spin"
                                    aria-hidden="true"
                                />
                                {{ t("settings.rolesDelete") }}
                            </Button>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </template>
        </div>
    </div>
</template>
