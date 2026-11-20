import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import { setActivePinia, createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import type { Router } from "vue-router";
import WorkspaceView from "../pages/WorkspaceView.vue";
import WorkspaceAgentManagementDialog from "../components/WorkspaceAgentManagementDialog.vue";
import { useSessionStore } from "../../../stores/session";
import { useChatStore } from "../chat/stores/chat";
import { api, ApiError } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";
import { openSelect, selectItemValues, setSelectValue } from "../../../test-utils/select";
// task-52 / batch-02 ②：**真实全局 i18n** —— `stores/session.ts#createSession` 的默认标题读
// 的是 `i18n.global`（store 没有组件实例），本文件下方那个局部 `createI18n` 不参与求值。
import { i18n as globalI18n } from "../../../i18n";

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
            createAgentPrincipal: vi.fn<typeof apiModule.api.createAgentPrincipal>(),
            // PLAN-0622：创建入口由 CP 能力投影驱动（缺这个 mock 会 fail-closed 到禁用）。
            getSelfPermissions: vi.fn<typeof apiModule.api.getSelfPermissions>(),
        },
    };
});

const mockedApi = vi.mocked(api, true);

const SESSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    SESSION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const i18n = createI18n({
    legacy: false,
    locale: "en",
    messages: {
        en: {
            workspace: {
                panelCode: "Code",
                panelChanges: "Changes",
                panelMonitor: "Monitor",
                chatHeader: "Workspace chat",
                noSession: "No active session",
                createSession: "New chat",
                // task-52：新建会话的默认标题（`stores/session.ts#createSession` 的默认参数）。
                sessionDefaultTitle: "Untitled session",
                usageCostUnmapped: "Not priced",
                usageCostNoteNoTokenCounts: "no token counts",
                usageCostNoteNoPricing: "model not in pricing config",
                usageCostNoteUnknown: "No cost explanation",
                usageSourceReal: "Real billing",
                usageSourceEstimated: "Estimated",
                usageSourceFallback: "Usage fallback",
                chooseAgentTitle: "Choose an Agent",
                chooseAgentLabel: "Choose Agent",
                chooseAgentPlaceholder: "Select Agent",
                noBoundAgent: "No bound Agent",
                noEnabledAgent: "The bound Agents are disabled",
                openAgentManagement: "Open Agent management",
                agentLoadFailed: "Failed to load Agents",
                agentManagement: "Agent management",
                activeAgent: "Active Agent",
                agentManagementDescription: "Manage Workspace Agents",
                boundAgents: "Bound Agents",
                refreshAgents: "Refresh",
                loadingAgents: "Loading Agents",
                noAgentCapabilities: "No tool permissions",
                defaultAgentTemplate: "Default template",
                unbindAgent: "Unbind",
                editAgentCap: "Edit cap",
                createAgentPrincipal: "Create Agent",
                agentName: "Agent name",
                agentCreatePermissionNote: "CREATE_ACCOUNT required",
                agentCapNote: "Choose cap",
                bindAgent: "Bind Agent",
                saveAgentCap: "Save cap",
                agentActionRead: "Read",
                agentActionWrite: "Write",
                agentActionDelete: "Delete",
                agentActionExec: "Execute",
                agentActionNetwork: "Network",
                agentActionCredential: "Credential",
                agentResourceFor: "Resource for {action}",
                agentCreatedUnbound: "Created but unbound",
                agentBindFailed: "Bind failed",
                agentCreateFailed: "Create failed",
                agentSaveFailed: "Save failed",
                agentUnbindFailed: "Unbind failed",
                confirmAgentUnbind: "Confirm unbind",
                cancel: "Cancel",
                closePanel: "Close",
                // task-88：主列行尾右栏开合图标 + 右栏「+」/空态文案。
                dockToggleOpen: "Expand the right panel",
                dockToggleClose: "Collapse the right panel",
                containerPlusNew: "New tab: choose a panel type",
                dockTabOpen: "Open",
                dockEmptyHint: "No panels are open yet. Use + above to pick one.",
                containerEmpty: "No tabs in this container",
                expandFiles: "Expand the file tree",
                collapseFiles: "Collapse the file tree",
                toggleCode: "Toggle the code panel",
                toggleDiff: "Toggle the changes panel",
                toggleMonitor: "Toggle the monitor panel",
            },
        },
    },
});

const stubs = {
    ChatPanel: {
        emits: ["open-context-panel"],
        template:
            '<div data-testid="chat-panel-stub"><button data-testid="chat-open-context" @click="$emit(\'open-context-panel\')" /></div>',
    },
    SessionContextPanel: {
        props: { sessionId: { type: String, default: null } },
        template: '<div data-testid="session-context-panel-stub" />',
    },
    FileEditor: { template: '<div data-testid="file-editor-stub" />' },
    // S3a: the collapse control lives in the file-tree panel head, so the stub
    // exposes it with the same id the old toolbar button had.
    FileTreePanel: {
        emits: ["collapse"],
        template: `<div data-testid="file-tree-stub"><button data-testid="workspace-toolbar-toggle-tree" @click="$emit('collapse')" /></div>`,
    },
    WorkspaceChangesPanel: { template: '<div data-testid="changes-panel-stub" />' },
    SessionMonitorPanel: { template: '<div data-testid="session-monitor-stub" />' },
};

/**
 * BL-376 / task-152：**本文件所有挂载都必须经此函数登记**，`afterEach` 统一 `unmount()`。
 *
 * <p>原因与 `WorkspaceWorkbench.spec.ts:130-172` 同一根因：布局持久化是 250 ms 合并写入
 * （`createWorkspaceLayoutWriter`，`WorkspaceWorkbench.vue:179-187` 的 deep watch → `schedule`）。
 * 不卸载的实例会把 pending timer 活到下一条用例里落地，用**上一条用例**的几何（比如它开过的
 * `code`/`changes` 页签）覆盖下一条用例刚种下的固定布局 —— 本文件 `:435` 那条用例此前就因此恒红：
 * 期望 `dockTabs:[files,monitor]`，实测被追加 `code`（或 `changes`）。</p>
 *
 * <p>卸载会把 pending 值 flush 在本用例内（`WorkspaceWorkbench.vue:206` 的 `onBeforeUnmount`），
 * 下一条用例的 `beforeEach` 里的 `localStorage.clear()` 就能清掉它。</p>
 */
const mountedWrappers: VueWrapper[] = [];

function mountView(): VueWrapper {
    const wrapper = mount(WorkspaceView, { global: { plugins: [i18n], stubs } });
    mountedWrappers.push(wrapper);
    return wrapper;
}

/**
 * task-137（D-1907 图标簇收敛）：打开右栏面板的**唯一入口** —— 主列行尾开合图标
 * `workspace-dock-toggle` → 右栏页签行「+」→ 类型项 `dock-reopen-item-<id>`。
 * 旧的六颗工具栏图标（`workspace-toolbar-*`）已整体退役。幂等：已开就只选中。
 */
async function openPanel(wrapper: VueWrapper, id: string): Promise<void> {
    const toggle = wrapper.get('[data-testid="workspace-dock-toggle"]');
    if (toggle.attributes("aria-pressed") !== "true") await toggle.trigger("click");
    await settle();
    const tab = wrapper.find(`[data-testid="dock-tab-${id}"]`);
    if (tab.exists()) {
        await tab.trigger("click");
    } else {
        await wrapper.get('[data-testid="workspace-container-plus-right"]').trigger("click");
        await wrapper.get(`[data-testid="dock-reopen-item-${id}"]`).trigger("click");
    }
    await settle();
    await flushPromises();
}

async function settle() {
    await nextTick();
    await nextTick();
}

/**
 * 显式「开右栏 + 断言树本体渲染」的用例必须跑在**宽档视口**。
 *
 * <p>jsdom 默认 1024：右栏一开就吃掉 360，主列低于舒适线 ⇒ 挤压模型让树让位（`squeeze.treeYielded`
 * ⇒ `effectiveTreeCollapsed` 为 true），于是面板体渲染成 rail 而不是树。那是**视口**的决定，
 * 不是 fold 判据要测的东西；把它们混在一起，判据就成了「当前挤压阈值色不色」的测量仪
 * （task-94 正在改这层模型，阈值会继续动）。</p>
 */
async function withWideViewport(run: () => Promise<void>): Promise<void> {
    const previousWidth = window.innerWidth;
    window.innerWidth = 1920;
    window.dispatchEvent(new Event("resize"));
    try {
        await run();
    } finally {
        window.innerWidth = previousWidth;
        window.dispatchEvent(new Event("resize"));
    }
}

beforeEach(() => {
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
            {
                id: SESSION_B,
                title: "B",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                workspaceId: "workspace-1",
                archived: false,
            },
        ],
    });
    mockedApi.getWorkspaceAgents.mockResolvedValue([]);
    mockedApi.getSelfPermissions.mockResolvedValue({
        userId: "user-1",
        instanceCapabilities: [],
        instancePermissions: [],
        workspaces: [
            {
                workspaceId: "workspace-1",
                workspaceAdmin: true,
                permissions: [{ actionClass: "MANAGE_WORKSPACE_AGENTS", resource: "workspace-1" }],
            },
        ],
    } as never);
    mockedApi.getAgentTemplates.mockImplementation(async (layer) => ({
        layer,
        workspaceId: layer === "workspace" ? "workspace-1" : null,
        templates:
            layer === "user"
                ? [
                      {
                          id: "template-1",
                          name: "Stored template",
                          systemPrompt: "Frozen prompt",
                          toolMode: "workspace",
                          roleId: "role-1",
                          provider: "openai",
                          model: "gpt-example",
                      },
                  ]
                : [],
    }));
    mockedApi.createAgentPrincipal.mockResolvedValue({
        principalId: "principal-created",
        templateId: "template-1",
        templateName: "Stored template",
        createdAt: new Date().toISOString(),
    });
});

afterEach(() => {
    // 见 mountView 上方注释：不卸载的实例会让 250 ms 合并写入跨用例落地（顺序敏感）。
    for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount();
});

describe("WorkspaceView workbench layout (PLAN-0582 S2)", () => {
    /**
     * task-65 A 段（D-1777/D-1778）翻转本判据：树**不再**是中栏里的一列，而是右栏容器的一个
     * 面板（面板 id = files）。因此「树可见」与「dock 关闭」不再能并存 ——
     * 默认布局（本 spec 的 jsdom 视口 < 1800）右栏收起、且 dockTabs 为空 ⇒ 树无从渲染。
     * 这与 `WorkspaceWorkbench.spec.ts` 的「C2 已知缺口」是同一条产品事实，不是本测试的遗憾。
     */
    it("renders the conversation as the main column with the dock closed（树是右栏面板，故不渲染）", async () => {
        useSessionStore().currentSessionId = SESSION_A;
        const wrapper = mountView();
        await settle();
        await flushPromises();

        expect(wrapper.find('[data-testid="workspace-conversation"]').exists()).toBe(true);
        expect(
            wrapper
                .find('[data-testid="workspace-conversation"]')
                .find('[data-testid="chat-panel-stub"]')
                .exists(),
        ).toBe(true);

        // S2 ruling #3: the dock defaults to closed — no panel, no panel content.
        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="session-monitor-stub"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="file-editor-stub"]').exists()).toBe(false);
        // 树是右栏面板 ⇒ 右栏没渲染时它也不渲染。重开入口在主列行尾的开合图标（不是树上）。
        expect(wrapper.find('[data-testid="workspace-file-tree"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="workspace-file-rail"]').exists()).toBe(false);
        // task-137：旧的 files 图标读数改为行尾开合图标的展开态（默认收起 ⇒ false）。
        expect(
            wrapper.get('[data-testid="workspace-dock-toggle"]').attributes("aria-pressed"),
        ).toBe("false");
    });

    /**
     * task-144 ③（Lead 2026-11-17 批）：折叠 = **files 面板体收成 rail**，右栏与其余页签照常渲染。
     * 旧判据只断言「树没了 + 展开键在」，因此「整栏一起被换成 rail」也能过；这里补上
     * **可达性**读数：右栏行、dock 本体、其它页签仍在。
     */
    it("collapses the files panel into a 40px rail inside the panel body and expands it again", async () => {
        useSessionStore().currentSessionId = SESSION_A;
        await withWideViewport(async () => {
            const wrapper = mountView();
            await settle();
            await flushPromises();

            // 宽档首启右栏就开着 files（defaultWorkspaceLayoutForViewport ≥1800），树可见。
            expect(wrapper.find('[data-testid="workspace-file-tree"]').exists()).toBe(true);
            // 再挂上另一个页签，验证折叠后它们仍在行内、仍可达。
            await openPanel(wrapper, "code");
            await settle();
            await wrapper.find('[data-testid="dock-tab-files"]').trigger("click");
            await settle();

            // 折叠控制在同一面板的头部（S3a）。
            await wrapper.find('[data-testid="workspace-toolbar-toggle-tree"]').trigger("click");
            await settle();
            const rail = wrapper.get('[data-testid="workspace-file-rail"]');
            expect(rail.find('[data-testid="workspace-tree-expand"]').exists()).toBe(true);
            expect(wrapper.find('[data-testid="workspace-file-tree"]').exists()).toBe(false);
            // 折叠 ≠ 整栏消失：dock 本体与其它页签仍然渲染。
            expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(true);
            expect(
                wrapper
                    .find('[data-testid="workspace-container-tabs"][data-container="right"]')
                    .exists(),
            ).toBe(true);
            expect(wrapper.find('[data-testid="dock-tab-code"]').exists()).toBe(true);

            await wrapper.find('[data-testid="workspace-tree-expand"]').trigger("click");
            await settle();
            expect(wrapper.find('[data-testid="workspace-file-tree"]').exists()).toBe(true);
            expect(wrapper.find('[data-testid="workspace-tree-expand"]').exists()).toBe(false);
        });
    });

    it("opens dock tabs through the toolbar and keeps a single active tab", async () => {
        useSessionStore().currentSessionId = SESSION_A;
        // task-94 S5/D4：<1800 首启现在自带 files+monitor 两个页签 ⇒ 再开 code+changes 就是 4 个，
        // 第 4 个会落进 overflow 菜单（`maxVisibleTabs: 3`），本用例就取不到 `dock-tab-changes` 了。
        // 这条用例测的是**页签切换**，不是首启默认集合 ⇒ 显式种一个空右栏，让它只受自己控制。
        localStorage.setItem(
            "xihe-layout-ws:workspace-1",
            JSON.stringify({ dockTabs: [], activeDockTab: null, dockCollapsed: true }),
        );
        const wrapper = mountView();
        await settle();
        await flushPromises();

        await openPanel(wrapper, "code");
        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="file-editor-stub"]').exists()).toBe(true);
        // Only the active tab's content is mounted, so opening another one swaps it.
        await openPanel(wrapper, "changes");
        expect(wrapper.find('[data-testid="file-editor-stub"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="changes-panel-stub"]').exists()).toBe(true);
        // The code tab is still open, just inactive.
        expect(wrapper.find('[data-testid="dock-tab-code"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="dock-tab-changes"]').attributes("aria-selected")).toBe(
            "true",
        );

        await openPanel(wrapper, "changes");
        // task-88 ③（D-1907）：再点已激活页签 = 聚焦它，**不再收起整列** —— 收起只走行尾开合图标
        // `workspace-dock-toggle`（或面板关闭键）。这是语义变更，不是回归。
        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="dock-tab-changes"]').attributes("aria-selected")).toBe(
            "true",
        );

        await wrapper.find('[data-testid="workspace-dock-toggle"]').trigger("click");
        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(false);

        await openPanel(wrapper, "monitor");
        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="session-monitor-stub"]').exists()).toBe(true);
    });

    it("opens the dock context panel when the chat asks for it (PLAN-0626 M2)", async () => {
        useSessionStore().currentSessionId = SESSION_A;
        const wrapper = mountView();
        await settle();
        await flushPromises();

        await wrapper.find('[data-testid="chat-open-context"]').trigger("click");
        await settle();

        // D-1907 rev10（task-129）：ChatPanel → page → workbench.openSessionConfigTab(sessionId)
        // ⇒ 右栏开出 `pane:right:session-config:<sid>` 页签，面板体仍是同一份 SessionContextPanel。
        const configTab = `dock-tab-pane:right:session-config:${SESSION_A}`;
        expect(wrapper.find(`[data-testid="${configTab}"]`).attributes("aria-selected")).toBe(
            "true",
        );
        expect(wrapper.find('[data-testid="session-context-panel-stub"]').exists()).toBe(true);

        // 门：再点一次摘要行只聚焦，不重复开（卡面 rev2）。
        await wrapper.find('[data-testid="chat-open-context"]').trigger("click");
        await settle();
        expect(
            wrapper.findAll('[data-testid^="dock-tab-pane:right:session-config:"]'),
        ).toHaveLength(1);
    });

    it("closes the dock from its own close action without dropping the tabs", async () => {
        useSessionStore().currentSessionId = SESSION_A;
        const wrapper = mountView();
        await settle();
        await flushPromises();

        await openPanel(wrapper, "code");
        await wrapper.find('[data-testid="workspace-aux-close"]').trigger("click");
        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(false);

        // Re-opening restores the same tab and the same width (collapse ≠ width loss).
        await openPanel(wrapper, "code");
        expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="file-editor-stub"]').exists()).toBe(true);
    });

    it("keeps the dock and tree state per workspace across session switches", async () => {
        const sessionStore = useSessionStore();
        sessionStore.currentSessionId = SESSION_A;
        localStorage.setItem(
            "xihe-layout-ws:workspace-1",
            JSON.stringify({
                treeCollapsed: true,
                treeWidth: 240,
                dockCollapsed: false,
                dockWidth: 360,
                dockTabs: ["files", "monitor"],
                activeDockTab: "files",
                dockMode: "pinned",

                openTabs: ["session:s1"],
                activeColumn: "main",
                openTarget: "right",
            }),
        );
        await withWideViewport(async () => {
            const wrapper = mountView();
            await settle();
            await flushPromises();

            // 落盘态**显式**给：折叠 + 右栏开着 files。不靠「挤压自动让位」这类过渡期行为
            // （task-94 正在删的就是它），否则这条判据会随别人的阈值漂移。
            expect(wrapper.find('[data-testid="workspace-file-tree"]').exists()).toBe(false);
            expect(wrapper.find('[data-testid="workspace-file-rail"]').exists()).toBe(true);
            expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(true);

            // S3b P2-9: writes are coalesced, so poll for the persisted snapshot.
            await vi.waitFor(
                () => {
                    const stored = JSON.parse(
                        localStorage.getItem("xihe-layout-ws:workspace-1") ?? "{}",
                    ) as Record<string, unknown>;
                    expect(stored).toMatchObject({
                        treeCollapsed: true,
                        dockCollapsed: false,
                        dockTabs: ["files", "monitor"],
                        activeDockTab: "files",
                    });
                },
                { timeout: 2000, interval: 20 },
            );

            // Switching sessions no longer resets the auxiliary panel (S2 semantics).
            sessionStore.currentSessionId = SESSION_B;
            await settle();
            // 折叠态与右栏都跟着 workspace 走：rail 还在，右栏行/面板仍在（task-144 ③ 的可达性判据）。
            expect(wrapper.find('[data-testid="workspace-file-rail"]').exists()).toBe(true);
            expect(wrapper.find('[data-testid="workspace-file-tree"]').exists()).toBe(false);
            expect(wrapper.find('[data-testid="workspace-aux-panel"]').exists()).toBe(true);
            expect(
                wrapper
                    .find('[data-testid="workspace-container-tabs"][data-container="right"]')
                    .exists(),
            ).toBe(true);
        });
    });

    it("keeps the workspace usable without auto-creating a session", async () => {
        mockedApi.getSessions.mockResolvedValue({ sessions: [] });
        mockedApi.getWorkspaceAgents.mockResolvedValue([
            {
                principalId: "agent-1",
                name: "Research Agent",
                templateId: null,
                templateName: null,
                createdAt: new Date().toISOString(),
                permissionsSnapshot: [],
                bound: true,
                disabled: false,
            },
        ]);
        mockedApi.createSession.mockResolvedValue({
            id: SESSION_A,
            title: "New Chat",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            workspaceId: "workspace-1",
            agentPrincipalId: "agent-1",
            archived: false,
        });
        const wrapper = mountView();
        await nextTick();
        expect(wrapper.find('[data-testid="workspace-create-session"]').text()).toBe("New chat");

        await flushPromises();
        expect(wrapper.find('[data-testid="chat-panel-stub"]').exists()).toBe(false);

        await wrapper.find('[data-testid="workspace-create-session"]').trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="chat-panel-stub"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="workspace-agent-principal-select"]').exists()).toBe(
            true,
        );
        await setSelectValue(
            wrapper,
            '[data-testid="workspace-agent-principal-select"]',
            "agent-1",
        );
        await wrapper.find('[data-testid="workspace-create-agent-session"]').trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="chat-panel-stub"]').exists()).toBe(true);
        // D-1167 ④（task-365 F）：工具栏的「当前智能体」chip 整体删除 —— 会话身份在创建时已经
        // 由 `POST /sessions` 的 `agentPrincipalId` 请求参数钉住（下一行断言），workbench chrome
        // 不再复述它；无对象的断言 = 「该元素不存在」。
        expect(wrapper.find('[data-testid="workspace-active-agent"]').exists()).toBe(false);
        // task-52 / batch-02 ②：默认标题从前端硬编码 `"New Chat"` 改为 i18n 键
        // `workspace.sessionDefaultTitle`（`stores/session.ts#createSession` 的默认参数）。
        //
        // 期望值取**真实全局 i18n**（`src/i18n`）而不是本文件那套局部 `messages`：store 是
        // setup 之外的单例，它读的是 `i18n.global`，局部实例在这里不参与求值 —— 写死局部
        // 夹具的值会让这条断言永远测不到产品取值路径（正是 `check-i18n-fixture-copies` 记的假绿形态）。
        // 承重点：把 store 改回硬编码 `"New Chat"` ⇒ 本行红（实收 `"New Chat"`）。
        expect(mockedApi.createSession).toHaveBeenCalledWith(
            "agent-1",
            globalI18n.global.t("workspace.sessionDefaultTitle"),
        );
    });

    it("opens the Workspace Agent management panel from the toolbar", async () => {
        mockedApi.getWorkspaceAgents.mockResolvedValue([
            {
                principalId: "agent-1",
                name: "Research Agent",
                templateId: null,
                templateName: null,
                createdAt: new Date().toISOString(),
                permissionsSnapshot: [],
                bound: true,
                disabled: false,
            },
        ]);
        // task-174 A1（`D-1538`）：工具栏 `Bot` 入口已退役，智能体面板改由 dock 页签 /
        // 成员页「智能体」tab 打开 ⇒ 这里直接以布局预置打开该面板（原本靠点工具栏图标）。
        localStorage.setItem(
            "xihe-layout-ws:workspace-1",
            JSON.stringify({
                dockCollapsed: false,
                dockFocus: false,
                dockTabs: ["agents"],
                activeDockTab: "agents",
            }),
        );
        const wrapper = mountView();
        await flushPromises();

        // PLAN-0626 M3 (D26-05): 打开的是 dock 的 `agents` 页签；面板体只存在一次
        // exists exactly once and the mobile modal host is not mounted on desktop at all.
        expect(wrapper.get('[data-testid="dock-tab-agents"]').attributes("aria-selected")).toBe(
            "true",
        );
        expect(wrapper.findAll('[data-testid="workspace-agent-management-dialog"]')).toHaveLength(
            1,
        );
        expect(wrapper.findComponent(WorkspaceAgentManagementDialog).exists()).toBe(false);
        expect(mockedApi.getWorkspaceAgents).toHaveBeenCalledWith("workspace-1");
    });

    it("creates a principal from the selected persisted template snapshot", async () => {
        // task-174 A1（`D-1538`）：工具栏 `Bot` 入口已退役，智能体面板改由 dock 页签 /
        // 成员页「智能体」tab 打开 ⇒ 这里直接以布局预置打开该面板（原本靠点工具栏图标）。
        localStorage.setItem(
            "xihe-layout-ws:workspace-1",
            JSON.stringify({
                dockCollapsed: false,
                dockFocus: false,
                dockTabs: ["agents"],
                activeDockTab: "agents",
            }),
        );
        const wrapper = mountView();
        await flushPromises();
        // 2026-11-04 五裁（主体名规范）：名字只允许字母/中文/数字且不能以数字开头 ——
        // 原 "Template-backed" 带连字符，现在会被实时校验拦下（createBlocked ⇒ submit 不发）。
        await wrapper.find('[data-testid="agent-principal-name"]').setValue("TemplateBacked");
        await setSelectValue(wrapper, '[data-testid="agent-principal-template"]', "template-1");
        expect(wrapper.find('[data-testid="agent-principal-create-form"]').text()).toContain(
            "role-1",
        );
        expect(wrapper.find('[data-testid="agent-principal-create-form"]').text()).toContain(
            "gpt-example",
        );
        await wrapper.find('[data-testid="agent-principal-create-form"]').trigger("submit");
        await flushPromises();

        // PLAN-0622：创建改用对象入参（携带 scope/模型意图）；本用例只断言模板字段原样透传。
        expect(mockedApi.createAgentPrincipal).toHaveBeenCalledWith(
            expect.objectContaining({
                name: "TemplateBacked",
                templateId: "template-1",
            }),
        );
        expect(wrapper.find('[data-testid="unbound-agent-principal"]').text()).toContain(
            "principal-created",
        );
        expect(wrapper.find('[data-testid="unbound-agent-principal"]').text()).toContain(
            "Stored template",
        );
        expect(
            (wrapper.find('[data-testid="agent-principal-create"]').element as HTMLButtonElement)
                .disabled,
        ).toBe(true);
    });
});

// PLAN-0622 D26/D27：会话选择器只列**已绑定且未禁用**的 agent
// （未绑定 → CP 403 not bound；已禁用 → CP 409 AGENT_PRINCIPAL_DISABLED）。
it("lists only bound and enabled agents in the session selector", async () => {
    mockedApi.getSessions.mockResolvedValue({ sessions: [] });
    mockedApi.getWorkspaceAgents.mockResolvedValue([
        {
            principalId: "agent-bound",
            name: "Bound Agent",
            templateId: null,
            templateName: null,
            createdAt: new Date().toISOString(),
            permissionsSnapshot: [],
            bound: true,
            disabled: false,
        },
        {
            principalId: "agent-unbound",
            name: "Unbound Agent",
            templateId: null,
            templateName: null,
            createdAt: new Date().toISOString(),
            permissionsSnapshot: [],
            bound: false,
            disabled: false,
        },
        {
            principalId: "agent-disabled",
            name: "Disabled Agent",
            templateId: null,
            templateName: null,
            createdAt: new Date().toISOString(),
            permissionsSnapshot: [],
            bound: true,
            disabled: true,
        },
    ]);
    const wrapper = mountView();
    await flushPromises();
    await wrapper.find('[data-testid="workspace-create-session"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="workspace-agent-principal-select"]').exists()).toBe(true);
    await openSelect(wrapper, '[data-testid="workspace-agent-principal-select"]');
    const options = selectItemValues(wrapper);
    expect(options).toContain("agent-bound");
    expect(options, "an unbound agent must not be selectable").not.toContain("agent-unbound");
    expect(options, "a disabled agent must not be selectable").not.toContain("agent-disabled");
});

// PLAN-0622 D27 连带：工作区里的 agent 都**已绑定但被禁用**时，不能对用户说"尚未绑定"
// （那是错误归因 —— 用户会去重复绑定一个已经绑好的 agent）。UI 必须给出可操作的原因。
it("explains that the bound agents are disabled instead of claiming nothing is bound", async () => {
    mockedApi.getSessions.mockResolvedValue({ sessions: [] });
    mockedApi.getWorkspaceAgents.mockResolvedValue([
        {
            principalId: "agent-bound-disabled",
            name: "Bound but disabled",
            templateId: null,
            templateName: null,
            createdAt: new Date().toISOString(),
            permissionsSnapshot: [],
            bound: true,
            disabled: true,
        },
    ]);
    const wrapper = mountView();
    await flushPromises();
    await wrapper.find('[data-testid="workspace-create-session"]').trigger("click");
    await flushPromises();

    const hint = wrapper.find('[data-testid="workspace-agent-unavailable-hint"]');
    expect(hint.exists(), "the UI must explain why no agent is selectable").toBe(true);
    expect(hint.text()).toMatch(/禁用|disabled/i);
    expect(
        wrapper.find('[data-testid="workspace-agent-principal-select"]').exists(),
        "no selector when nothing is selectable",
    ).toBe(false);
});

/**
 * task-52 / batch-02 ①（P1，`D-1703`）：用量行**渲染出来的那段话**不能是内部标记。
 *
 * <p>前面的 `i18n/__tests__/usageCopyRules.spec.ts` 扫 locale 树，钉的是「文案库里没有 wire 词」；
 * 这条钉**页面真的把它渲染成人话**：CP 的 `costSource="unmapped"` / `source="real"` 原值
 * 只准进 `:data-cost-source` / `:data-source`（排障用），可见文本必须是译文。</p>
 *
 * <p>承重点（变异）：把 `usageCost` 那行改回字面量 `"未映射"` / 把徽标改回 `{{ usage.source }}`
 * ⇒ 本用例红（可见文本里出现 `unmapped`/`real`）。**只断言可见文本，不断言 data-* 属性为空** ——
 * wire 原值留在属性里是有意设计（人看人话、排障看属性）。</p>
 */
describe("WorkspaceView usage line copy (task-52 ①)", () => {
    async function mountWithUsage(usage: {
        inputTokens?: number;
        outputTokens?: number;
        source?: "real" | "estimated" | "fallback";
        cost?: number | null;
        costSource?: "price_table" | "provider_reported" | "unmapped";
        costNote?: string | null;
    }): Promise<VueWrapper> {
        useSessionStore().currentSessionId = SESSION_A;
        useChatStore().setSessionLastUsage(SESSION_A, usage);
        const wrapper = mountView();
        await settle();
        await flushPromises();
        return wrapper;
    }

    it("renders the un-priced case as readable copy, not the wire marker", async () => {
        const wrapper = await mountWithUsage({
            inputTokens: 3591,
            outputTokens: 8,
            source: "real",
            cost: null,
            costSource: "unmapped",
            costNote: "no token counts",
        });

        const cost = wrapper.get('[data-testid="workspace-usage-cost"]');
        // 本地夹具（locale=en）已登记 usageCostUnmapped ⇒ 可见文本是译文。
        expect(cost.text()).toBe("Not priced");
        expect(cost.text()).not.toMatch(/unmapped/i);
        // wire 原值仍在属性里（排障面没丢）。
        expect(cost.attributes("data-cost-source")).toBe("unmapped");
        expect(cost.attributes("data-cost-note")).toBe("no token counts");
        // 悬停说明把 CP 的英文 costNote 翻成人话，而不是原样透出。
        expect(cost.attributes("title")).toBe("no token counts");
    });

    it("renders the source badge as a localized label, not the raw enum", async () => {
        const wrapper = await mountWithUsage({
            inputTokens: 3591,
            outputTokens: 8,
            source: "real",
            cost: 0.12,
            costSource: "price_table",
            costNote: null,
        });

        const badge = wrapper.get('[data-testid="workspace-usage-source"]');
        expect(badge.text()).toBe("Real billing");
        expect(badge.text()).not.toBe("real");
        expect(badge.attributes("data-source")).toBe("real");
    });

    it("keeps the em dash for the fallback source (no token counts reported)", async () => {
        // **必须给 inputTokens**：用量行整行是 `v-if="lastUsage && usageInput !== undefined"`，
        // 不给 token 数这一行根本不渲染（第一版用例就是这么红的 —— `get()` 找不到节点）。
        // 但「有 token 数、却没有费用」正是 fallback 的真实形态：CP 只能数出 token，报不出钱。
        const wrapper = await mountWithUsage({
            inputTokens: 120,
            outputTokens: 0,
            source: "fallback",
            cost: null,
            costSource: "unmapped",
            costNote: "no token counts",
        });

        // fallback = 这一轮根本没有 token 计数 ⇒「—」是「没有这个读数」，不是「未定价」。
        // 两者混成同一个词，就是 D-1703 说的「用户读不懂」的另一半。
        const cost = wrapper.get('[data-testid="workspace-usage-cost"]');
        expect(cost.text()).toBe("—");
    });
});

// task-116（方案 A UI 侧）：工作区「默认智能体」—— 建会话不再必经选择框。
//
// 契约（与 task-106 CP 侧尚在对齐，UI 先按此写）：
// - `WorkspaceAgentBinding.isDefault` 由 `GET /workspaces/{id}/agents` 的真实响应给出，
//   UI **不缓存**（每次 loadAgents 重新读），因此改默认后刷新仍要能看到标记。
// - `POST /sessions` 在不带已选 agent 时由 CP 取工作区默认值；本卡的做法是**读列表里的默认值
//   显式传参**，因为会话身份必须在创建时确定（PLAN-0689 B3：principal-null 空 Session 不存在）。
// - 只有「没有可用默认值」这一种情况才回退到选择框（400），其余错误照旧 toast，不弹框 ——
//   把 500/403 也弹成选择框会让用户以为选一个就能成功。
function boundAgent(principalId: string, isDefault: boolean) {
    return {
        principalId,
        name: principalId,
        templateId: null,
        templateName: null,
        createdAt: new Date().toISOString(),
        permissionsSnapshot: [],
        bound: true,
        disabled: false,
        isDefault,
    };
}

function workspaceSession(id: string, agentPrincipalId: string) {
    return {
        id,
        title: "New Chat",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        workspaceId: "workspace-1",
        agentPrincipalId,
        archived: false,
    };
}

it("creates the session directly with the default agent and never opens the picker", async () => {
    // 本文件 beforeEach 不清调用历史（其它用例也会建会话）⇒ 断言次数前自己清一遍。
    mockedApi.createSession.mockClear();
    mockedApi.getSessions.mockResolvedValue({ sessions: [] });
    mockedApi.getWorkspaceAgents.mockResolvedValue([
        boundAgent("agent-default", true),
        boundAgent("agent-other", false),
    ]);
    mockedApi.createSession.mockResolvedValue(workspaceSession(SESSION_A, "agent-default"));
    const wrapper = mountView();
    await flushPromises();

    await wrapper.find('[data-testid="workspace-create-session"]').trigger("click");
    await flushPromises();

    // 承重点 ①：默认值直接进会话 —— 选择框一次都不渲染，用户看不到多余的一步。
    expect(wrapper.find('[data-testid="workspace-agent-principal-select"]').exists()).toBe(false);
    // 承重点 ②：用的是**默认**那个 agent，不是列表第一个 bound agent。
    expect(mockedApi.createSession).toHaveBeenCalledTimes(1);
    expect(mockedApi.createSession).toHaveBeenCalledWith(
        "agent-default",
        globalI18n.global.t("workspace.sessionDefaultTitle"),
    );
    expect(wrapper.find('[data-testid="chat-panel-stub"]').exists()).toBe(true);
});

it("falls back to the agent picker only when the default agent is rejected with 400", async () => {
    mockedApi.createSession.mockClear();
    mockedApi.getSessions.mockResolvedValue({ sessions: [] });
    mockedApi.getWorkspaceAgents.mockResolvedValue([boundAgent("agent-default", true)]);
    // CP 侧「无默认值 / 默认值不可用」用 400 表达（与 500/403 区分开：后两者不是「换一个就好」）。
    mockedApi.createSession.mockRejectedValue(
        new ApiError(
            {
                status: 400,
                code: "WORKSPACE_AGENT_DEFAULT_MISSING",
                detail: "No default agent configured",
                requestId: "req-default",
            },
            undefined,
        ),
    );
    const wrapper = mountView();
    await flushPromises();

    await wrapper.find('[data-testid="workspace-create-session"]').trigger("click");
    await flushPromises();

    // 400 ⇒ 退化为手动选择，且**不弹第二个模态**：用户拿到的是同一条现有路径。
    expect(wrapper.find('[data-testid="workspace-agent-principal-select"]').exists()).toBe(true);
    expect(mockedApi.createSession).toHaveBeenCalledTimes(1);

    // 选一个再提交仍然能建（回退不是死路）。
    mockedApi.createSession.mockResolvedValue(workspaceSession(SESSION_A, "agent-default"));
    await setSelectValue(
        wrapper,
        '[data-testid="workspace-agent-principal-select"]',
        "agent-default",
    );
    await wrapper.find('[data-testid="workspace-create-agent-session"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="chat-panel-stub"]').exists()).toBe(true);
});
