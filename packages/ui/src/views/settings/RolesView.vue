<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
    api,
    type ApiPreset,
    type ApiPresetCatalog,
    type ApiPresetWrite,
    type ApiWorkspace,
} from "../../composables/api";
import { useAuthStore } from "../../stores/auth";
import { logger } from "../../lib/logger";
import { presetErrorMessage } from "../../components/settings/roleErrorMessages";
import SettingsErrorSurface from "../../components/settings/SettingsErrorSurface.vue";
import RoleEditorDialog from "../../components/settings/RoleEditorDialog.vue";
import RoleBindingsPanel from "../../components/settings/RoleBindingsPanel.vue";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { LoaderCircle, Pencil, Plus, ShieldCheck, Trash2 } from "@lucide/vue";
// task-92（缺口二）：两段绑定草稿的整页离开守卫，复用域页/组页同一套 composable 与确认框形态。
import { useDraftLeaveGuard } from "../../composables/useDraftLeaveGuard";
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from "../../components/ui/empty";

/**
 * PLAN-0610 W5b: `/settings/presets` — the grant-preset definition surface plus the binding panel.
 *
 * <p>Two rules drive the whole page:</p>
 *
 * <ol>
 *   <li><b>The atom vocabulary is never hardcoded.</b> `GET /presets/catalog` is the only source; the
 *       editor renders whatever it returns and groups it by `scopeClass`.</li>
 *   <li><b>CP decides, the UI only mirrors.</b> A system preset is not deletable and only its display
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
 * custom preset that holds the atom without the capability may open the page, while an
 * atom-less principal still gets the forbidden view instead of a page that would 403.
 */
const canManageRoles = computed(() => auth.canManageRoles);

/**
 * task-92（缺口二）：`RoleBindingsPanel` 只报「当前段脏没脏」，这里只负责把它翻成一个能给用户
 * 点名的标签推进守卫（页面层不自己推断草稿 —— 与 `SettingsDomainView` 同一分工）。
 */
const {
    draftLabels,
    promptOpen: leavePromptOpen,
    setDrafts,
    keepEditing,
    discardDrafts,
} = useDraftLeaveGuard();

function onBindingsDirty(dirty: boolean): void {
    setDrafts(dirty ? [t("settings.presetsTitle")] : []);
}

type Tab = "presets" | "bindings";

const tab = ref<Tab>("presets"),
    presets = ref<ApiPreset[]>([]),
    catalog = ref<ApiPresetCatalog | null>(null),
    workspaces = ref<ApiWorkspace[]>([]),
    loading = ref(false),
    error = ref(""),
    loadCause = ref<unknown | null>(null),
    notice = ref("");

const editorOpen = ref(false),
    editorPreset = ref<ApiPreset | null>(null),
    saving = ref(false);
const deleteTarget = ref<ApiPreset | null>(null),
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
        const [loadedCatalog, loadedPresets] = await Promise.all([
            api.presetsCatalog(),
            api.listPresets(),
        ]);
        catalog.value = loadedCatalog;
        presets.value = loadedPresets;
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
    editorPreset.value = null;
    editorOpen.value = true;
}

function openEdit(preset: ApiPreset) {
    resetFeedback();
    editorPreset.value = preset;
    editorOpen.value = true;
}

async function submitEditor(payload: ApiPresetWrite) {
    saving.value = true;
    resetFeedback();
    try {
        if (editorPreset.value) {
            await api.updatePreset(editorPreset.value.id, payload);
            notice.value = t("settings.presetsSavedUpdated");
        } else {
            await api.createPreset(payload);
            notice.value = t("settings.presetsSavedCreated");
        }
        editorOpen.value = false;
        await loadAll();
    } catch (cause) {
        error.value = presetErrorMessage(cause, t);
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
        await api.deletePreset(target.id);
        notice.value = t("settings.presetsDeleted", { name: target.displayName || target.name });
        deleteTarget.value = null;
        await loadAll();
    } catch (cause) {
        // ROLE_IN_USE / SYSTEM_ROLE_IMMUTABLE stay on the page as localized copy — never the detail.
        error.value = presetErrorMessage(cause, t);
        deleteTarget.value = null;
    } finally {
        deleting.value = false;
    }
}

function atomSummary(preset: ApiPreset): string {
    return t("settings.presetsAtomCount", { count: preset.atoms.length });
}

/**
 * task-416 P1-4（D-1314）：列表原来只有「N 个原子」，看不出这个授权预设到底给了什么。
 * 补前 3 条**服务端已解析的** displayName（缺省回退 name），余量按服务端给的数组长度算，
 * **不本地重算原子词表**；含禁用原子的预设额外标一笔，避免用户拿去绑智能体才吃 409。
 */
const PRESET_ATOM_PREVIEW = 3;

function atomPreview(preset: ApiPreset): string {
    return preset.atoms
        .slice(0, PRESET_ATOM_PREVIEW)
        .map((atom) => atom.displayName || atom.name)
        .join("、");
}

function atomRemainder(preset: ApiPreset): number {
    return Math.max(0, preset.atoms.length - PRESET_ATOM_PREVIEW);
}

function hasForbiddenAtom(preset: ApiPreset): boolean {
    return preset.atoms.some((atom) => atom.agentPrincipalForbidden);
}

onMounted(() => {
    // D-713/B7: the page is direct-linkable (/settings/presets), so it cannot rely on SettingsNav
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
                    <h2 class="text-base font-semibold">
                        {{ t("settings.presetsForbiddenTitle") }}
                    </h2>
                    <p class="mt-1 text-sm text-muted-foreground">
                        {{ t("settings.presetsForbiddenBody") }}
                    </p>
                </div>
            </template>

            <template v-else>
                <header class="mb-4">
                    <!-- task-189：页面标题降为 h2（层标题 settings-layer-title 是唯一 h1）。 -->
                    <h2 data-testid="settings-page-title" class="text-lg font-semibold">
                        {{ t("settings.presetsTitle") }}
                    </h2>
                    <p class="mt-1 text-sm text-muted-foreground">
                        {{ t("settings.presetsSubtitle") }}
                    </p>
                </header>

                <div class="mb-3 flex gap-1 border-b">
                    <button
                        type="button"
                        data-testid="roles-tab-roles"
                        class="px-3 py-2 text-sm"
                        :class="
                            tab === 'presets'
                                ? 'border-b-2 border-primary font-medium'
                                : 'text-muted-foreground'
                        "
                        @click="tab = 'presets'"
                    >
                        {{ t("settings.presetsTabPresets") }}
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
                        {{ t("settings.presetsTabBindings") }}
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
                    v-if="tab === 'presets' && !loadCause"
                    data-testid="roles-list-section"
                    class="space-y-3"
                >
                    <div class="flex items-center justify-between">
                        <p class="text-xs text-muted-foreground">
                            {{ t("settings.presetsListHint") }}
                        </p>
                        <Button
                            data-testid="roles-create"
                            :disabled="!catalog"
                            :title="
                                !catalog ? t('settings.presetsCreateDisabledNoCatalog') : undefined
                            "
                            @click="openCreate"
                        >
                            <Plus class="size-4" aria-hidden="true" />
                            {{ t("settings.presetsCreate") }}
                        </Button>
                    </div>

                    <div v-if="loading" class="text-xs text-muted-foreground">
                        {{ t("settings.presetsLoading") }}
                    </div>

                    <!-- task-169 / F-19：表格原先在 0 行时只剩表头 + 一片空白。空态给文案 + 出口。 -->
                    <Empty v-else-if="presets.length === 0" data-testid="roles-empty" class="mt-1">
                        <EmptyHeader>
                            <EmptyMedia variant="icon">
                                <ShieldCheck class="size-4" aria-hidden="true" />
                            </EmptyMedia>
                            <EmptyTitle>{{ t("settings.presetsEmptyTitle") }}</EmptyTitle>
                            <EmptyDescription>
                                {{ t("settings.presetsEmptyBody") }}
                            </EmptyDescription>
                        </EmptyHeader>
                        <EmptyContent>
                            <Button
                                data-testid="roles-empty-create"
                                :disabled="!catalog"
                                :title="
                                    !catalog
                                        ? t('settings.presetsCreateDisabledNoCatalog')
                                        : undefined
                                "
                                @click="openCreate"
                            >
                                <Plus class="size-4" aria-hidden="true" />
                                {{ t("settings.presetsCreate") }}
                            </Button>
                        </EmptyContent>
                    </Empty>

                    <table v-else class="w-full text-left text-sm" data-testid="roles-table">
                        <thead class="text-xs text-muted-foreground">
                            <tr>
                                <th class="py-1">{{ t("settings.presetsColumnName") }}</th>
                                <th class="py-1">{{ t("settings.presetsColumnAtoms") }}</th>
                                <th class="py-1">{{ t("settings.presetsColumnBindings") }}</th>
                                <th class="py-1 text-right">
                                    {{ t("settings.presetsColumnActions") }}
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="preset in presets"
                                :key="preset.id"
                                :data-testid="`role-row-${preset.name}`"
                                class="border-t"
                            >
                                <td class="py-1">
                                    <span class="font-medium">{{
                                        preset.displayName || preset.name
                                    }}</span>
                                    <span class="ml-2 font-mono text-xs text-muted-foreground">
                                        {{ preset.name }}
                                    </span>
                                    <Badge
                                        v-if="preset.system"
                                        variant="secondary"
                                        data-testid="role-system-badge"
                                        class="ml-2"
                                    >
                                        {{ t("settings.presetsSystemBadge") }}
                                    </Badge>
                                </td>
                                <td class="py-1 text-xs">
                                    <span data-testid="role-atom-summary">{{
                                        atomPreview(preset)
                                    }}</span>
                                    <span
                                        v-if="atomRemainder(preset) > 0"
                                        class="ml-1 text-muted-foreground"
                                        data-testid="role-atom-more"
                                    >
                                        {{
                                            t("settings.presetsAtomMore", {
                                                count: atomRemainder(preset),
                                            })
                                        }}
                                    </span>
                                    <span
                                        v-if="hasForbiddenAtom(preset)"
                                        class="ml-1 text-muted-foreground"
                                        data-testid="role-atom-forbidden"
                                        :title="t('settings.presetsAtomForbiddenHint')"
                                    >
                                        {{ t("settings.presetsAtomForbidden") }}
                                    </span>
                                    <span class="ml-1 text-muted-foreground">{{
                                        atomSummary(preset)
                                    }}</span>
                                </td>
                                <td class="py-1 text-xs" data-testid="role-binding-count">
                                    {{ preset.bindingCount }}
                                </td>
                                <td class="space-x-1 py-1 text-right">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        :data-testid="`role-edit-${preset.name}`"
                                        @click="openEdit(preset)"
                                    >
                                        <Pencil class="size-3.5" aria-hidden="true" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        :disabled="preset.system"
                                        :title="
                                            preset.system
                                                ? t('settings.presetsSystemNotDeletable')
                                                : t('settings.presetsDelete')
                                        "
                                        :data-testid="`role-delete-${preset.name}`"
                                        @click="deleteTarget = preset"
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
                    :presets="presets"
                    :workspaces="workspaces"
                    @notice="notice = $event"
                    @dirty="onBindingsDirty"
                />

                <RoleEditorDialog
                    :open="editorOpen"
                    :preset="editorPreset"
                    :catalog="catalog"
                    :saving="saving"
                    :current-workspace-id="auth.currentWorkspaceId"
                    @close="editorOpen = false"
                    @submit="submitEditor"
                />

                <AlertDialog
                    :open="deleteTarget !== null"
                    @update:open="(value: boolean) => !value && (deleteTarget = null)"
                >
                    <AlertDialogContent data-testid="role-delete-dialog" aria-modal="true">
                        <AlertDialogHeader>
                            <AlertDialogTitle>{{
                                t("settings.presetsDeleteTitle")
                            }}</AlertDialogTitle>
                            <AlertDialogDescription>
                                {{
                                    t("settings.presetsDeleteBody", {
                                        name: deleteTarget?.displayName || deleteTarget?.name || "",
                                    })
                                }}
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <Button variant="ghost" @click="deleteTarget = null">
                                {{ t("settings.presetsCancel") }}
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
                                {{ t("settings.presetsDelete") }}
                            </Button>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>

                <!--
                    task-92：整页草稿的离开确认。与 `RoleEditorDialog`（模态内草稿，D 类）不是一回事：
                    那条守的是「关弹窗」，这条守的是「换页」。testid 与域页/组页同一套（同一个动作）。
                -->
                <AlertDialog
                    :open="leavePromptOpen"
                    @update:open="(value: boolean) => !value && keepEditing()"
                >
                    <AlertDialogContent data-testid="settings-leave-confirm">
                        <AlertDialogHeader>
                            <AlertDialogTitle>{{
                                t("settings.ia.leaveDraftTitle")
                            }}</AlertDialogTitle>
                            <AlertDialogDescription>
                                {{
                                    t("settings.ia.leaveDraftDesc", {
                                        domains: draftLabels.join(" / "),
                                    })
                                }}
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel
                                data-testid="settings-leave-keep"
                                @click="keepEditing"
                            >
                                {{ t("settings.ia.leaveDraftKeep") }}
                            </AlertDialogCancel>
                            <Button
                                type="button"
                                variant="destructive"
                                data-testid="settings-leave-discard"
                                @click="discardDrafts"
                            >
                                {{ t("settings.ia.leaveDraftDiscard") }}
                            </Button>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </template>
        </div>
    </div>
</template>
