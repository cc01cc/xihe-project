import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../../../i18n";
import { useWorkspaceConnectionStore } from "../../../../stores/workspaceConnection";
import WorkspaceStatusBar from "../WorkspaceStatusBar.vue";

/**
 * task-81 P1-1：状态栏「假断线」。
 *
 * 改前实测（`/workspace/<id>/environment` 停 4s）：
 *   SSE 请求  200 /api/v1/user-events      ← 用户通道是连着的
 *   状态栏    文件事件未连接                ← 却说断了
 *
 * 根因不在显示侧而在**发布侧**：`useWorkspaceSSE` 卸载时 `reset()` 把读数抹成 false，
 * 而 store 的 `connected=false` 有两种完全不同的原因（①订阅了但断了 ②本页没订阅）。
 * 状态栏把两者压成同一句像故障的话 ⇒ 用户去查网络，而事实是这页不订阅。
 *
 * 本 spec 每条独立可红：
 *   ① `subscribed` 初始值必须是 false（首帧不闪错态）
 *   ② 未订阅页 ⇒ unsubscribed 文案 + **灰点**（不是红/琥珀；注意力预算）
 *   ③ 订阅页三态逐条不变（connecting 优先于 connected / connected / disconnected）
 *   ④ 切页序：订阅页 → 未订阅页 ⇒ 不残留旧读数，**且**不显示「断了」
 *   ⑤ `publishConnection` 自身即证明有发布方（不靠入参声明，避免自相矛盾态）
 */

const routeState = vi.hoisted(() => ({ routeName: "workspace-environment" as string }));
const WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";

vi.mock("vue-router", () => ({
    createRouter: () => ({
        push: vi.fn<() => Promise<void>>(),
        replace: vi.fn<() => Promise<void>>(),
        beforeEach: vi.fn<() => void>(),
        afterEach: vi.fn<() => void>(),
        isReady: () => Promise.resolve(),
        currentRoute: { value: {} },
    }),
    createWebHistory: () => ({}),
    RouterLink: { template: "<a><slot /></a>" },
    useRoute: () => ({
        name: routeState.routeName,
        path: `/workspace/${WORKSPACE_ID}/environment`,
        params: { workspaceId: WORKSPACE_ID },
        query: {},
    }),
    useRouter: () => ({
        resolve: () => ({ href: "/", name: "workspace" }),
        getRoutes: () => [],
    }),
}));

vi.mock("../../../../composables/useWorkspaceNav", () => ({
    useWorkspaceNav: () => ({
        trail: {
            rootPath: `/workspace/${WORKSPACE_ID}`,
            container: { label: "演示工作区" },
        },
    }),
}));

async function mountBar() {
    const wrapper = mount(WorkspaceStatusBar, {
        global: {
            plugins: [i18n],
            stubs: { RouterLink: { template: "<a><slot /></a>" } },
        },
    });
    await flushPromises();
    return wrapper;
}

function stateOf(w: Awaited<ReturnType<typeof mountBar>>) {
    return w
        .find('[data-testid="workspace-status-connection"]')
        .attributes("data-connection-state");
}

function dotOf(w: Awaited<ReturnType<typeof mountBar>>) {
    const dot = w.find('[data-testid="workspace-status-connection"] span');
    return dot.exists() ? dot.classes().join(" ") : "";
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.clearAllMocks();
});

describe("task-81 P1-1 未订阅态", () => {
    it("① subscribed 初始值必须是 false（首帧不能闪成已连接/连接中）", async () => {
        const store = useWorkspaceConnectionStore();
        const w = await mountBar();
        expect(store.subscribed, "初始 false 是不闪错态的前提").toBe(false);
        expect(stateOf(w)).toBe("unsubscribed");
        w.unmount();
    });

    it("② 未订阅页文案与三态不同，且状态点是灰不是红/琥珀", async () => {
        const w = await mountBar();
        expect(stateOf(w)).toBe("unsubscribed");
        const text = w.find('[data-testid="workspace-status-connection"]').text();
        expect(text, "要读出「本页没订阅」这个中性事实").toBe("本页未订阅文件事件");
        expect(text).not.toContain("未连接");
        const dot = dotOf(w);
        expect(dot, "不得用琥珀（那是进行中）").not.toContain("amber");
        expect(dot, "不得用红（那是故障）").not.toContain("red");
        expect(dot, "不得用绿（那是已连接）").not.toContain("emerald");
        w.unmount();
    });

    it("③ 订阅页三态逐条不变：connecting 优先于 connected", async () => {
        const store = useWorkspaceConnectionStore();
        const w = await mountBar();
        store.publishConnection({ connected: true, connecting: true, error: null });
        await flushPromises();
        expect(stateOf(w), "重连时 isConnected 可能仍是上一轮 true ⇒ 先判 connecting").toBe(
            "connecting",
        );
        store.publishConnection({ connected: true, connecting: false, error: null });
        await flushPromises();
        expect(stateOf(w)).toBe("connected");
        store.publishConnection({ connected: false, connecting: false, error: null });
        await flushPromises();
        expect(stateOf(w), "订阅方报告断开 ⇒ 这才是真断线").toBe("disconnected");
        w.unmount();
    });

    it("④ 切页序：订阅页 → 未订阅页 ⇒ 不残留旧读数且不显示「断了」", async () => {
        const store = useWorkspaceConnectionStore();
        const w = await mountBar();
        store.publishConnection({ connected: true, connecting: false, error: null });
        await flushPromises();
        expect(stateOf(w)).toBe("connected");
        store.reset();
        await flushPromises();
        expect(stateOf(w), "不能留着上一页的已连接").toBe("unsubscribed");
        const text = w.find('[data-testid="workspace-status-connection"]').text();
        expect(text, "更不能把它读成故障「未连接」").not.toContain("未连接");
        w.unmount();
    });

    it("⑤ publishConnection 本身即声明订阅（不接收 subscribed 入参，避免自相矛盾态）", () => {
        const store = useWorkspaceConnectionStore();
        expect(store.subscribed).toBe(false);
        store.publishConnection({ connected: false, connecting: false, error: null });
        expect(store.subscribed, "能发布读数就证明有发布方").toBe(true);
        expect(store.connected).toBe(false);
    });

    it("⑥ 四态顺序是**显式裁定**：subscribed 判在 connected/connecting 之前", async () => {
        // 为什么需要这条：在生产不变式下（`reset()` 同时清四个字段、`publishConnection`
        // 先置 subscribed=true），`!subscribed ⇒ connecting/connected 均为 false`，
        // 于是把 `!subscribed` 挪到最后**不改变任何可观测行为** —— 那是等价变异。
        // 但「顺序」本身是裁定（task-81 要求未订阅页不得读成连接态），不是巧合。
        // 这条用**违背不变式的状态**把顺序钉住：若将来有人直接写 `store.connected = true`
        // （store 的 ref 是导出的，可达），未订阅页仍必须读 unsubscribed 而不是 connected。
        const store = useWorkspaceConnectionStore();
        const w = await mountBar();
        store.connected = true; // 直接改 ref（不经过 publishConnection ⇒ subscribed 仍为 false）
        await flushPromises();
        expect(stateOf(w), "未订阅页绝不能因为 connected 被直写就读成已连接").toBe("unsubscribed");
        w.unmount();
    });
});
