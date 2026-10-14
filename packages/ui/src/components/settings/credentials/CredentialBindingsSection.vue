<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { LoaderCircle } from "@lucide/vue";
import { Button } from "../../ui/button";
import { Badge } from "../../ui/badge";
import {
    api,
    ApiError,
    type ApiWorkspace,
    type WorkspaceAgentBinding,
} from "../../../composables/api";
import { logger } from "../../../lib/logger";
import { credentialErrorText } from "./errorText";

const props = defineProps<{
    credentialId: string;
}>();

const emit = defineEmits<{
    changed: [];
}>();

const { t } = useI18n();

const CREDENTIAL_USE_ACTION = "credential_use",
    CREDENTIAL_RESOURCE_PREFIX = "credential:";

const workspaces = ref<ApiWorkspace[]>([]),
    workspaceId = ref(""),
    agents = ref<WorkspaceAgentBinding[]>([]),
    selectedIds = ref<string[]>([]),
    loadingAgents = ref(false),
    busy = ref(false),
    error = ref("");

const credentialResource = computed(() => `${CREDENTIAL_RESOURCE_PREFIX}${props.credentialId}`);

function isBound(agent: WorkspaceAgentBinding): boolean {
    return agent.permissions.some(
        (permission) =>
            permission.actionClass === CREDENTIAL_USE_ACTION &&
            permission.resource === credentialResource.value,
    );
}

function toggle(id: string) {
    selectedIds.value = selectedIds.value.includes(id)
        ? selectedIds.value.filter((item) => item !== id)
        : [...selectedIds.value, id];
}

async function loadWorkspaces() {
    if (workspaces.value.length > 0) return;
    try {
        const result = await api.listWorkspaces();
        workspaces.value = Array.isArray(result) ? result : [];
    } catch (e) {
        error.value = credentialErrorText(e, t);
        if (!(e instanceof ApiError)) {
            logger.warn("Failed to load workspaces for credential bindings", e);
        }
    }
}

async function loadAgents() {
    if (!workspaceId.value) return;
    loadingAgents.value = true;
    error.value = "";
    selectedIds.value = [];
    try {
        const result = await api.getWorkspaceAgents(workspaceId.value);
        agents.value = Array.isArray(result) ? result : [];
    } catch (e) {
        agents.value = [];
        error.value = credentialErrorText(e, t);
        if (!(e instanceof ApiError)) {
            logger.warn("Failed to load workspace agents for credential bindings", e);
        }
    } finally {
        loadingAgents.value = false;
    }
}

async function apply(bound: boolean) {
    if (!workspaceId.value || selectedIds.value.length === 0) return;
    busy.value = true;
    error.value = "";
    try {
        const payload = {
            workspaceId: workspaceId.value,
            agentPrincipalIds: [...selectedIds.value],
        };
        if (bound) {
            await api.bindCredential(props.credentialId, payload);
        } else {
            await api.unbindCredential(props.credentialId, payload);
        }
        toast.success(t("credentials.bindDone"));
        await loadAgents();
        emit("changed");
    } catch (e) {
        error.value = credentialErrorText(e, t);
        if (!(e instanceof ApiError)) {
            logger.warn("Credential binding update failed", e);
        }
    } finally {
        busy.value = false;
    }
}

watch(workspaceId, () => {
    void loadAgents();
});

watch(
    () => props.credentialId,
    () => {
        workspaceId.value = "";
        agents.value = [];
        selectedIds.value = [];
        error.value = "";
    },
);

void loadWorkspaces();
</script>

<template>
    <div class="space-y-3" data-testid="credential-bindings">
        <p class="text-xs text-muted-foreground">{{ t("credentials.bindScopeNote") }}</p>

        <div class="flex flex-wrap items-center gap-2">
            <label class="text-xs text-muted-foreground" for="credential-bind-workspace">{{
                t("credentials.bindWorkspace")
            }}</label>
            <select
                id="credential-bind-workspace"
                v-model="workspaceId"
                data-testid="credential-bind-workspace"
                class="rounded-md border border-border bg-background px-2 py-1 text-xs"
            >
                <option value="">—</option>
                <option v-for="workspace in workspaces" :key="workspace.id" :value="workspace.id">
                    {{ workspace.name }}
                </option>
            </select>
        </div>

        <div v-if="loadingAgents" class="text-xs text-muted-foreground">
            {{ t("common.loading") }}
        </div>
        <template v-else-if="workspaceId">
            <ul
                v-if="agents.length > 0"
                class="max-h-48 space-y-1 overflow-auto"
                data-testid="credential-bind-agents"
            >
                <li
                    v-for="agent in agents"
                    :key="agent.principalId"
                    class="flex items-center gap-2 text-xs"
                >
                    <input
                        type="checkbox"
                        :checked="selectedIds.includes(agent.principalId)"
                        :data-testid="`credential-bind-agent-${agent.principalId}`"
                        @change="toggle(agent.principalId)"
                    />
                    <span class="font-medium">{{ agent.name }}</span>
                    <span class="font-mono text-muted-foreground">{{ agent.principalId }}</span>
                    <Badge
                        v-if="isBound(agent)"
                        variant="secondary"
                        data-testid="credential-bind-bound"
                    >
                        {{ t("credentials.bindAlready") }}
                    </Badge>
                </li>
            </ul>
            <p
                v-else
                class="text-xs text-muted-foreground"
                data-testid="credential-bind-agents-empty"
            >
                {{ t("credentials.bindAgentsEmpty") }}
            </p>
            <div class="flex gap-2">
                <Button
                    type="button"
                    size="sm"
                    data-testid="credential-bind-apply"
                    :disabled="busy || selectedIds.length === 0"
                    @click="apply(true)"
                >
                    <LoaderCircle v-if="busy" class="animate-spin" aria-hidden="true" />
                    {{ busy ? t("credentials.bindBusy") : t("credentials.bindApply") }}
                </Button>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="credential-bind-remove"
                    :disabled="busy || selectedIds.length === 0"
                    @click="apply(false)"
                >
                    {{ t("credentials.bindRemove") }}
                </Button>
            </div>
        </template>

        <p
            v-if="error"
            data-testid="credential-bind-error"
            class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
            {{ error }}
        </p>
    </div>
</template>
