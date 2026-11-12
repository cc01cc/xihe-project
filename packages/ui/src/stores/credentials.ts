import { ref } from "vue";
import { defineStore } from "pinia";
import { api } from "@/composables/api";
import type {
    CredentialCreateRequest,
    CredentialDeleteReport,
    CredentialOwnerType,
    CredentialReplaceRequest,
    CredentialSummary,
} from "@/types";

/**
 * PLAN-0498 credential manager state (consumes the 0496/0497 API surface).
 *
 * `load` owns the owner-scoped list; a superseded response is dropped so a slow
 * older call cannot overwrite a newer one (same guard as the audit store).
 * Lifecycle actions refresh the list on success; the response of a superseded
 * request is dropped. Detail tabs (bindings/references/audit) load per feature
 * in M2/M3 without extending this store.
 *
 * `task-239`（治本 `task-237` 真栈证实的 P1）：**WORKSPACE 层必须同时带
 * `ownerType` 与 `ownerId`** —— 契约 `openapi.yaml:960` 写明 "Required for USER/WORKSPACE
 * owners"，而 CP 在缺 `ownerId` 时会把它回落成调用者自己的 user id
 * （`CredentialAdminService.java:357-374`），随后 `isWorkspaceMember(user-uuid, actor)`
 * 恒 false ⇒ **403**（`CredentialAdminService.java:313` 抛
 * `"Workspace membership is required"`；真栈实测见
 * `internal/A03-xihe/evidence/2026-11-12-credentials-workspace-403-probe/`）。
 * 所以这里**不发这个请求**、置 `scopeMissing`，由面板渲染「先选择工作区」的诚实态；
 * **绝不静默退化成无参调用** —— 无参拿到的是调用者自己的 USER 凭据，把它标成工作区凭据
 * 正是本 P1 的反面坑。`USER` / `INSTANCE` 层不传 `ownerId`（`INSTANCE` 若传即 400）。
 */
export const useCredentialsStore = defineStore("credentials", () => {
    const credentials = ref<CredentialSummary[]>([]),
        loading = ref(false),
        error = ref<Error | null>(null),
        /** WORKSPACE 层缺 workspaceId ⇒ 本轮**没有发出请求**（面板只消费这个布尔）。 */
        scopeMissing = ref(false);

    let requestToken = 0,
        /** 最近一次 `load` 的归属范围；生命周期动作按它重载（不退回无参）。 */
        lastScope: { ownerType?: CredentialOwnerType; ownerId?: string } = {};

    async function load(ownerType?: CredentialOwnerType, ownerId?: string) {
        const token = ++requestToken;
        lastScope = { ownerType, ownerId };
        error.value = null;

        if (ownerType === "WORKSPACE" && !ownerId) {
            // 不发请求：缺 ownerId 的 WORKSPACE 请求在 CP 侧恒 403（见文件头注释）。
            credentials.value = [];
            loading.value = false;
            scopeMissing.value = true;
            return;
        }

        scopeMissing.value = false;
        loading.value = true;
        try {
            const result = await api.listCredentials({
                ...(ownerType ? { ownerType } : {}),
                ...(ownerId ? { ownerId } : {}),
            });
            if (token !== requestToken) return;
            credentials.value = Array.isArray(result.credentials) ? result.credentials : [];
        } catch (e) {
            if (token !== requestToken) return;
            credentials.value = [];
            error.value = new Error(e instanceof Error ? e.message : String(e));
        } finally {
            if (token === requestToken) loading.value = false;
        }
    }

    /**
     * task-239：生命周期动作重载**同一层**，而不是无参 `load()`。
     * 旧写法（`load()` 无参）会在新建/替换/删除工作区凭据后把列表翻回个人层 ——
     * **既有隐性 bug，非本卡引入**（`lastScope` 之前不存在，刷新只能退回 USER 默认视图）。
     */
    function reload() {
        return load(lastScope.ownerType, lastScope.ownerId);
    }

    async function create(payload: CredentialCreateRequest): Promise<CredentialSummary> {
        const created = await api.createCredential(payload);
        await reload();
        return created;
    }

    async function replace(
        credentialId: string,
        payload: CredentialReplaceRequest,
    ): Promise<CredentialSummary> {
        const replaced = await api.replaceCredential(credentialId, payload);
        await reload();
        return replaced;
    }

    async function remove(credentialId: string): Promise<CredentialDeleteReport> {
        const report = await api.deleteCredential(credentialId);
        await reload();
        return report;
    }

    return { credentials, loading, error, scopeMissing, load, create, replace, remove };
});
