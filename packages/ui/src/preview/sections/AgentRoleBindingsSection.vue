<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Bot, Info, X } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AgentRoleBinding, WorkspaceAgentBinding } from "../../composables/api";
import {
    mockAgentRoleBindings,
    mockAgentRoleCapByAgent,
    mockAgents,
    mockRoles,
    PREVIEW_WORKSPACE_ID,
} from "../mockData";

/**
 * Preview-only twin of `components/settings/AgentRoleBindingsSection.vue` (M5 T5.2).
 * Same interaction skeleton — agent picker, current rows, pending diff, read-only seed,
 * unbind-before-bind — but every read/write is local mock state and never calls `/api/v1/**`.
 */
const agents = mockAgents
    .filter((agent) => !agent.disabled)
    .map((agent: WorkspaceAgentBinding) => ({ principalId: agent.principalId, name: agent.name }));

const selectedAgentId = ref(agents[0]?.principalId ?? "");
const selectedRoleId = ref("");
const saving = ref(false);
const notice = ref("");
const error = ref("");
const demo409 = ref(true);
const bindingsByAgent = ref<Record<string, AgentRoleBinding[]>>(
    Object.fromEntries(
        Object.entries(mockAgentRoleBindings).map(([principalId, rows]) => [
            principalId,
            rows.map((row) => ({ ...row })),
        ]),
    ),
);
const desiredRoleIds = ref<string[]>([]);

const demo409Message = "role atoms exceed the agent's workspace cap: workspace.agent.manage";
const currentBindings = computed(() => bindingsByAgent.value[selectedAgentId.value] ?? []);
const isDirty = computed(() => {
    const current = currentBindings.value
        .map((row) => row.roleId)
        .sort()
        .join("\n");
    return current !== [...desiredRoleIds.value].sort().join("\n");
});
const roleFitsScope = (role: (typeof mockRoles)[number]) =>
    role.atoms.every((atom) => atom.scopeClass !== "instance");
const availableRoles = computed(() =>
    mockRoles.filter((role) => roleFitsScope(role) && !desiredRoleIds.value.includes(role.id)),
);

function roleLabel(roleId: string): string {
    const role = mockRoles.find((candidate) => candidate.id === roleId);
    return role?.displayName || role?.name || roleId;
}

function bindingFor(roleId: string): AgentRoleBinding | undefined {
    return currentBindings.value.find((row) => row.roleId === roleId);
}

function capAtomsFor(agentId: string): string[] {
    return mockAgentRoleCapByAgent[agentId] ?? [];
}

function resetForSelection() {
    desiredRoleIds.value = currentBindings.value.map((row) => row.roleId);
    selectedRoleId.value = "";
    notice.value = "";
    error.value = demo409.value ? demo409Message : "";
}

function toggleDemo409() {
    demo409.value = !demo409.value;
    error.value = demo409.value ? demo409Message : "";
}

function addRole() {
    if (!selectedAgentId.value) {
        error.value = "请选择智能体主体";
        return;
    }
    if (!selectedRoleId.value) return;
    if (desiredRoleIds.value.includes(selectedRoleId.value)) return;
    desiredRoleIds.value = [...desiredRoleIds.value, selectedRoleId.value];
    selectedRoleId.value = "";
    notice.value = "";
}

function removeRole(roleId: string) {
    if (bindingFor(roleId)?.isSystem) return;
    desiredRoleIds.value = desiredRoleIds.value.filter((id) => id !== roleId);
    notice.value = "";
}

function save() {
    if (!selectedAgentId.value || saving.value || !isDirty.value) return;
    saving.value = true;
    notice.value = "";
    error.value = "";

    const desired = new Set(desiredRoleIds.value);
    const toUnbind = currentBindings.value.filter(
        (row) => !row.isSystem && !desired.has(row.roleId),
    );
    const currentRoleIds = new Set(currentBindings.value.map((row) => row.roleId));
    const toBind = [...desired].filter((roleId) => !currentRoleIds.has(roleId));
    const capAtoms = new Set(capAtomsFor(selectedAgentId.value));
    const exceeding = new Set<string>();
    for (const roleId of toBind) {
        const role = mockRoles.find((candidate) => candidate.id === roleId);
        for (const atom of role?.atoms ?? []) {
            if (!capAtoms.has(atom.name)) exceeding.add(atom.name);
        }
    }

    // Mock the real write order: unbind removed rows first, then attempt binds.
    const kept = currentBindings.value.filter((row) => row.isSystem || desired.has(row.roleId));
    const nextRows = kept.filter(
        (row) => !toUnbind.some((removed) => removed.bindingId === row.bindingId),
    );

    if (exceeding.size > 0) {
        bindingsByAgent.value = { ...bindingsByAgent.value, [selectedAgentId.value]: nextRows };
        desiredRoleIds.value = nextRows.map((row) => row.roleId);
        error.value = `role atoms exceed the agent's workspace cap: ${[...exceeding].join(",")}`;
        saving.value = false;
        return;
    }

    const bound = toBind.map((roleId) => {
        const role = mockRoles.find((candidate) => candidate.id === roleId);
        const atoms = role?.atoms.map((atom) => atom.name) ?? [];
        return {
            bindingId: `arb-local-${roleId}`,
            roleId,
            name: role?.name ?? roleId,
            displayName: role?.displayName ?? null,
            scopeType: "workspace",
            scopeId: PREVIEW_WORKSPACE_ID,
            scopeName: "预览工作区",
            isSystem: false,
            grantedBy: "preview-admin",
            atomSummary: atoms.slice(0, 3),
            atomCount: atoms.length,
            atomsTruncated: atoms.length > 3,
        } satisfies AgentRoleBinding;
    });
    bindingsByAgent.value = {
        ...bindingsByAgent.value,
        [selectedAgentId.value]: [...nextRows, ...bound],
    };
    notice.value = `已保存（mock），该智能体现有 ${nextRows.length + bound.length} 条角色绑定`;
    saving.value = false;
}

watch(selectedAgentId, resetForSelection, { immediate: true });
</script>

<template>
    <Card data-testid="preview-agent-role-bindings" class="mt-6">
        <CardHeader class="border-b border-border/70">
            <CardTitle class="flex items-center gap-2">
                <Bot class="size-4 text-muted-foreground" />
                智能体角色绑定（mock）
                <Badge variant="secondary">AgentRoleBindingsSection</Badge>
            </CardTitle>
        </CardHeader>
        <CardContent class="space-y-3 py-4">
            <p class="text-xs leading-relaxed text-muted-foreground">
                与真实子组件同构：主体选择 / 当前绑定 / 待保存 diff / 种子只读 / 先解绑后绑定；
                数据全部来自 <code class="font-mono">mockData.ts</code>，不请求
                <code class="font-mono">/api/v1/**</code>。
            </p>

            <p
                v-if="error"
                data-testid="preview-agent-role-bindings-error"
                class="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive"
            >
                <span v-if="demo409" class="mr-1 font-medium">演示 409：</span>{{ error }}
            </p>
            <p
                v-if="notice"
                data-testid="preview-agent-role-bindings-notice"
                class="rounded border border-brand/40 bg-brand/10 px-2 py-1 text-xs text-brand-accent"
            >
                {{ notice }}
            </p>

            <div class="grid grid-cols-[1fr_1fr_auto] items-end gap-3">
                <label class="flex flex-col gap-1 text-xs text-muted-foreground">
                    选择智能体主体
                    <Select
                        :model-value="selectedAgentId || '__none__'"
                        @update:model-value="
                            (value) =>
                                (selectedAgentId = value === '__none__' ? '' : String(value ?? ''))
                        "
                    >
                        <SelectTrigger
                            data-testid="preview-agent-role-bindings-agent"
                            class="rounded border bg-background px-2 py-1 text-sm text-foreground"
                        >
                            <SelectValue>{{
                                selectedAgentId
                                    ? (agents.find(
                                          (agent) => agent.principalId === selectedAgentId,
                                      )?.name ?? selectedAgentId)
                                    : "选择智能体主体"
                            }}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="__none__">选择智能体主体</SelectItem>
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
                <label class="flex flex-col gap-1 text-xs text-muted-foreground">
                    角色
                    <Select
                        :model-value="selectedRoleId || '__none__'"
                        @update:model-value="
                            (value) =>
                                (selectedRoleId = value === '__none__' ? '' : String(value ?? ''))
                        "
                    >
                        <SelectTrigger
                            data-testid="preview-agent-role-bindings-role"
                            class="rounded border bg-background px-2 py-1 text-sm text-foreground"
                        >
                            <SelectValue>{{
                                selectedRoleId
                                    ? (availableRoles.find(
                                          (role) => role.id === selectedRoleId,
                                      )?.displayName ??
                                      availableRoles.find((role) => role.id === selectedRoleId)
                                          ?.name ??
                                      selectedRoleId)
                                    : "选择角色"
                            }}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="__none__">选择角色</SelectItem>
                            <SelectItem
                                v-for="role in availableRoles"
                                :key="role.id"
                                :value="role.id"
                            >
                                {{ role.displayName || role.name }}
                            </SelectItem>
                        </SelectContent>
                    </Select>
                </label>
                <div class="flex gap-2 pb-0.5">
                    <Button
                        variant="outline"
                        size="sm"
                        data-testid="preview-agent-role-bindings-add"
                        :disabled="saving || !selectedAgentId"
                        @click="addRole"
                    >
                        添加绑定
                    </Button>
                    <Button
                        size="sm"
                        data-testid="preview-agent-role-bindings-save"
                        :disabled="saving || !isDirty"
                        @click="save"
                    >
                        保存智能体角色
                    </Button>
                    <Button variant="ghost" size="sm" @click="toggleDemo409">
                        {{ demo409 ? "关闭 409 演示" : "演示 409" }}
                    </Button>
                </div>
            </div>

            <table class="w-full text-left text-sm" data-testid="preview-agent-role-bindings-table">
                <thead class="text-xs text-muted-foreground">
                    <tr>
                        <th class="py-1">角色</th>
                        <th class="py-1 text-right">移除</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="roleId in desiredRoleIds" :key="roleId" class="border-t">
                        <td class="py-1">
                            <span>{{ roleLabel(roleId) }}</span>
                            <Badge
                                v-if="bindingFor(roleId)?.isSystem"
                                variant="secondary"
                                class="ml-2"
                            >
                                种子
                            </Badge>
                        </td>
                        <td class="py-1 text-right">
                            <Button
                                v-if="!bindingFor(roleId)?.isSystem"
                                variant="ghost"
                                size="icon"
                                :data-testid="`preview-agent-role-binding-remove-${roleId}`"
                                :disabled="saving"
                                @click="removeRole(roleId)"
                            >
                                <X class="size-3.5" aria-hidden="true" />
                            </Button>
                        </td>
                    </tr>
                    <tr v-if="desiredRoleIds.length === 0">
                        <td colspan="2" class="py-2 text-xs text-muted-foreground">
                            该智能体还没有角色绑定。
                        </td>
                    </tr>
                </tbody>
            </table>

            <p class="flex items-start gap-2 text-xs text-muted-foreground">
                <Info class="mt-0.5 size-3.5 shrink-0" />
                <span>
                    演示路径：切到 Nova（无绑定）→ 添加「工作区所有者」→ 保存，会显示
                    <code class="font-mono">ROLE_BINDING_EXCEEDS_CAP</code>
                    的原子 detail；种子角色不可移除。
                </span>
            </p>
        </CardContent>
    </Card>
</template>
