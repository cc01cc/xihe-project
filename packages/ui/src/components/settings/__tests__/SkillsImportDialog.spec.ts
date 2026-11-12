import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { ApiError } from "../../../composables/api";
import { i18n } from "../../../i18n";
import SkillsImportDialog from "../SkillsImportDialog.vue";

/**
 * task-167 · 导入对话框：**断言的是"码 → 文案"的映射与提交形状**，不是"按钮在不在"。
 *
 * <p>三条卡的验收对应这里的三组：</p>
 * <ul>
 *   <li>成功路径：提交出去的批与 CP 契约同形（`definitionScope.type=instance` + 每条必填四字段），
 *       逐条拒绝用**同一张码表**渲染（不因"哪一侧先发现"而换措辞）。</li>
 *   <li>失败路径：`problem.code` → i18n 文案 + 「下一步能做什么」；**CP 的英文 `detail` 绝不能上屏**
 *       （本文件用 `detail: "you may not import into this skill library"` 做反向断言）。</li>
 *   <li>本地预检：非法 JSON / 超 64 条**不发请求**（CP 对超限是整批 400，本地提前拦省一次往返）。</li>
 * </ul>
 *
 * <p>`Dialog` 的内容经 `DialogPortal` → `Teleport` 落到 `document.body`，**不在 `wrapper` 子树里**；
 * 所以这里统一用 `attachTo: document.body` + `document.body` 查询（stub 掉 Teleport 反而会把整块内容吞掉，
 * 见 `SettingsCommandPalette.spec.ts:23-24` 的同一条踩坑记录）。</p>
 */

function mountDialog(submit: (payload: unknown) => Promise<unknown>) {
    return mount(SkillsImportDialog, {
        props: {
            open: true,
            submit: submit as never,
        },
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

function validBatch(name = "commit-msg-review") {
    return JSON.stringify({
        definitionScope: { type: "instance" },
        skills: [
            {
                name,
                description: "按仓库提交规范检查 commit message",
                body: "## 步骤\n\n1. 读 commit message",
                sourcePath: `skills/${name}/SKILL.md`,
            },
        ],
    });
}

async function fillAndSubmit(_wrapper: ReturnType<typeof mountDialog>, json: string) {
    const textarea = q<HTMLTextAreaElement>('[data-testid="skills-import-json"]');
    textarea.value = json;
    textarea.dispatchEvent(new Event("input"));
    await nextTick();
    q('[data-testid="skills-import-submit"]').click();
    await nextTick();
    await nextTick();
}

/** CP 失败的真实形状：`problem.code` 是枚举码，`detail` 是英文（后者绝不上屏）。 */
function apiError(status: number, code: string, detail: string): ApiError {
    return new ApiError({ status, code, detail, requestId: `req-${code}` });
}

describe("SkillsImportDialog（task-167）", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = "";
    });

    it("成功：提交批与契约同形，逐条拒绝用码表渲染（不显示 CP 英文 detail）", async () => {
        const submit = vi.fn<(payload: unknown) => Promise<unknown>>().mockResolvedValue({
            results: [
                {
                    skillId: "s-1",
                    name: "commit-msg-review",
                    action: "created",
                    version: 1,
                    bodyTokensEst: 12,
                    oversize: false,
                },
            ],
            rejected: [
                {
                    sourcePath: "skills/too-long/SKILL.md",
                    code: "SKILL_DESCRIPTION_TOO_LONG",
                    detail: "description exceeds 1024 characters",
                },
            ],
            summary: { created: 1, updated: 0, unchanged: 0, rejected: 1, oversize: 0 },
        });
        const wrapper = mountDialog(submit);
        await fillAndSubmit(wrapper, validBatch());

        expect(submit).toHaveBeenCalledTimes(1);
        const payload = submit.mock.calls[0][0] as {
            definitionScope: { type: string };
            skills: Array<Record<string, unknown>>;
        };
        expect(payload.definitionScope).toEqual({ type: "instance" });
        expect(payload.skills).toHaveLength(1);
        expect(payload.skills[0]).toEqual({
            name: "commit-msg-review",
            description: "按仓库提交规范检查 commit message",
            body: "## 步骤\n\n1. 读 commit message",
            sourcePath: "skills/commit-msg-review/SKILL.md",
        });

        // 成功摘要 + 逐条拒绝的本地化理由；码作为排查线索保留在行尾。
        expect(q('[data-testid="skills-import-result"]')).toBeTruthy();
        expect(q('[data-testid="skills-import-result-summary"]').textContent ?? "").toContain(
            "新建 1",
        );
        expect(
            q('[data-testid="skills-import-rejected-SKILL_DESCRIPTION_TOO_LONG"]').textContent ??
                "",
        ).toContain("description 超过 1024 字符");
        // 反向断言：CP 的英文 detail 不上屏。
        expect(document.body.textContent ?? "").not.toContain(
            "description exceeds 1024 characters",
        );
        // 提交成功即通知面板刷新（面板不做乐观插入）。
        expect(wrapper.emitted("imported")).toHaveLength(1);
    });

    it("403 越权：按 problem.code 映射中文文案 + 下一步动作，英文 detail 不出现", async () => {
        const submit = vi
            .fn<(payload: unknown) => Promise<unknown>>()
            .mockRejectedValue(
                apiError(
                    403,
                    "SKILL_IMPORT_FORBIDDEN",
                    "you may not import into this skill library",
                ),
            );
        const wrapper = mountDialog(submit);
        await fillAndSubmit(wrapper, validBatch());

        expect(q('[data-testid="skills-import-error"]')).toBeTruthy();
        expect(q('[data-testid="skills-import-error-title"]').textContent).toBe("没有导入权限");
        expect(q('[data-testid="skills-import-error-action"]').textContent ?? "").toContain(
            "MANAGE_SKILL_LIBRARY",
        );
        expect(q('[data-testid="skills-import-error-code"]').textContent ?? "").toContain(
            "SKILL_IMPORT_FORBIDDEN",
        );
        expect(document.body.textContent ?? "").not.toContain(
            "you may not import into this skill library",
        );
    });

    it("400 批过大：整批拒绝的说法 + 拆分下一步（不冒充逐条拒绝）", async () => {
        const submit = vi
            .fn<(payload: unknown) => Promise<unknown>>()
            .mockRejectedValue(apiError(400, "SKILL_IMPORT_TOO_LARGE", "batch exceeds 64 items"));
        const wrapper = mountDialog(submit);
        await fillAndSubmit(wrapper, validBatch());

        expect(q('[data-testid="skills-import-error-title"]').textContent).toBe("一次最多 64 条");
        expect(q('[data-testid="skills-import-error-body"]').textContent ?? "").toContain("整批");
        expect(q('[data-testid="skills-import-error-action"]').textContent ?? "").toContain("64");
        expect(document.body.textContent ?? "").not.toContain("batch exceeds 64 items");
    });

    it("本地预检：非法 JSON / 超 64 条都不发请求", async () => {
        const submit = vi.fn<(payload: unknown) => Promise<unknown>>();
        const wrapper = mountDialog(submit);
        await fillAndSubmit(wrapper, "[not json");
        expect(submit).not.toHaveBeenCalled();
        expect(q('[data-testid="skills-import-draft-error-reason"]').textContent).toBe(
            "不是合法 JSON",
        );

        const items = Array.from({ length: 65 }, (_, index) => ({
            name: `skill-${index}`,
            description: "描述",
            body: "正文",
            sourcePath: `skills/skill-${index}/SKILL.md`,
        }));
        await fillAndSubmit(
            wrapper,
            JSON.stringify({ definitionScope: { type: "instance" }, skills: items }),
        );
        expect(submit).not.toHaveBeenCalled();
        expect(q('[data-testid="skills-import-draft-error-reason"]').textContent ?? "").toContain(
            "64",
        );
    });
});
