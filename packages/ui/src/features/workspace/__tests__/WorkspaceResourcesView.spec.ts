import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { RESOURCE_DEFS } from "../../../lib/settingsIa";

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
        workspace: { resourcesRefHint: "平台 / 用户层的同类资源在这里只读引用：" },
        settings: {
            ia: {
                resourceCredentials: "凭据",
                resourceMcp: "MCP 服务器",
                resourceSkills: "技能",
            },
        },
        resources: {
            nameAgents: "智能体",
            layerTab: {
                credentials: { USER: "个人", WORKSPACE: "本工作区", INSTANCE: "平台" },
                mcp: { WORKSPACE: "本工作区", INSTANCE: "平台" },
                skills: { USER: "个人", WORKSPACE: "本工作区", INSTANCE: "平台" },
                agents: { USER: "个人", WORKSPACE: "本工作区", INSTANCE: "平台" },
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
            agents: stub("agents"),
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

async function mountPage(): Promise<ReturnType<typeof mount>> {
    const { default: WorkspaceResourcesView } = await import("../pages/WorkspaceResourcesView.vue");
    const wrapper = mount(WorkspaceResourcesView, {
        global: { plugins: [i18n], stubs: { RouterLink: RouterLinkStub } },
    });
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
    it("资源清单 = RESOURCE_DEFS 里「有 WORKSPACE 层」的派生结果（页面不持第二份清单）", async () => {
        const wrapper = await mountPage();
        const tabIds = wrapper
            .findAll('[data-testid^="ws-resources-tab-"]')
            .map((node) => node.attributes("data-testid")?.replace("ws-resources-tab-", ""));
        expect(tabIds).toEqual([...DERIVED_IDS]);
        // 派生结果本身钉住一次（矩阵顺序），防止有人把 filter 条件改成「全部资源」还绿。
        expect([...DERIVED_IDS]).toEqual(["credentials", "mcp", "skills", "agents"]);
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

    it("切资源：换面板 + 把选中项写进 URL（深链可分享）", async () => {
        const wrapper = await mountPage();
        await wrapper.get('[data-testid="ws-resources-tab-skills"]').trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="resource-view-skills"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="resource-view-credentials"]').exists()).toBe(false);
        expect(replaceSpy).toHaveBeenCalledWith({ query: { resource: "skills" } });
    });

    it("深链与非法值：?resource=mcp 生效；?resource=knowledge 回落派生首项", async () => {
        routeState.query = { resource: "mcp" };
        let wrapper = await mountPage();
        expect(wrapper.find('[data-testid="resource-view-mcp"]').exists()).toBe(true);
        wrapper.unmount();

        // knowledge 不在派生集合里 ⇒ 回落首项（而不是渲染 G3 缺口页当「本工作区资源」）。
        routeState.query = { resource: "knowledge" };
        wrapper = await mountPage();
        expect(wrapper.find('[data-testid="resource-view-credentials"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="resource-view-knowledge"]').exists()).toBe(false);
    });

    it("平台 / 用户层只作只读引用：链接按该资源的 layerRules 派生（mcp 无个人层）", async () => {
        routeState.query = { resource: "skills" };
        let wrapper = await mountPage();
        const skillRefs = wrapper.findAll('[data-testid^="ws-resources-ref-layer-"]');
        expect(skillRefs.map((node) => node.attributes("href"))).toEqual([
            "/resources/skills?layer=USER",
            "/resources/skills?layer=INSTANCE",
        ]);
        wrapper.unmount();

        // mcp 的 layerRules 只有 WORKSPACE/INSTANCE ⇒ 引用条只剩平台层：证明链接不是手写常量。
        routeState.query = { resource: "mcp" };
        wrapper = await mountPage();
        const mcpRefs = wrapper.findAll('[data-testid^="ws-resources-ref-layer-"]');
        expect(mcpRefs.map((node) => node.attributes("href"))).toEqual([
            "/resources/mcp?layer=INSTANCE",
        ]);
    });
});
