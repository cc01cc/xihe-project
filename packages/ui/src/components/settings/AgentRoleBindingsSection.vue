<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
    api,
    type AgentPrincipalOption,
    type AgentRoleBinding,
    type ApiBindingScope,
    type ApiPreset,
    type ApiWorkspace,
} from "../../composables/api";
import { presetErrorMessage } from "./roleErrorMessages";
import RolePresetDriftDialog from "../../views/settings/RolePresetDriftDialog.vue";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Empty, EmptyDescription, EmptyHeader } from "../ui/empty";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { LoaderCircle, X } from "@lucide/vue";
/** T5.2: agent preset bindings live here so RoleBindingsPanel stays small. CP owns the gate;
 * errors render localized copy + code via presetErrorMessage (task-855), never CP detail. */
const props = defineProps<{
    scope: ApiBindingScope;
    scopeId: string;
    workspaceId: string;
    presets: ApiPreset[];
    /** 工作区显示名映射（差异面按 scopeId 展示工作区名）；缺省时退化为 uuid。 */
    workspaces?: ApiWorkspace[];
}>();
const emit = defineEmits<{ notice: [message: string]; dirty: [boolean] }>();
const { t } = useI18n();

const agents = ref<AgentPrincipalOption[]>([]);
const selectedPrincipalId = ref("");
const bindings = ref<AgentRoleBinding[]>([]);
const desiredPresetIds = ref<string[]>([]);
const selectedPresetId = ref("");
const loading = ref(false);
const saving = ref(false);
const error = ref("");

const authWorkspaceId = computed(() => (props.scope === "workspace" ? props.workspaceId : null));
const selectedAgent = computed(
    () => agents.value.find((agent) => agent.principalId === selectedPrincipalId.value) ?? null,
);
/**
 * task-948 R39：智能体主体也有「与模板对比 / 重新对齐」——差异与写面都由 CP 的同一套
 * compare/realign 提供（subjectType=agent_principal），UI 只切换主体类型，不另做一套口径。
 */
const driftOpen = ref(false);
const selectedAgentLabel = computed(() => selectedAgent.value?.name ?? selectedPrincipalId.value);
const isDirty = computed(() => {
    const current = bindings.value
        .map((binding) => binding.roleId)
        .sort()
        .join("\n");
    return current !== [...desiredPresetIds.value].sort().join("\n");
});
/**
 * task-92（缺口二）：本段草稿（已绑定集合 vs 期望集合）**外报**给宿主 —— 段自己知道脏，
 * 宿主只知道「这一段挂了没」。判据同 `isDirty`，不另算一套。
 */
watch(isDirty, (dirty) => emit("dirty", dirty), { immediate: true });
onBeforeUnmount(() => emit("dirty", false));

const availablePresets = computed(() =>
    props.presets.filter(
        (preset) => presetFitsScope(preset) && !desiredPresetIds.value.includes(preset.id),
    ),
);

function presetFitsScope(preset: ApiPreset): boolean {
    // task-416（P0-1②）：含**禁用原子**的预设对智能体主体永远不可绑（选了必然 409）。
    // 判据消费服务端 agentPrincipalForbidden，不在 UI 重算原子词表；持 MANAGE_ROLES 的
    // 全量视图会把这些预设送过来，所以过滤必须在消费侧做。
    if (preset.atoms.some((atom) => atom.agentPrincipalForbidden)) return false;
    if (props.scope === "instance") return true;
    return preset.atoms.every((atom) => atom.scopeClass === "both");
}

function presetLabel(presetId: string): string {
    const preset = props.presets.find((candidate) => candidate.id === presetId);
    return preset?.displayName || preset?.name || presetId;
}

function bindingFor(roleId: string): AgentRoleBinding | undefined {
    return bindings.value.find((binding) => binding.roleId === roleId);
}

async function loadAgents() {
    loading.value = true;
    error.value = "";
    try {
        if (props.scope === "workspace") {
            if (!props.workspaceId) {
                agents.value = [];
            } else {
                const rows = await api.getWorkspaceAgents(props.workspaceId);
                agents.value = rows
                    .filter((row) => !row.disabled)
                    .map((row) => ({
                        principalId: row.principalId,
                        name: row.name,
                    }));
            }
        } else {
            agents.value = await api.listAgentPrincipals();
        }
        const previousSelection = selectedPrincipalId.value;
        if (!agents.value.some((agent) => agent.principalId === selectedPrincipalId.value)) {
            selectedPrincipalId.value = agents.value[0]?.principalId ?? "";
        }
        if (!selectedPrincipalId.value) {
            bindings.value = [];
            desiredPresetIds.value = [];
        } else if (selectedPrincipalId.value === previousSelection) {
            // A scope reload kept the same principal: the selection watcher will not fire.
            await loadBindings();
        }
    } catch (cause) {
        agents.value = [];
        bindings.value = [];
        desiredPresetIds.value = [];
        error.value = presetErrorMessage(cause, t);
    } finally {
        loading.value = false;
    }
}

async function loadBindings() {
    const principalId = selectedPrincipalId.value;
    if (!principalId) return;
    loading.value = true;
    error.value = "";
    try {
        bindings.value = await api.getAgentRoles(authWorkspaceId.value, principalId);
        desiredPresetIds.value = bindings.value.map((binding) => binding.roleId);
    } catch (cause) {
        bindings.value = [];
        desiredPresetIds.value = [];
        error.value = presetErrorMessage(cause, t);
    } finally {
        loading.value = false;
    }
}

function addPreset() {
    error.value = "";
    if (!selectedAgent.value) {
        error.value = t("settings.presetsBindingsAgentPick");
        return;
    }
    if (!selectedPresetId.value) return;
    if (desiredPresetIds.value.includes(selectedPresetId.value)) return;
    desiredPresetIds.value = [...desiredPresetIds.value, selectedPresetId.value];
    selectedPresetId.value = "";
}

function removePreset(roleId: string) {
    const binding = bindingFor(roleId);
    if (binding?.isSystem) return;
    desiredPresetIds.value = desiredPresetIds.value.filter((id) => id !== roleId);
}

async function save() {
    const principalId = selectedPrincipalId.value;
    if (!principalId || saving.value || !isDirty.value) return;
    saving.value = true;
    error.value = "";
    const desired = new Set(desiredPresetIds.value);
    const toUnbind = bindings.value.filter(
        (binding) => !binding.isSystem && !desired.has(binding.roleId),
    );
    const currentRoleIds = new Set(bindings.value.map((binding) => binding.roleId));
    const toBind = [...desired].filter((roleId) => !currentRoleIds.has(roleId));
    try {
        // task-416（P0-1③）：**先绑后解**。旧写法先解绑，一旦绑定被拒（禁用原子 / cap 上限）
        // 主体就停在**零角色**态 —— 一次失败的换角色把权限抹掉了，这是不可接受的失败模式。
        // 先绑的代价：换角色时可能先撞上 CP 的角色数上限而 409；但那种失败**保留旧角色集**，
        // 用户看到拒绝原因、权限不变，属于 fail-safe。两害相权取其可恢复的一侧。
        for (const roleId of toBind) {
            await api.bindAgentRole(authWorkspaceId.value, principalId, roleId);
        }
        for (const binding of toUnbind) {
            await api.unbindAgentRole(authWorkspaceId.value, principalId, binding.bindingId);
        }
        await loadBindings();
        emit(
            "notice",
            t("settings.presetsBindingsAgentSaved", { count: desiredPresetIds.value.length }),
        );
    } catch (cause) {
        const failure = presetErrorMessage(cause, t);
        // A partial save may have changed the server set; re-read so the next click is truthful.
        await loadBindings().catch(() => undefined);
        // loadBindings clears the surface on success; the user still needs the refusal detail.
        error.value = failure;
    } finally {
        saving.value = false;
    }
}

watch(
    [() => props.scope, () => props.workspaceId, () => props.scopeId],
    () => {
        selectedPrincipalId.value = "";
        void loadAgents();
    },
    { immediate: true },
);

watch(selectedPrincipalId, (next, previous) => {
    if (!next || next === previous) return;
    void loadBindings();
});
</script>

<template>
    <section data-testid="agent-preset-bindings-section" class="space-y-2 rounded border p-3">
        <div class="flex items-start justify-between gap-2">
            <div>
                <h3 class="text-sm font-medium">{{ t("settings.presetsBindingsAgentTitle") }}</h3>
                <p class="mt-1 text-xs text-muted-foreground">
                    {{ t("settings.presetsBindingsAgentHint") }}
                </p>
            </div>
            <Button
                variant="outline"
                size="sm"
                data-testid="agent-preset-drift-compare"
                :disabled="!selectedPrincipalId"
                @click="driftOpen = true"
            >
                {{ t("settings.presetsDriftCompare") }}
            </Button>
        </div>

        <p
            v-if="error"
            data-testid="agent-preset-bindings-error"
            class="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-700"
        >
            {{ error }}
        </p>

        <label class="flex flex-col gap-1 text-xs text-muted-foreground">
            {{ t("settings.presetsBindingsAgentPick") }}
            <Select
                :model-value="selectedPrincipalId || '__none__'"
                :disabled="loading || agents.length === 0"
                @update:model-value="
                    (value) =>
                        (selectedPrincipalId = value === '__none__' ? '' : String(value ?? ''))
                "
            >
                <SelectTrigger
                    data-testid="agent-preset-bindings-agent"
                    class="min-w-64 rounded border bg-background px-2 py-1 text-sm text-foreground"
                >
                    <SelectValue>{{
                        selectedPrincipalId
                            ? (agents.find((agent) => agent.principalId === selectedPrincipalId)
                                  ?.name ?? selectedPrincipalId)
                            : t("settings.presetsBindingsAgentPick")
                    }}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="__none__">{{
                        t("settings.presetsBindingsAgentPick")
                    }}</SelectItem>
                    <SelectItem
                        v-for="agent in agents"
                        :key="agent.principalId"
                        :value="agent.principalId"
                    >
                        {{ agent.name }}
                    </SelectItem>
                </SelectContent>
            </Select>
        </label>

        <Empty
            v-if="!loading && agents.length === 0"
            data-testid="agent-preset-bindings-empty"
            class="items-start gap-2 p-3 text-left"
        >
            <!-- 表单内提示，不是空页面：走精简形态（无 EmptyMedia 图标、无操作入口）。 -->
            <EmptyHeader class="items-start gap-1">
                <EmptyDescription class="text-xs">{{
                    t("settings.presetsBindingsAgentNoAgents")
                }}</EmptyDescription>
            </EmptyHeader>
        </Empty>
        <p v-else-if="loading" class="text-xs text-muted-foreground">
            {{ t("settings.presetsBindingsAgentLoading") }}
        </p>

        <table v-else class="w-full text-left text-sm" data-testid="agent-preset-bindings-table">
            <thead class="text-xs text-muted-foreground">
                <tr>
                    <th class="py-1">{{ t("settings.presetsBindingsPresets") }}</th>
                    <th class="py-1 text-right">{{ t("settings.presetsBindingsRemove") }}</th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="roleId in desiredPresetIds" :key="roleId" class="border-t">
                    <td class="py-1">
                        <span>{{ presetLabel(roleId) }}</span>
                        <Badge v-if="bindingFor(roleId)?.isSystem" variant="secondary" class="ml-2">
                            {{ t("settings.presetsBindingsAgentSeed") }}
                        </Badge>
                    </td>
                    <td class="py-1 text-right">
                        <Button
                            v-if="!bindingFor(roleId)?.isSystem"
                            variant="ghost"
                            size="icon"
                            :data-testid="`agent-role-binding-remove-${roleId}`"
                            @click="removePreset(roleId)"
                        >
                            <X class="size-3.5" aria-hidden="true" />
                        </Button>
                    </td>
                </tr>
                <tr v-if="desiredPresetIds.length === 0">
                    <td colspan="2" class="py-2 text-xs text-muted-foreground">
                        {{ t("settings.presetsBindingsEmpty") }}
                    </td>
                </tr>
            </tbody>
        </table>

        <div class="flex flex-wrap items-end gap-2">
            <label class="flex flex-col gap-1 text-xs text-muted-foreground">
                {{ t("settings.presetsBindingsPreset") }}
                <Select
                    :model-value="selectedPresetId || '__none__'"
                    @update:model-value="
                        (value) =>
                            (selectedPresetId = value === '__none__' ? '' : String(value ?? ''))
                    "
                >
                    <SelectTrigger
                        data-testid="agent-preset-bindings-role"
                        class="min-w-56 rounded border bg-background px-2 py-1 text-sm text-foreground"
                    >
                        <SelectValue>{{
                            selectedPresetId
                                ? (availablePresets.find((preset) => preset.id === selectedPresetId)
                                      ?.displayName ??
                                  availablePresets.find((preset) => preset.id === selectedPresetId)
                                      ?.name ??
                                  selectedPresetId)
                                : t("settings.presetsBindingsPresetPick")
                        }}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="__none__">{{
                            t("settings.presetsBindingsPresetPick")
                        }}</SelectItem>
                        <SelectItem
                            v-for="preset in availablePresets"
                            :key="preset.id"
                            :value="preset.id"
                        >
                            {{ preset.displayName || preset.name }}
                        </SelectItem>
                    </SelectContent>
                </Select>
            </label>
            <Button
                variant="outline"
                data-testid="agent-preset-bindings-add"
                :disabled="loading || !selectedAgent"
                @click="addPreset"
            >
                {{ t("settings.presetsBindingsAdd") }}
            </Button>
            <Button
                data-testid="agent-preset-bindings-save"
                :disabled="saving || loading || !isDirty"
                @click="save"
            >
                <LoaderCircle v-if="saving" class="animate-spin" aria-hidden="true" />
                {{ t("settings.presetsBindingsAgentSave") }}
            </Button>
        </div>
        <RolePresetDriftDialog
            :open="driftOpen"
            subject-type="agent_principal"
            :subject-id="selectedPrincipalId"
            :subject-label="selectedAgentLabel"
            :workspaces="workspaces ?? []"
            @close="driftOpen = false"
            @realigned="emit('notice', t('settings.presetsDriftRealigned'))"
        />
    </section>
</template>
