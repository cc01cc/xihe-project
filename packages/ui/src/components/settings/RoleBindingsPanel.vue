<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
    api,
    type ApiAdminUser,
    type ApiBindingInput,
    type ApiBindingScope,
    type ApiBindingSet,
    type ApiRole,
    type ApiWorkspace,
} from "../../composables/api";
import { logger } from "../../lib/logger";
import { roleErrorMessage } from "./roleErrorMessages";
import AgentRoleBindingsSection from "./AgentRoleBindingsSection.vue";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Badge } from "../ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SearchableCombobox, type SearchableComboboxOption } from "../ui/combobox";
import { LoaderCircle, X } from "@lucide/vue";

/**
 * PLAN-0610 W5b: `GET/PUT /api/v1/bindings?scope=&scopeId=`.
 *
 * <p>The PUT is a **full replacement of one scope's user bindings**, so the panel always sends the
 * complete desired set (every row it shows) — never a delta. That is the contract's idempotency
 * promise: replaying the same body is a no-op (no epoch bump, no audit row).</p>
 *
 * <p>The response is the resolved binding set; it does **not** carry an effective-capability echo,
 * so the summary under the table is derived locally from the bound roles' catalog atoms and is
 * labelled as such. When CP starts returning the projection (W3-3+/W5d) this derivation is the only
 * thing that has to change.</p>
 */
const props = defineProps<{
    roles: ApiRole[];
    workspaces: ApiWorkspace[];
    /** Role atoms are needed for the local "scope compatibility" hint. */
}>();
const emit = defineEmits<{ notice: [message: string]; dirty: [boolean] }>();

const { t } = useI18n();

const scope = ref<ApiBindingScope>("instance"),
    scopeId = ref<string>("");
const subjectType = ref<"user" | "agent_principal">("user");
const bindingSet = ref<ApiBindingSet | null>(null),
    loading = ref(false),
    saving = ref(false),
    error = ref("");

/** Pending rows: the panel's editable copy of the scope's complete binding set. */
const rows = ref<ApiBindingInput[]>([]);

/**
 * task-92（缺口二）：草稿基准**派生自服务端回来的 `bindingSet`**（不维护布尔，「脏」永远等于
 * 「期望集合 ≠ 已存集合」）；`save()` 成功后 `syncRows()` 把两者重新对齐 ⇒ 自动复位，不需要手动清标志。
 *
 * <p>两段草稿的口径：只算**当前 subjectType** 那一段 —— 另一段此刻不可见也改不了，算进来会让用户
 * 在看不到它的界面上被拦下。切段后 `agentDirty` 由 `AgentRoleBindingsSection` 重挂时的广播复位。</p>
 */
function rowKey(row: ApiBindingInput): string {
    return `${row.subjectType ?? "user"}|${row.subjectId}|${row.roleId}`;
}
const bindingKey = computed(() => (bindingSet.value?.bindings ?? []).map(rowKey).sort().join("\n"));
const userDirty = computed(() => rows.value.map(rowKey).sort().join("\n") !== bindingKey.value);
const agentDirty = ref(false);
const panelDirty = computed(() =>
    subjectType.value === "user" ? userDirty.value : agentDirty.value,
);
watch(panelDirty, (dirty) => emit("dirty", dirty), { immediate: true });
onBeforeUnmount(() => emit("dirty", false));

const subjectQuery = ref(""),
    subjectResults = ref<ApiAdminUser[]>([]),
    subjectSearching = ref(false);
const selectedSubject = ref<ApiAdminUser | null>(null),
    selectedRoleId = ref("");

/**
 * task-152：搜索结果一次最多回 11 个账号，Select 弹层宽度跟着 `min-w-56` 的触发器走，
 * 长邮箱在弹层里被裁；改可搜索面板后搜索框本身就是过滤面（服务端搜索仍是外层输入框）。
 */
const subjectOptions = computed<SearchableComboboxOption[]>(() =>
    subjectResults.value.map((user) => ({
        value: user.id,
        label: user.username || user.email,
    })),
);

const workspaceId = computed(() => (scope.value === "workspace" ? scopeId.value : ""));

/**
 * Roles that can never be bound in the selected scope: a workspace binding cannot hold an
 * instance-only atom (CP answers `400 ROLE_SCOPE_MISMATCH`). The catalog is the SSOT, so this is a
 * hint derived from the role's atoms, not a second vocabulary.
 */
function roleFitsScope(role: ApiRole): boolean {
    if (scope.value === "instance") return true;
    return role.atoms.every((atom) => atom.scopeClass === "both");
}

/** `subjectId → bound roles (id + label)`, preserving the server's order. */
const grouped = computed(() => {
    const bySubject = new Map<
        string,
        { subjectId: string; roles: { id: string; label: string }[] }
    >();
    for (const row of rows.value) {
        const role = props.roles.find((candidate) => candidate.id === row.roleId);
        const entry = bySubject.get(row.subjectId) ?? { subjectId: row.subjectId, roles: [] };
        entry.roles.push({ id: row.roleId, label: role?.displayName || role?.name || row.roleId });
        bySubject.set(row.subjectId, entry);
    }
    return [...bySubject.values()];
});

/** Local derivation of the effective atoms per subject (see the file header). */
const effectiveSummary = computed(() =>
    grouped.value.map((entry) => {
        const atoms = new Set<string>();
        for (const bound of entry.roles) {
            const role = props.roles.find((candidate) => candidate.id === bound.id);
            role?.atoms.forEach((atom) => atoms.add(atom.name));
        }
        return { subjectId: entry.subjectId, atoms: [...atoms].sort() };
    }),
);

function subjectLabel(subjectId: string): string {
    const known = subjectResults.value.find((user) => user.id === subjectId);
    return known ? known.username || known.email : subjectId;
}
function workspaceLabel(id: string): string {
    return props.workspaces.find((workspace) => workspace.id === id)?.name ?? id;
}
function roleLabel(id: string): string {
    const role = props.roles.find((candidate) => candidate.id === id);
    return role ? role.displayName || role.name : id;
}

function syncRows(next: ApiBindingSet) {
    bindingSet.value = next;
    rows.value = next.bindings.map((row) => ({
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        roleId: row.roleId,
    }));
}

async function load() {
    if (subjectType.value !== "user") {
        // The agent section owns its own read path (and its own error surface).
        return;
    }
    if (scope.value === "workspace" && !workspaceId.value) {
        bindingSet.value = null;
        rows.value = [];
        return;
    }
    loading.value = true;
    error.value = "";
    try {
        syncRows(await api.getBindings(scope.value, workspaceId.value || null));
    } catch (cause) {
        bindingSet.value = null;
        rows.value = [];
        error.value = roleErrorMessage(cause, t);
    } finally {
        loading.value = false;
    }
}

async function searchSubjects() {
    subjectSearching.value = true;
    error.value = "";
    try {
        subjectResults.value = await api.listAdminUsers(subjectQuery.value);
    } catch (cause) {
        // The list is a convenience; a UUID can still be pasted by hand.
        logger.warn("Failed to search users for bindings", cause);
        subjectResults.value = [];
        error.value = roleErrorMessage(cause, t);
    } finally {
        subjectSearching.value = false;
    }
}

function addRow() {
    error.value = "";
    const subjectId = selectedSubject.value?.id;
    if (!subjectId) {
        error.value = t("settings.rolesBindingsSubjectRequired");
        return;
    }
    if (!selectedRoleId.value) {
        error.value = t("settings.rolesBindingsRoleRequired");
        return;
    }
    if (
        rows.value.some((row) => row.subjectId === subjectId && row.roleId === selectedRoleId.value)
    ) {
        error.value = t("settings.rolesBindingsDuplicate");
        return;
    }
    rows.value = [...rows.value, { subjectType: "user", subjectId, roleId: selectedRoleId.value }];
    selectedRoleId.value = "";
}

function removeRow(subjectId: string, roleId: string) {
    rows.value = rows.value.filter(
        (row) => !(row.subjectId === subjectId && row.roleId === roleId),
    );
}

async function save() {
    if (saving.value) return;
    saving.value = true;
    error.value = "";
    try {
        const next = await api.replaceBindings(
            scope.value,
            workspaceId.value || null,
            rows.value.map((row) => ({
                subjectType: row.subjectType ?? "user",
                subjectId: row.subjectId,
                roleId: row.roleId,
            })),
        );
        syncRows(next);
        emit("notice", t("settings.rolesBindingsSaved", { count: next.bindings.length }));
    } catch (cause) {
        error.value = roleErrorMessage(cause, t);
    } finally {
        saving.value = false;
    }
}

watch([scope, scopeId, subjectType], () => {
    void load();
});

// The panel is mounted when its tab is opened, so the first read has to happen here as well (the
// scope watch above only fires on change).
onMounted(() => {
    void load();
});

// The parent loads roles/workspaces asynchronously; the first usable scope can only be read once a
// workspace id exists, so keep the current selection honest rather than issuing an invalid request.
watch(
    () => props.workspaces,
    (list) => {
        if (!scopeId.value && list.length > 0) {
            scopeId.value = list[0]?.id ?? "";
        }
    },
    { immediate: true },
);

defineExpose({ load });
</script>

<template>
    <section data-testid="role-bindings-panel" class="space-y-3">
        <div class="flex flex-wrap items-end gap-3">
            <label class="flex flex-col gap-1 text-xs text-muted-foreground">
                {{ t("settings.rolesBindingsScope") }}
                <Select
                    :model-value="scope"
                    @update:model-value="(value) => (scope = String(value) as ApiBindingScope)"
                >
                    <SelectTrigger
                        data-testid="role-bindings-scope"
                        class="rounded border bg-background px-2 py-1 text-sm text-foreground"
                    >
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="instance">{{
                            t("settings.rolesBindingsScopeInstance")
                        }}</SelectItem>
                        <SelectItem value="workspace">{{
                            t("settings.rolesBindingsScopeWorkspace")
                        }}</SelectItem>
                    </SelectContent>
                </Select>
            </label>
            <label
                v-if="scope === 'workspace'"
                class="flex flex-col gap-1 text-xs text-muted-foreground"
            >
                {{ t("settings.rolesBindingsWorkspace") }}
                <Select
                    :model-value="scopeId"
                    @update:model-value="(value) => (scopeId = String(value))"
                >
                    <SelectTrigger
                        data-testid="role-bindings-workspace"
                        class="min-w-56 rounded border bg-background px-2 py-1 text-sm text-foreground"
                    >
                        <SelectValue>{{ workspaceLabel(scopeId) }}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem
                            v-for="workspace in workspaces"
                            :key="workspace.id"
                            :value="workspace.id"
                        >
                            {{ workspace.name }}
                        </SelectItem>
                    </SelectContent>
                </Select>
            </label>
            <Button
                variant="outline"
                data-testid="role-bindings-reload"
                :disabled="loading"
                @click="load"
            >
                <LoaderCircle v-if="loading" class="animate-spin" aria-hidden="true" />
                {{ t("settings.rolesBindingsReload") }}
            </Button>
            <label class="flex flex-col gap-1 text-xs text-muted-foreground">
                {{ t("settings.rolesBindingsSubjectType") }}
                <Select
                    :model-value="subjectType"
                    @update:model-value="
                        (value) => (subjectType = String(value) as 'user' | 'agent_principal')
                    "
                >
                    <SelectTrigger
                        data-testid="role-bindings-subject-type"
                        class="rounded border bg-background px-2 py-1 text-sm text-foreground"
                    >
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="user">{{
                            t("settings.rolesBindingsSubjectTypeUser")
                        }}</SelectItem>
                        <SelectItem value="agent_principal">{{
                            t("settings.rolesBindingsSubjectTypeAgent")
                        }}</SelectItem>
                    </SelectContent>
                </Select>
            </label>
        </div>

        <p
            v-if="error"
            data-testid="role-bindings-error"
            class="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-700"
        >
            {{ error }}
        </p>

        <table
            v-if="subjectType === 'user'"
            class="w-full text-left text-sm"
            data-testid="role-bindings-table"
        >
            <thead class="text-xs text-muted-foreground">
                <tr>
                    <th class="py-1">{{ t("settings.rolesBindingsSubject") }}</th>
                    <th class="py-1">{{ t("settings.rolesBindingsRoles") }}</th>
                    <th class="py-1 text-right">{{ t("settings.rolesBindingsRemove") }}</th>
                </tr>
            </thead>
            <tbody>
                <tr
                    v-for="entry in grouped"
                    :key="entry.subjectId"
                    :data-testid="`role-binding-row-${entry.subjectId}`"
                    class="border-t"
                >
                    <td class="py-1">
                        <span class="font-mono text-xs">{{ subjectLabel(entry.subjectId) }}</span>
                        <span class="ml-2 text-xs text-muted-foreground">{{
                            entry.subjectId
                        }}</span>
                    </td>
                    <td class="py-1">
                        <Badge v-for="bound in entry.roles" :key="bound.id" variant="outline">
                            {{ bound.label }}
                        </Badge>
                    </td>
                    <td class="py-1 text-right">
                        <Button
                            v-for="bound in entry.roles"
                            :key="bound.id"
                            variant="ghost"
                            size="icon"
                            :data-testid="`role-binding-remove-${entry.subjectId}-${bound.id}`"
                            @click="removeRow(entry.subjectId, bound.id)"
                        >
                            <X class="size-3.5" aria-hidden="true" />
                        </Button>
                    </td>
                </tr>
                <tr v-if="grouped.length === 0">
                    <td colspan="3" class="py-2 text-xs text-muted-foreground">
                        {{ t("settings.rolesBindingsEmpty") }}
                    </td>
                </tr>
            </tbody>
        </table>

        <div
            v-if="subjectType === 'user'"
            class="flex flex-wrap items-end gap-2 rounded border p-3"
        >
            <label class="flex flex-col gap-1 text-xs text-muted-foreground">
                {{ t("settings.rolesBindingsSubjectSearch") }}
                <Input
                    v-model="subjectQuery"
                    data-testid="role-bindings-subject-query"
                    class="w-56"
                    :placeholder="t('settings.rolesBindingsSubjectSearchPlaceholder')"
                    @keyup.enter="searchSubjects"
                />
            </label>
            <Button
                variant="outline"
                data-testid="role-bindings-subject-search"
                @click="searchSubjects"
            >
                {{ t("settings.rolesBindingsSearch") }}
            </Button>
            <label class="flex flex-col gap-1 text-xs text-muted-foreground">
                {{ t("settings.rolesBindingsSubject") }}
                <!-- task-152 已登记例外：面板宽度覆写。实测 50 个账号、最长文本 229px（approvalpolicyreal…），
                     面板 224px 时裁 15 项 ⇒ 提到 320px 后裁 0。第三次出现同类覆写应停手报 lead，改为升成组件 tier prop。 -->
                <SearchableCombobox
                    :model-value="selectedSubject?.id ?? ''"
                    :options="subjectOptions"
                    :placeholder="t('settings.rolesBindingsSubjectPick')"
                    testid="role-bindings-subject"
                    trigger-class="min-w-56 h-auto rounded border bg-background px-2 py-1 text-foreground"
                    panel-class="min-w-[20rem]"
                    @update:model-value="
                        (value) =>
                            (selectedSubject =
                                subjectResults.find((user) => user.id === String(value)) ?? null)
                    "
                />
            </label>
            <label class="flex flex-col gap-1 text-xs text-muted-foreground">
                {{ t("settings.rolesBindingsRole") }}
                <Select
                    :model-value="selectedRoleId"
                    @update:model-value="(value) => (selectedRoleId = String(value))"
                >
                    <SelectTrigger
                        data-testid="role-bindings-role"
                        class="min-w-56 rounded border bg-background px-2 py-1 text-sm text-foreground"
                    >
                        <SelectValue>{{
                            selectedRoleId
                                ? roleLabel(selectedRoleId)
                                : t("settings.rolesBindingsRolePick")
                        }}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem
                            v-for="role in roles"
                            :key="role.id"
                            :value="role.id"
                            :disabled="!roleFitsScope(role)"
                            :data-testid="`role-bindings-role-option-${role.name}`"
                        >
                            {{ role.displayName || role.name }}
                            {{
                                roleFitsScope(role)
                                    ? ""
                                    : t("settings.rolesBindingsRoleScopeMismatch")
                            }}
                        </SelectItem>
                    </SelectContent>
                </Select>
            </label>
            <Button data-testid="role-bindings-add" @click="addRow">
                {{ t("settings.rolesBindingsAdd") }}
            </Button>
        </div>

        <Button
            v-if="subjectType === 'user'"
            data-testid="role-bindings-save"
            :disabled="saving"
            @click="save"
        >
            <LoaderCircle v-if="saving" class="animate-spin" aria-hidden="true" />
            {{ t("settings.rolesBindingsSave") }}
        </Button>

        <div
            v-if="subjectType === 'user' && effectiveSummary.length > 0"
            data-testid="role-bindings-effective"
            class="rounded border bg-muted/30 p-3 text-xs"
        >
            <p class="font-medium">{{ t("settings.rolesBindingsEffectiveTitle") }}</p>
            <p class="mt-1 text-muted-foreground">{{ t("settings.rolesBindingsEffectiveHint") }}</p>
            <ul class="mt-2 space-y-1">
                <li v-for="entry in effectiveSummary" :key="`eff-${entry.subjectId}`">
                    <span class="font-mono">{{ subjectLabel(entry.subjectId) }}</span
                    >:
                    <!-- task-409 P2-4：原子名是机器标识符，逐个 code 呈现并给 title，
                         不再挤成一行逗号串（长串既读不出边界也选不准单个）。 -->
                    <span v-if="entry.atoms.length === 0">—</span>
                    <span v-else class="flex flex-wrap gap-1" data-testid="binding-effective-atoms">
                        <code
                            v-for="atom in entry.atoms"
                            :key="atom"
                            class="rounded bg-muted px-1 py-0.5 font-mono text-xs"
                            :title="atom"
                        >
                            {{ atom }}
                        </code>
                    </span>
                </li>
            </ul>
        </div>

        <AgentRoleBindingsSection
            v-if="subjectType === 'agent_principal'"
            :scope="scope"
            :scope-id="scopeId"
            :workspace-id="workspaceId"
            :roles="roles"
            @notice="emit('notice', $event)"
            @dirty="(value) => (agentDirty = value)"
        />
    </section>
</template>
