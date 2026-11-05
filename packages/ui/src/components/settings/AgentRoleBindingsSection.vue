<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
    api,
    type AgentPrincipalOption,
    type AgentRoleBinding,
    type ApiBindingScope,
    type ApiRole,
} from "../../composables/api";
import { roleErrorMessage } from "./roleErrorMessages";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { LoaderCircle, X } from "@lucide/vue";
/** T5.2: agent role bindings live here so RoleBindingsPanel stays small. CP owns the gate;
 * ROLE_BINDING_EXCEEDS_CAP's detail is surfaced by roleErrorMessage (BL-288). */
const props = defineProps<{
    scope: ApiBindingScope;
    scopeId: string;
    workspaceId: string;
    roles: ApiRole[];
}>();
const emit = defineEmits<{ notice: [message: string] }>();
const { t } = useI18n();

const agents = ref<AgentPrincipalOption[]>([]);
const selectedPrincipalId = ref("");
const bindings = ref<AgentRoleBinding[]>([]);
const desiredRoleIds = ref<string[]>([]);
const selectedRoleId = ref("");
const loading = ref(false);
const saving = ref(false);
const error = ref("");

const authWorkspaceId = computed(() => (props.scope === "workspace" ? props.workspaceId : null));
const selectedAgent = computed(
    () => agents.value.find((agent) => agent.principalId === selectedPrincipalId.value) ?? null,
);
const isDirty = computed(() => {
    const current = bindings.value
        .map((binding) => binding.roleId)
        .sort()
        .join("\n");
    return current !== [...desiredRoleIds.value].sort().join("\n");
});
const availableRoles = computed(() =>
    props.roles.filter((role) => roleFitsScope(role) && !desiredRoleIds.value.includes(role.id)),
);

function roleFitsScope(role: ApiRole): boolean {
    if (props.scope === "instance") return true;
    return role.atoms.every((atom) => atom.scopeClass === "both");
}

function roleLabel(roleId: string): string {
    const role = props.roles.find((candidate) => candidate.id === roleId);
    return role?.displayName || role?.name || roleId;
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
            desiredRoleIds.value = [];
        } else if (selectedPrincipalId.value === previousSelection) {
            // A scope reload kept the same principal: the selection watcher will not fire.
            await loadBindings();
        }
    } catch (cause) {
        agents.value = [];
        bindings.value = [];
        desiredRoleIds.value = [];
        error.value = roleErrorMessage(cause, t);
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
        desiredRoleIds.value = bindings.value.map((binding) => binding.roleId);
    } catch (cause) {
        bindings.value = [];
        desiredRoleIds.value = [];
        error.value = roleErrorMessage(cause, t);
    } finally {
        loading.value = false;
    }
}

function addRole() {
    error.value = "";
    if (!selectedAgent.value) {
        error.value = t("settings.rolesBindingsAgentPick");
        return;
    }
    if (!selectedRoleId.value) return;
    if (desiredRoleIds.value.includes(selectedRoleId.value)) return;
    desiredRoleIds.value = [...desiredRoleIds.value, selectedRoleId.value];
    selectedRoleId.value = "";
}

function removeRole(roleId: string) {
    const binding = bindingFor(roleId);
    if (binding?.isSystem) return;
    desiredRoleIds.value = desiredRoleIds.value.filter((id) => id !== roleId);
}

async function save() {
    const principalId = selectedPrincipalId.value;
    if (!principalId || saving.value || !isDirty.value) return;
    saving.value = true;
    error.value = "";
    const desired = new Set(desiredRoleIds.value);
    const toUnbind = bindings.value.filter(
        (binding) => !binding.isSystem && !desired.has(binding.roleId),
    );
    const currentRoleIds = new Set(bindings.value.map((binding) => binding.roleId));
    const toBind = [...desired].filter((roleId) => !currentRoleIds.has(roleId));
    try {
        // Unbind first: swapping a role can otherwise trip the CP cap before the old row is gone.
        for (const binding of toUnbind) {
            await api.unbindAgentRole(authWorkspaceId.value, principalId, binding.bindingId);
        }
        for (const roleId of toBind) {
            await api.bindAgentRole(authWorkspaceId.value, principalId, roleId);
        }
        await loadBindings();
        emit(
            "notice",
            t("settings.rolesBindingsAgentSaved", { count: desiredRoleIds.value.length }),
        );
    } catch (cause) {
        const failure = roleErrorMessage(cause, t);
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
    <section data-testid="agent-role-bindings-section" class="space-y-2 rounded border p-3">
        <div>
            <h3 class="text-sm font-medium">{{ t("settings.rolesBindingsAgentTitle") }}</h3>
            <p class="mt-1 text-xs text-muted-foreground">
                {{ t("settings.rolesBindingsAgentHint") }}
            </p>
        </div>

        <p
            v-if="error"
            data-testid="agent-role-bindings-error"
            class="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-700"
        >
            {{ error }}
        </p>

        <label class="flex flex-col gap-1 text-xs text-muted-foreground">
            {{ t("settings.rolesBindingsAgentPick") }}
            <select
                v-model="selectedPrincipalId"
                data-testid="agent-role-bindings-agent"
                class="min-w-64 rounded border bg-background px-2 py-1 text-sm text-foreground"
                :disabled="loading || agents.length === 0"
            >
                <option value="">{{ t("settings.rolesBindingsAgentPick") }}</option>
                <option v-for="agent in agents" :key="agent.principalId" :value="agent.principalId">
                    {{ agent.name }}
                </option>
            </select>
        </label>

        <p
            v-if="!loading && agents.length === 0"
            data-testid="agent-role-bindings-empty"
            class="text-xs text-muted-foreground"
        >
            {{ t("settings.rolesBindingsAgentNoAgents") }}
        </p>
        <p v-else-if="loading" class="text-xs text-muted-foreground">
            {{ t("settings.rolesBindingsAgentLoading") }}
        </p>

        <table v-else class="w-full text-left text-sm" data-testid="agent-role-bindings-table">
            <thead class="text-xs text-muted-foreground">
                <tr>
                    <th class="py-1">{{ t("settings.rolesBindingsRoles") }}</th>
                    <th class="py-1 text-right">{{ t("settings.rolesBindingsRemove") }}</th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="roleId in desiredRoleIds" :key="roleId" class="border-t">
                    <td class="py-1">
                        <span>{{ roleLabel(roleId) }}</span>
                        <Badge v-if="bindingFor(roleId)?.isSystem" variant="secondary" class="ml-2">
                            {{ t("settings.rolesBindingsAgentSeed") }}
                        </Badge>
                    </td>
                    <td class="py-1 text-right">
                        <Button
                            v-if="!bindingFor(roleId)?.isSystem"
                            variant="ghost"
                            size="icon"
                            :data-testid="`agent-role-binding-remove-${roleId}`"
                            @click="removeRole(roleId)"
                        >
                            <X class="size-3.5" aria-hidden="true" />
                        </Button>
                    </td>
                </tr>
                <tr v-if="desiredRoleIds.length === 0">
                    <td colspan="2" class="py-2 text-xs text-muted-foreground">
                        {{ t("settings.rolesBindingsEmpty") }}
                    </td>
                </tr>
            </tbody>
        </table>

        <div class="flex flex-wrap items-end gap-2">
            <label class="flex flex-col gap-1 text-xs text-muted-foreground">
                {{ t("settings.rolesBindingsRole") }}
                <select
                    v-model="selectedRoleId"
                    data-testid="agent-role-bindings-role"
                    class="min-w-56 rounded border bg-background px-2 py-1 text-sm text-foreground"
                >
                    <option value="">{{ t("settings.rolesBindingsRolePick") }}</option>
                    <option v-for="role in availableRoles" :key="role.id" :value="role.id">
                        {{ role.displayName || role.name }}
                    </option>
                </select>
            </label>
            <Button
                variant="outline"
                data-testid="agent-role-bindings-add"
                :disabled="loading || !selectedAgent"
                @click="addRole"
            >
                {{ t("settings.rolesBindingsAdd") }}
            </Button>
            <Button
                data-testid="agent-role-bindings-save"
                :disabled="saving || loading || !isDirty"
                @click="save"
            >
                <LoaderCircle v-if="saving" class="animate-spin" aria-hidden="true" />
                {{ t("settings.rolesBindingsAgentSave") }}
            </Button>
        </div>
    </section>
</template>
