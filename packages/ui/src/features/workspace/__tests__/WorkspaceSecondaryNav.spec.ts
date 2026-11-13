import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import { i18n } from "../../../i18n";
import WorkspaceSecondaryNav from "../components/WorkspaceSecondaryNav.vue";

/**
 * task-297 的**机器判据**：面包屑必须能读出「在哪个工作区的哪一页」。
 *
 * <p><b>缺陷形态（不是外观问题）</b>：`useWorkspaceNav()` 的 `trail` 一直算三段
 * ——`工作区`（根）→ `<工作区名或 id>`（容器）→ `<页>`，注释也这么写；
 * 但 `WorkspaceSecondaryNav.vue` 的模板只渲染**两段**（常量「工作区」+ 当前页）⇒
 * `trail.container` 是**死字段**。用户看到的「工作区 › 会话」里没有任何一处说清是哪个
 * 工作区，而右边紧挨着的 tab 又写着「会话」，两处同一个词、都没信息量。
 * 这就是用户原话「不明所以的划分」的机制。</p>
 *
 * <p><b>为什么断言 testid 而不是「有几个 li」</b>：vendor 的 `BreadcrumbSeparator`
 * 自己也渲染一个 `<li>`（`BreadcrumbSeparator.vue` 的根是 `li`），所以 li 计数里
 * 永远混着分隔符 —— 数 li 数出来的 3 在**改前改后都是 3**（改前是 2 段 + 1 分隔符，
 * 改后是 3 段 + 2 分隔符 ⇒ 5）。用 `li` 数量当判据会**对缺陷免疫**，等于没测。
 * 断言中间段的 `data-testid` 才直接对撞「这段有没有被渲染」。</p>
 */
const WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";
const WORKSPACE_NAME = "演示工作区";

const routeState = vi.hoisted(() => ({
    workspaceName: "演示工作区" as string | null,
    routeName: "workspace" as string,
}));

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
    useRoute: () =>
        ({
            name: routeState.routeName,
            path: `/workspace/${WORKSPACE_ID}`,
            params: { workspaceId: WORKSPACE_ID },
            query: {},
        }) as unknown as RouteLocationNormalizedLoaded,
    useRouter: () => ({
        resolve: (to: { name?: string; params?: Record<string, string> }) => ({
            href: `/workspace/${String(to.params?.workspaceId ?? "")}${to.name === "workspace" ? "" : `/${String(to.name)}`}`,
            name: to.name,
        }),
        getRoutes: () => [
            {
                name: "workspace",
                meta: {
                    workspacePage: { id: "sessions", labelKey: "workspaceNav.sessions", order: 10 },
                },
            },
        ],
    }),
}));

function mockAuth() {
    // auth store 的 workspace 是 tab 作用域选择，这里直接写 ref 模拟已加载的工作区。
    localStorage.setItem("xihe-token", "test-token");
    localStorage.setItem("xihe-user", JSON.stringify({ id: "u1" }));
}

async function mountNav() {
    const wrapper = mount(WorkspaceSecondaryNav, {
        global: {
            plugins: [i18n],
            // vue-router 被 mock 掉后没有全局 RouterLink，显式给桩（否则每次挂载都报
            // "Failed to resolve component: RouterLink"，真缺陷会被这行噪音淹没）。
            stubs: { RouterLink: { template: "<a><slot /></a>" } },
        },
    });
    await flushPromises();
    return wrapper;
}

/** 把当前选中的工作区塞进 auth store（`auth.workspace` 是 readTabWorkspace 的产物）。 */
async function setAuthWorkspace(id: string, name: string) {
    const { useAuthStore } = await import("../../../stores/auth");
    const auth = useAuthStore();
    auth.workspace = { id, name } as never;
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
    routeState.workspaceName = WORKSPACE_NAME;
    routeState.routeName = "workspace";
    mockAuth();
});

describe("WorkspaceSecondaryNav 面包屑（task-297）", () => {
    it("中间段必须渲染，且取工作区**名**而不是 id", async () => {
        const wrapper = await mountNav();
        await setAuthWorkspace(WORKSPACE_ID, WORKSPACE_NAME);
        await flushPromises();

        const middle = wrapper.find('[data-testid="workspace-breadcrumb-container"]');
        // 这条是缺陷的正撞面：改前这段根本不存在（trail.container 是死字段）。
        expect(middle.exists()).toBe(true);
        expect(middle.text()).toBe(WORKSPACE_NAME);
        // 全段可读成「工作区 › 演示工作区 › 会话」——能看出在哪个工作区的哪一页。
        const whole = wrapper.find('[data-testid="workspace-breadcrumb"]').text();
        expect(whole).toContain("工作区");
        expect(whole).toContain(WORKSPACE_NAME);
        expect(whole).toContain(i18n.global.t("workspaceNav.sessions"));
        wrapper.unmount();
    });

    it("工作区尚未加载（auth.workspace 为空）时回退成 id —— 有信息量，不静默留空", async () => {
        const wrapper = await mountNav();

        const middle = wrapper.find('[data-testid="workspace-breadcrumb-container"]');
        expect(middle.exists()).toBe(true);
        // 回退成 id 而不是常量「工作区」：否则会读成「工作区 › 工作区」这种同义重复。
        expect(middle.text()).toBe(WORKSPACE_ID);
        expect(middle.text()).not.toBe(i18n.global.t("workspaceNav.workspaceContainer"));
        wrapper.unmount();
    });

    it("auth.workspace 与路由参数不一致时以**路由**为准（地址栏与面包屑不许打架）", async () => {
        const wrapper = await mountNav();
        // 模拟切换工作区的那一帧：store 里还是上一个工作区。
        await setAuthWorkspace("99999999-9999-4999-8999-999999999999", "另一个工作区");
        await flushPromises();

        const middle = wrapper.find('[data-testid="workspace-breadcrumb-container"]');
        expect(middle.text()).toBe(WORKSPACE_ID);
        expect(middle.text()).not.toContain("另一个工作区");
        wrapper.unmount();
    });

    it("中间段不带 aria-current —— 一页只能有一个「当前页」", async () => {
        const wrapper = await mountNav();
        await setAuthWorkspace(WORKSPACE_ID, WORKSPACE_NAME);
        await flushPromises();

        const middle = wrapper.find('[data-testid="workspace-breadcrumb-container"]');
        // vendor 的 BreadcrumbPage 硬写 aria-current="page"（BreadcrumbPage.vue:16），
        // 所以中间段用普通 span；否则屏幕阅读器会读出两个「当前页」。
        expect(middle.attributes("aria-current")).toBeUndefined();
        expect(middle.attributes("data-slot")).not.toBe("breadcrumb-page");
        wrapper.unmount();
    });
});

/**
 * **视觉权重判据（task-297 第 2 步，Lead 2026-11-13 裁定 A 案）** —— 量化，不写「看起来更轻」。
 *
 * <p><b>为什么需要它</b>：用户说「上面 3 行不明所以的划分」。实测（真栈 1920×1080）三条：
 * ① 行1 页签栏 31.5 高，但**内容只占 39 / 1381 px**（无会话时只有一个回退词「对话」）；
 * ② **层级是倒的** —— 行2 次级导航 **38.67 比行1 主级页签栏 31.5 还高**；
 * ③ 行1 与行2 挂着同样的底边与实底 ⇒ 三行**等重**，读不出谁主谁次。
 * ⇒ 病根不是「行数多」，是「等重」。故 A 案不动结构，只把行2 压到明显轻于行1。</p>
 *
 * <p><b>怎么量化（三个独立、可从 class 串复算的量）</b>：
 * ```
 * 判据 1（底边）：行1 根节点有可见 border-b（且非 border-transparent）；
 *                 行2 根节点 border-bottom-color 为 transparent。
 * 判据 2（底色）：行1 有 bg-* 实底 token；行2 不得有 bg-* 实底 token。
 * 判据 3（高度）：行2 高度**必须等于改前 38.67**（零几何变化是 Lead 的硬约束）——
 *                 这条不在本文件测（jsdom 不做布局），由真栈实测报告承担。
 * ```
 * 三条都是**声明式 token 断言**（class 串），不需要浏览器即可复算；
 * 真实渲染值（backgroundColor alpha = 0、borderBottomColor alpha = 0、h = 38.67）
 * 由真栈实测报告给出，两者互为印证。</p>
 */
describe("WorkspaceSecondaryNav 视觉权重低于页签栏（task-297 第 2 步 A 案）", () => {
    /** 从 class 串里判「有没有实底」：bg-* 且不是 bg-transparent / bg-none 这类无底值。 */
    function hasSolidBackground(classes: string[]): boolean {
        return classes.some(
            (cls) => cls.startsWith("bg-") && cls !== "bg-transparent" && cls !== "bg-none",
        );
    }

    it("判据 1：行2 的底边必须是透明的（几何保留 1px，只去可见线）", async () => {
        const wrapper = await mountNav();
        const classes = (
            wrapper.get('[data-testid="workspace-secondary-nav"]').attributes("class") ?? ""
        )
            .split(/\s+/)
            .filter(Boolean);

        // 几何必须留着：border-b 在 ⇒ 底边仍占 1px，行高才可能保持 38.67。
        // 去掉 border-b 会让高度掉 0.67（38.67 -> 38.00），那是越界的几何变化。
        expect(classes).toContain("border-b");
        expect(classes).toContain("border-transparent");
        // 且不得再出现「可见底边」的写法。
        expect(classes).not.toContain("border-border");
        wrapper.unmount();
    });

    it("判据 2：行2 不得有实底与 backdrop-blur —— 让它退成背景而不是一条带", async () => {
        const wrapper = await mountNav();
        const classes = (
            wrapper.get('[data-testid="workspace-secondary-nav"]').attributes("class") ?? ""
        )
            .split(/\s+/)
            .filter(Boolean);

        expect(hasSolidBackground(classes)).toBe(false);
        expect(classes).not.toContain("backdrop-blur");
        // py-2 必须留着：它是行高的组成部分（7 + 内容 24 + 底边 0.67 = 38.67）。
        expect(classes).toContain("py-2");
        wrapper.unmount();
    });

    it("判据 3：行2 权重必须**严格低于**行1（同一套度量下比较，不是各说各话）", () => {
        // 行1 页签栏（WorkspaceTabBar.vue:247）与行2 的度量口径一致，
        // 否则「行2 更轻」这个比较没有共同基准（D-1137：一致性断言要锚独立基准）。
        const tabBar = [
            "flex",
            "h-9",
            "shrink-0",
            "items-center",
            "gap-1",
            "border-b",
            "bg-card",
            "px-2",
        ];
        const secondaryNav = [
            "flex",
            "flex-wrap",
            "items-center",
            "justify-between",
            "gap-3",
            "border-b",
            "border-transparent",
            "px-4",
            "py-2",
        ];

        // 行1 有实底（bg-card），行2 没有 ⇒ 底色这一维行2 更轻。
        expect(hasSolidBackground(tabBar)).toBe(true);
        expect(hasSolidBackground(secondaryNav)).toBe(false);
        // 行1 底边可见，行2 底边透明 ⇒ 描边这一维行2 更轻。
        expect(tabBar).not.toContain("border-transparent");
        expect(secondaryNav).toContain("border-transparent");
    });
});
