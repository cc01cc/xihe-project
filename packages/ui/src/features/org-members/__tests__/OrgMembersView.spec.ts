import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../../i18n";

/**
 * PLAN-0773 M3（task-240）页面的机器判据：
 * ② 非成员 404 与缺原子 403 两条文案**不同**且各有单测（不许把 404 说成"没权限"）；
 * ③ 写面按钮 disabled 且点击**无请求**（不造可点入口）；
 * ⑥ 成员的 orgUnitId 显示**成员实际所在单元**（fixture 按真实语义造，不照抄父单元 id）。
 */

const ROOT = {
    id: "u-root",
    name: "研发部",
    parentId: null,
    depth: 0,
    hasChildren: true,
};
const CHILD = {
    id: "u-child",
    name: "平台组",
    parentId: "u-root",
    depth: 1,
    hasChildren: false,
};
const MEMBERS = [
    // 直属根单元的成员。
    {
        memberKind: "human",
        memberId: "m-1",
        orgUnitId: "u-root",
        displayName: "alice",
    },
    // 真实语义：成员实际坐在**子单元**（fixture 刻意不照抄父单元 id —— 卡面 ⑥ 的反例守卫）。
    {
        memberKind: "agent_principal",
        memberId: "m-2",
        orgUnitId: "u-child",
        displayName: "codebot",
    },
];

type FetchHandler = (url: URL) => { status: number; body: unknown };
let calls: string[] = [];

function mockFetch(handler: FetchHandler) {
    calls = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const raw = typeof input === "string" ? input : input.url;
        const url = new URL(raw, "http://localhost");
        calls.push(url.pathname + url.search);
        const { status, body } = handler(url);
        return Promise.resolve(
            new Response(JSON.stringify(body), {
                status,
                headers: { "content-type": "application/json" },
            }),
        );
    });
}

function happyHandler(url: URL) {
    if (url.pathname.endsWith("/org-units")) {
        if (url.searchParams.get("parentId") === "u-root") {
            return { status: 200, body: { nodes: [CHILD] } };
        }
        return { status: 200, body: { nodes: [ROOT] } };
    }
    if (url.pathname.endsWith("/org-units/u-root/members")) {
        return { status: 200, body: { members: MEMBERS } };
    }
    return { status: 200, body: { nodes: [], members: [] } };
}

async function mountView() {
    const { default: OrgMembersView } = await import("../pages/OrgMembersView.vue");
    const wrapper = mount(OrgMembersView, {
        // task-91：成员页现在承载个人智能体主体的落点。面板自己有取数面与判据，
        // 本文件只钉「落点挂上了」——它的请求不该混进本文件对 happyHandler 的调用清单。
        global: { plugins: [i18n], stubs: { AgentPrincipalsPanel: true } },
        attachTo: document.body,
    });
    await flushPromises();
    return wrapper;
}

/** 选中根节点（点开根 → 点标签 = 选中），等成员列表落位。 */
async function selectRoot(wrapper: Awaited<ReturnType<typeof mountView>>) {
    await wrapper.get('[data-testid="org-tree-toggle-u-root"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="org-tree-label-u-root"]').trigger("click");
    await flushPromises();
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
    localStorage.setItem("xihe-token", "test-token");
});

describe("OrgMembersView — 个人智能体主体落点（task-91）", () => {
    it("成员页承载个人智能体主体：段标题 + 面板挂载", async () => {
        mockFetch(happyHandler);
        const wrapper = await mountView();
        const section = wrapper.get('[data-testid="org-members-agents"]');
        expect(section.get('[data-testid="org-members-agents-title"]').text()).toBe("智能体主体");
        // 面板本体（取数、创建门）的判据在 components/settings/__tests__/AgentPrincipalsPanel.spec.ts。
        expect(section.findComponent({ name: "AgentPrincipalsPanel" }).exists()).toBe(true);
        wrapper.unmount();
    });
});

describe("OrgMembersView 主链路（PLAN-0773 M3-1/M3-2）", () => {
    it("选中单元 → 成员列表：tag 区分 + orgUnitId 显示成员实际所在单元（卡面 ⑥）", async () => {
        mockFetch(happyHandler);
        const wrapper = await mountView();
        await selectRoot(wrapper);

        const rows = wrapper.findAll('[data-testid^="org-member-row-"]');
        expect(rows).toHaveLength(2);
        // tag 区分：人类 / 智能体两枚徽标各就各位。
        expect(wrapper.get('[data-testid="org-member-kind-m-1"]').text()).toBe("人类");
        expect(wrapper.get('[data-testid="org-member-kind-m-2"]').text()).toBe("智能体");
        // m-2 实际在子单元 ⇒ 显示「平台组」而不是父单元「研发部」（名字来自懒加载的子节点注册表）。
        expect(wrapper.get('[data-testid="org-member-unit-m-1"]').text()).toBe("研发部");
        expect(wrapper.get('[data-testid="org-member-unit-m-2"]').text()).toBe("平台组");
        wrapper.unmount();
    });

    it("行点击只选中、不收起子树（reka 行默认 select+toggle 的坑，已在组件里拦掉）", async () => {
        mockFetch(happyHandler);
        const wrapper = await mountView();
        // 展开根单元 ⇒ 子节点行出现。
        await wrapper.get('[data-testid="org-tree-toggle-u-root"]').trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="org-tree-label-u-child"]').exists()).toBe(true);

        // 点父单元标签 = 只选中：子树**不许**在同一击里收起（收起来右栏还显示子树成员，左右错位）。
        await wrapper.get('[data-testid="org-tree-label-u-root"]').trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="org-tree-label-u-child"]').exists()).toBe(true);
        // 只有 chevron 能收起。
        await wrapper.get('[data-testid="org-tree-toggle-u-root"]').trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="org-tree-label-u-child"]').exists()).toBe(false);
        wrapper.unmount();
    });

    it("「含下级」开关默认开；关掉后请求不再带 includeDescendants", async () => {
        mockFetch(happyHandler);
        const wrapper = await mountView();
        await selectRoot(wrapper);

        const firstMembersCall = calls.find((c) => c.includes("/members"));
        expect(firstMembersCall).toContain("includeDescendants=true");

        // reka Switch 的 click 翻转属交互行为，jsdom 合成事件覆盖不到（同 MenuItem，见包
        // AGENTS「Reka UI 交互陷阱」）⇒ 在组件边界直接发 update:checked，断言的是本页契约：
        // 开关翻转 ⇒ 重新请求且 URL 参数随之变化。
        const switchComp = wrapper.findComponent(
            (await import("../../../components/ui/switch")).Switch,
        );
        switchComp.vm.$emit("update:checked", false);
        await vi.waitFor(
            () => {
                expect(calls.filter((c) => c.includes("/members"))).toHaveLength(2);
            },
            { timeout: 1000, interval: 20 },
        );
        const membersCalls = calls.filter((c) => c.includes("/members"));
        expect(membersCalls[1]).not.toContain("includeDescendants");
        wrapper.unmount();
    });

    /**
     * task-33 第二段：标签措辞与"这是否会被记住"两件事的机器判据。
     *
     * <p>① 「含下级」改「含子单元成员」后，光看视觉会以为「层级」含混 —— 标签要带 `title` 把
     * 语义讲全（嵌套任意层级都算进来，不只是直接子级）。② 开关**刻意不持久化**（见
     * `OrgUnitMemberList.vue` 的注释）：它一旦被记住，"上次关过"就会变成用户想不起来的隐性状态，
     * 从而**重新制造**本卡要修的体验。这两条都不是靠读代码能守住的 —— 有人加一行
     * `useLocalStorage` 或删掉 title，任何用例都不会红。</p>
     */
    it("标签带 title 讲全语义，且开关翻转不写 localStorage（刻意不持久化）", async () => {
        mockFetch(happyHandler);
        const wrapper = await mountView();
        await selectRoot(wrapper);

        const label = wrapper.findAll("label").find((node) => node.text().includes("含子单元成员"));
        expect(label, "标签文案不是「含子单元成员」").toBeDefined();
        // 非空即"不是裸 key"：vue-i18n 缺键时渲染的是 `orgMembers.includeDescendantsTitle` 字面量。
        const title = label?.attributes("title") ?? "";
        expect(title, "标签缺 title 或 key 未落地").toBe("包含该单元下所有层级单元的成员");

        const switchComp = wrapper.findComponent(
            (await import("../../../components/ui/switch")).Switch,
        );
        switchComp.vm.$emit("update:checked", false);
        await flushPromises();

        const persisted = Object.keys(localStorage).filter(
            (key) =>
                /descendant|下级|子单元/i.test(key) ||
                /descendant/i.test(localStorage.getItem(key) ?? ""),
        );
        expect(persisted, "开关被持久化了 —— 这会重新制造「上次关过」的隐性状态").toEqual([]);
        wrapper.unmount();
    });

    it("写面按钮全部 disabled，点击不发出任何请求（卡面 ③：不造可点入口）", async () => {
        mockFetch(happyHandler);
        const wrapper = await mountView();
        await selectRoot(wrapper);
        const requestsAfterLoad = calls.length;

        const ids = [
            "org-write-new-unit",
            "org-write-rename",
            "org-write-move",
            "org-write-add-member",
            "org-write-remove-member",
            "org-write-change-role",
        ];
        for (const id of ids) {
            const button = wrapper.get(`[data-testid="${id}"]`);
            expect(button.attributes("disabled")).toBeDefined();
            await button.trigger("click");
        }
        // 禁用说明在页面上（不是只有 title 悬浮）。
        expect(wrapper.get('[data-testid="org-write-actions"]').text()).toContain("只读预览");
        expect(calls.length).toBe(requestsAfterLoad);
        wrapper.unmount();
    });
});

describe("OrgMembersView 404 ⇔ 403 双文案（卡面 ②：不许混用）", () => {
    it("404 ORG_UNIT_NOT_FOUND（非成员）⇒ 「无法查看组织单元」，不出现「缺权限」文案", async () => {
        mockFetch((url) => {
            if (url.pathname.endsWith("/org-units") && !url.searchParams.get("parentId")) {
                return { status: 200, body: { nodes: [ROOT] } };
            }
            if (url.searchParams.get("parentId") === "u-root") {
                return { status: 200, body: { nodes: [CHILD] } };
            }
            return {
                status: 404,
                body: {
                    status: 404,
                    code: "ORG_UNIT_NOT_FOUND",
                    detail: "not visible",
                    requestId: "r",
                },
            };
        });
        const wrapper = await mountView();
        await selectRoot(wrapper);

        const error = wrapper.get('[data-testid="org-member-error"]');
        expect(error.text()).toContain("无法查看组织单元");
        expect(error.text()).not.toContain("READ_ORG_UNIT_MEMBERS");
        expect(error.text()).not.toContain("缺少读取权限");
        wrapper.unmount();
    });

    it("403 FORBIDDEN（缺原子）⇒ 「缺少读取权限」并点名 READ_ORG_UNIT_MEMBERS，不出现 404 文案", async () => {
        mockFetch((url) => {
            if (url.pathname.endsWith("/org-units") && !url.searchParams.get("parentId")) {
                return { status: 200, body: { nodes: [ROOT] } };
            }
            if (url.searchParams.get("parentId") === "u-root") {
                return { status: 200, body: { nodes: [CHILD] } };
            }
            return {
                status: 403,
                body: { status: 403, code: "FORBIDDEN", detail: "denied", requestId: "r" },
            };
        });
        const wrapper = await mountView();
        await selectRoot(wrapper);

        const error = wrapper.get('[data-testid="org-member-error"]');
        expect(error.text()).toContain("缺少读取权限");
        expect(error.text()).toContain("READ_ORG_UNIT_MEMBERS");
        expect(error.text()).not.toContain("无法查看组织单元");
        wrapper.unmount();
    });
});

/**
 * task-33（用户截图报障）：层级缩进 + 层级语义。
 *
 * <p>症状：研发部 / 数据部 / 分析组 三行左对齐无差别。根因不是数据（`分析组` 的 parentId 确实是
 * `数据部`）而是渲染：本页**只有 loading / error 占位行**做缩进，正常行一处都没有。</p>
 *
 * <p>判据（可复算）：depth d 的行首文字缩进 = `INDENT_BASE + d * INDENT_STEP` = 8 / 24 / 40 px；
 * 行容器的 `aria-level` = 1 / 2 / 3。**注意 `aria-level` 是 reka 自己设的**
 * （`reka-ui@2.11.0 dist/Tree/TreeItem.js:141` 的 `"aria-level": __props.level`，`level` 为 1 基），
 * 不是我们绑的 —— 这里断言它是**防回归**：①`v-bind="fi.bind"` 必须继续把 `level` 传下去
 * （漏传 ⇒ 属性消失）；②将来若有人想在页面上覆盖它，会立刻红。</p>
 */
describe("OrgMembersView 层级缩进与 aria-level（task-33）", () => {
    const D_ROOT = { id: "d-root", name: "研发部", parentId: null, depth: 0, hasChildren: true };
    const D_CHILD = {
        id: "d-child",
        name: "平台组",
        parentId: "d-root",
        depth: 1,
        hasChildren: true,
    };
    const D_GRAND = {
        id: "d-grand",
        name: "存储组",
        parentId: "d-child",
        depth: 2,
        hasChildren: false,
    };

    function deepHandler(url: URL) {
        if (url.pathname.endsWith("/org-units")) {
            const parentId = url.searchParams.get("parentId");
            if (parentId === "d-root") return { status: 200, body: { nodes: [D_CHILD] } };
            if (parentId === "d-child") return { status: 200, body: { nodes: [D_GRAND] } };
            return { status: 200, body: { nodes: [D_ROOT] } };
        }
        return { status: 200, body: { members: [] } };
    }

    /** 展开到三层都可见。 */
    async function expandAll(wrapper: Awaited<ReturnType<typeof mountView>>) {
        await wrapper.get('[data-testid="org-tree-toggle-d-root"]').trigger("click");
        await flushPromises();
        await wrapper.get('[data-testid="org-tree-toggle-d-child"]').trigger("click");
        await flushPromises();
    }

    it("缩进随层级递增：8 / 24 / 40 px，相邻差 = 一个步长（16）", async () => {
        mockFetch(deepHandler);
        const wrapper = await mountView();
        await expandAll(wrapper);

        const leftOf = (key: string) =>
            wrapper.get(`[data-testid="org-tree-label-${key}"]`).attributes("style") ?? "";

        // 缩进挂在 label 上（不包容器）：行容器已有 px-2，包容器会让 hover/选中底色与文字脱开。
        expect(leftOf("d-root")).toContain("padding-left: 8px");
        expect(leftOf("d-child")).toContain("padding-left: 24px");
        expect(leftOf("d-grand")).toContain("padding-left: 40px");
        wrapper.unmount();
    });

    it("aria-level = 1 / 2 / 3（reka 由 level 派生，我们只钉不覆盖）", async () => {
        mockFetch(deepHandler);
        const wrapper = await mountView();
        await expandAll(wrapper);

        const levelOf = (key: string) =>
            wrapper.get(`[data-testid="org-tree-node-${key}"]`).attributes("aria-level");

        // 注：`org-tree-node-*` 这条 testid 的**权威断言在浏览器侧**
        // （`e2e/mock/task33-org-tree-indent.spec.ts`）。这里只在 `levelOf` 里顺带用到它 ——
        // 同一事实不在 jsdom 再断言一次，否则"谁是权威"会变模糊（Lead 裁定）。
        expect(levelOf("d-root")).toBe("1");
        expect(levelOf("d-child")).toBe("2");
        expect(levelOf("d-grand")).toBe("3");

        // task-10 / batch-2 ④（触控）：展开 chevron 的命中区必须 ≥24×24（SC 2.5.8）。
        // `--spacing` = Tailwind 默认 4px 步进（`@theme` 默认值；main.css:290 密度说明、
        // :367-381 记 D-1842 删掉了此前的 0.21875rem=3.5px 覆盖）⇒ `min-h-7` = 7 步 = 28px，
        // 比下限多出的 4px 是余量；`h-6`/`size-6` = 24px 恰好压在下限上（零余量），故仍禁。
        // jsdom 不求值 Tailwind ⇒ 钉类名，真实 rect 由浏览器侧 rect 导出（task-51）复核。
        const toggles = wrapper.findAll('[data-testid^="org-tree-toggle-"]');
        expect(toggles.length).toBeGreaterThan(0);
        for (const toggle of toggles) {
            expect(toggle.classes()).toEqual(expect.arrayContaining(["min-h-7", "min-w-7"]));
            expect(toggle.classes()).not.toContain("h-6");
        }
        // 叶子行没有 chevron，但仍占同宽（否则父子行文字起点差 10.5px）。
        expect(wrapper.get('[data-testid="org-tree-node-d-root"]').html()).toContain("min-w-7");
        wrapper.unmount();
    });

    // task-84：/members 自渲染 main，skip-link 的目标就钉在这里。
    // 断言落在**标签名 + 全局 id + 可编程聚焦**上，不测 class —— class 变了不影响无障碍，
    // 而这三件里任何一件掉出来，跳过链接就退化成「只滚动」。
    it("页面根是 main 地标，且是 skip-link 的可聚焦目标", async () => {
        mockFetch(happyHandler);
        const wrapper = await mountView();
        const mains = wrapper.findAll("main");
        expect(mains).toHaveLength(1);
        const main = mains[0];
        expect(main.element.tagName).toBe("MAIN");
        expect(main.attributes("id")).toBe("main-content");
        expect(main.attributes("tabindex")).toBe("-1");
        // 锚点必须能在文档里被解析到同一个节点（skip-link 的 href 指向的就是它）。
        expect(document.getElementById("main-content")).toBe(main.element);
        // tabindex="-1" 的语义是「可编程聚焦、不进 Tab 序」：focus() 后必须真的拿到焦点。
        (main.element as HTMLElement).focus();
        expect(document.activeElement).toBe(main.element);
        wrapper.unmount();
    });
});
