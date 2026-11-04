import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * PLAN-0659：把「真浏览器截图」落盘到 PLAN 的 `evidence/` 目录。
 *
 * 证据目录必须由 `XIHE_EVIDENCE_DIR` **显式注入**：A03 主检出与各 worktree 到 `plans/` 的
 * 相对深度不同（`packages/ui` 下一层数会变），写死相对路径在某个 checkout 里会静默落到
 * 错误位置或被当成「已取证」。没有注入就直接失败——宁可红，也不产出「以为有截图」。
 *
 * 截图是**证据**不是视觉基线：不进 `toHaveScreenshot` 比对（平台/字体差异），路径记进
 * 测试注解 `evidence`，由 PLAN verify 逐张复核。
 */
export async function captureEvidence(page: Page, name: string): Promise<void> {
    const directory = process.env.XIHE_EVIDENCE_DIR;
    if (!directory) {
        throw new Error(
            "XIHE_EVIDENCE_DIR is not set — evidence screenshots must land in the PLAN evidence " +
                "directory (e.g. <one>/plans/PLAN-0659-xh-multi-principal-thread/evidence)",
        );
    }
    const target = resolve(directory, `${name}.png`);
    mkdirSync(dirname(target), { recursive: true });
    // `animations: "disabled"` 冻结 CSS 过渡（shimmer 等），否则截图拍到中间帧。
    await page.screenshot({ path: target, fullPage: true, animations: "disabled" });
    test.info().annotations.push({ type: "evidence", description: target });
}
