import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
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

/**
 * task-61：错误卡**可见区**文本 = 标题 + 正文 + 动作三行。
 * 折叠区（技术详情）刻意不算进来 —— 判据要的是「用户不展开时看不到码」。
 */
function errorCardVisibleText(): string {
    return [
        q('[data-testid="skills-import-error-title"]').textContent ?? "",
        q('[data-testid="skills-import-error-body"]').textContent ?? "",
        q('[data-testid="skills-import-error-action"]').textContent ?? "",
    ].join("\n");
}

/**
 * 展开「技术详情」折叠区（reka `CollapsibleTrigger` 自带切换，不额外绑 click）。
 *
 * <p>内容在**折叠态是未挂载**（`Presence`），展开要走 watcher 调度 ⇒ 必须 `flushPromises()`，
 * 只 `nextTick()` 不够（第一版就是这么红的：节点 missing，症状像"折叠坏了"，其实是断言太早）。
 * 写法对齐 `ToolFacesView.spec.ts:349-355` 的既有范式。</p>
 */
async function revealTechnicalDetail(): Promise<void> {
    q('[data-testid="skills-import-error-detail-toggle"]').dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
    );
    await flushPromises();
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

    /**
     * task-61：判据本体换成 `packages/ui/AGENTS.md` §错误面 的**三件事**，并加一条反向判据「码不消失」。
     *
     * <p>旧断言只钉「码在屏上」（`toContain("SKILL_IMPORT_FORBIDDEN")`）—— 那正好是**记录缺陷**的写法：
     * 码常显在正文第四行，用户先看到一串常量。现在拆成四条：</p>
     * <ol>
     *   <li>可读文案在（标题/正文/动作）—— 旧的标题与动作断言保留，不减；</li>
     *   <li>**正文不含错误码**，也不含 `API error \d+`（§错误面 判据）；</li>
     *   <li>**码不消失**：默认折叠 ⇒ 未渲染；展开后出现 —— 这是"只挪不删"的机器判据，
     *       少了它下一个人会以为「既然不进正文，那就删掉这行」，报障凭据就此消失；</li>
     *   <li>CP 英文 detail 永不进 UI（原断言保留）。</li>
     * </ol>
     */
    it("403 越权：正文不含错误码，码只在折叠区里（不删只挪）", async () => {
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
        // 这条断言原先钉的是原子常量 `MANAGE_SKILL_LIBRARY`，文案去泄露后（A03 f63195fc3）它恒红 ——
        // 是**我自己**留下的红：改了文案没改断言，而且当时只跑了改过的 spec。现在钉人话，
        // 并把「常量不许回到用户文案里」反向钉住（正向判据不能只删不加）。
        const actionText = q('[data-testid="skills-import-error-action"]').textContent ?? "";
        expect(actionText).toContain("管理实例技能库");
        expect(actionText).not.toContain("MANAGE_SKILL_LIBRARY");

        const visibleText = errorCardVisibleText();
        expect(visibleText).not.toMatch(/SKILL_[A-Z_]+/);
        expect(visibleText).not.toMatch(/API error \d+/);

        // 折叠态：码节点根本没渲染（不是"隐藏"）
        expect(document.body.querySelector('[data-testid="skills-import-error-code"]')).toBeNull();
        await revealTechnicalDetail();
        expect(q('[data-testid="skills-import-error-code"]').textContent ?? "").toContain(
            "SKILL_IMPORT_FORBIDDEN",
        );

        expect(document.body.textContent ?? "").not.toContain(
            "you may not import into this skill library",
        );
    });

    /**
     * task-61 的第二个泄露点：`fallback` slug 把码**插进了 action 文案**（`把错误码 {code} 和时间点报给管理员`），
     * 于是整卡里码出现两次。真机读数见证据 §3。
     */
    it("未知码（fallback）：码不在 action 里，只在折叠区出现一次", async () => {
        const submit = vi
            .fn<(payload: unknown) => Promise<unknown>>()
            .mockRejectedValue(apiError(502, "SOMETHING_UNEXPECTED", "upstream said no"));
        const wrapper = mountDialog(submit);
        await fillAndSubmit(wrapper, validBatch());

        const visibleText = errorCardVisibleText();
        expect(visibleText).not.toContain("SOMETHING_UNEXPECTED");
        // HTTP 状态仍要可见（那是用户能报给管理员的另一条线索），只是措辞改成不插码
        expect(visibleText).toContain("502");
        expect(visibleText).not.toMatch(/API error \d+/);

        await revealTechnicalDetail();
        expect(q('[data-testid="skills-import-error-code"]').textContent ?? "").toContain(
            "SOMETHING_UNEXPECTED",
        );
        // 整卡（含折叠区）里码只出现一次 —— 折叠区之外一处都没有
        const whole = document.body.textContent ?? "";
        expect(whole.split("SOMETHING_UNEXPECTED").length - 1).toBe(1);
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
