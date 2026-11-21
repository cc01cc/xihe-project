import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { i18n as sourceI18n } from "../../../i18n";
import { RESOURCE_DEFS, visibleLayersForResource } from "../../../lib/settingsIa";

/**
 * PLAN-0773 **M4-2**（task-210）`/workspace/:id/resources` 的机器判据。
 *
 * <p>这页最容易被写坏的方式不是「渲染不对」，而是**在页面里又抄了一份资源清单或层清单**
 * —— 那种写法在真机上照样看起来对，只有加资源/改矩阵时才暴露。所以本文件断言的顺序是：
 * ① 资源清单**必须等于** `RESOURCE_DEFS.layerRules` 的派生结果（同一份计算，不是同一串字面量）；
 * ② 层**固定**：子视图收到的是 `layer="WORKSPACE"`，页面里没有层切换入口；
 * ③ 其它层只能拿到**只读引用**链接（`?layer=`），且条数随资源的 `layerRules` 变
 * （`mcp` 无个人层 ⇒ 只有 INSTANCE 一条）。</p>
 */
const messages = {
    "zh-CN": {
        workspaceNav: { resources: "资源" },
        // task-26（批 1）：夹具跟着 SSOT 走 —— 层名是「个人层」（task-251 / D-1043），
        // 留着旧称会把过期文案锁死在测试里（产品改了、夹具还在替旧名字背书）。
        workspace: {
            resourcesRefHint: "平台 / 个人层的同类资源在这里只读引用：",
            // task-44：页面 h1 的文案（与真实 i18n 的 workspace.resourcesTitle 同值）。
            resourcesTitle: "工作区资源",
        },
        settings: {
            ia: {
                resourceCredentials: "凭据",
                resourceMcp: "MCP 服务器",
                resourceSkills: "技能",
            },
        },
        // task-145 / DSD-1511：原先这里有 5 条「已迁到工作区设置」指路文案的夹具 —— 指路卡
        // 整块删除后夹具一并删除（留着夹具等于替已删除的文案背书）。
        resources: {
            // task-52 / batch-02 ③：说明合并成可折叠摘要（默认收起）。
            resourcesHintSummary: "关于本页资源的层级与去处",
            resourcesHintShow: "查看说明",
            resourcesHintHide: sourceI18n.global.t("resources.resourcesHintHide"),
            layerTab: {
                credentials: { USER: "个人", WORKSPACE: "本工作区", INSTANCE: "平台" },
                mcp: { WORKSPACE: "本工作区", INSTANCE: "平台" },
                skills: { USER: "个人", WORKSPACE: "本工作区", INSTANCE: "平台" },
                knowledge: {},
            },
        },
    },
};

const { replaceSpy, routeState } = vi.hoisted(() => ({
    replaceSpy: vi.fn<(arg: unknown) => void>(),
    routeState: {
        params: { workspaceId: "ws-1" } as Record<string, string>,
        query: {} as Record<string, unknown>,
    },
}));

vi.mock("vue-router", () => ({
    useRoute: () => routeState,
    useRouter: () => ({ replace: replaceSpy }),
}));

/**
 * 视图映射只**替身**，不加载真实面板：真面板会拉 api/store（那是各自 spec 的事）。
 * 替身把收到 props 落成 DOM 属性 —— 这样「层被钉死」是可断言的**结果**，不是读组件实现的猜测。
 */
vi.mock("../../../lib/resourceViews", async () => {
    const vue = await import("vue");
    // 替身组件一律用 `setup()` + `h()`：**与生产构建一致、不依赖模块解析条件**。
    // 返回**模块形状**（`__esModule: true`）：`defineAsyncComponent` 只对"模块"解包 `.default`，
    // 直接返回 `{ default: comp }` 会被当成组件本身 ⇒ 渲染成空注释节点 + "missing template" 警告。
    // 约定与判据（含正负两侧读数）：`packages/ui/AGENTS.md`「async 组件替身（defineAsyncComponent）约定」（task-234）。
    // 哨兵（**别删**）：`internal/A03-xihe/evidence/2026-11-13-async-stub-convention/fixtures/case-3-template-string.spec.ts`
    //   断言 `typeof vue.compile === "function"`。模块解析条件哪天变了它会红 —— 那就是该回来重判上面那条理由的时候；
    //   删掉它等于把「理由仍成立」变成无人复核的假设。
    const stub = (id: string) => async () => ({
        __esModule: true,
        default: {
            name: `${id}-view-stub`,
            props: {
                layer: { type: String, default: undefined },
                workspaceId: { type: String, default: undefined },
            },
            setup(props: { layer?: string; workspaceId?: string }) {
                return () =>
                    vue.h("div", {
                        "data-testid": `resource-view-${id}`,
                        "data-layer": props.layer,
                        "data-workspace-id": props.workspaceId,
                    });
            },
        },
    });
    return {
        RESOURCE_VIEWS: {
            credentials: stub("credentials"),
            mcp: stub("mcp"),
            skills: stub("skills"),
            knowledge: stub("knowledge"),
        },
    };
});

const i18n = createI18n({ legacy: false, locale: "zh-CN", fallbackLocale: "zh-CN", messages });

const RouterLinkStub = {
    props: { to: {} },
    setup(props: { to?: unknown }, ctx: { slots: { default?: () => unknown[] } }) {
        return () => h("a", { href: String(props.to) }, ctx.slots.default?.());
    },
};

/** 派生口径的**独立复算**：与页面不同的写法（filter + some），用来对撞页面里那份。 */
const DERIVED_IDS = RESOURCE_DEFS.filter((def) =>
    def.layerRules.some((rule) => rule.layer === "WORKSPACE"),
).map((def) => def.id);
/** D-1432 / task-41：已迁到工作区设置的资源 —— 页签里去掉、改指路（独立复算，不读页面常量）。 */
const MOVED_IDS = ["mcp", "skills"] as const;
const TAB_IDS = DERIVED_IDS.filter((id) => !(MOVED_IDS as readonly string[]).includes(id));

/**
 * task-52 / batch-02 ③：顶部说明默认**折叠**（`hintsOpen = false`）。
 *
 * <p>所以「读直链」类断言必须先展开 —— 展开动作走**真实触发器点击**（不是改组件内部
 * state 的捷径），这样「折叠默认 + 可展开」这件事本身也被这些既有用例盯着：谁把
 * `CollapsibleTrigger` 拆了或把默认值改成 always-open，既有断言不会给出别的绿灯。</p>
 */
async function mountPage(
    options: { expandHints?: boolean } = {},
): Promise<ReturnType<typeof mount>> {
    const { default: WorkspaceResourcesView } = await import("../pages/WorkspaceResourcesView.vue");
    const wrapper = mount(WorkspaceResourcesView, {
        global: { plugins: [i18n], stubs: { RouterLink: RouterLinkStub } },
    });
    if (options.expandHints !== false) {
        await flushPromises();
        const toggle = wrapper.find('[data-testid="ws-resources-hints-toggle"]');
        if (toggle.exists()) {
            await toggle.trigger("click");
            await flushPromises();
        }
    }
    // `defineAsyncComponent` 是「加载 → 状态切换 → 再渲染」三段：一次 flush 只把加载完成，
    // 面板要到下一个 tick 才挂上。循环到面板出现为止（有界，不用固定 sleep）。
    for (let i = 0; i < 10; i += 1) {
        await flushPromises();
        await nextTick();
        if (wrapper.findAll('[data-testid^="resource-view-"]').length > 0) break;
    }
    return wrapper;
}

beforeEach(() => {
    replaceSpy.mockClear();
    routeState.params = { workspaceId: "ws-1" };
    routeState.query = {};
});

describe("工作区资源页（M4-2 / task-210）", () => {
    /**
     * task-44（a11y P0）：页面**必须有 h1**，且文本就是页面标题。
     *
     * <p>为什么这条要单独钉：读屏「按标题导航」只认 h1..h6 元素 —— 不认 aria-label、不认
     * 视觉上的大字。改前本页模板根直接是 role=tablist，整棵树里 **0 个 heading** ⇒ 这一页在
     * 标题导航里根本不存在（成员 / 设置 / 环境三页各有 h1）。所以判据取「元素 + 层级 + 文本」，
     * 不取「看起来有标题」。</p>
     *
     * <p>同一断言里还钉两件**不能一起坏**的事：h1 不许被塞进 tablist（tablist 的子元素按 ARIA
     * 只应是 tab），以及 tablist 的组名不许在补 h1 时被弄丢（task-90 同族判据）。</p>
     */
    it("有且只有一个 h1，文本是资源页标题；h1 不在 tablist 内；页签集合 ≥2 时 tablist 仍带组名", async () => {
        const wrapper = await mountPage();

        const headings = wrapper.findAll("h1");
        expect(headings, "本页必须恰好一个 h1（h1 唯一是四页的一致口径）").toHaveLength(1);
        expect(headings[0].attributes("data-testid")).toBe("workspace-resources-title");
        expect(headings[0].text()).toBe(messages["zh-CN"].workspace.resourcesTitle);
        // 层级核对：h1 是页面级标题，不得落进 tablist（那里按 ARIA 只应有 tab）。
        expect(headings[0].element.closest('[role="tablist"]')).toBeNull();

        // task-162：本页页签只剩 1 个时**整条页签栏不渲染**，于是这里没有 tablist 可取。
        // 组名判据（task-90 同族）改成条件式而不是删掉：页签集合长回 ≥2 时必须仍然带 aria-label，
        // 只剩 1 个时必须一个 tablist 都没有 —— 两个方向都要咬住，否则「干脆不渲染组名」也能绿。
        const tablists = wrapper.findAll('[role="tablist"]');
        if (TAB_IDS.length > 1) {
            expect(tablists).toHaveLength(1);
            expect(tablists[0]!.attributes("aria-label")).toBe(
                messages["zh-CN"].workspaceNav.resources,
            );
        } else {
            expect(tablists).toHaveLength(0);
        }
    });
    it("资源清单 = RESOURCE_DEFS 里「有 WORKSPACE 层」的派生结果（页面不持第二份清单）", async () => {
        const wrapper = await mountPage();
        const tabIds = wrapper
            .findAll('[data-testid^="ws-resources-tab-"]')
            .map((node) => node.attributes("data-testid")?.replace("ws-resources-tab-", ""));
        // D-1432：派生结果减去「已迁走」的两个 = 本页页签。
        // task-162：页签只剩 1 个时页签栏不渲染 ⇒ DOM 侧为空；清单本身由下面两条 SSOT 断言钉住。
        expect(tabIds).toEqual(TAB_IDS.length > 1 ? [...TAB_IDS] : []);
        // 派生结果本身钉住一次（矩阵顺序），防止有人把 filter 条件改成「全部资源」还绿。
        // task-96：智能体撤出资源面 ⇒ 派生集合里不再有它（工作区层入口在 dock tab 与管理弹窗，不在这页）。
        expect([...DERIVED_IDS]).toEqual(["credentials", "mcp", "skills"]);
        expect([...TAB_IDS]).toEqual(["credentials"]);
        // 已迁走的两个既不进页签、也不再有任何指路节点（task-145 / DSD-1511）。
        expect(wrapper.find('[data-testid="ws-resources-tab-mcp"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="ws-resources-tab-skills"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="ws-resources-moved-hint"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="ws-resources-moved-link-mcp"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="ws-resources-moved-link-skills"]').exists()).toBe(false);
        // knowledge **自然不入选**：它的 layerRules 为空（G3 缺口），不是被白名单挡掉的。
        expect(
            RESOURCE_DEFS.find((def) => def.id === "knowledge")?.layerRules.some(
                (rule) => rule.layer === "WORKSPACE",
            ),
        ).toBe(false);
        expect(wrapper.find('[data-testid="ws-resources-tab-knowledge"]').exists()).toBe(false);
    });

    it("层固定「本工作区」：子视图收到 layer=WORKSPACE + 路由里的 workspaceId", async () => {
        const wrapper = await mountPage();
        const view = wrapper.get('[data-testid="resource-view-credentials"]');
        expect(view.attributes("data-layer")).toBe("WORKSPACE");
        expect(view.attributes("data-workspace-id")).toBe("ws-1");
        // 页面里没有层切换控件（层 tab 只属于全局资源页）：RTL 不会渲染任何
        // `resource-layer-tab-*` 形态的节点，也没有指向 `?layer=WORKSPACE` 的「本层」入口。
        expect(wrapper.find('[data-testid^="resource-layer-tab-"]').exists()).toBe(false);
    });

    it("页签只剩 credentials（mcp/skills 已迁、智能体随资源区摘除）⇒ 不渲染页签条，也不写 URL", async () => {
        const wrapper = await mountPage();
        // task-162：单一页签不再渲染（1920×1080 真栈实测：原先这条 43px 高、满宽分隔线的带里
        // 只有「凭据」一个字，点开不动任何东西）。资源名由 h1 + 面板自带标题表达，不靠这条带。
        expect(wrapper.findAll('[data-testid^="ws-resources-tab-"]')).toHaveLength(0);
        expect(wrapper.findAll('[role="tablist"]')).toHaveLength(0);
        expect(wrapper.find('[data-testid="resource-view-credentials"]').exists()).toBe(true);
        // 深链写回只发生在**切换**时；现在没有任何可点页签，挂载本身也不该写 URL
        // （否则每次进页多一条历史）。原先这条是靠「点唯一页签 → 断言没 replace」咬住的，
        // 页签不渲染后改成直接断言挂载后 replace 未被调用，承重不变。
        await flushPromises();
        expect(replaceSpy).not.toHaveBeenCalled();
    });

    it("深链：?resource=mcp（已迁）⇒ 静默回落首个可用资源，页面上没有任何指路节点", async () => {
        routeState.query = { resource: "mcp" };
        const wrapper = await mountPage();
        // task-145 / DSD-1511：旧深链**静默回落**到首个未迁资源（credentials），
        // 既不留指路卡（那是「请到别处」的空壳），也不留空白页。
        expect(wrapper.find('[data-testid="resource-view-mcp"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="resource-view-credentials"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="workspace-layer-moved"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="ws-resources-moved-hint"]').exists()).toBe(false);
    });

    it("非法/缺口资源回落：?resource=knowledge 落回首个未迁资源（面板照常渲染）", async () => {
        routeState.query = { resource: "knowledge" };
        const wrapper = await mountPage();
        expect(wrapper.find('[data-testid="resource-view-credentials"]').exists()).toBe(true);
        // knowledge 的 layerRules 为空（G3 缺口），本页从不渲染它，也不为它造指路卡。
        expect(wrapper.find('[data-testid="resource-view-knowledge"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="workspace-layer-moved"]').exists()).toBe(false);
    });

    it("平台 / 个人层只作只读引用：链接按「选中资源 × 可见层」派生", async () => {
        // credentials 三层都真实存在 ⇒ 引用条 = 个人 + 平台（本工作区那层就是本页自己，不列）。
        routeState.query = { resource: "credentials" };
        const wrapper = await mountPage();
        const credentialRefs = wrapper.findAll('[data-testid^="ws-resources-ref-layer-"]');
        expect(credentialRefs.map((node) => node.attributes("href"))).toEqual([
            "/resources/credentials?layer=USER",
            "/resources/credentials?layer=INSTANCE",
        ]);
        wrapper.unmount();

        // mcp 已迁走 ⇒ 它的 query 静默回落 credentials，所以引用条仍是 credentials 的两条：
        // 证明链接跟着**最终选中的资源**走，不是照着 URL 里的 resource 手写。
        routeState.query = { resource: "mcp" };
        const fallback = await mountPage();
        expect(
            fallback
                .findAll('[data-testid^="ws-resources-ref-layer-"]')
                .map((node) => node.attributes("href")),
        ).toEqual(["/resources/credentials?layer=USER", "/resources/credentials?layer=INSTANCE"]);
        // 层事实本身在 settingsIa 里仍为真（mcp 有 WORKSPACE/INSTANCE），只是 WORKSPACE 不可见。
        expect(visibleLayersForResource("mcp")).toEqual(["INSTANCE"]);
        expect(visibleLayersForResource("credentials")).toEqual(["USER", "WORKSPACE", "INSTANCE"]);
    });

    /**
     * task-52 / batch-02 ③（P1-4，D-1703）：**默认折叠**，展开才给明细与直链。
     *
     * 现象（Lead 截图 b02-tab-资源.png）：两条迁移说明各占一整行压在页头主位，
     * 真正的功能（凭据管理）被挤到下面且是空态 ⇒ 导航说明压过功能主体。
     *
     * 判据分两半，合起来才是「折叠」的意思：
     * ① 默认态：摘要行在、明细不在（不是删掉）；
     * ② 展开后：只读引用明细与链接一个不少（信息没丢，只是收起来）。
     *
     * task-145 / DSD-1511 之后本条只剩**一种**明细（平台 / 个人层只读引用）：「已迁到工作区设置」
     * 那段连同指路卡整块删除，因此展开后必须**反查不到** moved 节点/直链。
     *
     * 承重点（变异）：把 hintsOpen 初值改 ref(true) ⇒ ① 红；把 CollapsibleContent 里的
     * 引用链接删掉 ⇒ ② 红。**「默认收起」和「内容还在」必须同时成立** —— 只测前者会把「删掉说明」
     * 误判成修好了。
     */
    it("顶部说明默认折叠：摘要行常驻、只读引用收在展开里；已迁指路节点反查为 0", async () => {
        routeState.query = { resource: "credentials" };
        const wrapper = await mountPage({ expandHints: false });

        const hints = wrapper.get('[data-testid="ws-resources-hints"]');
        // ① 摘要行在（可点开）。
        expect(wrapper.find('[data-testid="ws-resources-hints-toggle"]').exists()).toBe(true);
        // ② 明细不在默认态。
        expect(wrapper.find('[data-testid="ws-resources-moved-hint"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid^="ws-resources-ref-layer-"]').exists()).toBe(false);
        // ③ 展开后只读引用明细 + 全部链接都在；已迁指路节点（task-145 删除）反查为 0。
        await wrapper.get('[data-testid="ws-resources-hints-toggle"]').trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="ws-resources-moved-hint"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="ws-resources-moved-link-mcp"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="ws-resources-moved-link-skills"]').exists()).toBe(false);
        expect(
            wrapper
                .findAll('[data-testid^="ws-resources-ref-layer-"]')
                .map((n) => n.attributes("href")),
        ).toEqual(["/resources/credentials?layer=USER", "/resources/credentials?layer=INSTANCE"]);
        // 折叠状态如实反映在 ARIA 上（读屏用户也能知道现在是哪种）。
        expect(
            wrapper.get('[data-testid="ws-resources-hints-toggle"]').attributes("aria-expanded"),
        ).toBe("true");
        expect(hints.text()).toContain("收起说明");
    });
});

describe("资源页触控目标（task-10 / batch-2 ④）", () => {
    it("说明折叠按钮不再用 h-6 覆盖（h-6 恰在下限 24px 上、无余量）", async () => {
        // vendor `size="sm"` 已是 h-7 = 28px（4px 栅格；3.5px 时代 24.5px）；覆盖成 h-6 今天是
        // 24px（3.5px 时代 21px）—— 两值都不给余量，故仍不许覆盖。
        // jsdom 不求值 Tailwind ⇒ 钉类名；真实 rect 见 task-51 的浏览器 rect 导出。
        const wrapper = await mountPage();
        const toggle = wrapper.get('[data-testid="ws-resources-hints-toggle"]');
        expect(toggle.classes()).not.toContain("h-6");
        wrapper.unmount();
    });
});
