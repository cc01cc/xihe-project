import type { Page } from "@playwright/test";
import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";
import { findLeaks, summarizeLeaks } from "../../src/lib/copyLeakPatterns";

/**
 * task-57 判据 4：把三处「仅源级、改后仍未上屏」的文案**测到上屏**。
 *
 * <p>三处原先都只在 i18n 源里被认出来，没有任何渲染面证据。本文件给每一处一个真实格子：</p>
 * <ul>
 *   <li><b>导入弹窗</b>（import.fileHint / import.exampleHint）—— 持实例原子时点「导入技能」即开；</li>
 *   <li><b>置灰原因</b>（import.disabledReason）—— 无原子时由 v-if="!canImport" 画成正文 &lt;p&gt;；</li>
 *   <li><b>403 卡的 action</b>（import.error.forbidden.action）—— 提交被服务端整批拒绝时渲染。</li>
 * </ul>
 *
 * <p><b>为什么这条卡值得单独存在</b>：action 的键是**动态拼**的
 * （t(`settings.skills.import.error.${error.slug}.action`)，SkillsImportDialog.vue:349）。
 * 静态 grep 键路径**找不到任何消费方** ⇒ 极易被判成「无渲染路径的死文案」而删掉，
 * 而它其实每次 403 都上屏。这是「仪器看不见 ≠ 不存在」在**源码层**的复现，不是浏览器层。</p>
 *
 * <p>判据本体（9 形态）不在本文件维护：唯一来源 src/lib/copyLeakPatterns.ts。</p>
 *
 * <p><b>覆盖面边界（别把这份证据读大）</b>：mock 车道证明的是「该文案在真实组件树里渲染出来」，
 * <b>不</b>等于真实链路上会出现该状态（packages/ui/AGENTS.md：Mock E2E 不得当真实链路完成证据）。
 * 本卡判据是**文案受众**，不是接口行为，所以 mock 车道是正确量具；接口行为仍归真栈 E2E。</p>
 */

function json(body: unknown) {
    return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

/**
 * 能力/原子投影：SkillsPanel.vue:43 的 canImport 判的是**实例域原子** MANAGE_SKILL_LIBRARY
 * （不是粗粒度 cap:instance:admin）⇒ 给不给这个原子就是开关。
 * 必须注册在 setupMockAuth 之后（Playwright 后注册优先）。
 */
async function stubPermissions(page: Page, atoms: string[]): Promise<void> {
    await page.route("**/api/v1/me/permissions", (route) =>
        route.fulfill(
            json({
                userId: "user-1",
                instanceCapabilities: ["config:instance:admin"],
                instancePermissions: atoms.map((actionClass) => ({ actionClass, resource: "*" })),
            }),
        ),
    );
}

async function stubSkillsList(page: Page): Promise<void> {
    await page.route(/\/api\/v1\/skills(\?.*)?$/, (route) =>
        route.fulfill(json({ items: [], total: 0 })),
    );
}

/**
 * mock 车道的默认工作区 id（`workspace-fixture.ts:74`）。
 *
 * <p><b>为什么不能用真栈那个 id</b>：`KNOWN_WORKSPACE_IDS` 是**封闭表**（D-1178 —— 泛化匹配会让 mock
 * 车道永远验不了「访问不存在的工作区 ⇒ 404」）。拿真栈 id 进来会被夹具 404，症状是「面板根本没渲染」，
 * 很容易被误读成「这个面不存在」⇒ 又会造出一条假阴性。要么用登记过的 id，要么按该文件头注释自补桩；
 * 本 spec 不需要自造 id，所以用默认值。</p>
 */
const WS_ID = "11111111-1111-4111-8111-111111111111";
/**
 * 落点 = **资源区 › 技能 › 实例层**（`SkillsResourceView.vue:37`：`<SkillsPanel v-if="layer === 'INSTANCE'">`）。
 *
 * <p>不是工作区设置 › 技能 tab —— 第一版派到那里，页面自己写着「写面未接线：导入对话框的 scope 由
 * JSON 里的 definitionScope 决定」，`settings-skills-import` 一个都不渲染，`toBeEnabled` 直接
 * element(s) not found。**「按钮找不到」的第一因是落点错，不是文案没渲染**：这条读数如果跳过，
 * 下一步就会去改文案，改完还是找不到 —— 同一个坑在 task-47 已经踩过一次（先怀疑仪器与落点）。</p>
 */
const URL_SKILLS = "/resources/skills?layer=INSTANCE";

/** 默认工作区仍要登记在 URL 之外：mock 夹具的会话/权限投影按 KNOWN_WORKSPACE_IDS 收口。 */
void WS_ID;

test.describe("task-57: 技能导入三个面的文案受众判据", () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test("持实例原子 ⇒ 导入弹窗上屏，弹窗正文过 9 形态", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await stubPermissions(page, ["MANAGE_SKILL_LIBRARY"]);
        await stubSkillsList(page);
        await page.goto(URL_SKILLS);

        const entry = page.getByTestId("settings-skills-import");
        await expect(entry).toBeEnabled({ timeout: EXPECT_TIMEOUT_MS });
        await entry.click({ timeout: ACTION_TIMEOUT_MS });

        const dialog = page.getByTestId("skills-import-dialog");
        await expect(dialog).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        const leaks = findLeaks(await dialog.innerText());
        expect(leaks, "导入弹窗泄露审查者形态：" + summarizeLeaks(leaks)).toEqual([]);
    });

    test("缺实例原子 ⇒ 置灰原因成为正文 <p>，过 9 形态", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await stubPermissions(page, []);
        await stubSkillsList(page);
        await page.goto(URL_SKILLS);

        const reason = page.getByTestId("settings-skills-import-disabled-reason");
        await expect(reason).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        // 阳性对照：入口确实同时被置灰（否则这段文案挂在能点的按钮上，语义就错了）
        await expect(page.getByTestId("settings-skills-import")).toBeDisabled();
        const leaks = findLeaks(await reason.innerText());
        expect(leaks, "置灰原因泄露审查者形态：" + summarizeLeaks(leaks)).toEqual([]);
    });

    test("个人层 ⇒ 新建技能弹窗上屏，说明正文过 9 形态", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        // 两个原子都给：MANAGE_SKILL_LIBRARY 门实例层导入，个人层新建门的是另一个原子
        //（settingsIa.ts:445「该原子只门面板里的『导入技能』按钮」）—— 本用例只关心弹窗正文。
        await stubPermissions(page, ["MANAGE_SKILL_LIBRARY", "MANAGE_PERSONAL_SKILLS"]);
        await stubSkillsList(page);
        await page.goto("/resources/skills?layer=USER");

        const create = page.getByTestId("personal-skills-create");
        await expect(create).toBeEnabled({ timeout: EXPECT_TIMEOUT_MS });
        await create.click({ timeout: ACTION_TIMEOUT_MS });

        const dialog = page.getByTestId("personal-skill-create-dialog");
        await expect(dialog).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        const leaks = findLeaks(await dialog.innerText());
        expect(leaks, "个人层新建弹窗泄露审查者形态：" + summarizeLeaks(leaks)).toEqual([]);
    });
});

/**
 * 单独一个 describe：这条用例**故意**让 `/skills/import` 回 403，才会渲染出 403 卡。
 *
 * <p>mock 车道有 page-failure 门（console / pageerror / >=400 三通道全列），故意回 4xx 会被它判红 ——
 * `e2e/mock/resource-detail.spec.ts` 头注释第 ④ 条早就写了这件事，我第一版没读就撞上了。
 * 正解不是绕开门，而是用它的 `mockAllow` **逐条**放行：放行清单必须带出处，禁止「看到红就加一条」
 * （`helpers/mock-test.ts:34` 原文）。这里只放开 `/api/v1/skills/import` 这一条路径，
 * 其余任何 >=400 仍然照判。</p>
 */
test.describe("task-57: 技能导入 403 卡（故意 4xx，逐条放行）", () => {
    test.use({ viewport: { width: 1440, height: 900 } });
    test.use({ mockAllow: [...DEFAULT_MOCK_ALLOW, "/api/v1/skills/import"] });

    test("导入被整批 403 拒绝 ⇒ 卡片含 action 一行，过 9 形态", async ({ page }) => {
        await setupMockAuth(page, { capabilities: { isInstanceAdmin: true } });
        await stubPermissions(page, ["MANAGE_SKILL_LIBRARY"]);
        await stubSkillsList(page);
        await page.route(/\/api\/v1\/skills\/import(\?.*)?$/, (route) =>
            route.fulfill({
                status: 403,
                contentType: "application/json",
                body: JSON.stringify({
                    type: "https://xihe.local/errors/forbidden",
                    title: "Forbidden",
                    status: 403,
                    code: "SKILL_IMPORT_FORBIDDEN",
                    detail: "no instance skill library write right",
                    requestId: "req-task57-403",
                }),
            }),
        );
        await page.goto(URL_SKILLS);
        await page.getByTestId("settings-skills-import").click({ timeout: ACTION_TIMEOUT_MS });
        const dialog = page.getByTestId("skills-import-dialog");
        await expect(dialog).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });

        // 提交按钮受本地预检控制：空正文时恒 disabled（实测第一版就卡在这）。
        // 取本页自带的示例正文填进去 —— 示例按定义是合法批，比在 spec 里另抄一份 schema 更不会漂。
        const example = await page.getByTestId("skills-import-example").innerText();
        await page.getByTestId("skills-import-json").fill(example);

        // 不靠 sleep：先轮询到提交按钮可用，点了再轮询错误卡出现。
        const submit = page.getByTestId("skills-import-submit");
        await expect(submit).toBeEnabled({ timeout: EXPECT_TIMEOUT_MS });
        await submit.click({ timeout: ACTION_TIMEOUT_MS });

        const card = page.getByTestId("skills-import-error");
        await expect(card).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        // 阳性对照：action 那一行真的在卡里（动态键拼出来的文案，最怕它就是渲染不出来）
        await expect(page.getByTestId("skills-import-error-action")).not.toHaveText("");
        // 判据范围收到**三条文案**上：卡里另有一行「错误码：{code}」会把常量带进来，
        // 那是另一条轴（ui/AGENTS.md §错误面：新错误面须「不含错误码」，technicalDetail 收折叠区），
        // 归那张卡管，不在本卡顺手改 —— 已在卡面与证据 §8.5 登记为跨卡发现。
        const copy = [
            await page.getByTestId("skills-import-error-title").innerText(),
            await page.getByTestId("skills-import-error-body").innerText(),
            await page.getByTestId("skills-import-error-action").innerText(),
        ].join(" ");
        const leaks = findLeaks(copy);
        expect(leaks, "403 卡泄露审查者形态：" + summarizeLeaks(leaks)).toEqual([]);
    });
});
