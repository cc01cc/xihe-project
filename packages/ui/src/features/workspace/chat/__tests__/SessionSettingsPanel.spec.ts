import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h, ref, watchEffect } from "vue";
import SessionSettingsPanel from "../components/SessionSettingsPanel.vue";
import { i18n } from "../../../../i18n";
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

const PolicyStub = defineComponent({
    setup: () => () => h("div", { "data-testid": "stub-policy-controls" }),
});
const ContextSourcesStub = defineComponent({
    setup: () => () => h("div", { "data-testid": "stub-context-sources" }),
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

function mountPanel(overrides: { selectedBranchId?: string } = {}) {
    return mount(SessionSettingsPanel, {
        props: {
            sessionId: SESSION_ID,
            branchOptions,
            selectedBranchId: overrides.selectedBranchId ?? ROOT_BRANCH_ID,
            mainBranchId: ROOT_BRANCH_ID,
            branchDisabled: false,
        },
        global: {
            plugins: [i18n],
            stubs: {
                SessionPolicyControls: PolicyStub,
                SessionContextTemplate: TemplateStub,
                ContextSourcesU1: ContextSourcesStub,
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
        expect(summary.attributes("aria-expanded")).toBe("false");
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
        expect(wrapper.get('[data-testid="session-settings-expanded"]').isVisible()).toBe(false);
        wrapper.unmount();
    });

    it("keeps every risk state visible while collapsed", async () => {
        setPolicyMode("auto");
        setSessionBinding(null);
        const wrapper = mountPanel({ selectedBranchId: CHILD_BRANCH_ID });
        await flushPromises();

        expect(wrapper.get('[data-testid="session-settings-expanded"]').isVisible()).toBe(false);
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
    it("expands into the two-level panel with the four partitions", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        await wrapper.get('[data-testid="session-settings-summary"]').trigger("click");

        const expanded = wrapper.get('[data-testid="session-settings-expanded"]');
        expect(expanded.isVisible()).toBe(true);
        expect(
            wrapper.get('[data-testid="session-settings-summary"]').attributes("aria-expanded"),
        ).toBe("true");
        for (const section of ["approval", "template", "context", "branch"]) {
            expect(
                wrapper.find(`[data-testid="session-settings-section-${section}"]`).exists(),
            ).toBe(true);
        }
        expect(wrapper.get('[data-testid="session-branch-select"]').element).toBeTruthy();

        await wrapper.get('[data-testid="session-settings-summary"]').trigger("click");
        expect(
            wrapper.get('[data-testid="session-settings-summary"]').attributes("aria-expanded"),
        ).toBe("false");
        expect(
            wrapper.get('[data-testid="session-settings-expanded"]').attributes("style"),
        ).toContain("display: none");
        wrapper.unmount();
    });

    it("emits the selected branch instead of owning branch state", async () => {
        const wrapper = mountPanel();
        await flushPromises();
        await wrapper.get('[data-testid="session-settings-summary"]').trigger("click");

        await wrapper.get('[data-testid="session-branch-select"]').setValue(CHILD_BRANCH_ID);

        expect(wrapper.emitted("select-branch")?.at(-1)).toEqual([CHILD_BRANCH_ID]);
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
});
