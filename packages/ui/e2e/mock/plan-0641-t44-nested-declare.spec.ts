// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { LONG_TIMEOUT_MS } from "../timeouts";
import { copyForKey } from "../helpers/select";

/**
 * PLAN-0641 T4.4（design §6.3 row 4，B6=(a)，contract F4）—— **task-945 按 task-939 的新 IA 重写**。
 *
 * 旧实现把未声明嵌套仓渲染成面板顶部的五张全宽卡片（`nested-repos-panel` / `nested-repo-row`）；
 * R76 判定它属于「块挂在错误的容器里」⇒ 现在是**树行内的一次性动作**：目录行带类型徽标，
 * 只有 `nested` / `gitdir` 给「纳入快照」入口（子模块 / 符号链接 / 裸库只留徽标 —— 一个点了
 * 只会换回 400 的死入口不该存在）。
 *
 * 判据（每条都能抓回归，不只是换选择器）：
 *   ① 卡片 IA 不得回潮（`nested-repos-panel` / `nested-repo-row` 计数 0）；
 *   ② 徽标只出现在**路径一致**的树行上（发现项按整条 workspace 相对路径匹配，不看叶子名）——
 *      `vendor/lib` 未展开 `vendor` 前不该有徽标，展开后才出现；
 *   ③ 可申报性按 type 白名单：`nested` / `gitdir` 有入口，其余三种没有；
 *   ④ 两步确认：第一次点击只展开确认、不 POST；确认后才 POST，且 body 带**整条**相对路径（B12）；
 *   ⑤ 成功后重新发现 ⇒ 该行徽标与入口一起消失，其余项仍在。
 *
 * Discovery 与 root CRUD 都走 mock 车道的路由拦截；真 CP → Runtime 探针链归包测试与 host E2E。
 */

/** 树：`vendor/lib` 是两层（未展开 `vendor` 时不可见），其余四项在顶层。 */
const SEED_TREE = [
    {
        name: "vendor",
        path: "vendor",
        type: "directory",
        children: [{ name: "lib", path: "vendor/lib", type: "directory", children: [] }],
    },
    { name: "linked-wt", path: "linked-wt", type: "directory", children: [] },
    { name: "helper", path: "helper", type: "directory", children: [] },
    { name: "linked", path: "linked", type: "directory", children: [] },
    { name: "mirror.git", path: "mirror.git", type: "directory", children: [] },
];

const REPOS = [
    { path: "vendor/lib", type: "nested", declared: false },
    { path: "linked-wt", type: "gitdir", declared: false },
    { path: "helper", type: "submodule", declared: false },
    { path: "linked", type: "symlink", declared: false },
    { path: "mirror.git", type: "bare", declared: false },
];

test.describe("PLAN-0641 T4.4 nested-repo declare entry (mock, tree-row IA)", () => {
    test("only nested/gitdir rows get the inline entry; the other three stay label-only", async ({
        page,
    }, testInfo) => {
        await setupMockSessions(page, {
            sessions: [{ id: "session-1", title: "Session 1" }],
            messages: { "session-1": [] },
        });
        await setupMockAuth(page);
        await page.addInitScript((tree) => {
            localStorage.setItem("xihe-mock-filetree", JSON.stringify(tree));
        }, SEED_TREE);

        // Registered after `setupMockAuth`, whose `**/api/v1/**` catch-all answers `{}` for
        // unmatched routes; later routes take precedence in Playwright.
        let discoveryCalls = 0;
        await page.route("**/api/v1/workspaces/*/nested-repos", async (route) => {
            discoveryCalls += 1;
            // 申报成功后 CP 逐出其 30s 缓存，重新发现会把该目录报成 declared:true。
            const items =
                discoveryCalls === 1
                    ? REPOS
                    : REPOS.map((repo) =>
                          repo.path === "vendor/lib" ? { ...repo, declared: true } : repo,
                      );
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    workspaceId: "11111111-1111-4111-8111-111111111111",
                    cachedAt: new Date().toISOString(),
                    items,
                }),
            });
        });
        let declareBody: { path?: string } | null = null;
        await page.route(
            "**/api/v1/workspaces/11111111-1111-4111-8111-111111111111/roots",
            async (route) => {
                declareBody = route.request().postDataJSON() as { path?: string } | null;
                await route.fulfill({
                    status: 201,
                    contentType: "application/json",
                    body: JSON.stringify({ id: "root-1", alias: null, position: 1 }),
                });
            },
        );

        await page.goto("/workspace/11111111-1111-4111-8111-111111111111");

        const tree = page.getByTestId("workspace-file-tree");
        await expect(tree).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        const loading = tree.getByTestId("workspace-tree-loading");
        await expect(loading).toHaveCount(0, { timeout: LONG_TIMEOUT_MS });

        // ① 卡片 IA 不得回潮。
        await expect(page.getByTestId("nested-repos-panel")).toHaveCount(0);
        await expect(page.getByTestId("nested-repo-row")).toHaveCount(0);

        const nestedCopy = copyForKey("workspace.nestedRepoType_nested");
        const gitdirCopy = copyForKey("workspace.nestedRepoType_gitdir");
        const submoduleCopy = copyForKey("workspace.nestedRepoType_submodule");
        const symlinkCopy = copyForKey("workspace.nestedRepoType_symlink");
        const bareCopy = copyForKey("workspace.nestedRepoType_bare");
        for (const [key, copy] of [
            ["nestedRepoType_nested", nestedCopy],
            ["nestedRepoType_gitdir", gitdirCopy],
            ["nestedRepoType_submodule", submoduleCopy],
            ["nestedRepoType_symlink", symlinkCopy],
            ["nestedRepoType_bare", bareCopy],
        ] as const) {
            expect(copy, `语言包必须提供 workspace.${key}（缺键要红）`).not.toBeNull();
        }

        const badges = page.getByTestId("nested-repo-type");
        // ② `vendor/lib` 藏在折叠的 `vendor` 里 ⇒ 展开前只有四个顶层项带徽标。
        await expect(badges).toHaveCount(4);
        await tree
            .locator("button", { hasText: /^vendor$/ })
            .first()
            .click();
        await expect(badges).toHaveCount(5, { timeout: LONG_TIMEOUT_MS });

        // 徽标挂在**那一行**上（同一个行容器里的行按钮文本 = 目录名）。
        const badgeRows = await badges.evaluateAll((nodes) =>
            nodes.map((badge) => ({
                row: (badge.parentElement?.querySelector("button")?.textContent ?? "").trim(),
                type: badge.getAttribute("title") ?? "",
            })),
        );
        expect(badgeRows).toEqual([
            { row: "lib", type: nestedCopy },
            { row: "linked-wt", type: gitdirCopy },
            { row: "helper", type: submoduleCopy },
            { row: "linked", type: symlinkCopy },
            { row: "mirror.git", type: bareCopy },
        ]);

        // ③ 可申报性白名单：只有 nested / gitdir 的行有入口（顺序 = 徽标顺序）。
        const entries = page.getByTestId("nested-repo-declare");
        await expect(entries).toHaveCount(2);
        const entryRows = await entries.evaluateAll((nodes) =>
            nodes.map((entry) =>
                (entry.parentElement?.querySelector("button")?.textContent ?? "").trim(),
            ),
        );
        expect(entryRows).toEqual(["lib", "linked-wt"]);
        const declareCopy = copyForKey("workspace.nestedRepoDeclare");
        expect(declareCopy, "语言包必须提供 workspace.nestedRepoDeclare").not.toBeNull();
        await expect(entries.first()).toHaveText(declareCopy!);
        // 内部术语不得出屏（FT5 的浏览器侧同判据）。
        await expect(tree.getByText("声明为根", { exact: true })).toHaveCount(0);

        await tree.screenshot({ path: testInfo.outputPath("t44-nested-declare-tree.png") });

        // ④ 两步确认：第一次点击只展开确认；确认后才 POST，body 带整条 workspace 相对路径（B12）。
        await entries.first().click();
        await expect(page.getByTestId("nested-repo-confirm")).toBeVisible();
        expect(declareBody).toBeNull();

        await page.getByTestId("nested-repo-declare-confirm").click();
        const declaredCopy = copyForKey("workspace.nestedRepoDeclared");
        expect(declaredCopy, "语言包必须提供 workspace.nestedRepoDeclared").not.toBeNull();
        await expect(page.getByText(declaredCopy!, { exact: true })).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        expect(declareBody).toEqual({ path: "vendor/lib" });

        // ⑤ 成功后重新发现：该行的徽标与入口消失，其余四个仍在。
        await expect(badges).toHaveCount(4, { timeout: LONG_TIMEOUT_MS });
        await expect(entries).toHaveCount(1, { timeout: LONG_TIMEOUT_MS });
        const remainingRows = await badges.evaluateAll((nodes) =>
            nodes.map((badge) =>
                (badge.parentElement?.querySelector("button")?.textContent ?? "").trim(),
            ),
        );
        expect(remainingRows).toEqual(["linked-wt", "helper", "linked", "mirror.git"]);
    });
});
