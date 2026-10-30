<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
    api,
    ApiError,
    type ApiPrincipalGrantAtom,
    type ApiPrincipalGrantView,
    type ApiWorkspace,
} from "../../composables/api";
import { useAuthStore } from "../../stores/auth";
import { logger } from "../../lib/logger";

/**
 * PLAN-0585 M2: the ADMIN-only page that grants or revokes one human user's
 * `CREATE_ACCOUNT` / `MANAGE_WORKSPACE_AGENTS` atoms through
 * `GET/PATCH /api/v1/principal-grants/{username}`.
 *
 * The page never re-implements authorization: it only mirrors the CP difference-set contract
 * (decision #6/#7) — the target is addressed by exact username, `CREATE_ACCOUNT` is instance wide
 * (`resource="*"`), `MANAGE_WORKSPACE_AGENTS` needs a concrete workspace UUID, and the PATCH
 * response's `changed` flag is surfaced as-is (false = idempotent replay, no new audit row).
 */
const { t } = useI18n();
const auth = useAuthStore();
const isAdmin = computed(() => auth.isAdmin);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREATE_ACCOUNT = "CREATE_ACCOUNT";
const MANAGE_WORKSPACE_AGENTS = "MANAGE_WORKSPACE_AGENTS";

const username = ref("");
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const notice = ref("");

const loadedUserId = ref<string | null>(null);
const loadedUsername = ref<string | null>(null);

const initialCreateAccount = ref(false);
const initialWorkspaces = ref<string[]>([]);
const createAccount = ref(false);
const grantedWorkspaces = ref<string[]>([]);

const workspaceDraft = ref("");
const workspaces = ref<ApiWorkspace[]>([]);

function problemMessage(cause: unknown): string {
    const code = cause instanceof ApiError ? cause.problem.code : "";
    switch (code) {
        case "USER_NOT_FOUND":
            return t("settings.principalGrantsErrorUserNotFound");
        case "FORBIDDEN":
        case "AUTHORIZATION_REQUIRED":
            return t("settings.principalGrantsErrorForbidden");
        case "UNMANAGEABLE_ACTION_CLASS":
        case "UNKNOWN_ACTION_CLASS":
            return t("settings.principalGrantsErrorUnmanageable");
        case "INVALID_GRANT_RESOURCE":
            return t("settings.principalGrantsErrorResource");
        case "DIRECT_GRANT_CONFLICT":
            return t("settings.principalGrantsErrorConflict");
        case "OPERATION_LOCK_TIMEOUT":
            return t("settings.principalGrantsErrorTimeout");
        case "INVALID_REQUEST":
            return t("settings.principalGrantsErrorInvalid");
        default:
            // Never surface the server's raw English detail.
            return t("settings.principalGrantsErrorGeneric");
    }
}

function applyView(view: ApiPrincipalGrantView) {
    loadedUserId.value = view.userId;
    loadedUsername.value = view.username;
    initialCreateAccount.value = view.grants.some((grant) => grant.actionClass === CREATE_ACCOUNT);
    initialWorkspaces.value = view.grants
        .filter((grant) => grant.actionClass === MANAGE_WORKSPACE_AGENTS)
        .map((grant) => grant.resource);
    createAccount.value = initialCreateAccount.value;
    grantedWorkspaces.value = [...initialWorkspaces.value];
}

function clearLoaded() {
    loadedUserId.value = null;
    loadedUsername.value = null;
    initialCreateAccount.value = false;
    initialWorkspaces.value = [];
    createAccount.value = false;
    grantedWorkspaces.value = [];
}

async function load() {
    const target = username.value.trim();
    error.value = "";
    notice.value = "";
    if (!target) {
        error.value = t("settings.principalGrantsUsernameRequired");
        return;
    }
    loading.value = true;
    try {
        applyView(await api.getPrincipalGrants(target));
    } catch (cause) {
        clearLoaded();
        error.value = problemMessage(cause);
    } finally {
        loading.value = false;
    }
}

async function loadWorkspaces() {
    try {
        workspaces.value = await api.listWorkspaces();
    } catch (cause) {
        // The UUID can still be typed by hand; an unreadable list must not block the page.
        logger.warn("Failed to load workspaces for principal grants", cause);
        workspaces.value = [];
    }
}

function addWorkspace() {
    error.value = "";
    const candidate = workspaceDraft.value.trim();
    if (!candidate) {
        error.value = t("settings.principalGrantsWorkspaceRequired");
        return;
    }
    if (!UUID_PATTERN.test(candidate)) {
        error.value = t("settings.principalGrantsWorkspaceInvalid");
        return;
    }
    const normalized = candidate.toLowerCase();
    if (!grantedWorkspaces.value.includes(normalized)) {
        grantedWorkspaces.value = [...grantedWorkspaces.value, normalized];
    }
    workspaceDraft.value = "";
}

function removeWorkspace(workspaceId: string) {
    error.value = "";
    grantedWorkspaces.value = grantedWorkspaces.value.filter((item) => item !== workspaceId);
}

async function save() {
    if (!loadedUsername.value || saving.value) return;
    const add: ApiPrincipalGrantAtom[] = [];
    const remove: ApiPrincipalGrantAtom[] = [];
    if (createAccount.value && !initialCreateAccount.value) {
        add.push({ actionClass: CREATE_ACCOUNT, resource: "*" });
    }
    if (!createAccount.value && initialCreateAccount.value) {
        remove.push({ actionClass: CREATE_ACCOUNT, resource: "*" });
    }
    for (const workspaceId of grantedWorkspaces.value) {
        if (!initialWorkspaces.value.includes(workspaceId)) {
            add.push({ actionClass: MANAGE_WORKSPACE_AGENTS, resource: workspaceId });
        }
    }
    for (const workspaceId of initialWorkspaces.value) {
        if (!grantedWorkspaces.value.includes(workspaceId)) {
            remove.push({ actionClass: MANAGE_WORKSPACE_AGENTS, resource: workspaceId });
        }
    }
    saving.value = true;
    error.value = "";
    notice.value = "";
    try {
        const mutation = await api.patchPrincipalGrants(loadedUsername.value, { add, remove });
        applyView(mutation);
        notice.value = mutation.changed
            ? t("settings.principalGrantsSavedChanged")
            : t("settings.principalGrantsSavedUnchanged");
    } catch (cause) {
        error.value = problemMessage(cause);
    } finally {
        saving.value = false;
    }
}

onMounted(() => {
    if (isAdmin.value) void loadWorkspaces();
});
</script>

<template>
    <div data-testid="principal-grant-view" class="max-w-5xl">
        <template v-if="!isAdmin">
            <div
                data-testid="principal-grant-forbidden"
                class="max-w-md mx-auto mt-16 border rounded-xl bg-card p-6 text-center"
            >
                <h1 class="text-base font-semibold">
                    {{ t("settings.principalGrantsForbiddenTitle") }}
                </h1>
                <p class="mt-1 text-sm text-muted-foreground">
                    {{ t("settings.principalGrantsForbiddenBody") }}
                </p>
            </div>
        </template>

        <template v-else>
            <header class="mb-4">
                <h1 class="text-lg font-semibold">{{ t("settings.principalGrantsTitle") }}</h1>
                <p class="mt-1 text-sm text-muted-foreground">
                    {{ t("settings.principalGrantsSubtitle") }}
                </p>
            </header>

            <form
                class="mb-4 flex flex-wrap items-end gap-2"
                data-testid="principal-grant-form"
                @submit.prevent="load"
            >
                <label class="flex flex-col gap-1 text-xs text-muted-foreground">
                    {{ t("settings.principalGrantsUsername") }}
                    <input
                        v-model="username"
                        data-testid="principal-grant-username"
                        class="w-64 rounded border bg-background px-2 py-1 text-sm text-foreground"
                        :placeholder="t('settings.principalGrantsUsernamePlaceholder')"
                        autocomplete="off"
                        spellcheck="false"
                    />
                </label>
                <button
                    type="submit"
                    data-testid="principal-grant-load"
                    class="rounded border px-3 py-1 text-sm"
                    :disabled="loading"
                >
                    {{
                        loading
                            ? t("settings.principalGrantsLoading")
                            : t("settings.principalGrantsLoad")
                    }}
                </button>
            </form>

            <p
                v-if="error"
                data-testid="principal-grant-error"
                class="mb-3 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-700"
            >
                {{ error }}
            </p>
            <p
                v-if="notice"
                data-testid="principal-grant-notice"
                class="mb-3 rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700"
            >
                {{ notice }}
            </p>

            <section
                v-if="loadedUsername"
                data-testid="principal-grant-editor"
                class="space-y-4 rounded-xl border bg-card p-4"
            >
                <p data-testid="principal-grant-identity" class="text-xs text-muted-foreground">
                    {{ t("settings.principalGrantsTarget", { username: loadedUsername }) }} ·
                    {{ loadedUserId }}
                </p>

                <label class="flex items-start gap-2 text-sm">
                    <input
                        v-model="createAccount"
                        type="checkbox"
                        data-testid="principal-grant-create-account"
                        class="mt-1"
                    />
                    <span>
                        <span class="font-medium">{{
                            t("settings.principalGrantsCreateAccount")
                        }}</span>
                        <span class="block text-xs text-muted-foreground">
                            {{ t("settings.principalGrantsCreateAccountHint") }}
                        </span>
                    </span>
                </label>

                <div class="space-y-2 border-t pt-3">
                    <p class="text-sm font-medium">
                        {{ t("settings.principalGrantsManageAgents") }}
                    </p>
                    <p class="text-xs text-muted-foreground">
                        {{ t("settings.principalGrantsManageAgentsHint") }}
                    </p>

                    <ul class="space-y-1">
                        <li
                            v-for="workspaceId in grantedWorkspaces"
                            :key="workspaceId"
                            data-testid="principal-grant-workspace-row"
                            class="flex items-center gap-2 text-sm"
                        >
                            <code class="rounded bg-muted px-1 py-0.5 text-xs">{{
                                workspaceId
                            }}</code>
                            <button
                                type="button"
                                data-testid="principal-grant-workspace-remove"
                                class="text-xs text-rose-600 underline"
                                @click="removeWorkspace(workspaceId)"
                            >
                                {{ t("settings.principalGrantsRemoveWorkspace") }}
                            </button>
                        </li>
                    </ul>
                    <p
                        v-if="grantedWorkspaces.length === 0"
                        data-testid="principal-grant-workspace-empty"
                        class="text-xs text-muted-foreground"
                    >
                        {{ t("settings.principalGrantsNoWorkspace") }}
                    </p>

                    <div class="flex flex-wrap items-center gap-2">
                        <input
                            v-model="workspaceDraft"
                            data-testid="principal-grant-workspace-input"
                            list="principal-grant-workspace-choices"
                            class="w-72 rounded border bg-background px-2 py-1 text-sm"
                            :placeholder="t('settings.principalGrantsWorkspacePlaceholder')"
                            autocomplete="off"
                            spellcheck="false"
                        />
                        <datalist id="principal-grant-workspace-choices">
                            <option
                                v-for="workspace in workspaces"
                                :key="workspace.id"
                                :value="workspace.id"
                            >
                                {{ workspace.name }}
                            </option>
                        </datalist>
                        <button
                            type="button"
                            data-testid="principal-grant-workspace-add"
                            class="rounded border px-2 py-1 text-xs"
                            @click="addWorkspace"
                        >
                            {{ t("settings.principalGrantsAddWorkspace") }}
                        </button>
                    </div>
                </div>

                <div class="border-t pt-3">
                    <button
                        type="button"
                        data-testid="principal-grant-save"
                        class="rounded bg-primary px-3 py-1 text-sm text-primary-foreground"
                        :disabled="saving"
                        @click="save"
                    >
                        {{
                            saving
                                ? t("settings.principalGrantsSaving")
                                : t("settings.principalGrantsSave")
                        }}
                    </button>
                </div>
            </section>
        </template>
    </div>
</template>
