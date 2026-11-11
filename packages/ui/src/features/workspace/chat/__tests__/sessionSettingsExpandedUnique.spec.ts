import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h } from "vue";
import SessionSettingsPanel from "../components/SessionSettingsPanel.vue";
import { i18n } from "../../../../i18n";
import { api } from "../../../../composables/api";
import type * as apiModule from "../../../../composables/api";
import { usePolicyStore } from "../../../../stores/policy";
import { useSessionStore } from "../../../../stores/session";

/**
 * task-90 · 重复 testid 第 2 组的机器判据。
 *
 * 为什么单开一支 spec 而不是加进 `SessionSettingsPanel.spec.ts`：那支 spec 把
 * `SessionContextPanel` 整个 stub 掉了，而重复的第二个节点恰恰由它渲染 —— 用 stub
 * 去验"DOM 里只有一个"，等于用看不见的东西证明看得见的东西（这就是这个 bug 能在
 * 两支 spec 全绿的情况下活下来的原因）。
 *
 * 这里挂**真实组合**：SessionSettingsPanel（移动壳）→ 真实 SessionContextPanel（正文），
 * 只 stub 三层叶子控件（它们既不含争议 testid，也会去打网络）。判据是计数，不是注释。
 */

const { SESSION_ID, ROOT_BRANCH_ID, CHILD_BRANCH_ID } = vi.hoisted(() => ({
    SESSION_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ROOT_BRANCH_ID: "44444444-4444-4444-8444-444444444444",
    CHILD_BRANCH_ID: "55555555-5555-4555-8555-555555555555",
}));

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

// The real SessionContextPanel reads the branch projection from the chat store; the
// projection itself is not under test here, only the DOM shape it renders into.
vi.mock("../stores/chat", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../stores/chat")>();
    return {
        ...actual,
        useChatStore: () => ({
            getSessionBranches: () => [
                { branchId: ROOT_BRANCH_ID, parentBranchId: null, label: "main" },
                { branchId: CHILD_BRANCH_ID, parentBranchId: ROOT_BRANCH_ID, label: "child" },
            ],
            getSelectedBranchId: () => ROOT_BRANCH_ID,
            isStreaming: () => false,
            selectBranch: vi.fn<() => boolean>(),
        }),
    };
});

const PolicyStub = defineComponent({
    props: { sessionId: { type: String, default: "" } },
    setup: () => () => h("div", { "data-testid": "stub-policy-controls" }),
});
const TemplateStub = defineComponent({
    props: { sessionId: { type: String, default: "" } },
    setup: () => () => h("div", { "data-testid": "stub-context-template" }),
});
const ContextSourcesStub = defineComponent({
    props: { sessionId: { type: String, default: "" } },
    setup: () => () => h("div", { "data-testid": "stub-context-sources" }),
});

function mountPanel(isMobile: boolean) {
    return mount(SessionSettingsPanel, {
        props: {
            sessionId: SESSION_ID,
            branchOptions: [
                { branchId: ROOT_BRANCH_ID, label: "main" },
                { branchId: CHILD_BRANCH_ID, label: "child" },
            ],
            selectedBranchId: ROOT_BRANCH_ID,
            mainBranchId: ROOT_BRANCH_ID,
            isMobile,
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

/** Every `data-testid` in the rendered tree that belongs to the session-settings family. */
function sessionSettingsTestIds(root: Element | null): string[] {
    if (!root) return [];
    return Array.from(root.querySelectorAll('[data-testid^="session-settings"]')).map(
        (node) => node.getAttribute("data-testid") ?? "",
    );
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
    usePolicyStore().states[SESSION_ID] = {
        mode: "manual",
        loading: false,
        changing: false,
        loaded: true,
        error: null,
    };
    useSessionStore().sessions = [
        {
            id: SESSION_ID,
            title: "Session",
            createdAt: "2026-10-31T00:00:00Z",
            updatedAt: "2026-10-31T00:00:00Z",
            workspaceId: "workspace-1",
            contextTemplateLayer: "user",
            contextTemplateId: "user-template",
            contextTemplateVersion: 2,
        },
    ];
});

describe("session-settings-expanded is unique in the DOM (task-90)", () => {
    it("mobile sheet: wrapper + nested panel render exactly one expanded node", async () => {
        const wrapper = mountPanel(true);
        await flushPromises();

        // Closed: the sheet is rendered but v-show-hidden; the body is inside it.
        // The count assertion comes FIRST on purpose: on the pre-fix tree (wrapper carrying
        // the same testid) this is the line that fails with 2, and it must not be masked by
        // an earlier assertion about the shell's own name.
        expect(wrapper.findAll('[data-testid="session-settings-expanded"]')).toHaveLength(1);
        expect(wrapper.findAll('[data-testid="session-settings-mobile-sheet"]')).toHaveLength(1);

        await wrapper.get('[data-testid="session-settings-summary"]').trigger("click");

        // Open: still one — this is the assertion that fails on the pre-fix tree (2).
        expect(wrapper.findAll('[data-testid="session-settings-expanded"]')).toHaveLength(1);
        expect(wrapper.get('[data-testid="session-settings-expanded"]').isVisible()).toBe(true);

        // The shell and the body must not share a DOM id either: `aria-controls` on the
        // summary points at the shell, so a duplicate id made `getElementById` ambiguous.
        // (Queried inside the mounted root — `mount()` attaches to a detached element.)
        const root = wrapper.element as Element;
        expect(root.querySelectorAll(`[id="session-settings-panel-${SESSION_ID}"]`)).toHaveLength(
            1,
        );
        expect(root.querySelectorAll(`[id="session-settings-body-${SESSION_ID}"]`)).toHaveLength(1);

        wrapper.unmount();
    });

    it("mobile sheet: no testid in the session-settings family is rendered twice", async () => {
        const wrapper = mountPanel(true);
        await flushPromises();
        await wrapper.get('[data-testid="session-settings-summary"]').trigger("click");

        const ids = sessionSettingsTestIds(wrapper.element as Element);
        const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
        expect(duplicated).toEqual([]);
        // Sanity: the family really is rendered (an empty list would also have no duplicates).
        expect(ids).toContain("session-settings-expanded");
        expect(ids).toContain("session-settings-mobile-sheet");

        wrapper.unmount();
    });

    it("desktop: the chat column mounts no expanded node at all (the dock owns it)", async () => {
        const wrapper = mountPanel(false);
        await flushPromises();

        expect(wrapper.findAll('[data-testid="session-settings-mobile-sheet"]')).toHaveLength(0);
        expect(wrapper.findAll('[data-testid="session-settings-expanded"]')).toHaveLength(0);
        wrapper.unmount();
    });
});
