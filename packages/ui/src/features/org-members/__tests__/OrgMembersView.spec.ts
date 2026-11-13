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
        global: { plugins: [i18n] },
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
