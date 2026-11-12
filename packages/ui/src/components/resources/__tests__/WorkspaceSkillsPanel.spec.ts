import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

import { i18n } from "../../../i18n";
import WorkspaceSkillsPanel from "../WorkspaceSkillsPanel.vue";
import type { AgentSkillSummary } from "../../../composables/api";

/**
 * `T2b.3` · 「本工作区技能」面板**不画来源列**（Lead 2026-11-12 裁定 ①，负断言）。
 *
 * <p>为什么是负断言而不是"列值对不对"：`GET /skills?definitionScope=workspace&workspaceId=`
 * 的实现是 `findByDefinitionScope(WORKSPACE, workspaceId)`（`SkillLibraryService.list:70-71`）⇒
 * 返回的每一条都是**本区定义**；「继承自平台」不是一条技能定义行（继承发生在 agent 绑定，
 * `SkillBindingCreateRequest.skillId` 指向实例定义），本页拿不到该关系；`SkillView`
 * （`openapi.yaml:8531-8550`）也没有逐行来源字段。计划自己的 spec 同样写明不画
 * （`plans/PLAN-0772-.../spec/resource-layer-matrix.md:53`）。
 *
 * <p>⇒ 画一个"本区自建 / 继承自平台"两值列 = 编数据。本 spec 钉住两件事：
 * ①**不存在**来源列与两个编造值（含拟议的第三值 `覆盖平台同名`）；
 * ②页面上有一句真话解释"为什么没有来源列"（不是沉默地少一列）。</p>
 */
const getWorkspaceSkills = vi.fn<(workspaceId: string) => Promise<AgentSkillSummary[]>>();

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../composables/api")>();
    return {
        ...actual,
        api: {
            ...actual.api,
            getWorkspaceSkills: (workspaceId: string) => getWorkspaceSkills(workspaceId),
        },
    };
});

function wsSkill(overrides: Partial<AgentSkillSummary> = {}): AgentSkillSummary {
    return {
        skillId: "skill-ws-a",
        name: "workspace-only-skill",
        definitionScope: { type: "workspace", workspaceId: "ws-1" },
        ...overrides,
    };
}

function mountPanel() {
    return mount(WorkspaceSkillsPanel, {
        props: { workspaceId: "ws-1" },
        global: {
            plugins: [i18n],
            stubs: { RouterLink: { template: "<a><slot /></a>" } },
        },
    });
}

beforeEach(() => {
    getWorkspaceSkills.mockReset();
    getWorkspaceSkills.mockResolvedValue([wsSkill()]);
});

describe("本工作区技能面板：不画来源列（T2b.3）", () => {
    it("列出本区定义，且页面**没有**来源列/来源徽标（含拟议的第三值）", async () => {
        const wrapper = mountPanel();
        await nextTick();
        await nextTick();

        expect(getWorkspaceSkills).toHaveBeenCalledWith("ws-1");
        expect(wrapper.find("[data-testid='workspace-skill-item-skill-ws-a']").text()).toContain(
            "workspace-only-skill",
        );

        const text = wrapper.text();
        // 两个真实值都不该出现在**列/单元格**里：本层列表没有"继承"行（数据面拿不到该关系）。
        expect(text).not.toContain("继承自平台");
        expect(text).not.toContain("覆盖平台同名");
        const cells = wrapper.findAll("td, th").map((cell) => cell.text());
        expect(cells).not.toContain("本区自建");
        expect(cells).not.toContain("来源");
        // 没有任何"来源"列/单元格的 testid 或表头。
        expect(wrapper.findAll("[data-testid^='skills-source']")).toHaveLength(0);
        expect(wrapper.findAll("th").map((th) => th.text())).not.toContain("来源");
    });

    it("用一句话解释「为什么没有来源列」（不沉默地少一列）", async () => {
        const wrapper = mountPanel();
        await nextTick();
        await nextTick();

        const note = wrapper.find("[data-testid='workspace-skills-source-note']");
        expect(note.exists()).toBe(true);
        expect(note.text()).toContain("本区自建定义");
        expect(note.text()).toContain("绑定");
    });
});
