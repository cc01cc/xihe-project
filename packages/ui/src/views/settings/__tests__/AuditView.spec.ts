import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import { i18n } from "../../../i18n";
import { api } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";
import type {
    AuditEntry,
    AuditEntryDetail,
    AuditListResponse,
    SafePolicySummaryView,
} from "../../../types";

vi.mock("vue-router", () => ({
    useRoute: () =>
        ({
            name: "settings-audit",
            path: "/settings/audit",
            params: {},
            query: {},
            hash: "",
            fullPath: "/settings/audit",
            matched: [],
            redirectedFrom: undefined,
            meta: {},
        }) as RouteLocationNormalizedLoaded,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    RouterLink: { template: "<a><slot /></a>" },
}));

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listAuditEntries: vi.fn(),
            getAuditEntry: vi.fn(),
        },
    };
});

// Exact values produced by CP SafePolicySummary. Bypass upgrades an
// ask rule to `effect: 'allow'` with a non-null allowedBy, so this fixture mirrors that verdict.
const POLICY: SafePolicySummaryView = {
    effect: "allow",
    sourceLayer: "builtin",
    matchedRule: '{ write, "*", ask }',
    reason: "requires approval for domain write",
    mode: "auto",
    allowedBy: "auto@session",
    actionClass: "write",
    shape: "structured",
};

function auditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
    return {
        type: "mcp_invocation",
        id: "inv-1",
        toolCallId: "call-auto-1",
        status: "completed",
        summary: "write_file",
        source: "agent",
        createdAt: "2026-10-07T12:00:00Z",
        startedAt: "2026-10-07T11:59:00Z",
        finishedAt: "2026-10-07T12:00:10Z",
        policy: POLICY,
        ...overrides,
    };
}

const LIST: AuditEntry[] = [
    auditEntry(),
    auditEntry({
        id: "inv-ask",
        toolCallId: "call-ask-2",
        policy: {
            ...POLICY,
            effect: "ask",
            mode: "manual",
            allowedBy: null,
            matchedRule: '{ exec, "*", ask }',
        },
    }),
    auditEntry({
        id: "inv-deny",
        toolCallId: "call-deny-2",
        policy: {
            ...POLICY,
            effect: "deny",
            matchedRule: null,
            mode: null,
            allowedBy: null,
        },
    }),
    auditEntry({ id: "inv-legacy", toolCallId: "call-legacy-3", policy: undefined }),
    auditEntry({
        id: "inv-reuse-4",
        toolCallId: "call-reuse-4",
        policy: {
            ...POLICY,
            effect: "ask",
            mode: "manual",
            allowedBy: null,
            reused: true,
        },
    }),
    auditEntry({
        id: "inv-reuse-null-5",
        toolCallId: "call-reuse-null-5",
        policy: { ...POLICY, reused: null },
    }),
    auditEntry({
        id: "inv-reuse-false-6",
        toolCallId: "call-reuse-false-6",
        policy: { ...POLICY, reused: false },
    }),
    auditEntry({
        id: "inv-reuse-absent-7",
        toolCallId: "call-reuse-absent-7",
        policy: { ...POLICY },
    }),
    auditEntry({
        id: "inv-active",
        toolCallId: "call-active",
        status: "active",
        policy: undefined,
    }),
];

function listResponse(overrides: Partial<AuditListResponse> = {}): AuditListResponse {
    return {
        entries: LIST,
        page: 0,
        size: 20,
        totalElements: LIST.length,
        totalPages: 1,
        ...overrides,
    };
}

function detailFor(id: string): AuditEntryDetail {
    const found = LIST.find((item) => item.id === id) ?? LIST[0];
    if (!found) throw new Error(`unknown audit fixture: ${id}`);
    return {
        entry: found,
        timeline: [
            {
                sequence: 1,
                eventType: "invocation.opened",
                fromStatus: null,
                toStatus: "active",
                createdAt: "2026-10-07T11:59:00Z",
            },
            {
                sequence: 2,
                eventType: "attempt.succeeded",
                fromStatus: "started",
                toStatus: "succeeded",
                actorType: "cp",
                createdAt: "2026-10-07T12:00:05Z",
            },
        ],
        attempts: [
            {
                id: "attempt-1",
                stage: "agent_dispatch",
                retryNo: 0,
                module: "agent",
                status: "succeeded",
                durationMs: 125,
            },
        ],
    };
}

async function mountOnly() {
    const { default: AuditView } = await import("../AuditView.vue"),
        wrapper = mount(AuditView, { global: { plugins: [i18n] } });
    await flushPromises();
    return wrapper;
}

async function mountView(entryId = "inv-1") {
    const wrapper = await mountOnly(),
        entryRow = wrapper.find(`[data-testid="settings-audit-entry-${entryId}"]`);
    await entryRow.trigger("click");
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(api.listAuditEntries).mockResolvedValue(listResponse());
    vi.mocked(api.getAuditEntry).mockImplementation(async (_type, id) => detailFor(id));
});

describe("AuditView policy verdict (PLAN-0328 T1.15)", () => {
    it("renders the server projection verbatim, keyed by toolCallId", async () => {
        const wrapper = await mountView("inv-1"),
            block = wrapper.find('[data-testid="settings-audit-policy-call-auto-1"]');
        expect(block.exists()).toBe(true);
        expect(block.text()).toContain("策略判定");
        expect(
            wrapper.find('[data-testid="settings-audit-policy-call-auto-1-effect"]').text(),
        ).toBe("允许");
        expect(
            wrapper.find('[data-testid="settings-audit-policy-call-auto-1-matched-rule"]').text(),
        ).toBe('{ write, "*", ask }');
        expect(
            wrapper.find('[data-testid="settings-audit-policy-call-auto-1-source-layer"]').text(),
        ).toBe("内置层");
        expect(wrapper.find('[data-testid="settings-audit-policy-call-auto-1-mode"]').text()).toBe(
            "自动放行",
        );
        expect(block.text()).toContain("工具调用: call-auto-1");
    });

    it("keeps a plain ask verdict on the ask rendering", async () => {
        const wrapper = await mountView("inv-ask"),
            ask = wrapper.find('[data-testid="settings-audit-policy-call-ask-2"]');
        expect(ask.exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-audit-policy-call-ask-2-effect"]').text()).toBe(
            "询问",
        );
        expect(
            wrapper.find('[data-testid="settings-audit-policy-call-ask-2-matched-rule"]').text(),
        ).toBe('{ exec, "*", ask }');
        expect(
            wrapper.find('[data-testid="settings-audit-policy-call-ask-2-source-layer"]').text(),
        ).toBe("内置层");
        expect(wrapper.find('[data-testid="settings-audit-policy-call-ask-2-mode"]').text()).toBe(
            "手动审批",
        );
        expect(
            wrapper.find('[data-testid="settings-audit-policy-call-ask-2-allowed-by"]').exists(),
        ).toBe(false);
    });

    it("highlights a mode-based allowance with the exact allowedBy value", async () => {
        const wrapper = await mountView("inv-1"),
            allowedBy = wrapper.find(
                '[data-testid="settings-audit-policy-call-auto-1-allowed-by"]',
            );
        expect(allowedBy.exists()).toBe(true);
        expect(allowedBy.text()).toContain("由 auto 放行");
        expect(allowedBy.text()).toContain("auto@session");
    });

    it("preserves nullable matchedRule, mode and allowedBy without fabricating verdict defaults", async () => {
        const wrapper = await mountView("inv-deny");

        expect(
            wrapper.find('[data-testid="settings-audit-policy-call-deny-2-effect"]').text(),
        ).toBe("拒绝");
        expect(
            wrapper.find('[data-testid="settings-audit-policy-call-deny-2-matched-rule"]').text(),
        ).toBe("未命中具体规则");
        expect(wrapper.find('[data-testid="settings-audit-policy-call-deny-2-mode"]').text()).toBe(
            "未提供",
        );
        expect(
            wrapper.find('[data-testid="settings-audit-policy-call-deny-2-allowed-by"]').exists(),
        ).toBe(false);
    });

    it("renders an explicit no-verdict state for legacy rows instead of a fake verdict", async () => {
        const wrapper = await mountView("inv-legacy"),
            absent = wrapper.find('[data-testid="settings-audit-policy-absent-inv-legacy"]');
        expect(absent.exists()).toBe(true);
        expect(absent.text()).toBe("无判定记录（旧记录或非 MCP 路径）");
        expect(wrapper.find('[data-testid="settings-audit-policy-call-legacy-3"]').exists()).toBe(
            false,
        );
    });

    it("marks a session-reuse dispatch with an icon and text, and never for null/absent/false", async () => {
        const wrapper = await mountView("inv-reuse-4"),
            reuse = wrapper.find('[data-testid="settings-audit-policy-call-reuse-4-reused"]');
        expect(reuse.exists()).toBe(true);
        expect(reuse.text()).toBe("由复用放行");
        // Not color-only: the marker carries an icon and the reuse text next to the verdict.
        expect(reuse.find("svg").exists()).toBe(true);
        expect(
            wrapper.find('[data-testid="settings-audit-policy-call-reuse-4-effect"]').text(),
        ).toBe("询问");

        for (const entryId of ["inv-reuse-null-5", "inv-reuse-false-6", "inv-reuse-absent-7"]) {
            const other = await mountView(entryId),
                toolCallId = LIST.find((item) => item.id === entryId)?.toolCallId ?? "";
            expect(
                other.find(`[data-testid="settings-audit-policy-${toolCallId}-reused"]`).exists(),
            ).toBe(false);
        }
    });

    it("keeps reason, actionClass and shape inside the expandable detail", async () => {
        const wrapper = await mountView("inv-1"),
            block = wrapper.find('[data-testid="settings-audit-policy-call-auto-1"]');
        expect(block.find("details").exists()).toBe(true);
        expect(block.find("summary").text()).toBe("判定详情");
        expect(
            wrapper.find('[data-testid="settings-audit-policy-call-auto-1-reason"]').text(),
        ).toBe("requires approval for domain write");
        expect(
            wrapper.find('[data-testid="settings-audit-policy-call-auto-1-action-class"]').text(),
        ).toBe("write");
        expect(wrapper.find('[data-testid="settings-audit-policy-call-auto-1-shape"]').text()).toBe(
            "结构化",
        );
    });
});

describe("AuditView audit read surface (PLAN-0466)", () => {
    it("renders an active MCP invocation as in progress, not successful", async () => {
        const wrapper = await mountOnly(),
            activeRow = wrapper.find('[data-testid="settings-audit-entry-inv-active"]'),
            status = activeRow.findAll("span").find((item) => item.text() === "active");

        expect(status).toBeDefined();
        expect(status?.classes()).toContain("text-amber-600");
        expect(status?.classes()).not.toContain("text-emerald-600");
    });

    it("lists audit entries and routes detail reads through the audit API", async () => {
        const wrapper = await mountOnly();

        expect(api.listAuditEntries).toHaveBeenCalledWith({
            page: 0,
            size: 20,
            status: undefined,
            type: undefined,
        });
        expect(wrapper.find('[data-testid="settings-audit-entry-inv-1"]').exists()).toBe(true);
        expect(wrapper.text()).toContain("write_file");
        expect(wrapper.find('[data-testid="settings-audit-empty"]').exists()).toBe(false);

        await wrapper.find('[data-testid="settings-audit-entry-inv-1"]').trigger("click");
        await flushPromises();

        expect(api.getAuditEntry).toHaveBeenCalledWith("mcp_invocation", "inv-1");
        expect(wrapper.find('[data-testid="settings-audit-items"]').text()).toContain("write_file");
    });

    it("keeps the attempts and timeline sections fed by the domain history", async () => {
        const wrapper = await mountView("inv-1");

        expect(wrapper.find('[data-testid="settings-audit-events"]').text()).toContain(
            "invocation.opened",
        );
        expect(wrapper.find('[data-testid="settings-audit-events"]').text()).toContain("active");
        expect(wrapper.text()).toContain("agent_dispatch");
        expect(wrapper.text()).toContain("125ms");
    });

    it("applies the status and type filters to the list request", async () => {
        const wrapper = await mountOnly();

        await wrapper.find('[data-testid="settings-audit-status"]').setValue("failed");
        await flushPromises();
        expect(api.listAuditEntries).toHaveBeenLastCalledWith({
            status: "failed",
            type: undefined,
            page: 0,
            size: 20,
        });

        await wrapper.find('[data-testid="settings-audit-type"]').setValue("chat_run");
        await flushPromises();
        expect(api.listAuditEntries).toHaveBeenLastCalledWith({
            status: "failed",
            type: "chat_run",
            page: 0,
            size: 20,
        });
    });

    it("paginates audit entries and keeps navigation within the returned bounds", async () => {
        vi.mocked(api.listAuditEntries)
            .mockResolvedValueOnce(listResponse({ entries: LIST.slice(0, 1), totalPages: 2 }))
            .mockResolvedValueOnce(
                listResponse({ entries: LIST.slice(1, 2), page: 1, totalPages: 2 }),
            )
            .mockResolvedValueOnce(listResponse({ entries: LIST.slice(0, 1), totalPages: 2 }));
        const wrapper = await mountOnly(),
            [previous, next] = wrapper
                .findAll("button")
                .filter((button) => ["上一页", "下一页"].includes(button.text()));

        expect(previous).toBeDefined();
        expect(next).toBeDefined();
        expect(previous?.attributes("disabled")).toBeDefined();
        expect(wrapper.text()).toContain("1 / 2");

        await next?.trigger("click");
        await flushPromises();

        expect(api.listAuditEntries).toHaveBeenLastCalledWith({
            page: 1,
            size: 20,
            status: undefined,
            type: undefined,
        });
        expect(wrapper.text()).toContain("2 / 2");
        expect(wrapper.find('[data-testid="settings-audit-entry-inv-ask"]').exists()).toBe(true);
        expect(previous?.attributes("disabled")).toBeUndefined();

        await previous?.trigger("click");
        await flushPromises();

        expect(api.listAuditEntries).toHaveBeenLastCalledWith({
            page: 0,
            size: 20,
            status: undefined,
            type: undefined,
        });
        expect(wrapper.text()).toContain("1 / 2");
    });

    it("surfaces list errors and keeps the empty detail state", async () => {
        vi.mocked(api.listAuditEntries).mockRejectedValue(new Error("503 unavailable"));
        const wrapper = await mountOnly();

        expect(wrapper.text()).toContain("503 unavailable");
        expect(wrapper.find('[data-testid="settings-audit-no-selection"]').exists()).toBe(true);
    });

    it("shows the empty state when the filtered set is empty", async () => {
        vi.mocked(api.listAuditEntries).mockResolvedValue(
            listResponse({ entries: [], totalElements: 0, totalPages: 0 }),
        );
        const wrapper = await mountOnly();

        expect(wrapper.find('[data-testid="settings-audit-empty"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-audit-no-selection"]').exists()).toBe(true);
    });
});
