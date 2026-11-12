import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";

import { ApiError, type SkillImportResultPayload } from "../../../composables/api";
import { i18n } from "../../../i18n";
import PersonalSkillCreateDialog from "../PersonalSkillCreateDialog.vue";

/**
 * `task-312` · 个人层「新建技能」对话框（裁定 A：复用 `POST /skills/import` 的**单条**批）。
 *
 * <p>断言的重点不是"按钮在不在"，而是三件会翻车的事：</p>
 * <ol>
 *   <li><b>提交出去的形状</b>：`definition_scope_id` / `trusted` / `attachments` **键不存在**
 *       （用 `in` 判，不用 `=== undefined` —— 后者在"显式设成 undefined"时也会过，而那正是我们要禁的
 *       形态）；`sourcePath` 由 name 派生为 `manual/<name>/SKILL.md`。</li>
 *   <li><b>本地预检不发明规则、也不放过空正文</b>：名字按 CP 的 `NAME_PATTERN` 判；`body` trim 后
 *       为空 ⇒ 不发请求（单条 create 最容易出的错是"提交成功但建了个空技能"）。</li>
 *   <li><b>200 不等于成功</b>：`rejected[]` 与 `unchanged` 都不是 created —— 前者不关窗、就地给原因
 *       （CP 英文 `detail` 只进 logger），后者如实说"没有做任何修改"。</li>
 * </ol>
 *
 * <p>`Dialog` / `AlertDialog` 的内容都经 `Teleport` 落到 `document.body`，所以统一
 * `attachTo: document.body` + 从 `document` 取（与 `SkillsImportDialog.spec.ts` 同一手法）。</p>
 */
function mountDialog(
    submit: (payload: unknown) => Promise<unknown>,
    existing?: ReadonlyArray<{ name: string; version: number }>,
) {
    return mount(PersonalSkillCreateDialog, {
        props: { open: true, submit: submit as never, existing },
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
}

/** Teleport 到 body ⇒ 一律从 document 取；取不到就直接炸，别让空 wrapper 静默通过。 */
function q<T extends Element = HTMLElement>(selector: string): T {
    const node = document.body.querySelector<T>(selector);
    if (!node) throw new Error("missing node: " + selector);
    return node;
}

function text(selector: string): string {
    return (q(selector).textContent ?? "").trim();
}

async function fill(fields: { name?: string; description?: string; body?: string }): Promise<void> {
    const targets: Array<[string, string | undefined]> = [
        ["personal-skill-create-name", fields.name],
        ["personal-skill-create-description", fields.description],
        ["personal-skill-create-body", fields.body],
    ];
    for (const [testid, value] of targets) {
        if (value === undefined) continue;
        const input = q<HTMLInputElement>(`[data-testid="${testid}"]`);
        input.value = value;
        input.dispatchEvent(new Event("input"));
    }
    await nextTick();
}

async function clickSubmit(): Promise<void> {
    q('[data-testid="personal-skill-create-submit"]').click();
    await flushPromises();
    await nextTick();
}

function importResult(action: "created" | "updated" | "unchanged"): SkillImportResultPayload {
    return {
        results: [
            {
                skillId: "skill-new",
                name: "my-note",
                action,
                version: action === "created" ? 1 : 4,
                bodyTokensEst: 12,
                oversize: false,
            },
        ],
        rejected: [],
        summary: {
            created: action === "created" ? 1 : 0,
            updated: action === "updated" ? 1 : 0,
            unchanged: action === "unchanged" ? 1 : 0,
            rejected: 0,
            oversize: 0,
        },
    };
}

function rejectedResult(code: string, detail: string): SkillImportResultPayload {
    return {
        results: [],
        rejected: [{ sourcePath: "manual/my-note/SKILL.md", code, detail }],
        summary: { created: 0, updated: 0, unchanged: 0, rejected: 1, oversize: 0 },
    };
}

const VALID_FIELDS = {
    name: "my-note",
    description: "个人用的一条说明",
    body: "## 步骤\n\n1. 只对我生效",
};

describe("PersonalSkillCreateDialog（task-312）", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = "";
    });

    it("成功：单条 payload 与契约同形，definition_scope_id / trusted 键**不存在**", async () => {
        const submit = vi
            .fn<(payload: unknown) => Promise<unknown>>()
            .mockResolvedValue(importResult("created"));
        const wrapper = mountDialog(submit);
        await fill(VALID_FIELDS);
        await clickSubmit();

        expect(submit).toHaveBeenCalledTimes(1);
        const payload = submit.mock.calls[0][0] as {
            definitionScope: Record<string, unknown>;
            skills: Array<Record<string, unknown>>;
        };
        // 顶层：只有两个键，作用域是 user 且**没有 id 字段**。
        expect(Object.keys(payload).sort()).toEqual(["definitionScope", "skills"]);
        expect(payload.definitionScope).toEqual({ type: "user" });
        expect("definition_scope_id" in payload).toBe(false);
        expect("workspaceId" in payload.definitionScope).toBe(false);

        expect(payload.skills).toHaveLength(1);
        expect(payload.skills[0]).toEqual({
            ...VALID_FIELDS,
            sourcePath: "manual/my-note/SKILL.md",
        });
        // 硬判据（Lead 验收口径）：**键不存在**，不是 `=== undefined`。
        expect("definition_scope_id" in payload.skills[0]).toBe(false);
        expect("trusted" in payload.skills[0]).toBe(false);
        expect("attachments" in payload.skills[0]).toBe(false);

        // 成功即关窗（列表会刷新出行，无需在窗里再留一份"成功"副本）。
        expect(wrapper.emitted("update:open")).toEqual([[false]]);
        expect(wrapper.emitted("imported")).toHaveLength(1);
    });

    it("名字不合法 ⇒ 按 CP 的 NAME_PATTERN 本地拒，不发请求", async () => {
        const submit = vi.fn<(payload: unknown) => Promise<unknown>>();
        mountDialog(submit);
        await fill({ ...VALID_FIELDS, name: "My Skill" });
        await clickSubmit();

        expect(submit).not.toHaveBeenCalled();
        expect(text('[data-testid="personal-skill-create-name-error"]')).toBe(
            i18n.global.t("settings.skills.import.rejected.nameInvalid"),
        );
    });

    it("正文 trim 后为空 ⇒ 本地拒，不发请求（不建空技能）", async () => {
        const submit = vi.fn<(payload: unknown) => Promise<unknown>>();
        mountDialog(submit);
        await fill({ ...VALID_FIELDS, body: "   \n\t  " });
        await clickSubmit();

        expect(submit).not.toHaveBeenCalled();
        expect(text('[data-testid="personal-skill-create-body-error"]')).toBe(
            i18n.global.t("settings.skills.import.rejected.bodyEmpty"),
        );
    });

    it("同名已存在 ⇒ 先弹确认（含当前版本），确认前不发请求；确认后才提交", async () => {
        const submit = vi
            .fn<(payload: unknown) => Promise<unknown>>()
            .mockResolvedValue(importResult("updated"));
        mountDialog(submit, [{ name: "my-note", version: 3 }]);
        await fill(VALID_FIELDS);
        await clickSubmit();

        // 未确认：一个请求都没发。
        expect(submit).not.toHaveBeenCalled();
        const confirmBody = text('[data-testid="personal-skill-create-confirm-body"]');
        // 文案必须同时出现「会更新」与「原内容不可恢复」，且带上当前版本号。
        expect(confirmBody).toContain("my-note");
        expect(confirmBody).toContain("v3");
        expect(confirmBody).toContain("原内容不可恢复");

        q('[data-testid="personal-skill-create-confirm-action"]').click();
        await flushPromises();
        await nextTick();

        expect(submit).toHaveBeenCalledTimes(1);
        const payload = submit.mock.calls[0][0] as { skills: Array<Record<string, unknown>> };
        expect(payload.skills).toHaveLength(1);
    });

    it("200 但 rejected ⇒ 不关窗、按码表给本地化原因，且 CP 英文 detail 不上屏", async () => {
        const detail = "only an instance administrator may import a trusted skill";
        const submit = vi
            .fn<(payload: unknown) => Promise<unknown>>()
            .mockResolvedValue(rejectedResult("SKILL_NAME_INVALID", detail));
        const wrapper = mountDialog(submit);
        await fill(VALID_FIELDS);
        await clickSubmit();

        expect(wrapper.emitted("update:open")).toBeUndefined();
        expect(text('[data-testid="personal-skill-create-outcome-body"]')).toBe(
            i18n.global.t("settings.skills.import.rejected.nameInvalid"),
        );
        expect(document.body.textContent ?? "").not.toContain(detail);
    });

    it("unchanged（同名同正文）⇒ 不许报已创建，只说明没有修改", async () => {
        const submit = vi
            .fn<(payload: unknown) => Promise<unknown>>()
            .mockResolvedValue(importResult("unchanged"));
        const wrapper = mountDialog(submit);
        await fill(VALID_FIELDS);
        await clickSubmit();

        expect(wrapper.emitted("update:open")).toBeUndefined();
        expect(text('[data-testid="personal-skill-create-outcome-body"]')).toBe(
            i18n.global.t("resources.skills.create.unchanged"),
        );
        // 反向断言：屏幕上不能出现"创建成功"式的措辞（保持不变才是事实）。
        expect(document.body.textContent ?? "").not.toContain(
            i18n.global.t("settings.skills.import.resultTitle"),
        );
    });

    it("名字合法即按 CP 判据放行（`a..b` 不被本地路径预检误拒）", async () => {
        // CP 的 `NAME_PATTERN`（`SkillImportValidator.java:33`）= `^[a-z0-9][a-z0-9._-]{0,63}$`，
        // 允许连续点；CP 的 `normalizePath`（`:248-271`）只拒**段级** `..`、不拒子串。
        // 若这里改成复用导入侧的 `includes("..")` 判据，就会把 CP 合法的名字误拒 —— 那等于 UI
        // 自己发明一条 CP 没有的规则。本用例把这个决定钉住。
        const submit = vi
            .fn<(payload: unknown) => Promise<unknown>>()
            .mockResolvedValue(importResult("created"));
        mountDialog(submit);
        await fill({ ...VALID_FIELDS, name: "a..b" });
        await clickSubmit();

        expect(submit).toHaveBeenCalledTimes(1);
        const payload = submit.mock.calls[0][0] as { skills: Array<Record<string, unknown>> };
        expect(payload.skills[0]!.sourcePath).toBe("manual/a..b/SKILL.md");
    });

    it("请求级失败（403）⇒ 本地化标题/正文 + 码，CP 英文 detail 只进 logger", async () => {
        const detail = "you may not write to this skill library";
        const submit = vi.fn<(payload: unknown) => Promise<unknown>>().mockRejectedValue(
            new ApiError({
                status: 403,
                code: "SKILL_IMPORT_FORBIDDEN",
                detail,
                requestId: "req-403",
            }),
        );
        mountDialog(submit);
        await fill(VALID_FIELDS);
        await clickSubmit();

        expect(q('[data-testid="personal-skill-create-request-error"]')).toBeTruthy();
        expect(text('[data-testid="personal-skill-create-request-error-title"]')).not.toBe("");
        expect(text('[data-testid="personal-skill-create-request-error-body"]')).not.toBe("");
        expect(text('[data-testid="personal-skill-create-request-error-code"]')).toContain(
            "SKILL_IMPORT_FORBIDDEN",
        );
        expect(document.body.textContent ?? "").not.toContain(detail);
    });
});
