/**
 * Splitter 首帧闪光回归门（task-127；定因见 task-93 结论）。
 *
 * 缺陷形态 [实测 task-93]：首帧 sidebar = 1585.3px，192.4ms 内收缩到 336px —— 肉眼可见的一次跳动。
 * 根因 [源码] reka-ui 2.11.0 dist/utils/style.js:45-50：layout 未初始化时把 px 的 defaultSize
 * 当作无单位 flex-grow（336 : 1）；我方放大器是 AppLayout.vue:458 / Sidebar.vue:182 的
 * transition-[flex-grow] duration-300。
 *
 * 为什么必须逐帧采样：稳态读数（帧门后）永远一致，「闪一下」只存在于过渡的 300ms 里。
 * 判据：
 *   1) 任一中间帧 sidebar 宽 > 稳定值 × 1.05 ⇒ 红（卡面判据）；
 *   2) 同一次 flex-grow 挤压 main，故任一帧 main 宽 < 稳定值 × 0.95 也判红（同源另一侧）；
 *   3) 首个可见帧就必须落在稳态 ±5% 内（过渡不应作用于「尚未测量」的元素）。
 *
 * 读数落盘 one/.tmp/xh/ui-gates/splitter-flicker/red-before.json；不改产品代码、不截图。
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    installFrameSampler,
    measureSettled,
    readFrameSamples,
    type FrameSample,
} from "../helpers/frame-gate";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** packages/ui/e2e/real → A03-xihe */
const PROJECT_ROOT = path.resolve(HERE, "../../../..");
/** A03-xihe → one */
const ONE_ROOT = path.resolve(PROJECT_ROOT, "..");
const PASSWORD_FILE = path.join(PROJECT_ROOT, ".local", "dev", "admin-password");
const ADMIN_IDENTIFIER = process.env.XIHE_E2E_ADMIN_IDENTIFIER ?? "admin@xihe.local";
/**
 * 读数目录：每个视口一个文件（Playwright 每个 test 一个 worker 进程 ⇒ 模块态不共享，
 * 写同一个文件会互相覆盖；按视口分文件既无竞争又能逐条复算）。
 */
const OUT_DIR =
    process.env.SPLITTER_FLICKER_OUT_DIR ??
    path.join(ONE_ROOT, ".tmp", "xh", "ui-gates", "splitter-flicker");

/** 首帧闪光容差：稳定值 ±5%（超出即肉眼可见的跳动）。 */
const FLASH_RATIO_MAX = 1.05;
const FLASH_RATIO_MIN = 0.95;
/** 有效样本下限：少于该数说明采样器没跑起来，判红而不是判绿。 */
const MIN_MEASURED_FRAMES = 5;

const VIEWPORTS = [
    { name: "1920x1080", width: 1920, height: 1080 },
    { name: "1440x900", width: 1440, height: 900 },
    { name: "1600x900", width: 1600, height: 900 },
] as const;

interface FlashFrame {
    t: number;
    value: number;
    ratio: number;
}

interface FlashRecord {
    viewport: string;
    settled: boolean;
    forcedShots: number;
    finishedByForce: number;
    stableSidebar: number | null;
    stableMain: number | null;
    sampleCount: number;
    measuredFrames: number;
    maxSidebarRatio: number | null;
    minSidebarRatio: number | null;
    maxMainRatio: number | null;
    minMainRatio: number | null;
    overshootFrames: FlashFrame[];
    undershootFrames: FlashFrame[];
    transitionFrames: number;
    samples: FrameSample[];
}

function persist(record: FlashRecord): void {
    mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, "red-" + record.viewport + ".json");
    writeFileSync(
        file,
        JSON.stringify({ generatedAt: new Date().toISOString(), record }, null, 2) + "\n",
        "utf8",
    );
}

/** 口令运行时从文件读入（不进日志、不进参数、不进截图）。 */
function readAdminPassword(): string {
    const password = readFileSync(PASSWORD_FILE, "utf8").trim();
    // 只断言「非空」，绝不回显口令本身。
    expect(
        password.length,
        "口令文件 " + path.relative(ONE_ROOT, PASSWORD_FILE) + " 为空",
    ).toBeGreaterThan(0);
    return password;
}

async function loginViaForm(page: Page): Promise<void> {
    const password = readAdminPassword();
    await page.goto("/login", { waitUntil: "load" });
    await page.locator("#identifier").fill(ADMIN_IDENTIFIER);
    await page.locator("#password").fill(password);
    const [response] = await Promise.all([
        page.waitForResponse(
            (res) =>
                new URL(res.url()).pathname === "/api/v1/auth/login" &&
                res.request().method() === "POST",
        ),
        page.locator('button[type="submit"]').first().click(),
    ]);
    expect(response.status(), "登录接口应 200").toBe(200);
    await expect
        .poll(() => page.evaluate(() => Boolean(localStorage.getItem("xihe-token"))), {
            timeout: 10_000,
        })
        .toBe(true);
}

/** 取一个工作区 id（只需要落到 AppLayout，不需要会话）。 */
async function pickWorkspaceId(page: Page): Promise<string | null> {
    return page.evaluate(async () => {
        const token = localStorage.getItem("xihe-token") ?? "";
        const res = await fetch("/api/v1/workspaces", {
            headers: { authorization: "Bearer " + token },
        });
        if (!res.ok) return null;
        const body = (await res.json()) as unknown;
        const list: unknown[] = Array.isArray(body)
            ? body
            : ((body as { workspaces?: unknown[] }).workspaces ?? []);
        const first = list[0] as { id?: string } | undefined;
        return first?.id ?? null;
    });
}

function fmt(value: number | null): string {
    return value === null ? "null" : value.toFixed(3);
}

test.describe("Splitter 首帧闪光（task-127）", () => {
    for (const vp of VIEWPORTS) {
        test(vp.name + " 逐帧采样不得超出稳定值 ±5%", async ({ page }) => {
            await page.setViewportSize({ width: vp.width, height: vp.height });
            await loginViaForm(page);
            const workspaceId = await pickWorkspaceId(page);
            expect.soft(workspaceId, vp.name + " 未能取到工作区 id（API 未返回）").not.toBeNull();
            if (!workspaceId) return;

            // 采样器在**下一次文档启动前**生效：工作区那次装载的帧才进入样本
            await installFrameSampler(page);
            await page.goto("/workspace/" + workspaceId, { waitUntil: "load" });
            await page.locator('[data-testid="sidebar"]').waitFor({ state: "attached" });
            const { gate, widths } = await measureSettled(page);
            const samples = await readFrameSamples(page);

            const stableSidebar = widths.sidebar;
            const stableMain = widths.main;
            expect
                .soft(stableSidebar, vp.name + " 稳定态 sidebar 宽取不到（帧门后仍为 null）")
                .not.toBeNull();
            expect
                .soft(stableMain, vp.name + " 稳定态 workspace-main 宽取不到（帧门后仍为 null）")
                .not.toBeNull();
            if (!stableSidebar || !stableMain) return;

            // 只统计「两侧都已布局」的帧：0 宽帧属装载瞬间，不是闪光
            const measured = samples.filter(
                (sample): sample is FrameSample & { sidebar: number; main: number } =>
                    sample.sidebar !== null &&
                    sample.main !== null &&
                    sample.sidebar > 0 &&
                    sample.main > 0,
            );
            const sidebarRatios = measured.map((sample) => sample.sidebar / stableSidebar);
            const mainRatios = measured.map((sample) => sample.main / stableMain);
            const overshootFrames: FlashFrame[] = measured
                .map((sample) => ({
                    t: sample.t,
                    value: sample.sidebar,
                    ratio: sample.sidebar / stableSidebar,
                }))
                .filter((frame) => frame.ratio > FLASH_RATIO_MAX);
            const undershootFrames: FlashFrame[] = measured
                .map((sample) => ({
                    t: sample.t,
                    value: sample.main,
                    ratio: sample.main / stableMain,
                }))
                .filter((frame) => frame.ratio < FLASH_RATIO_MIN);

            const record: FlashRecord = {
                viewport: vp.name,
                settled: gate.settled,
                forcedShots: gate.forcedShots,
                finishedByForce: gate.finishedByForce,
                stableSidebar,
                stableMain,
                sampleCount: samples.length,
                measuredFrames: measured.length,
                maxSidebarRatio: sidebarRatios.length > 0 ? Math.max(...sidebarRatios) : null,
                minSidebarRatio: sidebarRatios.length > 0 ? Math.min(...sidebarRatios) : null,
                maxMainRatio: mainRatios.length > 0 ? Math.max(...mainRatios) : null,
                minMainRatio: mainRatios.length > 0 ? Math.min(...mainRatios) : null,
                overshootFrames: overshootFrames.slice(0, 20),
                undershootFrames: undershootFrames.slice(0, 20),
                transitionFrames: samples.filter((sample) => sample.runningAnimations > 0).length,
                samples,
            };
            persist(record);

            const context =
                "实测稳定值 sidebar=" +
                stableSidebar +
                "px / main=" +
                stableMain +
                "px，有效帧 " +
                measured.length +
                "，帧门 settled=" +
                String(gate.settled);

            // 采样器必须真的跑起来：帧数不足 ⇒ 门无效，判红（不 skip）
            expect
                .soft(
                    measured.length,
                    vp.name +
                        " 有效采样帧 " +
                        measured.length +
                        "（阈值 ≥" +
                        MIN_MEASURED_FRAMES +
                        "；采样器未跑或装载过快，读数不可用 归属卡 task-127）",
                )
                .toBeGreaterThanOrEqual(MIN_MEASURED_FRAMES);

            // 判据 1（卡面）：任一中间帧 sidebar > 稳定值 ×1.05 ⇒ 红（现状首帧 1585 vs 336）
            expect
                .soft(
                    record.maxSidebarRatio ?? 0,
                    vp.name +
                        " sidebar 最大帧/稳定值比 " +
                        fmt(record.maxSidebarRatio) +
                        "（阈值 ≤" +
                        FLASH_RATIO_MAX +
                        "；" +
                        context +
                        "；超限帧示例 " +
                        JSON.stringify(overshootFrames.slice(0, 3)) +
                        " 归属卡 task-127）",
                )
                .toBeLessThanOrEqual(FLASH_RATIO_MAX);

            // 判据 2（同源另一侧）：main 被同一次 flex-grow 挤压 ⇒ 任一帧 < 稳定值 ×0.95 也判红
            expect
                .soft(
                    record.minMainRatio ?? 0,
                    vp.name +
                        " main 最小帧/稳定值比 " +
                        fmt(record.minMainRatio) +
                        "（阈值 ≥" +
                        FLASH_RATIO_MIN +
                        "；" +
                        context +
                        "；超限帧示例 " +
                        JSON.stringify(undershootFrames.slice(0, 3)) +
                        " 归属卡 task-127）",
                )
                .toBeGreaterThanOrEqual(FLASH_RATIO_MIN);

            // 判据 3：首个可见帧就应落在稳态 ±5% 内（过渡不应作用于尚未测量的元素）
            const firstFrame = measured[0];
            const firstRatio = firstFrame ? firstFrame.sidebar / stableSidebar : null;
            expect
                .soft(
                    firstRatio ?? 0,
                    vp.name +
                        " 首个可见帧 sidebar=" +
                        (firstFrame ? firstFrame.sidebar : "null") +
                        "px / 稳定 " +
                        stableSidebar +
                        "px = " +
                        fmt(firstRatio) +
                        "（阈值 ≤" +
                        FLASH_RATIO_MAX +
                        "；首帧即应等于稳态 归属卡 task-127）",
                )
                .toBeLessThanOrEqual(FLASH_RATIO_MAX);
        });
    }
});
