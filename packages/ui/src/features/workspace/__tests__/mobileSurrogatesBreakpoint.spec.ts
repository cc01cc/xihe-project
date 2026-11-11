import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import type { Router } from "vue-router";
import type * as apiModule from "../../../composables/api";
import { api } from "../../../composables/api";
import { i18n } from "../../../i18n";
import { useSessionStore } from "../../../stores/session";

/**
 * task-122 · 形态③（D-978）推广：`md:hidden` 移动替身在**跨断点**后是否被收回。
 *
 * ## 判据结构（三段缺一段就是假绿）
 * 1. **它真开了**：移动视口下打开替身 ⇒ 替身自己的根 testid 在；
 * 2. **桌面宿主真在**：跨断点后 `workspace-workbench` 在（否则"只剩 1 个"毫无意义）；
 * 3. **同名节点数**：该面板组件在同一棵 DOM 里出现几次。
 *
 * ## 为什么计数是"真实节点"而不是"代理节点"
 * 移动替身与桌面 dock 挂的是**同一个面板组件**（`[源码]`：`MobileWorkspaceSheet → FileTreePanel`；
 * `WorkspaceWorkbench` 桌面侧 `:712` 也是 `FileTreePanel`；监控/改动/成员同构）。因此把面板换成
 * "保留真实根 testid 的模块级替身"后，`workspace-tree-head` 的个数 = **同一面板被挂载几次**。
 * 被判的是"宿主有没有收回"，不是面板内部实现。
 *
 * ## 本卡的结论（读数的来源见下）
 * - **文件替身**：跨断点后 `workspace-tree-head` 曾是 **2**（真重复）—— 当时用 `it.fails` 作**钉子**钉住；
 *   `task-124` 修复后**转正为 `it`**，现在是"必须恰好 1 个"的判据（保留这条历史：这里曾预期失败）。
 * - **监控/改动替身**：跨断点后 `mobile-changes-sheet` **仍挂载**、桌面 dock 也起了 ⇒ **宿主共存**成立；
 *   同名节点是否出现取决于桌面 dock 是否正好展开到同一面板（默认 collapsed）⇒ 当初用 `it.fails` 钉"未收回"，
 *   `task-124` 修复后同样**转正为 `it`**。
 * - **成员替身**：收口已由 task-116 的 `MobileChatSheet.isMobile` 提供 ⇒ 本卡只补"覆盖到它"的判据（绿）。
 */

vi.mock("vue-router", () => ({
    createRouter: () => ({
        push: vi.fn<() => void>(),
        replace: vi.fn<() => void>(),
        beforeEach: vi.fn<() => void>(),
        afterEach: vi.fn<() => void>(),
        isReady: () => Promise.resolve(),
        currentRoute: { value: {} },
    }),
    createWebHistory: () => ({}),
    useRoute: () => ({
        params: { workspaceId: "workspace-1" },
        path: "/workspace/workspace-1",
        query: {},
    }),
    useRouter: () => ({
        push: vi.fn<Router["push"]>(),
        replace: vi.fn<Router["replace"]>(),
    }),
}));

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            getSessions: vi.fn<typeof apiModule.api.getSessions>(),
            createSession: vi.fn<typeof apiModule.api.createSession>(),
            getWorkspaceAgents: vi.fn<typeof apiModule.api.getWorkspaceAgents>(),
            getAgentTemplates: vi.fn<typeof apiModule.api.getAgentTemplates>(),
            getSelfPermissions: vi.fn<typeof apiModule.api.getSelfPermissions>(),
        },
    };
});

// 面板替身：保留各面板**真实的根 testid**，让"同一面板被挂载几次"可数。
vi.mock("../components/FileTreePanel.vue", () => ({
    default: { template: '<div data-testid="workspace-tree-head" />' },
}));
vi.mock("../components/WorkspaceChangesPanel.vue", () => ({
    default: { template: '<div data-testid="workspace-changes-panel" />' },
}));
vi.mock("../monitor/SessionMonitorPanel.vue", () => ({
    default: { template: '<div data-testid="session-monitor-panel" />' },
}));
vi.mock("../components/SessionParticipantsPanel.vue", () => ({
    default: { template: '<div data-testid="session-participants-panel" />' },
}));
vi.mock("../chat/components/ChatPanel.vue", () => ({
    default: { template: '<div data-testid="chat-panel-stub" />' },
}));
vi.mock("../components/FileEditor.vue", () => ({
    default: { template: '<div data-testid="file-editor-stub" />' },
}));

/**
 * Sheet 壳替身：**照 `open` 门控**（reka 的 `SheetContent` 只在 open 为真时挂载内容；jsdom 里真实
 * portal 挂不出来属环境限制而非产品行为）。`SheetContent` 替身保留 attrs 透传，所以各替身自己的
 * `data-testid`（`mobile-files-sheet` / `mobile-changes-sheet` / `mobile-members-sheet`）照原样落在 DOM 上。
 */
vi.mock("../../../components/ui/sheet/Sheet.vue", async () => {
    const { defineComponent, h } = await import("vue");
    return {
        default: defineComponent({
            props: { open: { type: Boolean, default: false } },
            setup:
                (props, { slots }) =>
                () =>
                    props.open
                        ? h("div", { "data-testid": "stub-sheet-root" }, slots.default?.())
                        : null,
        }),
    };
});
vi.mock("../../../components/ui/sheet/SheetContent.vue", async () => {
    const { defineComponent, h } = await import("vue");
    return {
        default: defineComponent({
            name: "SheetContent",
            emits: ["pointerDownOutside"],
            setup:
                (_, { slots, attrs }) =>
                () =>
                    h("div", attrs, slots.default?.()),
        }),
    };
});
vi.mock("../../../components/ui/sheet/SheetHeader.vue", () => ({
    default: { template: "<div><slot /></div>" },
}));
vi.mock("../../../components/ui/sheet/SheetTitle.vue", () => ({
    default: { template: "<div><slot /></div>" },
}));
vi.mock("../../../components/ui/sheet/SheetDescription.vue", () => ({
    default: { template: "<div><slot /></div>" },
}));
vi.mock("@lucide/vue", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return actual;
});

import WorkspaceView from "../pages/WorkspaceView.vue";
import WorkspaceWorkbench from "../components/WorkspaceWorkbench.vue";
import MobileChatSheet from "../components/MobileChatSheet.vue";

const mockedApi = vi.mocked(api, true);
const SESSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/**
 * 可编程的 `matchMedia`：jsdom 不实现它 ⇒ `useMediaQuery` 恒 false（永远桌面）。本卡要判"跨断点"，
 * 必须能真的翻断点，所以 spec 内自带一个带 change 监听的假实现。
 * 只有 **767px 那条查询**接到 `mediaState`：其它查询（如 `(max-width: 1439px)` 窄视口判定）一律
 * 按"宽屏"回答，免得顺带把布局切到另一条分支、把要判的东西搅浑。
 */
const mediaState = { mobile: true };
const mediaTargets = new Set<{ query: string; emit: (matches: boolean) => void }>();

function matchFor(query: string): boolean {
    if (query.includes("767px")) return mediaState.mobile;
    if (query.includes("min-width")) return !mediaState.mobile;
    return false;
}

function installMatchMedia() {
    Object.defineProperty(window, "matchMedia", {
        writable: true,
        configurable: true,
        value: (query: string) => {
            const handlers = new Set<(event: MediaQueryListEvent) => void>();
            mediaTargets.add({
                query,
                emit: (matches) =>
                    handlers.forEach((h) => h({ matches, media: query } as MediaQueryListEvent)),
            });
            return {
                get matches() {
                    return matchFor(query);
                },
                media: query,
                onchange: null,
                addEventListener: (_type: string, handler: EventListenerOrEventListenerObject) => {
                    handlers.add(handler as (event: MediaQueryListEvent) => void);
                },
                removeEventListener: () => handlers.clear(),
                addListener: () => {},
                removeListener: () => {},
                dispatchEvent: () => false,
            } as unknown as MediaQueryList;
        },
    });
}

/** 翻断点：先改事实，再把 change 事件发给所有已注册的 MediaQueryList。 */
async function resizeTo(mobile: boolean) {
    mediaState.mobile = mobile;
    mediaTargets.forEach((target) => {
        if (target.query.includes("767px") || target.query.includes("min-width")) {
            target.emit(matchFor(target.query));
        }
    });
    await settle();
}

function mountView(): VueWrapper {
    // attachTo：计数一律读 document（sheet 内容会 teleport）；脱离 body 挂载会永远数到 0。
    return mount(WorkspaceView, { global: { plugins: [i18n] }, attachTo: document.body });
}

function count(testid: string): number {
    return document.querySelectorAll(`[data-testid="${testid}"]`).length;
}

async function settle() {
    await nextTick();
    await nextTick();
    await flushPromises();
}

beforeEach(() => {
    document.body.innerHTML = "";
    mediaState.mobile = true;
    mediaTargets.clear();
    installMatchMedia();
    localStorage.clear();
    localStorage.setItem("xihe-token", "mock-token");
    localStorage.setItem("xihe-user", JSON.stringify({ id: "user-1", email: "test@xihe.local" }));
    localStorage.setItem(
        "xihe-workspace",
        JSON.stringify({ id: "workspace-1", name: "Mock Workspace", ownerId: "user-1" }),
    );
    setActivePinia(createPinia());
    mockedApi.getSessions.mockResolvedValue({
        sessions: [
            {
                id: SESSION_A,
                title: "A",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                workspaceId: "workspace-1",
                archived: false,
            },
        ],
    });
    mockedApi.getWorkspaceAgents.mockResolvedValue([]);
    mockedApi.getAgentTemplates.mockResolvedValue({ templates: [] });
    mockedApi.getSelfPermissions.mockResolvedValue({
        userId: "user-1",
        instanceCapabilities: [],
        instancePermissions: [],
        workspaces: [{ workspaceId: "workspace-1", capabilities: [], permissions: [] }],
        hasInstanceAdminRole: false,
    } as never);
});

describe("移动替身的跨断点收口（task-122 / D-978 形态③）", () => {
    it("机制自检：移动视口下替身能打开，跨断点后桌面分支能起来（三段判据的前两段）", async () => {
        useSessionStore().currentSessionId = SESSION_A;
        const wrapper = mountView();
        await settle();

        wrapper.findComponent(WorkspaceWorkbench).vm.$emit("files");
        await settle();
        expect(count("mobile-files-sheet")).toBe(1);
        expect(count("workspace-tree-head")).toBe(1);
        expect(count("workspace-workbench")).toBe(0);

        await resizeTo(false);
        expect(count("workspace-workbench")).toBe(1);
        wrapper.unmount();
    });

    it("文件替身跨断点必须收回：`workspace-tree-head` 在同一 DOM 里恰好 1 个（task-124 转正）", async () => {
        useSessionStore().currentSessionId = SESSION_A;
        const wrapper = mountView();
        await settle();
        wrapper.findComponent(WorkspaceWorkbench).vm.$emit("files");
        await settle();

        await resizeTo(false);

        expect(count("workspace-tree-head")).toBe(1);
        wrapper.unmount();
    });

    it("监控/改动替身跨断点必须收回：`mobile-changes-sheet` 在桌面分支起来后不再挂载（task-124 转正）", async () => {
        useSessionStore().currentSessionId = SESSION_A;
        const wrapper = mountView();
        await settle();
        wrapper.findComponent(WorkspaceWorkbench).vm.$emit("mobile-toggle-monitor");
        await settle();
        expect(count("mobile-changes-sheet")).toBe(1);

        await resizeTo(false);

        expect(count("mobile-changes-sheet")).toBe(0);
        wrapper.unmount();
    });

    it("成员替身：收口由 `MobileChatSheet.isMobile` 覆盖（task-116 的正例）", async () => {
        const wrapper = mount(MobileChatSheet, {
            props: { sessionId: SESSION_A, isMobile: true },
            global: { plugins: [createPinia(), i18n] },
            attachTo: document.body,
        });
        await settle();
        (wrapper.vm as unknown as { toggle: () => void }).toggle();
        await settle();
        await wrapper.get('[data-testid="members-entry-mobile"]').trigger("click");
        await settle();
        expect(count("mobile-members-sheet")).toBe(1);
        expect(count("session-participants-panel")).toBe(1);

        // 跨断点：WorkspaceView 把 isMobileViewport 传给替身，替身必须连成员面一起收回。
        await wrapper.setProps({ isMobile: false });
        await settle();
        expect(count("mobile-members-sheet")).toBe(0);
        expect(count("session-participants-panel")).toBe(0);
        wrapper.unmount();
    });
});
