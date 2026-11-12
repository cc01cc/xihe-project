import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";

import { i18n } from "../../../i18n";
import PersonalSkillsPanel from "../PersonalSkillsPanel.vue";
import type { SkillDefinitionSummary, SkillImportResultPayload } from "../../../composables/api";

/**
 * `T2b.3` · 「我的技能」面板（个人技能库）。
 *
 * <p>四条断言对应卡的验收：</p>
 * <ol>
 *   <li><b>读面不挂原子</b>：没有 `MANAGE_PERSONAL_SKILLS` 也照常列数据（P-189-3：
 *       撤销原子后读仍开放）—— 这是本卡**最重要的**一条：置灰整页会把"看不到自己已存的技能"
 *       变成产品行为。</li>
 *   <li><b>写面无权 = 按钮在、`disabled`、理由点名原子**且在 DOM 里**（不隐藏、不只给 `title`）。</li>
 *   <li><b>导入成功 ⇒ 重新取列表**（不乐观插入：`version`/`bodyTokensEst` 是服务端算的）。</li>
 *   <li><b>导入失败 ⇒ 逐条 `rejected[].code` 用同一张码表上屏**，且 CP 的英文 `detail` 不上屏。</li>
 * </ol>
 *
 * <p>`SkillsImportDialog` 的内容经 `Teleport` 落到 `document.body`，所以对话框部分一律从
 * `document` 取（与 `SkillsImportDialog.spec.ts` 同一手法）。</p>
 */
const listPersonalSkills = vi.fn<() => Promise<SkillDefinitionSummary[]>>();
const importSkillDefinitions = vi.fn<(payload: unknown) => Promise<SkillImportResultPayload>>();
const ensureSelfPermissions = vi.fn<() => Promise<void>>(async () => {});

const authState = vi.hoisted(() => ({ atoms: new Set<string>() }));

vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({
        hasInstanceAtom: (atom: string) => authState.atoms.has(atom),
        ensureSelfPermissions,
    }),
}));

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../composables/api")>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listPersonalSkills: () => listPersonalSkills(),
            importSkillDefinitions: (payload: unknown) => importSkillDefinitions(payload),
        },
    };
});

function skill(overrides: Partial<SkillDefinitionSummary> = {}): SkillDefinitionSummary {
    return {
        skillId: "skill-personal-a",
        name: "my-personal-skill",
        definitionScope: { type: "user", workspaceId: null },
        description: "只属于我的技能",
        bodyTokensEst: 120,
        oversize: false,
        trusted: false,
        sourcePath: "skills/my-personal-skill/SKILL.md",
        contentHash: "a".repeat(64),
        version: 3,
        attachments: [],
        updatedAt: "2026-11-12T08:00:00Z",
        ...overrides,
    };
}

const IMPORT_RESULT: SkillImportResultPayload = {
    results: [
        {
            skillId: "skill-new",
            name: "new-skill",
            action: "created",
            version: 1,
            bodyTokensEst: 10,
            oversize: false,
        },
    ],
    rejected: [],
    summary: { created: 1, updated: 0, unchanged: 0, rejected: 0, oversize: 0 },
};

function mountPanel() {
    return mount(PersonalSkillsPanel, {
        global: {
            plugins: [i18n],
            // 行尾详情入口是 `router-link`；本 spec 不测导航，stub 掉避免引入整个 router。
            stubs: { RouterLink: { template: "<a><slot /></a>" } },
        },
        attachTo: document.body,
    });
}

function q<T extends Element = HTMLElement>(selector: string): T {
    const node = document.body.querySelector<T>(selector);
    if (!node) throw new Error("missing node: " + selector);
    return node;
}

function userBatch(name = "my-personal-skill"): string {
    return JSON.stringify({
        definitionScope: { type: "user" },
        skills: [
            {
                name,
                description: "只属于我的技能",
                body: "## 步骤\n\n1. 只对自己生效",
                sourcePath: `skills/${name}/SKILL.md`,
            },
        ],
    });
}

async function submitBatch(json: string): Promise<void> {
    const textarea = q<HTMLTextAreaElement>('[data-testid="skills-import-json"]');
    textarea.value = json;
    textarea.dispatchEvent(new Event("input"));
    await nextTick();
    q('[data-testid="skills-import-submit"]').click();
    await nextTick();
    await nextTick();
}

/** `task-312` 新建对话框的字段填写与提交（内容 Teleport 到 body，故从 `document` 取）。 */
async function fillCreate(fields: {
    name: string;
    description: string;
    body: string;
}): Promise<void> {
    const targets: Array<[string, string]> = [
        ["personal-skill-create-name", fields.name],
        ["personal-skill-create-description", fields.description],
        ["personal-skill-create-body", fields.body],
    ];
    for (const [testid, value] of targets) {
        const input = q<HTMLInputElement>(`[data-testid="${testid}"]`);
        input.value = value;
        input.dispatchEvent(new Event("input"));
    }
    await nextTick();
}

async function clickCreateSubmit(): Promise<void> {
    q('[data-testid="personal-skill-create-submit"]').click();
    await flushPromises();
    await nextTick();
}

beforeEach(() => {
    authState.atoms = new Set<string>();
    listPersonalSkills.mockReset();
    importSkillDefinitions.mockReset();
    ensureSelfPermissions.mockClear();
    listPersonalSkills.mockResolvedValue([skill()]);
    // 两个对话框都 Teleport 到 body：上一个用例的残留会让 `querySelector` 取到旧节点。
    document.body.innerHTML = "";
});

describe("我的技能面板（T2b.3）", () => {
    it("没有 MANAGE_PERSONAL_SKILLS 也照常列数据（读面不挂原子，P-189-3）", async () => {
        const wrapper = mountPanel();
        await nextTick();
        await nextTick();

        // 数据来自 `GET /skills?definitionScope=user`（只带 scope、不带 workspaceId）。
        expect(listPersonalSkills).toHaveBeenCalledTimes(1);
        expect(wrapper.find("[data-testid='personal-skills-panel']").exists()).toBe(true);
        expect(
            wrapper.find("[data-testid='personal-skill-item-skill-personal-a']").text(),
        ).toContain("my-personal-skill");
        // 错误态/空态都不该出现（有数据就是有数据）。
        expect(wrapper.find("[data-testid='personal-skills-error']").exists()).toBe(false);
        wrapper.unmount();
    });

    it("无权写：导入按钮仍在 DOM、disabled，且理由文本点名 MANAGE_PERSONAL_SKILLS", async () => {
        const wrapper = mountPanel();
        await nextTick();
        await nextTick();

        const button = wrapper.find("[data-testid='personal-skills-import']");
        expect(button.exists()).toBe(true);
        expect(button.attributes("disabled")).toBeDefined();
        // 理由必须**在页面上**（只写 `title` 的话键盘/读屏/触屏都拿不到）。
        const reason = wrapper.find("[data-testid='personal-skills-import-disabled-reason']");
        expect(reason.exists()).toBe(true);
        expect(reason.text()).toContain("MANAGE_PERSONAL_SKILLS");
        expect(button.attributes("title")).toContain("MANAGE_PERSONAL_SKILLS");
        wrapper.unmount();
    });

    it("有 MANAGE_PERSONAL_SKILLS：按钮可点，理由行不渲染", async () => {
        authState.atoms.add("MANAGE_PERSONAL_SKILLS");
        const wrapper = mountPanel();
        await nextTick();
        await nextTick();

        const button = wrapper.find("[data-testid='personal-skills-import']");
        expect(button.attributes("disabled")).toBeUndefined();
        expect(
            wrapper.find("[data-testid='personal-skills-import-disabled-reason']").exists(),
        ).toBe(false);
        wrapper.unmount();
    });

    it("导入成功 ⇒ 重新取列表（不乐观插入）并显示汇总", async () => {
        authState.atoms.add("MANAGE_PERSONAL_SKILLS");
        importSkillDefinitions.mockResolvedValue(IMPORT_RESULT);
        const wrapper = mountPanel();
        await nextTick();
        await nextTick();
        expect(listPersonalSkills).toHaveBeenCalledTimes(1);

        wrapper.find("[data-testid='personal-skills-import']").trigger("click");
        await nextTick();
        await submitBatch(userBatch());

        // 提交形状：type=user，且**不带 workspaceId、不带 trusted**（P-189-1）。
        expect(importSkillDefinitions).toHaveBeenCalledTimes(1);
        const payload = importSkillDefinitions.mock.calls[0]![0] as {
            definitionScope: Record<string, unknown>;
            skills: Array<Record<string, unknown>>;
        };
        expect(payload.definitionScope).toEqual({ type: "user" });
        expect(payload.skills[0]!.trusted).toBeUndefined();

        // 成功后重新取列表（第二次调用），并把服务端汇总原样显示。
        expect(listPersonalSkills).toHaveBeenCalledTimes(2);
        expect(wrapper.find("[data-testid='personal-skills-import-summary']").text()).toContain(
            "1",
        );
        wrapper.unmount();
    });

    it("导入被逐条拒 ⇒ 按 rejected[].code 上屏本地化理由，且不显示 CP 英文 detail", async () => {
        authState.atoms.add("MANAGE_PERSONAL_SKILLS");
        importSkillDefinitions.mockResolvedValue({
            results: [],
            rejected: [
                {
                    sourcePath: "skills/bad-name/SKILL.md",
                    code: "SKILL_NAME_INVALID",
                    detail: "name does not match the required pattern",
                },
            ],
            summary: { created: 0, updated: 0, unchanged: 0, rejected: 1, oversize: 0 },
        });
        const wrapper = mountPanel();
        await nextTick();
        await nextTick();

        wrapper.find("[data-testid='personal-skills-import']").trigger("click");
        await nextTick();
        await submitBatch(userBatch());

        const rejected = wrapper.find("[data-testid='personal-skills-rejected-0']");
        expect(rejected.exists()).toBe(true);
        expect(rejected.text()).toContain("skills/bad-name/SKILL.md");
        // 码 → 中文措辞（与实例面板同一张表），英文 detail 不上屏。
        expect(rejected.text()).toContain("名称不合规");
        expect(rejected.text()).not.toContain("does not match the required pattern");
        wrapper.unmount();
    });

    it("无权写：新建按钮同样在 DOM、disabled，并共用同一条理由（task-312）", async () => {
        const wrapper = mountPanel();
        await nextTick();
        await nextTick();

        const create = wrapper.find("[data-testid='personal-skills-create']");
        expect(create.exists()).toBe(true);
        expect(create.attributes("disabled")).toBeDefined();
        // 两个入口共用一个理由段落：`aria-describedby` 指向同一个 id（只置灰不说原因 = 用户以为自己操作错了）。
        expect(create.attributes("aria-describedby")).toBe("personal-skills-import-reason");
        expect(
            wrapper.find("[data-testid='personal-skills-import-disabled-reason']").exists(),
        ).toBe(true);
        expect(create.attributes("title")).toContain("MANAGE_PERSONAL_SKILLS");
        wrapper.unmount();
    });

    it("有 MANAGE_PERSONAL_SKILLS：点新建打开个人层专用对话框（task-312）", async () => {
        authState.atoms.add("MANAGE_PERSONAL_SKILLS");
        const wrapper = mountPanel();
        await nextTick();
        await nextTick();

        wrapper.find("[data-testid='personal-skills-create']").trigger("click");
        await nextTick();
        await nextTick();

        expect(q('[data-testid="personal-skill-create-dialog"]')).toBeTruthy();
        wrapper.unmount();
    });

    it("新建成功 ⇒ 单条 payload（无 definition_scope_id / trusted）且列表重取（task-312）", async () => {
        authState.atoms.add("MANAGE_PERSONAL_SKILLS");
        importSkillDefinitions.mockResolvedValue(IMPORT_RESULT);
        const wrapper = mountPanel();
        await nextTick();
        await nextTick();
        expect(listPersonalSkills).toHaveBeenCalledTimes(1);

        wrapper.find("[data-testid='personal-skills-create']").trigger("click");
        await nextTick();
        await fillCreate({ name: "new-skill", description: "一条新说明", body: "## 正文" });
        await clickCreateSubmit();

        // 裁定 A：不新增端点，提交就是 `POST /skills/import` 的**单条**批。
        expect(importSkillDefinitions).toHaveBeenCalledTimes(1);
        const payload = importSkillDefinitions.mock.calls[0]![0] as {
            definitionScope: Record<string, unknown>;
            skills: Array<Record<string, unknown>>;
        };
        expect(payload.definitionScope).toEqual({ type: "user" });
        expect(payload.skills).toHaveLength(1);
        expect(payload.skills[0]!.sourcePath).toBe("manual/new-skill/SKILL.md");
        // 键**不存在**（不是 `=== undefined`）：这两个键一个由 CP 从 token 取、一个个人层禁入。
        expect("definition_scope_id" in payload.skills[0]!).toBe(false);
        expect("trusted" in payload.skills[0]!).toBe(false);

        // 成功后重取列表 + 显示服务端汇总（不乐观插入）。
        expect(listPersonalSkills).toHaveBeenCalledTimes(2);
        expect(wrapper.find("[data-testid='personal-skills-import-summary']").text()).toContain(
            "1",
        );
        wrapper.unmount();
    });

    it("新建同名 ⇒ 确认框带出列表里的当前版本，确认前不发请求（task-312）", async () => {
        authState.atoms.add("MANAGE_PERSONAL_SKILLS");
        const wrapper = mountPanel();
        await nextTick();
        await nextTick();
        // 默认夹具里 `my-personal-skill` 的 version = 3（服务端算的，面板不猜）。

        wrapper.find("[data-testid='personal-skills-create']").trigger("click");
        await nextTick();
        await fillCreate({
            name: "my-personal-skill",
            description: "覆盖前先确认",
            body: "## 新正文",
        });
        await clickCreateSubmit();

        expect(importSkillDefinitions).not.toHaveBeenCalled();
        const confirmBody =
            q('[data-testid="personal-skill-create-confirm-body"]').textContent ?? "";
        expect(confirmBody).toContain("my-personal-skill");
        expect(confirmBody).toContain("v3");
        // 必须同时说出"会更新"与"原内容不可恢复"，否则会被读成合并或另存。
        expect(confirmBody).toContain("原内容不可恢复");
        wrapper.unmount();
    });
});
