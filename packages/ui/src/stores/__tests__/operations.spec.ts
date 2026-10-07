import { describe, expect, it, vi, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useOperationStore } from "../operations";
import { api } from "../../composables/api";
import type { AuditEntry, AuditEntryDetail, AuditListResponse } from "../../types";

vi.mock("../../composables/api", () => ({
    api: {
        listAuditEntries: vi.fn(),
        getAuditEntry: vi.fn(),
        listOperations: vi.fn(),
        getOperationTrace: vi.fn(),
    },
}));

const auditEntries = (overrides: Partial<AuditListResponse> = {}): AuditListResponse => ({
    entries: [],
    page: 0,
    size: 20,
    totalElements: 0,
    totalPages: 0,
    ...overrides,
});

const chatEntry: AuditEntry = {
    type: "chat_run",
    id: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    status: "succeeded",
    summary: "audit-model",
    createdAt: "2026-10-07T12:00:00Z",
};

const detail: AuditEntryDetail = {
    entry: chatEntry,
    timeline: [
        {
            sequence: 1,
            eventType: "terminal",
            fromStatus: "running",
            toStatus: "succeeded",
            createdAt: "2026-10-07T12:01:00Z",
        },
    ],
    attempts: [],
};

describe("operations store", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.resetAllMocks();
    });

    it("loads audit entry pages", async () => {
        const store = useOperationStore();
        vi.mocked(api.listAuditEntries).mockResolvedValue(
            auditEntries({
                entries: [chatEntry],
                page: 2,
                size: 20,
                totalElements: 45,
                totalPages: 3,
            }),
        );

        await store.load({ status: "failed", page: 2, size: 20 });

        expect(api.listAuditEntries).toHaveBeenCalledWith({
            status: "failed",
            page: 2,
            size: 20,
        });
        expect(store.entries).toHaveLength(1);
        expect(store.entries[0]?.id).toBe(chatEntry.id);
        expect(store.page).toBe(2);
        expect(store.totalElements).toBe(45);
        expect(store.totalPages).toBe(3);
        expect(store.loading).toBe(false);
        expect(store.error).toBeNull();
    });

    it("passes the type filter through to the audit list route", async () => {
        const store = useOperationStore();
        vi.mocked(api.listAuditEntries).mockResolvedValue(auditEntries());

        await store.load({ type: "mcp_invocation", page: 0, size: 20 });

        expect(api.listAuditEntries).toHaveBeenCalledWith({
            type: "mcp_invocation",
            page: 0,
            size: 20,
        });
    });

    it("drops stale list responses", async () => {
        const store = useOperationStore();
        let rejectFirst: (reason: Error) => void = () => undefined;
        vi.mocked(api.listAuditEntries)
            .mockImplementationOnce(
                () =>
                    new Promise((_, reject) => {
                        rejectFirst = reject;
                    }),
            )
            .mockResolvedValueOnce(
                auditEntries({
                    entries: [chatEntry],
                    page: 1,
                    totalElements: 30,
                    totalPages: 2,
                }),
            );

        const first = store.load({ page: 0, size: 20 });
        await store.load({ page: 1, size: 20 });
        rejectFirst(new Error("request failed"));

        await first;
        expect(store.entries).toHaveLength(1);
        expect(store.page).toBe(1);
        expect(store.error).toBeNull();
        expect(store.loading).toBe(false);
    });

    it("surfaces list load errors", async () => {
        const store = useOperationStore();
        vi.mocked(api.listAuditEntries).mockRejectedValue(new Error("503 unavailable"));

        await store.load({ page: 0, size: 20 });

        expect(store.error?.message).toBe("503 unavailable");
        expect(store.entries).toHaveLength(0);
        expect(store.loading).toBe(false);
    });

    it("loads one audit entry detail with its timeline", async () => {
        const store = useOperationStore();
        vi.mocked(api.getAuditEntry).mockResolvedValue(detail);

        await store.loadDetail("chat_run", chatEntry.id);

        expect(api.getAuditEntry).toHaveBeenCalledWith("chat_run", chatEntry.id);
        expect(store.selectedDetail?.entry.id).toBe(chatEntry.id);
        expect(store.selectedDetail?.timeline).toHaveLength(1);
        expect(store.detailLoading).toBe(false);
        expect(store.error).toBeNull();
    });

    it("drops stale detail responses", async () => {
        const store = useOperationStore();
        let rejectFirst: (reason: Error) => void = () => undefined;
        vi.mocked(api.getAuditEntry)
            .mockImplementationOnce(
                () =>
                    new Promise((_, reject) => {
                        rejectFirst = reject;
                    }),
            )
            .mockResolvedValueOnce(detail);

        const first = store.loadDetail("chat_run", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        await store.loadDetail("chat_run", chatEntry.id);
        rejectFirst(new Error("request failed"));

        await first;
        expect(store.selectedDetail?.entry.id).toBe(chatEntry.id);
        expect(store.error).toBeNull();
        expect(store.detailLoading).toBe(false);
    });

    it("surfaces detail load errors", async () => {
        const store = useOperationStore();
        vi.mocked(api.getAuditEntry).mockRejectedValue(new Error("404 AUDIT_ENTRY_NOT_FOUND"));

        await store.loadDetail("chat_run", chatEntry.id);

        expect(store.error?.message).toBe("404 AUDIT_ENTRY_NOT_FOUND");
        expect(store.selectedDetail).toBeNull();
        expect(store.detailLoading).toBe(false);
    });

    it("clears the selected detail", async () => {
        const store = useOperationStore();
        vi.mocked(api.getAuditEntry).mockResolvedValue(detail);
        await store.loadDetail("chat_run", chatEntry.id);
        expect(store.selectedDetail).not.toBeNull();

        store.clearDetail();

        expect(store.selectedDetail).toBeNull();
        expect(store.detailLoading).toBe(false);
    });
});
