<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { logger } from "../../lib/logger";

type Permission = { actionClass: string; resource?: string };
type Role = { id: string; name: string; permissions: Permission[] };
type Template = {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    toolMode: "none" | "workspace";
    provider?: string;
    model?: string;
    roleId?: string;
};

const props = defineProps<{
    entries: Record<string, string>;
    saving?: boolean;
}>();

const emit = defineEmits<{
    save: [body: Record<string, string>];
}>();

const { t } = useI18n();
const actions = ["read", "write", "delete", "exec", "network", "credential"];
const roles = ref<Role[]>([]);
const templates = ref<Template[]>([]);
const selectedTemplateId = ref("");
const roleName = ref("");
const rolePermissions = ref<Permission[]>([]);
const editingRoleId = ref("");
const name = ref("");
const description = ref("");
const systemPrompt = ref("");
const toolMode = ref<"none" | "workspace">("none");
const provider = ref("");
const model = ref("");
const roleId = ref("");
const error = ref("");
const malformedConfig = ref(false);
const success = ref("");
const pendingDeleteId = ref("");
const pendingPayload = ref<Record<string, string> | null>(null);
const pendingSuccess = ref("");
const pendingKind = ref<"template-save" | "template-delete" | "role-save" | "role-delete" | null>(
    null,
);

watch(
    () => props.entries,
    (entries) => {
        malformedConfig.value = false;
        roles.value = parseArray<Role>(entries.roles, isRole);
        templates.value = parseArray<Template>(entries.templates, isTemplate);
        if (
            pendingPayload.value &&
            entries.roles === pendingPayload.value.roles &&
            entries.templates === pendingPayload.value.templates
        ) {
            success.value = pendingSuccess.value;
            pendingPayload.value = null;
            if (pendingKind.value === "template-save") resetTemplateForm();
            if (pendingKind.value === "template-delete") pendingDeleteId.value = "";
            if (pendingKind.value === "role-save") {
                editingRoleId.value = "";
                roleName.value = "";
                rolePermissions.value = [];
            }
            pendingKind.value = null;
        }
    },
    { immediate: true, deep: true },
);

watch(
    () => props.saving,
    (saving, wasSaving) => {
        if (wasSaving && !saving && pendingPayload.value) {
            error.value = t("settings.agentTemplateSaveFailed");
            pendingPayload.value = null;
            pendingKind.value = null;
        }
    },
);

const editing = computed(() => !!selectedTemplateId.value);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRole(value: unknown): value is Role {
    return (
        isRecord(value) &&
        typeof value.id === "string" &&
        typeof value.name === "string" &&
        Array.isArray(value.permissions) &&
        value.permissions.every(
            (permission) =>
                isRecord(permission) &&
                typeof permission.actionClass === "string" &&
                (permission.resource === undefined || typeof permission.resource === "string"),
        )
    );
}

function isTemplate(value: unknown): value is Template {
    return (
        isRecord(value) &&
        typeof value.id === "string" &&
        typeof value.name === "string" &&
        typeof value.description === "string" &&
        typeof value.systemPrompt === "string" &&
        (value.toolMode === "none" || value.toolMode === "workspace") &&
        (value.provider === undefined || typeof value.provider === "string") &&
        (value.model === undefined || typeof value.model === "string") &&
        (value.roleId === undefined || typeof value.roleId === "string")
    );
}

function parseArray<T>(value: string | undefined, isItem: (item: unknown) => item is T): T[] {
    if (!value) return [];
    try {
        const parsed: unknown = JSON.parse(value);
        if (!Array.isArray(parsed) || !parsed.every(isItem)) malformedConfig.value = true;
        return Array.isArray(parsed) && parsed.every(isItem) ? parsed : [];
    } catch (cause) {
        malformedConfig.value = true;
        logger.warn("Invalid stored Agent template JSON", cause);
        return [];
    }
}

function persist(nextRoles: Role[], nextTemplates: Template[], message: string) {
    if (malformedConfig.value || pendingPayload.value) return;
    error.value = "";
    success.value = "";
    pendingPayload.value = {
        roles: JSON.stringify(nextRoles),
        templates: JSON.stringify(nextTemplates),
    };
    pendingSuccess.value = message;
    emit("save", pendingPayload.value);
}

function resetTemplateForm() {
    selectedTemplateId.value = "";
    name.value = "";
    description.value = "";
    systemPrompt.value = "";
    toolMode.value = "none";
    provider.value = "";
    model.value = "";
    roleId.value = "";
    pendingDeleteId.value = "";
}

function editTemplate(template: Template) {
    selectedTemplateId.value = template.id;
    name.value = template.name;
    description.value = template.description ?? "";
    systemPrompt.value = template.systemPrompt ?? "";
    toolMode.value = template.toolMode;
    provider.value = template.provider ?? "";
    model.value = template.model ?? "";
    roleId.value = template.roleId ?? "";
}

function saveTemplate() {
    if (props.saving || pendingPayload.value) return;
    if (!name.value.trim() || !systemPrompt.value.trim()) {
        error.value = t("settings.agentTemplateRequired");
        return;
    }
    const id = selectedTemplateId.value || crypto.randomUUID();
    const template: Template = {
        id,
        name: name.value.trim(),
        description: description.value.trim(),
        systemPrompt: systemPrompt.value,
        toolMode: toolMode.value,
        ...(provider.value.trim() ? { provider: provider.value.trim() } : {}),
        ...(model.value.trim() ? { model: model.value.trim() } : {}),
        ...(roleId.value ? { roleId: roleId.value } : {}),
    };
    const next = templates.value.some((item) => item.id === id)
        ? templates.value.map((item) => (item.id === id ? template : item))
        : [...templates.value, template];
    pendingKind.value = "template-save";
    persist(roles.value, next, t("settings.agentTemplateSaved"));
}

function deleteTemplate(template: Template) {
    if (props.saving || pendingPayload.value) return;
    if (pendingDeleteId.value !== template.id) {
        pendingDeleteId.value = template.id;
        return;
    }
    const next = templates.value.filter((item) => item.id !== template.id);
    pendingKind.value = "template-delete";
    persist(roles.value, next, t("settings.agentTemplateDeleted"));
}

function saveRole() {
    if (props.saving || pendingPayload.value) return;
    if (!roleName.value.trim()) {
        error.value = t("settings.agentRoleRequired");
        return;
    }
    const id = editingRoleId.value || crypto.randomUUID();
    const role: Role = {
        id,
        name: roleName.value.trim(),
        permissions: rolePermissions.value.map((permission) => ({
            actionClass: permission.actionClass,
            resource: permission.resource?.trim() || "*",
        })),
    };
    const next = roles.value.some((item) => item.id === id)
        ? roles.value.map((item) => (item.id === id ? role : item))
        : [...roles.value, role];
    pendingKind.value = "role-save";
    persist(next, templates.value, t("settings.agentRoleSaved"));
}

function editRole(role: Role) {
    editingRoleId.value = role.id;
    roleName.value = role.name;
    rolePermissions.value = role.permissions.map((permission) => ({ ...permission }));
}

function deleteRole(role: Role) {
    if (props.saving || pendingPayload.value) return;
    if (templates.value.some((template) => template.roleId === role.id)) return;
    const next = roles.value.filter((item) => item.id !== role.id);
    pendingKind.value = "role-delete";
    persist(next, templates.value, t("settings.agentRoleDeleted"));
}

function cancelRoleEdit() {
    editingRoleId.value = "";
    roleName.value = "";
    rolePermissions.value = [];
}
</script>

<template>
    <section class="space-y-4 rounded-lg border p-4" data-testid="agent-templates-panel">
        <div>
            <h3 class="text-sm font-semibold">{{ t("settings.agentTemplatesHeading") }}</h3>
            <p class="mt-1 text-xs text-muted-foreground">
                {{ t("settings.agentTemplateSnapshotNote") }}
            </p>
        </div>

        <p v-if="malformedConfig" role="alert" class="text-sm text-destructive">
            {{ t("settings.agentTemplateConfigInvalid") }}
        </p>
        <form
            class="space-y-3 rounded-md border p-3"
            data-testid="agent-template-form"
            @submit.prevent="saveTemplate"
        >
            <h4 class="text-sm font-medium">
                {{ editing ? t("settings.agentTemplateEdit") : t("settings.agentTemplateCreate") }}
            </h4>
            <label class="block space-y-1 text-sm">
                <span>{{ t("settings.agentTemplateName") }}</span>
                <input
                    v-model="name"
                    required
                    maxlength="120"
                    data-testid="agent-template-name"
                    class="w-full rounded-md border bg-background px-3 py-2"
                />
            </label>
            <label class="block space-y-1 text-sm">
                <span>{{ t("settings.agentTemplateDescription") }}</span>
                <input
                    v-model="description"
                    maxlength="500"
                    data-testid="agent-template-description"
                    class="w-full rounded-md border bg-background px-3 py-2"
                />
            </label>
            <label class="block space-y-1 text-sm">
                <span>{{ t("settings.agentTemplatePrompt") }}</span>
                <textarea
                    v-model="systemPrompt"
                    required
                    rows="5"
                    data-testid="agent-template-prompt"
                    class="w-full rounded-md border bg-background px-3 py-2"
                />
            </label>
            <div class="grid gap-3 sm:grid-cols-2">
                <label class="block space-y-1 text-sm">
                    <span>{{ t("settings.agentTemplateToolMode") }}</span>
                    <select
                        v-model="toolMode"
                        data-testid="agent-template-tool-mode"
                        class="w-full rounded-md border bg-background px-3 py-2"
                    >
                        <option value="none">none</option>
                        <option value="workspace">workspace</option>
                    </select>
                </label>
                <label class="block space-y-1 text-sm">
                    <span>{{ t("settings.agentTemplateRole") }}</span>
                    <select
                        v-model="roleId"
                        data-testid="agent-template-role"
                        class="w-full rounded-md border bg-background px-3 py-2"
                    >
                        <option value="">{{ t("settings.agentTemplateNoRole") }}</option>
                        <option v-for="role in roles" :key="role.id" :value="role.id">
                            {{ role.name }}
                        </option>
                    </select>
                </label>
                <label class="block space-y-1 text-sm">
                    <span>{{ t("settings.agentTemplateProvider") }}</span>
                    <input
                        v-model="provider"
                        data-testid="agent-template-provider"
                        class="w-full rounded-md border bg-background px-3 py-2"
                    />
                </label>
                <label class="block space-y-1 text-sm">
                    <span>{{ t("settings.agentTemplateModel") }}</span>
                    <input
                        v-model="model"
                        data-testid="agent-template-model"
                        class="w-full rounded-md border bg-background px-3 py-2"
                    />
                </label>
            </div>
            <div class="flex flex-wrap gap-2">
                <button
                    type="submit"
                    data-testid="agent-template-save"
                    :disabled="saving || malformedConfig"
                    class="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                >
                    {{ saving ? t("common.saving") : t("common.save") }}
                </button>
                <button
                    v-if="editing"
                    type="button"
                    data-testid="agent-template-cancel-edit"
                    class="rounded-md border px-3 py-2 text-sm"
                    @click="resetTemplateForm"
                >
                    {{ t("common.cancel") }}
                </button>
            </div>
        </form>

        <div class="space-y-2" aria-label="Agent templates">
            <article
                v-for="template in templates"
                :key="template.id"
                class="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3"
                :data-testid="`agent-template-${template.id}`"
            >
                <div class="min-w-0">
                    <h4 class="truncate text-sm font-medium">{{ template.name }}</h4>
                    <p class="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                        {{ template.id }}
                    </p>
                    <p class="mt-1 text-xs text-muted-foreground">
                        {{
                            template.roleId
                                ? roles.find((role) => role.id === template.roleId)?.name
                                : t("settings.agentTemplateNoRole")
                        }}
                        · {{ template.toolMode }} ·
                        {{ template.provider || t("settings.notSet") }} /
                        {{ template.model || t("settings.notSet") }}
                    </p>
                </div>
                <div class="flex gap-2">
                    <button
                        type="button"
                        class="text-xs underline"
                        :data-testid="`agent-template-edit-${template.id}`"
                        @click="editTemplate(template)"
                    >
                        {{ t("settings.agentTemplateEdit") }}
                    </button>
                    <button
                        type="button"
                        class="text-xs text-destructive underline disabled:opacity-40"
                        :disabled="malformedConfig || saving"
                        :data-testid="`agent-template-delete-${template.id}`"
                        @click="deleteTemplate(template)"
                    >
                        {{
                            pendingDeleteId === template.id
                                ? t("settings.agentTemplateConfirmDelete")
                                : t("common.delete")
                        }}
                    </button>
                </div>
            </article>
            <p
                v-if="templates.length === 0"
                class="rounded-md border border-dashed p-3 text-sm text-muted-foreground"
            >
                {{ t("settings.agentTemplateEmpty") }}
            </p>
        </div>

        <form
            class="space-y-2 rounded-md border p-3"
            data-testid="agent-role-form"
            @submit.prevent="saveRole"
        >
            <h4 class="text-sm font-medium">
                {{ editingRoleId ? t("settings.agentRoleEdit") : t("settings.agentRoleCreate") }}
            </h4>
            <input
                v-model="roleName"
                required
                maxlength="120"
                :aria-label="t('settings.agentRoleName')"
                data-testid="agent-role-name"
                class="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
            <div class="space-y-2">
                <div
                    v-for="(permission, index) in rolePermissions"
                    :key="index"
                    class="grid grid-cols-[1fr_1fr_auto] gap-2"
                >
                    <select
                        v-model="permission.actionClass"
                        :data-testid="`agent-role-action-${index}`"
                        class="min-w-0 rounded-md border bg-background px-2 py-1 text-xs"
                    >
                        <option v-for="action in actions" :key="action" :value="action">
                            {{ action }}
                        </option>
                    </select>
                    <input
                        v-model="permission.resource"
                        :aria-label="`${t('settings.agentRoleResource')} ${index + 1}`"
                        :data-testid="`agent-role-resource-${index}`"
                        class="min-w-0 rounded-md border bg-background px-2 py-1 text-xs"
                    />
                    <button
                        type="button"
                        :aria-label="t('common.delete')"
                        class="text-xs text-destructive underline"
                        @click="rolePermissions.splice(index, 1)"
                    >
                        {{ t("common.delete") }}
                    </button>
                </div>
                <button
                    type="button"
                    data-testid="agent-role-add-permission"
                    class="rounded-md border px-2 py-1 text-xs"
                    @click="rolePermissions.push({ actionClass: 'read', resource: '*' })"
                >
                    {{ t("settings.agentRoleAddPermission") }}
                </button>
            </div>
            <button
                type="submit"
                data-testid="agent-role-save"
                :disabled="saving || malformedConfig"
                class="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
            >
                {{ t("common.save") }}
            </button>
            <button
                v-if="editingRoleId"
                type="button"
                data-testid="agent-role-cancel-edit"
                class="ml-2 text-sm underline"
                @click="cancelRoleEdit"
            >
                {{ t("common.cancel") }}
            </button>
            <ul class="space-y-1 text-xs">
                <li
                    v-for="role in roles"
                    :key="role.id"
                    class="flex items-center justify-between gap-2"
                    :data-testid="`agent-role-${role.id}`"
                >
                    <span
                        >{{ role.name }} ·
                        {{
                            role.permissions
                                .map((item) => `${item.actionClass}:${item.resource ?? "*"}`)
                                .join(", ") || t("settings.agentRoleNoPermissions")
                        }}</span
                    >
                    <span class="flex gap-2">
                        <button
                            type="button"
                            class="underline disabled:opacity-40"
                            :disabled="saving || !!pendingPayload"
                            :data-testid="`agent-role-edit-${role.id}`"
                            @click="editRole(role)"
                        >
                            {{ t("settings.agentTemplateEdit") }}
                        </button>
                        <button
                            type="button"
                            class="text-destructive underline disabled:opacity-40"
                            :disabled="
                                malformedConfig ||
                                saving ||
                                templates.some((template) => template.roleId === role.id)
                            "
                            :data-testid="`agent-role-delete-${role.id}`"
                            @click="deleteRole(role)"
                        >
                            {{ t("common.delete") }}
                        </button>
                    </span>
                </li>
            </ul>
        </form>

        <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
        <p
            v-if="success"
            role="status"
            data-testid="agent-template-save-status"
            class="text-sm text-emerald-700 dark:text-emerald-300"
        >
            {{ success }}
        </p>
    </section>
</template>
