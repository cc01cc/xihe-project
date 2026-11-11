import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

import { i18n } from "../../../i18n";
import { expectNoRawI18nKey } from "../../../test-utils/i18nKeys";
import SkillsPanel from "../SkillsPanel.vue";
import type { SkillDefinitionDetail, SkillDefinitionSummary } from "../../../composables/api";

/**
 * task-83 · 实例层技能页（只读）。
 *
 * 这五条用例锁的不是「能不能渲染」，而是几个**会悄悄退化**的口径：
 * ① 展开才取正文（列表接口不带 body，预取 N 条 = 白花 N 个请求）；
 * ② 正文容器必须限高滚动（正文是最大的列，去掉 `max-h` 会把页顶开）；
 * ③ `oversize`/`trusted` 是服务端字段，UI 不自己算；
 * ④ 不把 `workspaceId` 打印到界面（内部标识）；
 * ⑤ 空态 / 错误态各有出口（错误态要有重试）。
 */

const listSkillDefinitions = vi.fn<() => Promise<SkillDefinitionSummary[]>>();
const getSkillDefinition =
    vi.fn<(id: string, includeBody?: boolean) => Promise<SkillDefinitionDetail | null>>();

vi.mock("../../../composables/api", () => ({
    api: {
        listSkillDefinitions: () => listSkillDefinitions(),
        getSkillDefinition: (id: string, includeBody?: boolean) =>
            getSkillDefinition(id, includeBody),
    },
}));

function skill(overrides: Partial<SkillDefinitionSummary> = {}): SkillDefinitionSummary {
    return {
        skillId: "skill-a",
        name: "commit-msg-review",
        definitionScope: { type: "instance", workspaceId: null },
        description: "按仓库规范检查 commit message。",
        bodyTokensEst: 412,
        oversize: false,
        trusted: false,
        sourcePath: "skills/commit-msg-review/SKILL.md",
        contentHash: "a".repeat(64),
        version: 3,
        attachments: [],
        updatedAt: "2026-11-12T07:41:00Z",
        ...overrides,
    };
}

function mountPanel() {
    return mount(SkillsPanel, { global: { plugins: [i18n] } });
}

beforeEach(() => {
    listSkillDefinitions.mockReset();
    getSkillDefinition.mockReset();
});

describe("SkillsPanel（task-83）", () => {
    it("列出定义并显示条数、实例徽标与正文估算 token（前缀 ≈，不自己算）", async () => {
        listSkillDefinitions.mockResolvedValue([skill()]);
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.get('[data-testid="settings-skills-count"]').text()).toContain("1");
        const item = wrapper.get('[data-testid="skill-item-skill-a"]');
        expect(item.text()).toContain("commit-msg-review");
        expect(item.text()).toContain("实例");
        expect(item.text()).toContain("≈412");
        // task-93：整页不许出现裸 i18n 键（夹具缺键 / 用了不存在的键都会在这里红）
        expectNoRawI18nKey(wrapper.html());
        // 列表阶段绝不能请求正文
        expect(getSkillDefinition).not.toHaveBeenCalled();
    });

    it("oversize / trusted 直接取服务端字段，不做本地推断", async () => {
        listSkillDefinitions.mockResolvedValue([
            skill({ skillId: "skill-oversize", oversize: true, trusted: true }),
        ]);
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="skill-oversize-skill-oversize"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="skill-trusted-skill-oversize"]').exists()).toBe(true);
        // 只给一个 id 的字段，另一条同名字段不能被"猜"出来
        const plain = [skill({ skillId: "skill-plain" })];
        listSkillDefinitions.mockResolvedValue(plain);
        const wrapper2 = mountPanel();
        await flushPromises();
        expect(wrapper2.find('[data-testid="skill-oversize-skill-plain"]').exists()).toBe(false);
    });

    it("展开才取一次正文，折叠再展开不重复请求，正文落在限高滚动容器里", async () => {
        listSkillDefinitions.mockResolvedValue([skill()]);
        getSkillDefinition.mockResolvedValue({ ...skill(), body: "# 正文\n\n第二行" });
        const wrapper = mountPanel();
        await flushPromises();

        const toggle = wrapper.get('[data-testid="skill-body-toggle-skill-a"]');
        await toggle.trigger("click");
        await flushPromises();

        expect(getSkillDefinition).toHaveBeenCalledTimes(1);
        expect(getSkillDefinition).toHaveBeenCalledWith("skill-a", true);
        const pre = wrapper.get('[data-testid="skill-body-skill-a"] pre');
        expect(pre.text()).toContain("# 正文");
        // ② 正文容器必须限高（去掉 max-h 会让一条长定义把整页撑开）
        expect(pre.classes().join(" ")).toContain("max-h-64");
        expect(pre.classes().join(" ")).toContain("overflow-auto");

        // 折叠后重新展开：命中缓存，不再发请求
        await toggle.trigger("click");
        await flushPromises();
        await toggle.trigger("click");
        await flushPromises();
        expect(getSkillDefinition).toHaveBeenCalledTimes(1);
    });

    it("workspace 私有定义只显示徽标，不把 workspaceId 打到界面上", async () => {
        listSkillDefinitions.mockResolvedValue([
            skill({
                skillId: "skill-ws",
                definitionScope: {
                    type: "workspace",
                    workspaceId: "9f1c0b8e-1d2a-4e6f-8a3b-5c7d9e0f1a2b",
                },
            }),
        ]);
        const wrapper = mountPanel();
        await flushPromises();

        const text = wrapper.text();
        expect(text).toContain("工作区私有");
        expect(text).not.toContain("9f1c0b8e-1d2a-4e6f-8a3b-5c7d9e0f1a2b");
    });

    it("空态与错误态各有出口：错误态可重试且成功后渲染列表", async () => {
        listSkillDefinitions.mockResolvedValue([]);
        const empty = mountPanel();
        await flushPromises();
        expect(empty.find('[data-testid="settings-skills-empty"]').exists()).toBe(true);

        listSkillDefinitions.mockRejectedValueOnce(new Error("boom"));
        const failed = mountPanel();
        await flushPromises();
        expect(failed.find('[data-testid="settings-skills-error"]').exists()).toBe(true);

        listSkillDefinitions.mockResolvedValue([skill()]);
        await failed.get('[data-testid="settings-skills-retry"]').trigger("click");
        await flushPromises();
        expect(failed.find('[data-testid="settings-skills-error"]').exists()).toBe(false);
        expect(failed.find('[data-testid="skill-item-skill-a"]').exists()).toBe(true);
    });
});
