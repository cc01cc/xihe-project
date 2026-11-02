import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { defineComponent, h } from "vue";
import SessionContextPanel from "../SessionContextPanel.vue";

// Ids live in the hoisted block: the module factory below runs during the import phase,
// i.e. before the module body's `const` declarations are initialised.
const { selectBranch, SESSION_ID, ROOT_BRANCH_ID, CHILD_BRANCH_ID } = vi.hoisted(() => ({
    selectBranch: vi.fn<(sessionId: string, id: string) => boolean>(),
    SESSION_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ROOT_BRANCH_ID: "44444444-4444-4444-8444-444444444444",
    CHILD_BRANCH_ID: "55555555-5555-4555-8555-555555555555",
}));

vi.mock("../../chat/stores/chat", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../chat/stores/chat")>();
    return {
        ...actual,
        useChatStore: () => ({
            getSessionBranches: () => [
                { branchId: ROOT_BRANCH_ID, parentBranchId: null, label: "main" },
                { branchId: CHILD_BRANCH_ID, parentBranchId: ROOT_BRANCH_ID, label: "child" },
            ],
            getSelectedBranchId: () => ROOT_BRANCH_ID,
            isStreaming: () => false,
            selectBranch,
        }),
    };
});

const i18n = createI18n({
    legacy: false,
    locale: "en",
    messages: {
        en: {
            workspace: { noSession: "No active session" },
            chat: {
                approvalModeLabel: "Approval",
                contextTemplateLabel: "Template",
                branchSelectorLabel: "Branch",
                branchMainPath: "Main path",
                branchPathOption: "Branch",
            },
            sessionSettings: { title: "Session settings" },
        },
    },
});

const PolicyStub = defineComponent({
    props: { sessionId: { type: String, default: "" } },
    setup: (props) => () =>
        h("div", { "data-testid": "stub-policy-controls", "data-session": props.sessionId }),
});
const TemplateStub = defineComponent({
    props: { sessionId: { type: String, default: "" } },
    setup: (props) => () =>
        h("div", { "data-testid": "stub-context-template", "data-session": props.sessionId }),
});
const ContextSourcesStub = defineComponent({
    props: { sessionId: { type: String, default: "" } },
    setup: (props) => () =>
        h("div", { "data-testid": "stub-context-sources", "data-session": props.sessionId }),
});

function mountPanel(sessionId: string | null = SESSION_ID) {
    return mount(SessionContextPanel, {
        props: { sessionId },
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
    selectBranch.mockReset();
    selectBranch.mockReturnValue(true);
});

describe("SessionContextPanel (PLAN-0626 M2)", () => {
    it("renders the four settings partitions with the pre-existing testids", async () => {
        // testid 稳定的意义：5 个 e2e spec 只需加"打开面板"一步，无需换选择器。
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="session-settings-expanded"]').exists()).toBe(true);
        for (const section of ["approval", "template", "context", "branch"]) {
            expect(
                wrapper.find(`[data-testid="session-settings-section-${section}"]`).exists(),
            ).toBe(true);
        }
        expect(wrapper.get('[data-testid="session-branch-select"]').element).toBeTruthy();
        // Every child control receives the panel's session, not a stale one.
        for (const stub of ["policy-controls", "context-template", "context-sources"]) {
            expect(wrapper.get(`[data-testid="stub-${stub}"]`).attributes("data-session")).toBe(
                SESSION_ID,
            );
        }
    });

    it("shows the empty state (and no controls) without a session", async () => {
        const wrapper = mountPanel(null);
        await flushPromises();

        expect(wrapper.get('[data-testid="session-context-panel-empty"]').text()).toContain(
            "No active session",
        );
        expect(wrapper.find('[data-testid="session-settings-expanded"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="stub-policy-controls"]').exists()).toBe(false);
        // The branch select must not be rendered with an empty session id.
        expect(wrapper.find('[data-testid="session-branch-select"]').exists()).toBe(false);
    });

    it("selects a branch through the shared store instead of owning branch state", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        await wrapper.get('[data-testid="session-branch-select"]').setValue(CHILD_BRANCH_ID);

        expect(selectBranch).toHaveBeenCalledWith(SESSION_ID, CHILD_BRANCH_ID);
    });

    it("rebinds the controls when the session changes", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        await wrapper.setProps({ sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });

        expect(wrapper.get('[data-testid="session-branch-select"]').attributes("id")).toBe(
            "session-branch-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        );
        expect(wrapper.get('[data-testid="stub-policy-controls"]').attributes("data-session")).toBe(
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        );
    });
});
