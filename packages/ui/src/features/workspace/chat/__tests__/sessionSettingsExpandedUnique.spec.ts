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
import { paneTabId, SESSION_CONFIG_VIEW } from "../../lib/panelTabs";
import type * as chatModule from "../stores/chat";

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
    const actual = await importOriginal<typeof chatModule>();
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

/**
 * task-52 / DSD-1463（`DSD-1450` + `D-1907` rev10）· 唯一入口判据。
 *
 * 裁定原文：会话设置唯一入口 = 摘要行（`session-settings-summary`），**不新增行内入口**。
 * 摘要行下的 `session-settings-summary-approval` / `-branch` / `session-settings-risk-*` 是它的
 * 读数子节点（`<span>`），不是入口；所以这里按**激活面**口径筛：`<button>` / `<a>` /
 * `role=button|link|tab|menuitem` / 带 `aria-expanded` 的家族节点。产品若被改成「两个入口」，
 * 第二个可激活节点一出现就被抓到 —— 判据是计数，不是注释。
 * （对照 task-90 那条族内去重：那条只抓同 testid 重名，抓不到「两个不同名的入口」。）
 */
const ENTRY_ROLES = new Set(["button", "link", "tab", "menuitem"]);

function sessionSettingsEntryIds(root: Element | null): string[] {
    if (!root) return [];
    return Array.from(root.querySelectorAll('[data-testid^="session-settings"]'))
        .filter((node) => {
            const role = node.getAttribute("role");
            return (
                node.tagName === "BUTTON" ||
                node.tagName === "A" ||
                (role !== null && ENTRY_ROLES.has(role)) ||
                node.getAttribute("aria-expanded") !== null
            );
        })
        .map((node) => node.getAttribute("data-testid") ?? "");
}

/**
 * 唯一入口断言的**可调用形态** —— 正反两用：真实树返回唯一那个摘要行；假夹具直接抛，
 * 抛就是把「拆成两个入口必须报红」变成可执行事实（`:213` 的反向用例调它）。
 */
function assertSingleSessionSettingsEntry(root: Element | null, where: string): string {
    const entries = sessionSettingsEntryIds(root);
    const first = entries[0];
    if (entries.length !== 1 || first !== "session-settings-summary") {
        throw new Error(
            where +
                `: 会话设置入口应为 1 个且必须是 session-settings-summary，实测 ` +
                entries.length +
                ` 个 [` +
                entries.join(", ") +
                `]（DSD-1463：不新增行内入口）`,
        );
    }
    return first;
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
/**
 * task-52 · DSD-1463（裁定 A「会话设置唯一入口 = 摘要行，不新增行内入口」）的机器判据。
 *
 * 本段判什么：
 * ① 真实组合里，带 `session-settings` 前缀的**可激活节点**恰好 1 个，且必须是
 *    `session-settings-summary`（桌面 / 移动两分支都判）—— 这就是 DSD-1450 取消顶部入口、
 *    D-1907 rev10 把摘要行定为快捷开关之后，「同一面板不得有两个入口」的负向断言；
 * ② 入口唯一 ⇒ 打开动作唯一：桌面点摘要行只 emit **一次** `open-context-panel`，且它指向的右栏
 *    容器页签就是 `pane:right:session-config:<sid>`（`dock-tab-` 前缀的页签 testid 契约，
 *    真实页面上的「页签已开 + 再点只聚焦」由 `features/workspace/__tests__/WorkspaceView.spec.ts:414-437`
 *    用真实 WorkspaceView 判，本段只钉**身份**：入口 → pane id → 页签 testid 三者同值）；
 * ③ 移动端没有 dock ⇒ 同一入口只就地展开 sheet，**不** emit（否则等于又开一条右栏通道）；
 * ④ 反向用例：把摘要行拆成两个入口的假夹具必须让上面那条断言报红。
 *
 * 本段不判：`SessionSettingsPanel` 之外还有没有别的入口（那属于整页/真实栈口径，见
 * `packages/ui/e2e/real/ui-baseline.spec.ts` 与 WorkspaceView 那条用例）。
 */
describe("session-settings has exactly one entry (task-52 / DSD-1463)", () => {
    it("desktop: the summary row is the only activate-able node in the family", async () => {
        const wrapper = mountPanel(false);
        await flushPromises();

        const entry = assertSingleSessionSettingsEntry(wrapper.element as Element, "desktop");
        expect(entry).toBe("session-settings-summary");
        // 反向自检：家族节点确实渲染出来了（空树也会「只有 0 个入口」）。
        expect(sessionSettingsTestIds(wrapper.element as Element)).toContain(
            "session-settings-summary",
        );
        // 桌面没有 sheet（正文归 dock）⇒ 家族里不该出现第二个可激活节点。
        expect(wrapper.findAll('[data-testid="session-settings-mobile-sheet"]')).toHaveLength(0);

        wrapper.unmount();
    });

    it("desktop: clicking the single entry asks the dock exactly once for the session-config pane", async () => {
        const wrapper = mountPanel(false);
        await flushPromises();

        // pane 身份链路：产品纯函数 → 容器页签 id → 右栏页签 testid（WorkspaceDock 的
        // `testid-prefix="dock-tab-"`，见 WorkspaceDock.vue:385）。三者必须同值，否则摘要行
        // 指向的「会话配置」页签与真实页签行就是两样东西。
        const paneId = paneTabId("right", SESSION_CONFIG_VIEW, SESSION_ID);
        expect(paneId).toBe(`pane:right:session-config:${SESSION_ID}`);
        expect(`dock-tab-${paneId}`).toBe(`dock-tab-pane:right:session-config:${SESSION_ID}`);

        await wrapper.get('[data-testid="session-settings-summary"]').trigger("click");
        expect(wrapper.emitted("open-context-panel")).toHaveLength(1);
        // 再点一次：仍是同一个入口 ⇒ 不多开通道（幂等由 dock 侧保证，这里只判不新增事件源）。
        await wrapper.get('[data-testid="session-settings-summary"]').trigger("click");
        expect(wrapper.emitted("open-context-panel")).toHaveLength(2);

        wrapper.unmount();
    });

    it("mobile: the same single entry expands the sheet in place and never asks for the dock", async () => {
        const wrapper = mountPanel(true);
        await flushPromises();

        assertSingleSessionSettingsEntry(wrapper.element as Element, "mobile");
        await wrapper.get('[data-testid="session-settings-summary"]').trigger("click");
        expect(wrapper.emitted("open-context-panel")).toBeUndefined();
        expect(wrapper.get('[data-testid="session-settings-expanded"]').isVisible()).toBe(true);

        wrapper.unmount();
    });

    it("negative fixture: a second entry in the family makes the assertion fail", async () => {
        // 假夹具：摘要行 + 行内设置按钮（DSD-1450 取消过、DSD-1463 明令禁止的形态）。
        const TwoEntries = defineComponent({
            setup: () => () =>
                h("section", { "data-testid": "session-settings" }, [
                    h("button", { "data-testid": "session-settings-summary" }, "summary"),
                    h("button", { "data-testid": "session-settings-inline" }, "settings"),
                ]),
        });
        const wrapper = mount(TwoEntries);
        expect(() =>
            assertSingleSessionSettingsEntry(wrapper.element as Element, "fixture"),
        ).toThrowError(/实测 2 个 \[session-settings-summary, session-settings-inline\]/);
        // 真夹具的反面同样要红：把唯一入口改名，也必须是「不是 summary」而不是放行。
        const Renamed = defineComponent({
            setup: () => () =>
                h("section", { "data-testid": "session-settings" }, [
                    h("button", { "data-testid": "session-settings-entry" }, "summary"),
                ]),
        });
        const renamed = mount(Renamed);
        expect(() =>
            assertSingleSessionSettingsEntry(renamed.element as Element, "renamed"),
        ).toThrowError(/实测 1 个 \[session-settings-entry\]/);
        wrapper.unmount();
        renamed.unmount();
    });
});
