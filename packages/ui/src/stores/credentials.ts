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
 */
export const useCredentialsStore = defineStore("credentials", () => {
    const credentials = ref<CredentialSummary[]>([]),
        loading = ref(false),
        error = ref<Error | null>(null);

    let requestToken = 0;

    async function load(ownerType?: CredentialOwnerType) {
        const token = ++requestToken;
        loading.value = true;
        error.value = null;
        try {
            const result = await api.listCredentials(ownerType ? { ownerType } : {});
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

    async function create(payload: CredentialCreateRequest): Promise<CredentialSummary> {
        const created = await api.createCredential(payload);
        await load();
        return created;
    }

    async function replace(
        credentialId: string,
        payload: CredentialReplaceRequest,
    ): Promise<CredentialSummary> {
        const replaced = await api.replaceCredential(credentialId, payload);
        await load();
        return replaced;
    }

    async function remove(credentialId: string): Promise<CredentialDeleteReport> {
        const report = await api.deleteCredential(credentialId);
        await load();
        return report;
    }

    return { credentials, loading, error, load, create, replace, remove };
});
