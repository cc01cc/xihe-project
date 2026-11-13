import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * task-402 / `D-1243 G2`：实例档技能绑定面。
 *
 * <p>**这组用例的核心判据是 wire 形状**：三个调用一律把 workspaceId 传 `null`
 * （⇒ 实例档，CP `deriveScope` 派生 instance 行）。真 HTTP 已在 stack-1 验过同一口径
 * （2026-11-14 02:35，POST 201 `scopeType=instance`/`scopeId=null`、DELETE 204、
 * body 多带一键 400），所以这里钉的是「UI 有没有按那个口径发」，不是重新发明契约。</p>
 *
 * <p>其余判据：两种 scope 都照实显示、候选只给实例库且排除已绑、两条读面**各自降级**、
 * 错误码本地化（不直显 CP 英文 detail）、关闭/无目标时不取数。</p>
 */
const { getAgentSkills, getSkills, bindAgentSkill, unbindAgentSkill, toastSuccess } = vi.hoisted(
    () => ({
        getAgentSkills:
            vi.fn<
                (workspaceId: string | null | undefined, principalId: string) => Promise<unknown>
            >(),
        getSkills: vi.fn<() => Promise<unknown>>(),
        bindAgentSkill:
            vi.fn<
                (
                    workspaceId: string | null | undefined,
                    principalId: string,
                    skillId: string,
                ) => Promise<unknown>
            >(),
        unbindAgentSkill:
            vi.fn<
                (
                    workspaceId: string | null | undefined,
                    principalId: string,
                    bindingId: string,
                ) => Promise<void>
            >(),
        toastSuccess: vi.fn<(message: string) => void>(),
    }),
);

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../composables/api")>();
    return {
        ...actual,
        api: { ...actual.api, getAgentSkills, getSkills, bindAgentSkill, unbindAgentSkill },
    };
});

vi.mock("vue-sonner", () => ({
    toast: { success: toastSuccess, error: vi.fn<(message: string) => void>() },
}));

import { ApiError } from "../../../composables/api";
import { i18n } from "../../../i18n";
import { Select } from "../../ui/select";
import InstanceAgentSkillsDialog from "../InstanceAgentSkillsDialog.vue";

const PRINCIPAL = { id: "principal-1", name: "评审助手" };

function binding(overrides: Record<string, unknown> = {}) {
    return {
        bindingId: "binding-1",
        principalId: PRINCIPAL.id,
        skillId: "skill-instance-1",
        name: "commit-msg",
        description: null,
        sourceType: "instance",
        sourceName: "实例技能库",
        scopeType: "instance",
        scopeId: null,
        scopeName: null,
        tokenEstimate: 180,
        createdAt: "2026-11-13T09:00:00Z",
        ...overrides,
    };
}

function definition(skillId: string, name: string, type: "instance" | "workspace" | "user") {
    return {
        skillId,
        name,
        definitionScope: { type, workspaceId: type === "workspace" ? "ws-1" : null },
    };
}

function q(testid: string): HTMLElement | null {
    return document.body.querySelector('[data-testid="' + testid + '"]');
}

function mountDialog(open = true, principal: { id: string; name: string } | null = PRINCIPAL) {
    return mount(InstanceAgentSkillsDialog, {
        props: { open, principal },
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
}

beforeEach(() => {
    document.body.innerHTML = "";
    getAgentSkills.mockReset();
    getSkills.mockReset();
    bindAgentSkill.mockReset();
    unbindAgentSkill.mockReset();
    toastSuccess.mockReset();
    getAgentSkills.mockResolvedValue([binding()]);
    getSkills.mockResolvedValue([
        definition("skill-instance-1", "commit-msg", "instance"),
        definition("skill-instance-2", "ui-review", "instance"),
    ]);
    bindAgentSkill.mockResolvedValue(
        binding({ bindingId: "binding-2", skillId: "skill-instance-2" }),
    );
    unbindAgentSkill.mockResolvedValue(undefined);
});

describe("InstanceAgentSkillsDialog（task-402 实例档）", () => {
    it("打开即取两条读面，且 workspaceId 一律传 null（实例档 wire 判据）", async () => {
        const wrapper = mountDialog();
        await flushPromises();
        expect(getAgentSkills).toHaveBeenCalledTimes(1);
        expect(getAgentSkills.mock.calls[0]).toEqual([null, PRINCIPAL.id]);
        expect(getSkills).toHaveBeenCalledTimes(1);
        wrapper.unmount();
    });

    it("列表照实显示两种 scope 与来源徽标、token 估算", async () => {
        getAgentSkills.mockResolvedValue([
            binding(),
            binding({
                bindingId: "binding-ws",
                skillId: "skill-ws-1",
                name: "repo-conventions",
                sourceType: "workspace",
                scopeType: "workspace",
                scopeId: "ws-1",
                scopeName: "Ws 一号",
                tokenEstimate: 260,
            }),
        ]);
        const wrapper = mountDialog();
        await flushPromises();
        expect(q("instance-agent-skills-list")).not.toBeNull();
        expect(q("instance-agent-skill-item-binding-1")).not.toBeNull();
        expect(q("instance-agent-skill-scope-instance")!.textContent).toContain("实例级");
        expect(q("instance-agent-skill-scope-workspace")!.textContent).toContain("工作区级");
        expect(q("instance-agent-skill-source-binding-ws")!.textContent).toContain("工作区技能");
        expect(q("instance-agent-skills-list")!.textContent).toContain("180");
        wrapper.unmount();
    });

    it("绑定：workspaceId 传 null + 只发 skillId，成功后重读列表并提示", async () => {
        const wrapper = mountDialog();
        await flushPromises();
        const select = wrapper.findAllComponents(Select)[0]!;
        select.vm.$emit("update:modelValue", "skill-instance-2");
        await flushPromises();
        q("instance-agent-skills-bind")!.click();
        await flushPromises();
        expect(bindAgentSkill).toHaveBeenCalledTimes(1);
        expect(bindAgentSkill.mock.calls[0]).toEqual([null, PRINCIPAL.id, "skill-instance-2"]);
        expect(getAgentSkills).toHaveBeenCalledTimes(2);
        expect(toastSuccess).toHaveBeenCalledTimes(1);
        wrapper.unmount();
    });

    it("解绑：workspaceId 传 null + 用 bindingId，成功后重读列表", async () => {
        const wrapper = mountDialog();
        await flushPromises();
        q("instance-agent-skill-unbind-binding-1")!.click();
        await flushPromises();
        expect(unbindAgentSkill).toHaveBeenCalledTimes(1);
        expect(unbindAgentSkill.mock.calls[0]).toEqual([null, PRINCIPAL.id, "binding-1"]);
        expect(getAgentSkills).toHaveBeenCalledTimes(2);
        wrapper.unmount();
    });

    it("候选只给实例库：工作区私有与个人定义都不列出（无候选时选择器禁用）", async () => {
        getSkills.mockResolvedValue([
            definition("skill-ws-1", "repo-conventions", "workspace"),
            definition("skill-user-1", "personal-note", "user"),
        ]);
        const wrapper = mountDialog();
        await flushPromises();
        expect(q("instance-agent-skills-no-candidates")).not.toBeNull();
        expect(wrapper.findAllComponents(Select)[0]!.props("disabled")).toBe(true);
        expect(q("instance-agent-skills-bind")!.hasAttribute("disabled")).toBe(true);
        wrapper.unmount();
    });

    it("已绑的不重复列出：唯一候选已绑 ⇒ 选择器禁用", async () => {
        getSkills.mockResolvedValue([definition("skill-instance-1", "commit-msg", "instance")]);
        const wrapper = mountDialog();
        await flushPromises();
        expect(wrapper.findAllComponents(Select)[0]!.props("disabled")).toBe(true);
        expect(q("instance-agent-skills-no-candidates")).not.toBeNull();
        wrapper.unmount();
    });

    it("列表读失败：给失败态与重试出口，重试成功后列表回来（不静默装空）", async () => {
        getAgentSkills.mockRejectedValueOnce(new Error("boom"));
        const wrapper = mountDialog();
        await flushPromises();
        expect(q("instance-agent-skills-load-failed")).not.toBeNull();
        expect(q("instance-agent-skills-empty")).toBeNull();
        q("instance-agent-skills-retry")!.click();
        await flushPromises();
        expect(getAgentSkills).toHaveBeenCalledTimes(2);
        expect(q("instance-agent-skills-list")).not.toBeNull();
        wrapper.unmount();
    });

    it("候选读失败：已绑的照常显示，只降级新绑（两条读面各自降级）", async () => {
        getSkills.mockRejectedValue(new Error("boom"));
        const wrapper = mountDialog();
        await flushPromises();
        expect(q("instance-agent-skills-list")).not.toBeNull();
        expect(q("instance-agent-skills-catalog-failed")).not.toBeNull();
        expect(q("instance-agent-skills-bind")!.hasAttribute("disabled")).toBe(true);
        wrapper.unmount();
    });

    it("空绑定：给空态文案而不是空白", async () => {
        getAgentSkills.mockResolvedValue([]);
        const wrapper = mountDialog();
        await flushPromises();
        expect(q("instance-agent-skills-empty")).not.toBeNull();
        expect(q("instance-agent-skills-list")).toBeNull();
        wrapper.unmount();
    });

    it("409 SKILL_BINDING_EXISTS ⇒ 本地化「已经绑过」，弹窗保持打开", async () => {
        bindAgentSkill.mockRejectedValue(
            new ApiError({ code: "SKILL_BINDING_EXISTS", detail: "already bound", status: 409 }),
        );
        const wrapper = mountDialog();
        await flushPromises();
        wrapper.findAllComponents(Select)[0]!.vm.$emit("update:modelValue", "skill-instance-2");
        await flushPromises();
        q("instance-agent-skills-bind")!.click();
        await flushPromises();
        const error = q("instance-agent-skills-error")!;
        expect(error.textContent).toContain("已经绑过");
        expect(error.textContent).not.toContain("already bound");
        expect(q("instance-agent-skills-dialog")).not.toBeNull();
        wrapper.unmount();
    });

    it("403 FORBIDDEN ⇒ 点名所需原子；404 SKILL_NOT_FOUND ⇒ 不泄露存在性", async () => {
        bindAgentSkill.mockRejectedValue(
            new ApiError({ code: "FORBIDDEN", detail: "denied", status: 403 }),
        );
        const wrapper = mountDialog();
        await flushPromises();
        wrapper.findAllComponents(Select)[0]!.vm.$emit("update:modelValue", "skill-instance-2");
        await flushPromises();
        q("instance-agent-skills-bind")!.click();
        await flushPromises();
        expect(q("instance-agent-skills-error")!.textContent).toContain("MANAGE_AGENT_PRINCIPALS");

        bindAgentSkill.mockRejectedValue(
            new ApiError({ code: "SKILL_NOT_FOUND", detail: "Skill not found", status: 404 }),
        );
        q("instance-agent-skills-bind")!.click();
        await flushPromises();
        expect(q("instance-agent-skills-error")!.textContent).toContain("无权查看");
        wrapper.unmount();
    });

    it("解绑失败也本地化，并且不把行从列表里假装删掉", async () => {
        unbindAgentSkill.mockRejectedValue(
            new ApiError({ code: "SKILL_BINDING_NOT_FOUND", detail: "gone", status: 404 }),
        );
        const wrapper = mountDialog();
        await flushPromises();
        q("instance-agent-skill-unbind-binding-1")!.click();
        await flushPromises();
        expect(q("instance-agent-skills-error")!.textContent).toContain("不存在");
        expect(q("instance-agent-skill-item-binding-1")).not.toBeNull();
        wrapper.unmount();
    });

    it("关闭或没有目标时不取数；关闭按钮回 update:open=false", async () => {
        const closed = mountDialog(false);
        await flushPromises();
        expect(getAgentSkills).not.toHaveBeenCalled();
        closed.unmount();

        const noTarget = mountDialog(true, null);
        await flushPromises();
        expect(getAgentSkills).not.toHaveBeenCalled();
        noTarget.unmount();

        const wrapper = mountDialog();
        await flushPromises();
        q("instance-agent-skills-close")!.click();
        await flushPromises();
        expect(wrapper.emitted("update:open")!.at(-1)).toEqual([false]);
        wrapper.unmount();
    });
});
