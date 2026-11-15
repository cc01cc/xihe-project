/**
 * task-174（S2b）判据 ②：**六个页面**的容器页签行 + `aria-current` 分层读数 + 截图证据。
 *
 * 六个页面 = 设计稿 §2.1 的 center 六个单例页面板（`page:sessions`/`environment`/
 * `scheduled-tasks`/`resources`/`settings`/`members`），今天仍是路由页，故按路由取证。
 *
 * 为什么**分层数**而不是只报全页总数：`aria-current` 有三个合法来源（状态栏面包屑末段、
 * 会话列表的当前项、rail 的既有 2 处），全页一个数无法回答「导航行有没有抢第二个当前项」。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "task174-six";
/**
 * 证据目录落在 **`one` 仓** 的 `internal/A03-xihe/evidence/` 下（`internal/` 属 one 仓）。
 * 从 `packages/ui` 往上三层才是 `one`：`packages/ui` → `A03-xihe` → `one`。
 *
 * ⚠️ 这里曾经写成 `../..` ⇒ 产物落进 `A03-xihe/internal/...`（项目仓里的假 internal 目录，
 * 会被 `git status` 当未跟踪目录，并干扰 `--write-baseline` 的扫描面）。下面的断言就是防它复发。
 */
const REPO_EVIDENCE_DIR = resolve(
    process.cwd(),
    "../../../internal/A03-xihe/evidence/2026-11-15-task174-six-pages",
);
if (REPO_EVIDENCE_DIR.includes(`A03-xihe${sep}internal`)) {
    throw new Error(
        `证据目录落错仓：${REPO_EVIDENCE_DIR}（internal/ 属于 one 仓，不在 A03-xihe 仓内）`,
    );
}

/**
 * task-244（2026-11-15）：**常规测试跑不得写仓库**。
 * 此前本 spec 无条件把 6 张 PNG + readings.json 写进 `one` 仓的 `internal/A03-xihe/evidence/**`，
 * 后果是「跑一次测试 ⇒ 工作树变脏」：19:50 的窗口段甲 s1 步（以及 20:31 的 task-149 C 步全量跑）
 * 都把 6 个已跟踪文件重写了一遍，git status 里出现 6 个 M 却没有 owner（D-1608 家族：谁写的不清楚）。
 *
 * 现行口径：
 * · 默认 ⇒ 写 Playwright 的 `testInfo.outputDir`（lane 产物目录，已被 .gitignore 覆盖）；
 * · 显式证据生成 ⇒ `XH_EVIDENCE_WRITE=1`（可配 `XH_EVIDENCE_DIR` 指定落点）才写仓库证据目录。
 * 判据（卡面 ③）：默认跑前后 `git status --short internal/A03-xihe/evidence` 必须为空；
 * 显式跑仍产出 6 张；把落点改回仓库而不带开关时，默认跑就会污染 git status（反向可红）。
 */
function resolveWriteDir(outputDir: string): string {
    if (process.env.XH_EVIDENCE_WRITE === "1") {
        const dir = process.env.XH_EVIDENCE_DIR
            ? resolve(process.env.XH_EVIDENCE_DIR)
            : REPO_EVIDENCE_DIR;
        if (dir.includes(`A03-xihe${sep}internal`)) {
            throw new Error(`证据目录落错仓：${dir}（internal/ 属于 one 仓，不在 A03-xihe 仓内）`);
        }
        return dir;
    }
    return outputDir;
}

interface PageCase {
    readonly slug: string;
    readonly url: string;
}

const PAGES: readonly PageCase[] = [
    { slug: "01-sessions", url: `/workspace/${WORKSPACE_ID}/` },
    { slug: "02-environment", url: `/workspace/${WORKSPACE_ID}/environment` },
    { slug: "03-scheduled-tasks", url: `/workspace/${WORKSPACE_ID}/scheduled-tasks` },
    { slug: "04-resources", url: `/workspace/${WORKSPACE_ID}/resources` },
    { slug: "05-settings", url: `/workspace/${WORKSPACE_ID}/settings` },
    { slug: "06-members", url: `/workspace/${WORKSPACE_ID}/members` },
];

test.describe("task-174 判据②：六页面容器行与 aria-current", () => {
    /**
     * 逐条放行**夹具缺口**（不是放宽产品断言，gate 的出处要求见 `helpers/mock-test.ts` 头注释）：
     * mock 车道没有「工作区环境」读面端点（`GET /api/v1/workspaces/{id}/environment`）⇒ 环境页必 404。
     * 本读数只关心 IA/aria，页面的错误态不影响读数；**夹具缺口本身另记**（卡面「缺口」段）。
     */
    test.use({ mockAllow: [...DEFAULT_MOCK_ALLOW, "workspaces/[^/]+/environment"] });

    test("六页面：每页 1 行/容器 + 分层 aria-current + 截图", async ({ page }, testInfo) => {
        // 整测预算 = 每页预算 × 页数（task-236）。原先是一个写死的 180 秒字面量：一是硬编码，
        // 二是 `mise run lint:e2e` 的 timeout-budget 门只认 `e2e/timeouts.ts` 的共享常量（豁免硬上限 60 s，
        // 加 `timeout-exempt` 标记也过不去）⇒ 改成「6 页 × LONG_TIMEOUT_MS」，数值来源自解释，
        // 同时保持原有的 180 s 总量（6 × 30 s），单跑行为不变。
        test.setTimeout(LONG_TIMEOUT_MS * PAGES.length);
        const outDir = resolveWriteDir(testInfo.outputDir);
        mkdirSync(outDir, { recursive: true });
        await page.setViewportSize({ width: 1920, height: 1080 });
        const rows: Record<string, unknown>[] = [];

        for (const pageCase of PAGES) {
            await setupMockAuth(page, {});
            await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "six" }] });
            await page.goto(pageCase.url);
            // 六个页面不一定都挂工作台（环境页就是独立壳）⇒ 宽限等待，把「挂没挂」当读数记下来。
            await page
                .locator(
                    '[data-testid="workspace-container-tabs"], [data-testid="workspace-workbench"], main',
                )
                .first()
                .waitFor({ state: "visible", timeout: EXPECT_TIMEOUT_MS });

            const containerRows = page.locator('[data-testid="workspace-container-tabs"]');
            const containers = await containerRows.evaluateAll((nodes) =>
                nodes.map((node) => ({
                    container: node.getAttribute("data-container"),
                    tabs: [...node.querySelectorAll('[role="tab"]')].map((tab) =>
                        tab.getAttribute("data-tab-id"),
                    ),
                })),
            );
            const count = async (selector: string) => page.locator(selector).count();
            const row = {
                page: pageCase.slug,
                url: page.url().replace(/^https?:\/\/[^/]+/, ""),
                containers,
                rows: await containerRows.count(),
                hasWorkbench: await count('[data-testid="workspace-workbench"]'),
                ariaWhole: await count("[aria-current]"),
                ariaWholePage: await count('[aria-current="page"]'),
                ariaStatusBar: await count('[data-testid="workspace-status-bar"] [aria-current]'),
                ariaStatusBarPage: await count(
                    '[data-testid="workspace-status-bar"] [aria-current="page"]',
                ),
                ariaNavRow: await count('[data-testid="workspace-container-tabs"] [aria-current]'),
                ariaNavRowPage: await count(
                    '[data-testid="workspace-container-tabs"] [aria-current="page"]',
                ),
                ariaRail: await count('[data-testid="global-rail"] [aria-current]'),
                statusText: (await page.locator('[data-testid="workspace-status-bar"]').innerText())
                    .replace(/\s+/g, " ")
                    .trim(),
            };
            rows.push(row);
            console.log("[task174] " + JSON.stringify(row));

            const shot = resolve(outDir, pageCase.slug + ".png");
            mkdirSync(dirname(shot), { recursive: true });
            await page.screenshot({ path: shot, fullPage: false });
        }

        writeFileSync(resolve(outDir, "readings.json"), JSON.stringify(rows, null, 2), "utf8");
        console.log("[task174] 写盘目录 " + outDir);

        // 硬判据：每页都有容器页签行，且**每个容器行内** aria-current ≤ 1（导航行不抢当前项）。
        expect(rows, "六页都要有读数").toHaveLength(6);
        for (const row of rows) {
            // 判据②的正题：**凡是挂了工作台的页**，容器页签行内不许出现 aria-current（导航行不抢「当前项」）。
            if (Number(row.hasWorkbench) > 0) {
                expect(Number(row.ariaNavRow), row.page + "：容器行内不许出现 aria-current").toBe(
                    0,
                );
                expect(Number(row.rows), row.page + "：挂了工作台就应有容器页签行").toBeGreaterThan(
                    0,
                );
            }
        }
    });
});
