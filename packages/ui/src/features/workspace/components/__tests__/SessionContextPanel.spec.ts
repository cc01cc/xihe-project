import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { defineComponent, h } from "vue";
import SessionContextPanel from "../SessionContextPanel.vue";
import { setOnlySelectValue } from "../../../../test-utils/select";
import type * as apiModule from "../../../../composables/api";
import type * as chatModule from "../../chat/stores/chat";
import type { SessionTierState } from "../../../../types";

// Ids live in the hoisted block: the module factory below runs during the import phase,
// i.e. before the module body's `const` declarations are initialised.
const {
    selectBranch,
    getSessionTier,
    SESSION_ID,
    ROOT_BRANCH_ID,
    CHILD_BRANCH_ID,
    ORPHAN_BRANCH_ID,
    branchState,
} = vi.hoisted(() => {
    const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ROOT = "44444444-4444-4444-8444-444444444444",
        CHILD = "55555555-5555-4555-8555-555555555555",
        ORPHAN = "66666666-6666-4666-8666-666666666666",
        branch = (branchId: string, parentBranchId: string | null) => ({
            branchId,
            parentBranchId,
            forkPointMessageId: null,
            forkPointRunId: null,
            createdAt: "2026-11-22T00:00:00Z",
        });
    return {
        selectBranch: vi.fn<(sessionId: string, id: string) => boolean>(),
        getSessionTier: vi.fn<(sessionId: string) => Promise<SessionTierState>>(),
        SESSION_ID: SESSION,
        ROOT_BRANCH_ID: ROOT,
        CHILD_BRANCH_ID: CHILD,
        ORPHAN_BRANCH_ID: ORPHAN,
        // task-786：可变夹具 —— 三种 label 输入（根 / 正常子 / 父分支不在列表里的孤儿）
        // 必须由真实 `useSessionBranches` 计算，而不是让 store 直接喂 label。
        branchState: {
            branches: [branch(ROOT, null), branch(CHILD, ROOT)] as Array<{
                branchId: string;
                parentBranchId: string | null;
                forkPointMessageId: null;
                forkPointRunId: null;
                createdAt: string;
            }>,
            selectedId: ROOT as string,
        },
    };
});

vi.mock("../../chat/stores/chat", async (importOriginal) => {
    const actual = await importOriginal<typeof chatModule>();
    return {
        ...actual,
        useChatStore: () => ({
            getSessionBranches: () => branchState.branches,
            getSelectedBranchId: () => branchState.selectedId,
            isStreaming: () => false,
            selectBranch,
        }),
    };
});

// D-1908: the panel now renders the three-tier control instead of the approval dropdown,
// so the api module must be stubbed — otherwise the store's GET /tier escapes to fetch().
vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: { ...actual.api, getSessionTier },
    };
});

const i18n = createI18n({
    legacy: false,
    locale: "en",
    messages: {
        en: {
            workspace: { noSession: "No active session", viewerReadOnly: "Read-only workspace" },
            chat: {
                approvalModeLabel: "Approval",
                contextTemplateLabel: "Template",
                branchSelectorLabel: "Branch",
                branchMainPath: "Main path",
                branchPathOption: "Branch",
            },
            sessionSettings: {
                title: "Session settings",
                tierLabel: "Permission tier",
                tierView: "View only",
                tierWorkspace: "Workspace edits",
                tierFull: "Full access",
                tierNoPermission: "Cannot change: {reason}",
                tierInherited: "Inherited · workspace default: {tier}",
                tierOverride: "Session override: {tier}",
                tierNoWorkspaceDefault: "Inherited · no workspace default",
                tierUnsupported: "{tier} (not supported here)",
                tierUnsupportedHint: "This workspace caps edits inside the workspace.",
                tierReasonViewer: "the workspace is read-only",
                tierReasonNotOwner: "only the session creator can change it",
                tierReasonNoAtom: "missing session:permission:configure",
            },
        },
    },
});

const TierStub = defineComponent({
    props: { sessionId: { type: String, default: "" } },
    setup: (props) => () =>
        h("div", { "data-testid": "stub-tier-controls", "data-session": props.sessionId }),
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
                SessionTierSelect: TierStub,
                SessionContextTemplate: TemplateStub,
                ContextSourcesU1: ContextSourcesStub,
            },
        },
    });
}

beforeEach(() => {
    setActivePinia(createPinia());
    branchState.branches = [
        {
            branchId: ROOT_BRANCH_ID,
            parentBranchId: null,
            forkPointMessageId: null,
            forkPointRunId: null,
            createdAt: "2026-11-22T00:00:00Z",
        },
        {
            branchId: CHILD_BRANCH_ID,
            parentBranchId: ROOT_BRANCH_ID,
            forkPointMessageId: null,
            forkPointRunId: null,
            createdAt: "2026-11-22T00:00:01Z",
        },
    ];
    branchState.selectedId = ROOT_BRANCH_ID;
    selectBranch.mockReset();
    selectBranch.mockReturnValue(true);
    getSessionTier.mockReset();
    getSessionTier.mockResolvedValue({
        tier: "workspace",
        source: "workspace",
        workspaceTier: "workspace",
        canConfigure: true,
        denyReason: null,
        available: ["view", "workspace", "full"],
    });
});

describe("SessionContextPanel (PLAN-0626 M2)", () => {
    it("renders the four settings partitions with the pre-existing testids", async () => {
        // testid 稳定的意义：5 个 e2e spec 只需加"打开面板"一步，无需换选择器。
        const wrapper = mountPanel();
        await flushPromises();

        // task-90: exactly one node carries `session-settings-expanded`, and its DOM id is
        // unique (it used to collide with the mobile sheet wrapper's id).
        expect(wrapper.findAll('[data-testid="session-settings-expanded"]')).toHaveLength(1);
        expect(wrapper.get('[data-testid="session-settings-expanded"]').attributes("id")).toBe(
            `session-settings-body-${SESSION_ID}`,
        );
        for (const section of ["approval", "template", "context", "branch"]) {
            expect(
                wrapper.find(`[data-testid="session-settings-section-${section}"]`).exists(),
            ).toBe(true);
        }
        expect(wrapper.get('[data-testid="session-branch-select"]').element).toBeTruthy();
        // Every child control receives the panel's session, not a stale one.
        for (const stub of ["tier-controls", "context-template", "context-sources"]) {
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
        expect(wrapper.find('[data-testid="stub-tier-controls"]').exists()).toBe(false);
        // The branch select must not be rendered with an empty session id.
        expect(wrapper.find('[data-testid="session-branch-select"]').exists()).toBe(false);
    });

    it("selects a branch through the shared store instead of owning branch state", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        await setOnlySelectValue(wrapper, CHILD_BRANCH_ID);

        expect(selectBranch).toHaveBeenCalledWith(SESSION_ID, CHILD_BRANCH_ID);
    });

    it("rebinds the controls when the session changes", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        await wrapper.setProps({ sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });

        expect(wrapper.get('[data-testid="session-branch-select"]').attributes("id")).toBe(
            "session-branch-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        );
        expect(wrapper.get('[data-testid="stub-tier-controls"]').attributes("data-session")).toBe(
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        );
    });

    /**
     * task-786：`- 分支 617c28e1` 的两种可能输入必须被单测钉住 ——
     * ① 正常子分支（父分支在返回列表里）⇒ 深度前缀 `- ` + 「分支 <id8>」；
     * ② 父分支不在列表里（孤儿）⇒ 不回退成子项缩进，只给「分支 <id8>」。
     * 根分支永远显示「主路径」。标签由 `useSessionBranches` 计算，store 只供 wire 数据。
     */
    describe("branch option labels", () => {
        async function labelOf(branchId: string): Promise<string> {
            branchState.selectedId = branchId;
            const wrapper = mountPanel();
            await flushPromises();
            return wrapper.get('[data-testid="session-branch-select"]').attributes("title") ?? "";
        }

        it("labels the root branch (parentBranchId === null) as the main path", async () => {
            expect(await labelOf(ROOT_BRANCH_ID)).toBe("Main path");
        });

        it("labels a normal child branch with a single depth prefix", async () => {
            expect(await labelOf(CHILD_BRANCH_ID)).toBe(`- Branch ${CHILD_BRANCH_ID.slice(0, 8)}`);
        });

        it("labels an orphan branch (parent not in the list) without an indentation prefix", async () => {
            branchState.branches = [
                {
                    branchId: ORPHAN_BRANCH_ID,
                    parentBranchId: ROOT_BRANCH_ID,
                    forkPointMessageId: null,
                    forkPointRunId: null,
                    createdAt: "2026-11-22T00:00:02Z",
                },
            ];
            expect(await labelOf(ORPHAN_BRANCH_ID)).toBe(`Branch ${ORPHAN_BRANCH_ID.slice(0, 8)}`);
        });
    });
});
