// timeout-exempt: 视觉判据要在真浏览器取 computed style（task-534 卡面①）
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { MOCK_WORKSPACE_ID } from "./helpers/auth";
import { LONG_TIMEOUT_MS } from "../timeouts";

/**
 * task-534 判据①：**真浏览器**取 dotfile / 空目录 / 空 logs 的 computed 样式。
 *
 * 为什么必须真浏览器：jsdom 没有样式表，`getComputedStyle` 拿不到 Tailwind 生成的规则 ——
 * 单测只能断言 class 名单（"看起来像生效"），量不到"真的生效"。
 *
 * 注入方式用产品自带的 mock 播种钩子（`localStorage["xihe-mock-filetree"]`，仅 mock profile 读）：
 * 不新增测试专供代码，也不改产品默认树 —— 与 `src/preview/mock/data/workspaceTree.ts` 的
 * `MOCK_ROOT_TREES_VISUAL` 同构（那边服务 preview 车道，这边服务 e2e 车道，样本对象一致）。
 *
 * 判据（数值不写"看起来淡了"，一律给实测值 + 对照）：
 *  1 dotfile 行文字色 != 普通文件行文字色（并给出两者 rgb）
 *  2 空目录行 opacity < 1（并给出实测值；普通目录 = 1）
 *  3 空 logs **不渲染**（D-1234 合法例外）—— 与"空目录可见"形成对照
 */

const SEED = [
    { name: "README.md", path: "README.md", type: "file", size: 12 },
    {
        name: "src",
        path: "src",
        type: "directory",
        children: [{ name: "main.ts", path: "src/main.ts", type: "file", size: 3 }],
    },
    { name: "empty-notes", path: "empty-notes", type: "directory", children: [] },
    { name: "logs", path: "logs", type: "directory", children: [] },
    { name: ".env.local", path: ".env.local", type: "file", size: 9 },
];

test.describe("task-534 树视觉判据（真浏览器 computed style）", () => {
    test("dotfile 置灰 / 空目录淡 / 空 logs 隐藏 —— 三项都给实测值", async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, {
            sessions: [{ id: "session-1", title: "Session 1" }],
            messages: { "session-1": [] },
        });
        await page.addInitScript((tree) => {
            localStorage.setItem("xihe-mock-filetree", JSON.stringify(tree));
        }, SEED);

        await page.goto(`/workspace/${MOCK_WORKSPACE_ID}`);
        await expect(page.getByText("README.md")).toBeVisible({ timeout: LONG_TIMEOUT_MS });

        // 取色对象 = **承载文字的子节点**，不是行按钮本身。
        // 实测（本 spec 第一版就踩了）：行按钮的 color 恒为 `oklch(0.145 0 0)`，
        // 而 519 的 muted class 挂在 name span 上 ⇒ 对着按钮取色会得到
        // 「dotfile 与普通行同色」的**假红**（或者反过来说，改前若只看按钮会得假绿）。
        const read = async (locator: ReturnType<typeof page.locator>) =>
            locator.evaluate((el) => {
                const row = getComputedStyle(el);
                const spans = [...el.querySelectorAll("span")];
                const nameSpan = spans.find((node) => {
                    const text = (node.textContent ?? "").trim();
                    return text.length > 0 && node.querySelector("span") === null;
                });
                return {
                    rowColor: row.color,
                    textColor: nameSpan ? getComputedStyle(nameSpan).color : null,
                    opacity: row.opacity,
                };
            });

        const normalRow = page.locator('button:has-text("README.md")').first();
        const dotfileRow = page.locator('button[data-dotfile="true"]').first();
        const emptyDirRow = page.locator('button[data-empty-dir="true"]').first();

        await expect(dotfileRow).toBeVisible();
        await expect(emptyDirRow).toBeVisible();

        const normal = await read(normalRow);
        const dotfile = await read(dotfileRow);
        const emptyDir = await read(emptyDirRow);

        // 读数进报告：一个数值都没有的"视觉判据"不算判据
        test.info().annotations.push({
            type: "readings",
            description: `normal=${JSON.stringify(normal)} dotfile=${JSON.stringify(dotfile)} emptyDir=${JSON.stringify(emptyDir)}`,
        });
        console.log("[task-534] normal=", JSON.stringify(normal));
        console.log("[task-534] dotfile=", JSON.stringify(dotfile));
        console.log("[task-534] emptyDir=", JSON.stringify(emptyDir));

        // ① dotfile 必须换成 muted 色（与普通行对比，不判具体色号 —— 具体值随主题变）
        expect(
            dotfile.textColor,
            `dotfile 文字色应与普通行不同：dotfile=${dotfile.textColor} normal=${normal.textColor}`,
        ).not.toBe(normal.textColor);
        // ② 空目录必须是"淡"的：opacity < 1，普通行 = 1
        expect(Number(normal.opacity), "普通行不该被淡化").toBe(1);
        expect(Number(emptyDir.opacity), `空目录应淡化：opacity=${emptyDir.opacity}`).toBeLessThan(
            1,
        );
        // ③ 空 logs 属于运行时产物，必须整条不渲染
        await expect(
            page.getByText("logs", { exact: true }),
            "空 logs 必须隐藏（D-1234 例外）",
        ).toHaveCount(0);
    });
});
