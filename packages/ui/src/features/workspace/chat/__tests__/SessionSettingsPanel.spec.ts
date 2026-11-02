import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h, ref, watchEffect } from "vue";
import SessionSettingsPanel from "../components/SessionSettingsPanel.vue";
import { i18n } from "../../../../i18n";
import { toast } from "vue-sonner";
import { api } from "../../../../composables/api";
import type * as apiModule from "../../../../composables/api";
import { usePolicyStore } from "../../../../stores/policy";
import { useSessionStore } from "../../../../stores/session";

vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            getPolicyMode: vi.fn<typeof apiModule.api.getPolicyMode>(),
            setPolicyMode: vi.fn<typeof apiModule.api.setPolicyMode>(),
        },
    };
});

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string) => void>(),
    },
}));

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ROOT_BRANCH_ID = "44444444-4444-4444-8444-444444444444",
    CHILD_BRANCH_ID = "55555555-5555-4555-8555-555555555555";

const branchOptions = [
    { branchId: ROOT_BRANCH_ID, label: "主路径" },
    { branchId: CHILD_BRANCH_ID, label: "- 分支 55555555" },
];

const templateSummary = ref<{ label: string | null; loading: boolean; failed: boolean }>({
    label: null,
    loading: false,
    failed: false,
});

const TemplateStub = defineComponent({
    props: { sessionId: { type: String, default: "" } },
    emits: ["update:summary"],
    setup(_props, { emit }) {
        watchEffect(() => emit("update:summary", { ...templateSummary.value }));
        return () => h("div", { "data-testid": "stub-context-template" });
    },
});

// PLAN-0626 M2: the four partitions live in the dock panel; mobile hosts the same
// component in place, so this spec only needs to see that it was rendered.
const SessionContextPanelStub = defineComponent({
    props: { sessionId: { type: String, default: null } },
    setup: () => () => h("div", { "data-testid": "session-context-panel-stub" }),
});

function setPolicyMode(mode: "auto" | "manual" | null) {
    usePolicyStore().states[SESSION_ID] = {
        mode,
        loading: false,
        changing: false,
        loaded: mode !== null,
        error: null,
    };
}

function setSessionBinding(template: { id: string; version: number } | null) {
    useSessionStore().sessions = [
        {
            id: SESSION_ID,
            title: "Session",
            createdAt: "2026-10-31T00:00:00Z",
            updatedAt: "2026-10-31T00:00:00Z",
            workspaceId: "workspace-1",
            contextTemplateLayer: template ? "user" : null,
            contextTemplateId: template?.id ?? null,
            contextTemplateVersion: template?.version ?? null,
        },
    ];
}

function mountPanel(overrides: { selectedBranchId?: string; isMobile?: boolean } = {}) {
    return mount(SessionSettingsPanel, {
        props: {
            sessionId: SESSION_ID,
            branchOptions,
            selectedBranchId: overrides.selectedBranchId ?? ROOT_BRANCH_ID,
            mainBranchId: ROOT_BRANCH_ID,
            isMobile: overrides.isMobile ?? false,
        },
        global: {
            plugins: [i18n],
            stubs: {
                SessionContextPanel: SessionContextPanelStub,
                SessionContextTemplate: TemplateStub,
            },
        },
    });
}

beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(api.getPolicyMode).mockResolvedValue({
        sessionId: SESSION_ID,
        mode: "manual",
        sessionRules: 0,
    });
    vi.mocked(api.setPolicyMode).mockResolvedValue({
        sessionId: SESSION_ID,
        mode: "manual",
        scope: "session",
    });
    templateSummary.value = { label: null, loading: false, failed: false };
    setPolicyMode("manual");
    setSessionBinding({ id: "user-template", version: 2 });
});

describe("SessionSettingsPanel collapsed summary", () => {
    it("renders one read-only summary line with the current approval / template / branch values", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        const summary = wrapper.get('[data-testid="session-settings-summary"]');
        // PLAN-0626 M2: on desktop the summary is an entry, not an expander, so it must
        // not advertise `aria-expanded` (that would promise a disclosure it does not do).
        expect(summary.attributes("aria-expanded")).toBeUndefined();
        expect(summary.attributes("aria-label")).toBe("在侧栏打开会话设置");
        expect(summary.get('[data-testid="session-settings-summary-approval"]').text()).toContain(
            "手动审批",
        );
        expect(summary.get('[data-testid="session-context-template-current"]').text()).toContain(
            "user-template v2",
        );
        expect(summary.get('[data-testid="session-settings-summary-branch"]').text()).toContain(
            "主路径",
        );
        // Collapsed by default: the four legacy always-on rows are gone.
        // 2026-11-03: on desktop the panel is now NOT MOUNTED at all (the dock owns it);
        // asserting "exists but hidden" would have kept the duplicate-instance bug alive —
        // 真机 e2e 曾因桌面端多挂一份隐藏面板导致所有内部 testid 命中 2 个元素。
        expect(wrapper.find('[data-testid="session-settings-expanded"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("keeps every risk state visible while collapsed", async () => {
        setPolicyMode("auto");
        setSessionBinding(null);
        const wrapper = mountPanel({ selectedBranchId: CHILD_BRANCH_ID });
        await flushPromises();

        expect(wrapper.find('[data-testid="session-settings-expanded"]').exists()).toBe(false);
        // 1) auto approval warning + one-click remediation stay visible.
        const autoBanner = wrapper.get('[data-testid="session-policy-auto-banner"]');
        expect(autoBanner.isVisible()).toBe(true);
        expect(autoBanner.text()).toContain("自动放行已开启");
        expect(autoBanner.get('[data-testid="session-policy-auto-close"]').isVisible()).toBe(true);
        // 2) unbound request template.
        expect(wrapper.get('[data-testid="session-settings-risk-template"]').isVisible()).toBe(
            true,
        );
        // 3) non-main-path branch.
        expect(wrapper.get('[data-testid="session-settings-risk-branch"]').isVisible()).toBe(true);
        wrapper.unmount();
    });

    it("does not repeat the same unbound sentence twice in the collapsed row", async () => {
        setSessionBinding(null);
        const wrapper = mountPanel();
        await flushPromises();

        const summaryText = wrapper.get('[data-testid="session-settings-summary"]').text();
        expect(summaryText.split("模板未绑定").length - 1).toBe(1);
        expect(wrapper.get('[data-testid="session-context-template-current"]').text()).toContain(
            "—",
        );
        wrapper.unmount();
    });

    it("uses nowrap + ellipsis instead of stacking labels in a narrow column", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        const values = wrapper.get('[data-testid="session-settings-summary"] span.flex');
        expect(values.classes()).toContain("whitespace-nowrap");
        expect(wrapper.get('[data-testid="session-context-template-current"]').classes()).toContain(
            "truncate",
        );
        wrapper.unmount();
    });
});

describe("SessionSettingsPanel expansion", () => {
    it("opens the dock panel on desktop instead of expanding in place (M2)", async () => {
        // PLAN-0626 M2: the desktop summary row is an ENTRY to the dock's `context` panel.
        const wrapper = mountPanel();
        await flushPromises();

        await wrapper.get('[data-testid="session-settings-summary"]').trigger("click");

        expect(wrapper.emitted("open-context-panel")).toHaveLength(1);
        expect(
            wrapper.get('[data-testid="session-settings-summary"]').attributes("aria-expanded"),
        ).toBeUndefined();
        wrapper.unmount();
    });

    it("keeps the in-place expansion on mobile by rendering the same panel there (Q1 = C)", async () => {
        const wrapper = mountPanel({ isMobile: true });
        await flushPromises();

        await wrapper.get('[data-testid="session-settings-summary"]').trigger("click");

        const expanded = wrapper.get('[data-testid="session-settings-expanded"]');
        expect(expanded.isVisible()).toBe(true);
        expect(
            wrapper.get('[data-testid="session-settings-summary"]').attributes("aria-expanded"),
        ).toBe("true");
        // The four partitions live in SessionContextPanel only — mobile hosts the same
        // component instead of a second copy (no duplicated DOM, single set of testids).
        expect(expanded.find('[data-testid="session-context-panel-stub"]').exists()).toBe(true);
        // Mobile must not ask for a dock panel it cannot show.
        expect(wrapper.emitted("open-context-panel")).toBeUndefined();

        await wrapper.get('[data-testid="session-settings-summary"]').trigger("click");
        expect(
            wrapper.get('[data-testid="session-settings-summary"]').attributes("aria-expanded"),
        ).toBe("false");
        expect(
            wrapper.get('[data-testid="session-settings-expanded"]').attributes("style"),
        ).toContain("display: none");
        wrapper.unmount();
    });

    it("closes auto approval from the always-visible warning and hides the warning", async () => {
        setPolicyMode("auto");
        const wrapper = mountPanel();
        await flushPromises();

        await wrapper.get('[data-testid="session-policy-auto-close"]').trigger("click");
        await flushPromises();

        expect(api.setPolicyMode).toHaveBeenCalledWith(SESSION_ID, "manual");
        expect(wrapper.find('[data-testid="session-policy-auto-banner"]').exists()).toBe(false);
        wrapper.unmount();
    });

    // PLAN-0582 S5-10 / S4 audit P1-2: a safety action's failure must stay visible.
    it("surfaces a failed auto-approval close instead of failing silently", async () => {
        setPolicyMode("auto");
        vi.mocked(api.setPolicyMode).mockRejectedValueOnce(new Error("boom"));
        const wrapper = mountPanel();
        await flushPromises();

        await wrapper.get('[data-testid="session-policy-auto-close"]').trigger("click");
        await flushPromises();

        expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toContain("关闭自动放行失败");
        expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
        // Optimistic hiding would claim it is off while it is still on.
        expect(wrapper.get('[data-testid="session-policy-auto-banner"]').isVisible()).toBe(true);
        wrapper.unmount();
    });

    it("reflects a bound template name coming from the template control", async () => {
        setSessionBinding(null);
        templateSummary.value = { label: "Workspace Template v3", loading: false, failed: false };
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.get('[data-testid="session-context-template-current"]').text()).toContain(
            "Workspace Template v3",
        );
        expect(wrapper.find('[data-testid="session-settings-risk-template"]').exists()).toBe(false);
        wrapper.unmount();
    });

    // PLAN-0582 S3b / S4 audit P1-1: the collapsed row must not leak projection state.
    it("shows a placeholder while the template projection is still loading", async () => {
        templateSummary.value = { label: null, loading: true, failed: false };
        const wrapper = mountPanel();
        await flushPromises();

        const current = wrapper.get('[data-testid="session-context-template-current"]');
        // No raw template id flash on the first frame.
        expect(current.text()).not.toContain("user-template");
        expect(current.text()).toContain("—");
        // Loading is not a risk: the chip must not flash either.
        expect(wrapper.find('[data-testid="session-settings-risk-template"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("reports a failed template projection as a risk instead of a clean row", async () => {
        templateSummary.value = { label: null, loading: false, failed: true };
        const wrapper = mountPanel();
        await flushPromises();

        const current = wrapper.get('[data-testid="session-context-template-current"]');
        // The raw id is unreadable, so failure shows localized copy instead.
        expect(current.text()).not.toContain("user-template");
        expect(current.text()).toContain("模板加载失败");
        // A failed projection is itself a risk: the chip must stay visible.
        const risk = wrapper.get('[data-testid="session-settings-risk-template"]');
        expect(risk.isVisible()).toBe(true);
        expect(risk.text()).toContain("模板加载失败");
        wrapper.unmount();
    });
});
