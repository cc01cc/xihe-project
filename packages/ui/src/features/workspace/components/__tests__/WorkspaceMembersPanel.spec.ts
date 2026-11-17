import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { setSelectValueAt } from "../../../../test-utils/select";
import { i18n } from "../../../../i18n";
import { expectModalDialog } from "../../../../test-utils/modalDialog";

const WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";

const OWNER = {
    userId: "11111111-1111-4111-8111-111111111111",
    username: "owner",
    email: "owner@test.com",
    name: "Owner",
    role: "OWNER",
    createdAt: "2026-10-28T00:00:00Z",
};
const EDITOR = {
    userId: "22222222-2222-4222-8222-222222222222",
    username: "editor",
    email: "editor@test.com",
    name: "Editor",
    role: "EDITOR",
    createdAt: "2026-10-28T01:00:00Z",
};

const apiMock = vi.hoisted(() => ({
    listWorkspaceMembers: vi.fn<() => Promise<unknown[]>>(),
    addWorkspaceMember: vi.fn<(input: { username: string; role: string }) => Promise<unknown>>(),
    updateWorkspaceMemberRole: vi.fn<(userId: string, role: string) => Promise<unknown>>(),
    removeWorkspaceMember: vi.fn<(workspaceId: string, userId: string) => Promise<void>>(),
}));

vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        api: apiMock,
        // PLAN-0565: minimal ApiError stand-in carrying problem.code for mapping.
        ApiError: class MockApiError extends Error {
            problem: { code: string };
            constructor(code: string) {
                super(code);
                this.name = "MockApiError";
                this.problem = { code };
            }
        },
    };
});

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message?: unknown) => string | number>(),
        error: vi.fn<(message?: unknown) => string | number>(),
        warning: vi.fn<(message?: unknown) => string | number>(),
        info: vi.fn<(message?: unknown) => string | number>(),
    },
}));

async function mountPanel(readonly = false) {
    const { default: WorkspaceMembersPanel } = await import("../WorkspaceMembersPanel.vue");
    const wrapper = mount(WorkspaceMembersPanel, {
        attachTo: document.body,
        props: { workspaceId: WORKSPACE_ID, readonly },
        global: { plugins: [i18n] },
    });
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    apiMock.listWorkspaceMembers.mockResolvedValue([
        structuredClone(OWNER),
        structuredClone(EDITOR),
    ]);
    apiMock.addWorkspaceMember.mockResolvedValue({ ...EDITOR, role: "VIEWER" });
    apiMock.updateWorkspaceMemberRole.mockResolvedValue({ ...EDITOR, role: "VIEWER" });
    apiMock.removeWorkspaceMember.mockResolvedValue(undefined);
});

afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
});

describe("WorkspaceMembersPanel", () => {
    it("loads and renders members with identity fields", async () => {
        const wrapper = await mountPanel();
        expect(wrapper.findAll('[data-testid="ws-members-row"]')).toHaveLength(2);
        expect(wrapper.text()).toContain("owner");
        expect(wrapper.text()).toContain("editor@test.com");
        expect(apiMock.listWorkspaceMembers).toHaveBeenCalledWith(WORKSPACE_ID);
    });

    it("adds a member by username with the selected role", async () => {
        const wrapper = await mountPanel();
        await wrapper.find('[data-testid="ws-members-add-input"]').setValue("newmember");
        await wrapper.find('[data-testid="ws-members-add-btn"]').trigger("click");
        await flushPromises();

        expect(apiMock.addWorkspaceMember).toHaveBeenCalledWith(WORKSPACE_ID, {
            username: "newmember",
            role: "EDITOR",
        });
        expect(apiMock.listWorkspaceMembers).toHaveBeenCalledTimes(2);
    });

    it("blocks a username outside the shared name rule before any request (v29)", async () => {
        // v23/v29：username 与主体名同规则。含前后空格不静默 trim，符号/数字开头同样拦在前端。
        const wrapper = await mountPanel();
        const input = wrapper.find('[data-testid="ws-members-add-input"]');
        const button = wrapper.find('[data-testid="ws-members-add-btn"]');
        const hint = () => wrapper.find('[data-testid="ws-members-add-username-error"]');

        await input.setValue(" bad name ");
        await flushPromises();
        expect(button.attributes("disabled")).toBeDefined();
        expect(hint().text()).toContain("名称前后不能有空格");

        await input.setValue("abc-def");
        await flushPromises();
        expect(button.attributes("disabled")).toBeDefined();
        expect(hint().text()).toContain("只能使用英文字母、中文汉字或数字");

        await input.setValue("a".repeat(33));
        await flushPromises();
        expect(button.attributes("disabled")).toBeDefined();
        expect(hint().text()).toContain("用户名最长 32 个字符");

        await input.setValue("王小明");
        await flushPromises();
        expect(hint().exists()).toBe(false);
        expect(button.attributes("disabled")).toBeUndefined();

        expect(apiMock.addWorkspaceMember).not.toHaveBeenCalled();
    });

    it("surfaces the ruling-6 copy for unknown usernames", async () => {
        const { ApiError } = await import("../../../../composables/api");
        apiMock.addWorkspaceMember.mockRejectedValue(new ApiError("USER_NOT_FOUND"));
        const wrapper = await mountPanel();
        await wrapper.find('[data-testid="ws-members-add-input"]').setValue("ghost");
        await wrapper.find('[data-testid="ws-members-add-btn"]').trigger("click");
        await flushPromises();

        expect(wrapper.text()).toContain("该用户不存在，请对方先注册");
        expect(apiMock.listWorkspaceMembers).toHaveBeenCalledTimes(1);
    });

    it("maps already-exists and last-owner codes to localized copy", async () => {
        const { ApiError } = await import("../../../../composables/api");
        const wrapper = await mountPanel();

        apiMock.addWorkspaceMember.mockRejectedValue(new ApiError("MEMBER_ALREADY_EXISTS"));
        await wrapper.find('[data-testid="ws-members-add-input"]').setValue("owner");
        await wrapper.find('[data-testid="ws-members-add-btn"]').trigger("click");
        await flushPromises();
        expect(wrapper.text()).toContain("该用户已是工作区成员");

        apiMock.updateWorkspaceMemberRole.mockRejectedValue(new ApiError("LAST_OWNER"));
        // task-53 item 6：OWNER 行不再渲染角色选择器（item 列表里没有 OWNER 项 ⇒ 原先是个
        // 空框），所以「可改角色的行」只剩 editor 那一行 ⇒ 索引从 1 变 0。
        await setSelectValueAt(wrapper, 0, "VIEWER");
        await flushPromises();
        expect(wrapper.text()).toContain("不能移除或降级唯一所有者");
    });

    it("owner row has no empty role select; remove is disabled with a reason", async () => {
        // task-53 item 6（改前是"锁定所有者行的选择器"）：OWNER 行的 model-value 是 "OWNER"，
        // 而可选值只有 EDITOR/VIEWER ⇒ 那个 Select **没有对应 item**，触发器渲染成一个**空框**
        // （b02-tab-成员.png 所有者右侧那个空白下拉就是它）。空框既不可用也不解释自己，
        // 所以锁定行**不再渲染**选择器；角色由上面的 chip 呈现。
        const wrapper = await mountPanel();
        const ownerRow = wrapper.findAll('[data-testid="ws-members-row"]')[0]!;

        // 判据 1：所有者行**没有任何**角色选择器（不是"有但禁用"，而是根本不渲染空控件）。
        expect(ownerRow.findAll('[data-slot="select-trigger"]')).toHaveLength(0);
        // 判据 2：非锁定的 editor 行仍有选择器 ⇒ 上面那条不是因为整块被藏了才成立。
        // 注意这里有**两个**触发器：加人表单里的角色选择器 + editor 行的角色选择器
        // （所有者行的已按判据 1 消失），所以期望值是 2 而不是 1。
        expect(wrapper.findAll('[data-slot="select-trigger"]')).toHaveLength(2);
        expect(wrapper.findAll('[data-testid^="ws-members-role-"]')).toHaveLength(1);

        // 判据 3：唯一所有者不可移除，且**给出原因**（item 7：不能是可点却无反应的淡红按钮）。
        const removeBtn = ownerRow.get('[data-testid^="ws-members-remove-"]');
        expect(removeBtn.attributes("disabled")).toBeDefined();
        expect(removeBtn.attributes("title")).toBe("不能移除或降级唯一所有者");
        wrapper.unmount();

        const readonlyWrapper = await mountPanel(true);
        // BL-344 残留：只读不再"隐藏表单"（v-if），而是**保留节点 + hidden 类 + 禁用控件**
        // （否则节点替换会让 host E2E 的 fill→click 命中 detached 节点）。
        const readonlyForm = readonlyWrapper.get('[data-testid="ws-members-add"]');
        expect(readonlyForm.exists()).toBe(true);
        expect(readonlyForm.classes()).toContain("hidden");
        expect(
            (
                readonlyWrapper.get('[data-testid="ws-members-add-input"]')
                    .element as HTMLInputElement
            ).disabled,
        ).toBe(true);
        expect(readonlyWrapper.text()).toContain("仅工作区所有者可以管理成员。");
        expect(readonlyWrapper.findAll('[data-testid="ws-members-row"]')).toHaveLength(2);
        expect(apiMock.removeWorkspaceMember).not.toHaveBeenCalled();
        readonlyWrapper.unmount();
    });

    /**
     * task-85（DEV-011 §10:153「红，只在确认时出现」+ :168-169 可发现性例外；用户 2026-11-03 裁定）。
     *
     * <p>行内「移除」是**入口**，不是提交动作 —— 真正不可恢复的移除发生在确认弹窗里。
     * 改前实测（真浏览器）：本页列表态 3 个危险红控件（每行一个），违反「每屏 ≤ 1」；
     * 而且它们行内就红、同时违反「只在确认时出现」。改后行内为中性 outline，
     * 红只剩确认弹窗里的移除提交按钮（下面那条断言钉住它**必须**仍是 red）。</p>
     */
    it("行内「移除」是中性入口，危险视觉只留给确认弹窗（task-85）", async () => {
        const wrapper = await mountPanel();
        const rowRemoves = wrapper.findAll('[data-testid^="ws-members-remove-"]');
        expect(rowRemoves.length).toBeGreaterThan(0);
        for (const btn of rowRemoves) {
            // 判据 1：入口不得带危险视觉（variant 投影成 data-variant，class 里也不许出现 destructive）。
            expect(btn.attributes("data-variant")).toBe("outline");
            //      注意：Button 基类里带 `aria-invalid:*:destructive`（校验态用的），那是所有
            //      变体共有的、正常态不生效，所以只剔除该类 token 后判剩余危险 token。
            const dangerTokens = btn
                .classes()
                .filter((c) => /destructive/.test(c))
                .filter((c) => !/aria-invalid/.test(c));
            expect(dangerTokens).toHaveLength(0);
            // 判据 2：可发现性通道仍在（:168-169「位置固定 + 文字标签」）—— 颜色退出不等于入口消失。
            expect(btn.text()).toBe("移除");
            expect(btn.element.tagName).toBe("BUTTON");
        }
        wrapper.unmount();
    });
    it("removes a member through the confirm dialog", async () => {
        const wrapper = await mountPanel();
        const editorRow = wrapper.findAll('[data-testid="ws-members-row"]')[1];
        await editorRow.find('[data-testid^="ws-members-remove-"]').trigger("click");
        await flushPromises();

        expect(
            document.body.querySelector('[data-testid="ws-members-remove-confirm"]'),
        ).not.toBeNull();
        // task-49：模态语义三件套（role / aria-modal / 名字来自标题）。
        expectModalDialog("ws-members-remove-confirm", "alertdialog", "移除成员？");
        const confirm = document.body.querySelector(
            '[data-testid="ws-members-remove-btn"]',
        ) as HTMLButtonElement | null;
        expect(confirm).not.toBeNull();
        // task-85：红色只该落在确认弹窗里的提交按钮（行内入口已改中性）。
        expect(confirm!.getAttribute("data-variant")).toBe("destructive");
        confirm?.click();
        await flushPromises();

        expect(apiMock.removeWorkspaceMember).toHaveBeenCalledWith(WORKSPACE_ID, EDITOR.userId);
        expect(apiMock.listWorkspaceMembers).toHaveBeenCalledTimes(2);
        wrapper.unmount();
    });

    /**
     * BL-344 残留（首帧竞态）：`readonly` 三态。修前 `readonly` 是 boolean，首帧
     * `workspaceRole === undefined ⇒ canManageWorkspace=false ⇒ readonly=true` ⇒ 加人表单
     * **不渲染**，role 解析后才挂载 ⇒ host E2E 的 `fill()` 落在随后被替换的节点上（detached）。
     */
    it("三态：readonly 未解析（undefined）时加人表单可见但控件禁用", async () => {
        const wrapper = await mountPanel();
        await wrapper.setProps({ readonly: undefined });

        const form = wrapper.get('[data-testid="ws-members-add"]');
        expect(form.exists(), "readonly 未知时表单必须已挂载（修前首帧不渲染）").toBe(true);
        expect(form.classes(), "未知 ≠ 只读：容器可见").not.toContain("hidden");
        const input = wrapper.get('[data-testid="ws-members-add-input"]');
        expect((input.element as HTMLInputElement).disabled, "未知态按不可用渲染").toBe(true);
        expect(
            (wrapper.get('[data-testid="ws-members-add-btn"]').element as HTMLButtonElement)
                .disabled,
        ).toBe(true);
        wrapper.unmount();
    });

    it("三态：确定只读时表单仍挂载但视觉隐藏（hidden 类，不卸载）", async () => {
        const wrapper = await mountPanel(true);

        const form = wrapper.get('[data-testid="ws-members-add"]');
        expect(form.exists(), "确定只读时也不卸载，避免节点被替换").toBe(true);
        expect(form.classes(), "只读 ⇒ 视觉隐藏（hidden 类），不是 v-if").toContain("hidden");
        expect(
            (wrapper.get('[data-testid="ws-members-add-input"]').element as HTMLInputElement)
                .disabled,
        ).toBe(true);
        wrapper.unmount();
    });

    it("列表刷新后加人表单节点 identity 与已填草稿都保持不变", async () => {
        const wrapper = await mountPanel();
        const inputBefore = wrapper.get('[data-testid="ws-members-add-input"]')
            .element as HTMLInputElement;
        await wrapper.get('[data-testid="ws-members-add-input"]').setValue("membereditor");
        expect(inputBefore.value).toBe("membereditor");

        // 模拟"成员列表刷新"：换一份数据 + 换 workspaceId 触发一次重新加载。
        apiMock.listWorkspaceMembers.mockResolvedValue([
            structuredClone(OWNER),
            structuredClone(EDITOR),
            { ...structuredClone(EDITOR), userId: "22222222-2222-4222-8222-222222222222" },
        ]);
        await wrapper.setProps({ workspaceId: "77777777-7777-4777-8777-777777777777" });
        await flushPromises();

        const inputAfter = wrapper.get('[data-testid="ws-members-add-input"]')
            .element as HTMLInputElement;
        expect(inputAfter, "刷新后 input 必须是同一个 DOM 节点（不被销毁重建）").toBe(inputBefore);
        expect(inputAfter.value, "刷新后草稿不能被清空").toBe("membereditor");
        wrapper.unmount();
    });
});
