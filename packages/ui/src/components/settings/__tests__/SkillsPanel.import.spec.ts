import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent } from "vue";

import { i18n } from "../../../i18n";
import SettingsLayerHeader from "../SettingsLayerHeader.vue";
import SkillsPanel from "../SkillsPanel.vue";
import type { SkillDefinitionSummary } from "../../../composables/api";

/**
 * task-167 · 「导入技能」入口的**可见性与门**（不是"对话框好不好看"）。
 *
 * <p>两条口径来自 Lead 的裁定：</p>
 * <ol>
 *   <li><b>入口恒在</b>：无权时**置灰 + 写清理由**，绝不隐藏 —— 隐藏会让人以为产品没有导入能力
 *       （这正是 task-83 当时"本卡不铺开"留下的观感缺口）。所以断言分两条：无权时按钮**仍然存在**、
 *       且带 `disabled` 属性、且理由文本里点名所需原子。</li>
 *   <li><b>门按能力原子判</b>：`MANAGE_SKILL_LIBRARY`（CP `SkillAccessGuard.canManageInstanceLibrary()` 同源），
 *       **不是** `isAdmin` / 角色名。所以这里 mock 的 auth store 只暴露 `hasInstanceAtom`，
 *       即使"管理员"也别想绕过 —— 断言对象是原子集合。</li>
 * </ol>
 *
 * <p>为什么用真实 `SkillsImportDialog` 而不 stub：本卡要证明的是"点得开"这条链路，
 * stub 掉对话框就等于只证明了按钮有 `@click` 属性。</p>
 */

const listSkillDefinitions = vi.fn<() => Promise<SkillDefinitionSummary[]>>();
const importSkillDefinitions = vi.fn<(payload: unknown) => Promise<unknown>>();
const getSkillDefinition = vi.fn<(id: string, includeBody?: boolean) => Promise<null>>(
    async () => null,
);
const ensureSelfPermissions = vi.fn<() => Promise<void>>(async () => {});

const authState = vi.hoisted(() => ({ atoms: new Set<string>() }));

vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({
        hasInstanceAtom: (atom: string) => authState.atoms.has(atom),
        ensureSelfPermissions,
    }),
}));

// 只替换 `api` 的三个方法，其余（尤其 `ApiError`）保留真实实现 —— 对话框的
// `mapSkillImportError` 里 `instanceof ApiError` 需要真类，mock 掉会让失败路径抛 TypeError。
vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../composables/api")>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listSkillDefinitions: () => listSkillDefinitions(),
            importSkillDefinitions: (payload: unknown) => importSkillDefinitions(payload),
            getSkillDefinition: (id: string, includeBody?: boolean) =>
                getSkillDefinition(id, includeBody),
        },
    };
});

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
    // Dialog 内容会 Teleport 到 body ⇒ 必须 attachTo，并从 document 查。
    return mount(SkillsPanel, { global: { plugins: [i18n] }, attachTo: document.body });
}

function importEntry(): HTMLButtonElement | null {
    return document.body.querySelector<HTMLButtonElement>('[data-testid="settings-skills-import"]');
}

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    authState.atoms.clear();
    listSkillDefinitions.mockResolvedValue([skill()]);
    importSkillDefinitions.mockResolvedValue({
        results: [],
        rejected: [],
        summary: { created: 0, updated: 0, unchanged: 0, rejected: 0, oversize: 0 },
    });
});

describe("SkillsPanel · 导入入口门（task-167）", () => {
    it("持有 MANAGE_SKILL_LIBRARY：入口可点，点开就是真对话框（不是空壳）", async () => {
        authState.atoms.add("MANAGE_SKILL_LIBRARY");
        const wrapper = mountPanel();
        await flushPromises();

        const entry = importEntry();
        expect(entry, "入口必须渲染").not.toBeNull();
        expect(entry?.disabled).toBe(false);
        // 有权 ⇒ 不显示"为什么点不了"的理由条。
        expect(
            document.body.querySelector('[data-testid="settings-skills-import-disabled-reason"]'),
        ).toBeNull();

        entry?.click();
        await flushPromises();
        expect(document.body.querySelector('[data-testid="skills-import-dialog"]')).not.toBeNull();
        expect(
            document.body.querySelector('[data-testid="skills-import-dialog"]')?.textContent ?? "",
        ).toContain("导入技能定义");
        // 权限投影由面板挂载时拉取（单飞，失败 fail-closed）。
        expect(ensureSelfPermissions).toHaveBeenCalledTimes(1);
        wrapper.unmount();
    });

    it("无该原子：入口仍在但置灰，理由点名原子与下一步（隐藏=让人以为产品没有导入能力）", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        const entry = importEntry();
        expect(entry, "无权也必须渲染入口（不得隐藏）").not.toBeNull();
        expect(entry?.disabled).toBe(true);
        const reason =
            document.body.querySelector('[data-testid="settings-skills-import-disabled-reason"]')
                ?.textContent ?? "";
        expect(reason).toContain("MANAGE_SKILL_LIBRARY");
        expect(reason).toContain("实例管理员");
        // 点不动的按钮不许偷偷打开对话框。
        entry?.click();
        await flushPromises();
        expect(document.body.querySelector('[data-testid="skills-import-dialog"]')).toBeNull();
        wrapper.unmount();
    });

    it("只有 isAdmin 一类「管理员身份」不构成写权限：门只看原子", async () => {
        authState.atoms.add("MANAGE_INSTANCE_SETTINGS");
        const wrapper = mountPanel();
        await flushPromises();

        expect(importEntry()?.disabled).toBe(true);
        expect(
            document.body.querySelector('[data-testid="settings-skills-import-disabled-reason"]'),
        ).not.toBeNull();
        wrapper.unmount();
    });
    /**
     * task-176：**标题层级不跳级**。资源页不走域页的 `SettingsDomainView`（域页才渲染 `h2`），
     * 所以面板分节标题曾经是 `h3` ⇒ 屏幕/读屏读出来是 `h1（实例配置）→ h3（技能）`，**跳过 h2**。
     * 判据用**整页序列**（层标题 h1 + 面板分节标题），不是"标题只有一个"：
     * 期望 `["H1", "H2"]`；改前是 `["H1", "H3"]` ⇒ 必红。
     */
    it("标题层级不跳级：页面标题序列是 h1 → h2", async () => {
        const Host = defineComponent({
            components: { SettingsLayerHeader, SkillsPanel },
            template: `<div>
                <SettingsLayerHeader layer="instance" domain="技能" />
                <SkillsPanel />
            </div>`,
        });
        const wrapper = mount(Host, {
            global: { plugins: [i18n], stubs: { RouterLink: true } },
            attachTo: document.body,
        });
        await flushPromises();
        const tags = Array.from(wrapper.element.querySelectorAll("h1,h2,h3,h4")).map(
            (node) => node.tagName,
        );
        expect(tags).toEqual(["H1", "H2"]);
        wrapper.unmount();
    });
});
