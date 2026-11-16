import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { i18n } from "../../../i18n";
import { expectNoInternalFacts } from "../../../test-utils/copyAsserts";
import { setSelectValue } from "../../../test-utils/select";
import OrgMemberDetailSheet from "../components/OrgMemberDetailSheet.vue";
import type * as apiModule from "../../../composables/api";

/** task-44：智能体分支要 `router.push` 到工作区；这里只钉"推到哪"，真实导航由 E2E 覆盖。 */
const routerPush = vi.hoisted(() => vi.fn<(location: unknown) => Promise<void>>());
vi.mock("vue-router", () => ({ useRouter: () => ({ push: routerPush }) }));

/**
 * PLAN-0773 M3-3 / task-43：成员详情面（只读）。
 *
 * <p>本 spec 的**判据不是"渲染出来了"**，而是三件在卡面上被点名的事：</p>
 * <ol>
 *   <li><b>权限段是 B 形态且不许拼凑</b>：页面必须同时出现「他人权限不在本页展示」与
 *       「未展示 ≠ 无权限」，并给出指向本人投影的链接；**任何**从角色/绑定推原子的渲染都是缺陷。</li>
 *   <li><b>段② 的判据是能力原子 `MANAGE_ROLES`</b>，不是 `isInstanceAdmin` 能力位、也不是角色名
 *       —— 用例「能力位为真但原子为假 ⇒ gated 且零请求」就是这条的机器证明（把判定改成
 *       `isInstanceAdmin` 或角色字符串，这条必红）。</li>
 *   <li><b>代价与上限写清</b>：段① 按需展开、逐工作区查询、上限 5，且某个工作区 403 只影响那一行。</li>
 * </ol>
 */

const WORKSPACES = [
    { id: "w-1", name: "研发工作区" },
    { id: "w-2", name: "运营工作区" },
    { id: "w-3", name: "设计工作区" },
    { id: "w-4", name: "文档工作区" },
    { id: "w-5", name: "测试工作区" },
    { id: "w-6", name: "第六个工作区" },
    { id: "w-7", name: "第七个工作区" },
];

const apiState = vi.hoisted(() => ({
    listWorkspaces: vi.fn<() => Promise<unknown>>(),
    listWorkspaceMembers: vi.fn<(workspaceId: string) => Promise<unknown>>(),
    getBindings: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listWorkspaces: apiState.listWorkspaces,
            listWorkspaceMembers: apiState.listWorkspaceMembers,
            getBindings: apiState.getBindings,
        },
    };
});

const authState = vi.hoisted(() => ({ canManageRoles: true, projectionReady: true }));
const ensureSelfPermissions = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({
        ensureSelfPermissions,
        get canManageRoles() {
            return authState.canManageRoles;
        },
    }),
}));

/** 三个成员三种形态：human 有绑定 / human 无绑定 / agent_principal（卡面判据②「至少 3 个成员对照」）。 */
const ALICE = {
    memberKind: "human",
    memberId: "m-alice",
    orgUnitId: "u-root",
    displayName: "alice",
};
const BOB = { memberKind: "human", memberId: "m-bob", orgUnitId: "u-child", displayName: "bob" };
const BOT = {
    memberKind: "agent_principal",
    memberId: "m-bot",
    orgUnitId: "u-child",
    displayName: "codebot",
};

function mountSheet(member: unknown, unitName = "研发部") {
    return mount(OrgMemberDetailSheet, {
        props: { member: member as never, open: true, unitName },
        attachTo: document.body,
        global: { plugins: [i18n] },
    });
}

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
    authState.canManageRoles = true;
    authState.projectionReady = true;
    ensureSelfPermissions.mockImplementation(() => Promise.resolve(authState.projectionReady));
    apiState.listWorkspaces.mockResolvedValue(WORKSPACES);
    apiState.listWorkspaceMembers.mockImplementation((workspaceId: string) =>
        Promise.resolve(
            workspaceId === "w-1"
                ? [{ userId: "m-alice", role: "OWNER" }]
                : workspaceId === "w-2"
                  ? [{ userId: "m-alice", role: "EDITOR" }]
                  : [{ userId: "m-other", role: "VIEWER" }],
        ),
    );
    apiState.getBindings.mockResolvedValue({
        scopeType: "instance",
        scopeId: null,
        bindings: [
            {
                id: "b-1",
                subjectType: "user",
                subjectId: "m-alice",
                roleId: "r-1",
                roleName: "WS_OWNER",
            },
            {
                id: "b-2",
                subjectType: "user",
                subjectId: "m-alice",
                roleId: "r-2",
                roleName: "MANAGER",
            },
            {
                id: "b-3",
                subjectType: "user",
                subjectId: "m-other",
                roleId: "r-1",
                roleName: "WS_OWNER",
            },
        ],
    });
});

afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
});

describe("task-43 段③ 权限原子：B 形态（不拼凑）", () => {
    it("三句话都在：不在本页展示 / 未展示 ≠ 无权限 / 指向本人投影的链接", async () => {
        mountSheet(ALICE);
        await flushPromises();

        expect(q("org-member-detail-atoms-not-shown")?.textContent).toContain(
            "他人权限不在本页展示",
        );
        expect(q("org-member-detail-atoms-not-no-permission")?.textContent).toContain(
            "未展示 ≠ 无权限",
        );
        const link = q("org-member-detail-atoms-self-link");
        expect(link?.getAttribute("href")).toBe("/api/v1/me/permissions");
    });

    it("不渲染任何原子清单（B 形态不做猜测；正解是 task-52 的新端点）", async () => {
        mountSheet(ALICE);
        await flushPromises();

        const atomsSection = q("org-member-detail-atoms");
        expect(atomsSection).toBeTruthy();
        // 段③ 里**只有**陈述与链接：出现列表/原子名就说明有人开始从角色或绑定推权限了。
        expect(atomsSection?.querySelectorAll("li").length).toBe(0);
        expect(atomsSection?.textContent).not.toMatch(/MANAGE_ROLES|read/);
    });
});

describe("task-43 段② 访问角色绑定：判据是 MANAGE_ROLES 原子", () => {
    it("持原子 ⇒ 列出该成员的绑定，且按 subjectId 过滤（别人的绑定不串进来）", async () => {
        mountSheet(ALICE);
        await flushPromises();

        const rows = document.querySelectorAll('[data-testid^="org-member-detail-access-role-b-"]');
        expect(rows.length).toBe(2);
        expect(apiState.getBindings).toHaveBeenCalledWith("instance");
        expect(q("org-member-detail-access-role-rows")?.textContent).toContain("WS_OWNER");
        expect(q("org-member-detail-access-role-rows")?.textContent).not.toContain("m-other");
    });

    it("没有原子 ⇒ gated 文案可见，且**一个绑定请求都不发**", async () => {
        authState.canManageRoles = false;
        mountSheet(BOB);
        await flushPromises();

        expect(q("org-member-detail-access-role-gated")?.textContent).toContain("MANAGE_ROLES");
        expect(q("org-member-detail-access-role-gated")?.textContent).toContain("需实例管理员");
        expect(apiState.getBindings).not.toHaveBeenCalled();
    });

    it("能力位为真但原子为假 ⇒ 仍然 gated（能力位不等于原子，禁止 isInstanceAdmin 特判）", async () => {
        authState.canManageRoles = false;
        mountSheet(ALICE);
        await flushPromises();

        expect(q("org-member-detail-access-role-gated")).toBeTruthy();
        expect(apiState.getBindings).not.toHaveBeenCalled();
    });

    it("投影读失败 ⇒ unread 文案（读失败不等于没有权限），不发绑定请求", async () => {
        authState.projectionReady = false;
        mountSheet(ALICE);
        await flushPromises();

        expect(q("org-member-detail-access-role-unread")?.textContent).toContain("不等于没有权限");
        expect(apiState.getBindings).not.toHaveBeenCalled();
    });

    it("agent_principal ⇒ 段② 给「实例级不适用」，不查绑定也不查工作区", async () => {
        mountSheet(BOT);
        await flushPromises();

        expect(q("org-member-detail-access-role-agent")).toBeTruthy();
        expect(apiState.getBindings).not.toHaveBeenCalled();
        expect(apiState.listWorkspaceMembers).not.toHaveBeenCalled();
    });
});

describe("task-43 段① 工作区成员角色：按需展开 + 上限 + 单行容错", () => {
    it("未点按钮前一次工作区成员请求都不发（不把详情面做成 N 次自动查询）", async () => {
        mountSheet(ALICE);
        await flushPromises();

        expect(apiState.listWorkspaces).not.toHaveBeenCalled();
        expect(apiState.listWorkspaceMembers).not.toHaveBeenCalled();
        expect(q("org-member-detail-workspace-role-load")).toBeTruthy();
    });

    it("点开 ⇒ 按上限 5 逐个查，渲染三行角色；上限文字写明", async () => {
        mountSheet(ALICE);
        await flushPromises();
        (q("org-member-detail-workspace-role-load") as HTMLElement).click();
        await flushPromises();

        expect(apiState.listWorkspaceMembers).toHaveBeenCalledTimes(5);
        expect(q("org-member-detail-workspace-role-cost")?.textContent).toContain("上限 5");
        expect(q("org-member-detail-workspace-role-w-1")?.textContent).toContain("OWNER");
        expect(q("org-member-detail-workspace-role-w-2")?.textContent).toContain("EDITOR");
    });

    it("某个工作区 403 ⇒ 该行显示无权查看，其它行照常（不整段报错）", async () => {
        apiState.listWorkspaceMembers.mockImplementation((workspaceId: string) =>
            workspaceId === "w-2"
                ? Promise.reject(new Error("403 FORBIDDEN"))
                : Promise.resolve([{ userId: "m-alice", role: "OWNER" }]),
        );
        mountSheet(ALICE);
        await flushPromises();
        (q("org-member-detail-workspace-role-load") as HTMLElement).click();
        await flushPromises();

        expect(q("org-member-detail-workspace-role-w-2")?.textContent).toContain("无权查看");
        expect(q("org-member-detail-workspace-role-w-1")?.textContent).toContain("OWNER");
        expect(q("org-member-detail-workspace-role-error")).toBeNull();
    });

    it("agent_principal ⇒ 说明「不是工作区成员」，不给查询按钮", async () => {
        mountSheet(BOT);
        await flushPromises();

        expect(q("org-member-detail-workspace-role-agent")).toBeTruthy();
        expect(q("org-member-detail-workspace-role-load")).toBeNull();
    });
});

describe("task-43 身份 / 所属单元 / 动作（三成员对照）", () => {
    it("三个成员各自渲染自己的 kind/id/所属单元（不是同一份数据复制三遍）", async () => {
        const alice = mountSheet(ALICE, "研发部");
        await flushPromises();
        expect(q("org-member-detail-name")?.textContent).toContain("alice");
        expect(q("org-member-detail-id")?.textContent).toContain("m-alice");
        expect(q("org-member-detail-kind")?.textContent).toContain("人类");
        expect(q("org-member-detail-unit-name")?.textContent).toContain("研发部");
        alice.unmount();

        const bot = mountSheet(BOT, "平台组");
        await flushPromises();
        expect(q("org-member-detail-name")?.textContent).toContain("codebot");
        expect(q("org-member-detail-id")?.textContent).toContain("m-bot");
        expect(q("org-member-detail-kind")?.textContent).toContain("智能体");
        expect(q("org-member-detail-unit-name")?.textContent).toContain("平台组");
        bot.unmount();
    });

    it("所属单元的代价写清：只显示直接挂载单元，不推算链路", async () => {
        mountSheet(BOB, "平台组");
        await flushPromises();

        expect(q("org-member-detail-unit-cost")?.textContent).toContain("逐级查询");
    });

    it("动作全禁用，且两条原因都可见（不是灰按钮无解释）", async () => {
        mountSheet(BOB);
        await flushPromises();

        expect((q("org-member-detail-change-role") as HTMLButtonElement).disabled).toBe(true);
        expect((q("org-member-detail-remove") as HTMLButtonElement).disabled).toBe(true);
        expect(q("org-member-detail-action-reason-batch")?.textContent).toContain("尚未开放");
        expect(q("org-member-detail-action-reason-admin")?.textContent).toContain("管理员能力位");
    });
});

// ── task-44（D-1440 / A 方案）：智能体的三段不在本页，本页只做深链 ─────────────────────
// 判据：①「先选工作区」不是预选（误点会落进别人的工作区）②落地 URL 带 `agent=` 让面板能展开
// ③读失败 ≠ 没有工作区（两条文案分开）④人类成员根本不渲染这一段、也不发请求。
describe("task-44 agent → 工作区深链", () => {
    const PICKER = '[data-testid="org-member-detail-agent-open-picker"]';

    it("选择工作区后跳到 /workspace/{id}?agent=<pid> 并关闭抽屉", async () => {
        const wrapper = mountSheet(BOT);
        await flushPromises();

        // 不预选：打开时按钮必须是禁用的，避免一次误点直接落进默认工作区。
        expect((q("org-member-detail-agent-open-button") as HTMLButtonElement).disabled).toBe(true);
        await setSelectValue(wrapper, PICKER, "w-2");
        expect((q("org-member-detail-agent-open-button") as HTMLButtonElement).disabled).toBe(
            false,
        );

        (q("org-member-detail-agent-open-button") as HTMLButtonElement).click();
        await flushPromises();

        expect(routerPush).toHaveBeenCalledWith({
            path: "/workspace/w-2",
            query: { agent: "m-bot" },
        });
        expect(wrapper.emitted("update:open")?.at(-1)).toEqual([false]);
    });

    it("读工作区失败 ⇒ 失败文案（不是「你不在任何工作区」），且没有可点的跳转", async () => {
        apiState.listWorkspaces.mockRejectedValue(new Error("500 boom"));
        mountSheet(BOT);
        await flushPromises();

        expect(q("org-member-detail-agent-open-error")?.textContent).toContain(
            i18n.global.t("orgMembers.agentOpenError"),
        );
        expect(q("org-member-detail-agent-open-empty")).toBeNull();
        expect(q("org-member-detail-agent-open-button")).toBeNull();
    });

    it("一个工作区都没有 ⇒ 空态文案，且不发跳转", async () => {
        apiState.listWorkspaces.mockResolvedValue([]);
        mountSheet(BOT);
        await flushPromises();

        expect(q("org-member-detail-agent-open-empty")?.textContent).toContain(
            i18n.global.t("orgMembers.agentOpenEmpty"),
        );
        expect(q("org-member-detail-agent-open-button")).toBeNull();
    });

    it("人类成员：不渲染这一段，也不为它请求工作区列表", async () => {
        mountSheet(ALICE);
        await flushPromises();

        expect(q("org-member-detail-agent-open")).toBeNull();
        expect(apiState.listWorkspaces).not.toHaveBeenCalled();
    });
});

// ── 文案纪律（Lead 2026-11-15 裁定）：用户文案不写实现事实（错误码 / 原子名 / 端点名）──────
describe("task-44 agent 深链文案：不把实现事实写给用户", () => {
    it("说明与代价两句里没有错误码、原子名或端点名", async () => {
        mountSheet(BOT);
        await flushPromises();

        const copy = [
            q("org-member-detail-agent-open-desc")?.textContent ?? "",
            q("org-member-detail-agent-open-cost")?.textContent ?? "",
        ].join(" ");

        // 用户看到 "409" 会去搜「409 是什么」，而他要知道的只是「这件事在工作区里做」。
        // 判据在公共件里、**按键组**调用：合法出现错误码的错误提示不该被这条误伤（task-58 复用）。
        expectNoInternalFacts(copy, "orgMembers.agentOpen{Desc,Cost}");
    });
});
