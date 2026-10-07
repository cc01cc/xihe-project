import { ref } from "vue";
import { defineStore } from "pinia";
import { api } from "@/composables/api";
import type { AuditEntry, AuditEntryDetail, AuditEntryType, AuditListFilters } from "@/types";

/**
 * PLAN-0466 T2.1: audit read state.
 *
 * Reads the four-domain audit surface (`/api/v1/audit/entries*`) instead of the
 * legacy ledger routes; `load` owns the list (entries/paging/error), `loadDetail`
 * owns one entry's timeline. Responses of a superseded request are dropped so a
 * slow older call can never overwrite a newer filter result.
 */
export const useOperationStore = defineStore("operations", () => {
    const entries = ref<AuditEntry[]>([]);
    const selectedDetail = ref<AuditEntryDetail | null>(null);
    const page = ref(0);
    const size = ref(20);
    const totalElements = ref(0);
    const totalPages = ref(0);
    const loading = ref(false);
    const detailLoading = ref(false);
    const error = ref<Error | null>(null);

    let requestToken = 0;
    let detailToken = 0;

    async function load(filters: AuditListFilters = {}) {
        const token = ++requestToken;
        loading.value = true;
        error.value = null;
        try {
            const result = await api.listAuditEntries({
                page: page.value,
                size: size.value,
                ...filters,
            });
            if (token !== requestToken) return;
            entries.value = result.entries;
            page.value = result.page;
            size.value = result.size;
            totalElements.value = result.totalElements;
            totalPages.value = result.totalPages;
        } catch (e) {
            if (token !== requestToken) return;
            entries.value = [];
            error.value = new Error(e instanceof Error ? e.message : String(e));
        } finally {
            if (token === requestToken) loading.value = false;
        }
    }

    async function loadDetail(type: AuditEntryType, id: string) {
        const token = ++detailToken;
        detailLoading.value = true;
        error.value = null;
        try {
            const detail = await api.getAuditEntry(type, id);
            if (token !== detailToken) return;
            selectedDetail.value = detail;
        } catch (e) {
            if (token !== detailToken) return;
            selectedDetail.value = null;
            error.value = new Error(e instanceof Error ? e.message : String(e));
        } finally {
            if (token === detailToken) detailLoading.value = false;
        }
    }

    function clearDetail() {
        detailToken++;
        selectedDetail.value = null;
        detailLoading.value = false;
    }

    return {
        entries,
        selectedDetail,
        page,
        size,
        totalElements,
        totalPages,
        loading,
        detailLoading,
        error,
        load,
        loadDetail,
        clearDetail,
    };
});
