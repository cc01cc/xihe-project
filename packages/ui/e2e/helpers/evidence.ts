import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PLAN-0659：把「真浏览器截图」落盘到 PLAN 的 `evidence/` 目录。
 *
 * 证据目录优先由 `XIHE_EVIDENCE_DIR` **显式注入**：A03 主检出与各 worktree 到 `plans/` 的
 * 相对深度不同（`packages/ui` 下一层数会变），写死相对路径在某个 checkout 里会静默落到
 * 错误位置或被当成「已取证」。
 *
 * 2026-11-05（Lead 批准的最小修法）：变量未注入时**不再让用例直接红**，而是回退到
 * `<repo>/.local/evidence/e2e-auto`（`.local/` 已在 `.gitignore:95` 忽略）并打一行 WARN。
 * 这条回退只决定**截图落点**，不改任何断言语义；mock 基线上那 4 条
 * `XIHE_EVIDENCE_DIR is not set` 的环境前置红由此消除。需要把证据放到 PLAN 目录时仍应显式注入。
 *
 * 截图是**证据**不是视觉基线：不进 `toHaveScreenshot` 比对（平台/字体差异），路径记进
 * 测试注解 `evidence`，由 PLAN verify 逐张复核。
 */

/** 本文件位于 `<repo>/packages/ui/e2e/helpers/` ⇒ 上跳四级即仓库根。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** 未注入 `XIHE_EVIDENCE_DIR` 时的兜底落点（gitignored）。 */
const FALLBACK_EVIDENCE_DIR = resolve(REPO_ROOT, ".local/evidence/e2e-auto");

let warnedAboutFallback = false;

export async function captureEvidence(page: Page, name: string): Promise<void> {
    let directory = process.env.XIHE_EVIDENCE_DIR;
    if (!directory) {
        directory = FALLBACK_EVIDENCE_DIR;
        if (!warnedAboutFallback) {
            warnedAboutFallback = true;
            console.warn(
                "[evidence] XIHE_EVIDENCE_DIR is not set — evidence screenshots fall back to " +
                    `${FALLBACK_EVIDENCE_DIR} (.local/ is gitignored). Inject XIHE_EVIDENCE_DIR to ` +
                    "land them in a PLAN evidence directory.",
            );
        }
    }
    const target = resolve(directory, `${name}.png`);
    mkdirSync(dirname(target), { recursive: true });
    // `animations: "disabled"` 冻结 CSS 过渡（shimmer 等），否则截图拍到中间帧。
    await page.screenshot({ path: target, fullPage: true, animations: "disabled" });
    test.info().annotations.push({ type: "evidence", description: target });
}
