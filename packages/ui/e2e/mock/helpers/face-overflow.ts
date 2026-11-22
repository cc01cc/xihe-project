/**
 * task-844（W2 / P0-1 增量）：核心面「页面根 + 代表性容器」双轴横向溢出读数。
 *
 * 与 `helpers/overflow-guard.ts`（task-753，只读 `document.scrollingElement`）并存：
 * task-753 证明了 8 个核心面在 1366/1920 下**页面根**不溢出；但页面根不溢出 ≠ 容器没被
 * 静默裁剪/横向滚动。例如 `overflow-x: hidden` 或 `auto` 的面板会把内容裁掉或生出横向滚动条，
 * 页面根读数仍可以是 `scrollWidth <= innerWidth`。本 helper 因此把「代表性容器」也纳入判据：
 *
 * 1. `document.documentElement.scrollWidth <= window.innerWidth`（合同 §3 原文口径，严格比较）；
 * 2. 目标容器 `scrollWidth <= clientWidth + 1`（+1 吸收子像素；精确到容器自己的滚动区）；
 * 3. 目标容器 `overflow-x !== "scroll"`（`scroll` 会常驻横向滚动条；`auto` 无溢出时不渲染滚动条，
 *    其「是否真的溢出」已由第 2 条兜住）。
 *
 * 反证（`task844-1366-face-overflow.spec.ts` 内）：测试内向容器注入 6000px 探针后，
 * `assertFaceNoHorizontalOverflow()` **必须抛红**，证明本判据不是恒绿。
 *
 * 不设面级豁免、不放宽阈值；先给 3s 挂载收敛窗口（轮询，不是固定 sleep），永久溢出仍判红。
 */
import { expect, type Page } from "@playwright/test";

export interface ContainerOverflowReading {
    selector: string;
    tag: string;
    cls: string;
    scrollWidth: number;
    clientWidth: number;
    overflowX: string;
}

export interface WidestDescendant {
    tag: string;
    cls: string;
    width: number;
}

export interface FaceOverflowReading {
    docScrollWidth: number;
    innerWidth: number;
    container: ContainerOverflowReading | null;
    widest: WidestDescendant | null;
}

/** 子像素取整容差与挂载过渡收敛窗口（与 task-753 同口径，不放宽）。 */
const OVERFLOW_TOLERANCE_PX = 1;
const OVERFLOW_SETTLE_MS = 3_000;
const OVERFLOW_POLL_MS = 100;
/**
 * 布局过渡：工作区外壳有 `transition-[flex-grow] duration-300`，首帧会出现中心列被侧栏挤到
 * 十几 px 的中间态。那时 `scrollWidth == clientWidth` 恒成立 ⇒ 不溢出是**假绿**（容器还没成形）。
 * 因此除「无溢出」外还要求容器宽度连续两次采样不变，才认为布局已收敛。
 */
const STABLE_SAMPLES_REQUIRED = 2;

export async function readFaceOverflow(page: Page, selector: string): Promise<FaceOverflowReading> {
    return page.evaluate((sel) => {
        const doc = document.documentElement;
        const container = document.querySelector(sel);
        let widest: WidestDescendant | null = null;
        if (container) {
            for (const child of Array.from(container.querySelectorAll("*"))) {
                const box = child.getBoundingClientRect();
                if (box.width > (widest?.width ?? 0)) {
                    widest = {
                        tag: child.tagName.toLowerCase(),
                        cls: (child.getAttribute("class") ?? "").slice(0, 80),
                        width: Math.round(box.width),
                    };
                }
            }
        }
        return {
            docScrollWidth: doc.scrollWidth,
            innerWidth: window.innerWidth,
            container: container
                ? {
                      selector: sel,
                      tag: container.tagName.toLowerCase(),
                      cls: (container.getAttribute("class") ?? "").slice(0, 80),
                      scrollWidth: container.scrollWidth,
                      clientWidth: container.clientWidth,
                      overflowX: getComputedStyle(container).overflowX,
                  }
                : null,
            widest,
        };
    }, selector);
}

/**
 * 同步断言函数：刻意不返回 Promise，反证用例可用 try/catch 直接证明「撑破后必须抛红」。
 */
export function assertFaceNoHorizontalOverflow(reading: FaceOverflowReading, label: string): void {
    expect(reading.container, `${label}：找不到代表性容器`).not.toBeNull();

    expect(
        reading.docScrollWidth,
        `${label} 页面根横向溢出：document.documentElement.scrollWidth=${reading.docScrollWidth}` +
            ` > window.innerWidth=${reading.innerWidth}`,
    ).toBeLessThanOrEqual(reading.innerWidth);

    const container = reading.container;
    if (!container) return;
    const widest = reading.widest
        ? `；最宽子元素 <${reading.widest.tag} class="${reading.widest.cls}"> ${reading.widest.width}px`
        : "";
    expect(
        container.scrollWidth,
        `${label} 容器横向溢出：${container.selector}` +
            `（命中 <${container.tag} class="${container.cls}">）` +
            ` scrollWidth=${container.scrollWidth}` +
            ` clientWidth=${container.clientWidth} overflow-x=${container.overflowX}${widest}`,
    ).toBeLessThanOrEqual(container.clientWidth + OVERFLOW_TOLERANCE_PX);
    expect(
        container.overflowX,
        `${label} 容器存在常驻横向滚动条：${container.selector} overflow-x=scroll`,
    ).not.toBe("scroll");
}

interface SettleState {
    width: number;
    since: number;
}

/**
 * 条件等待（不是固定 sleep，遵守 `packages/ui/AGENTS.md:125`）：
 * 容器已挂载、当前无溢出，且容器宽度连续 `stableMs` 未变化。
 * 超时不在这里抛——永久溢出交给下面的同步断言，失败信息带真实读数与最宽子元素。
 */
async function waitForLayoutSettled(page: Page, selector: string): Promise<void> {
    await page
        .waitForFunction(
            ({ sel, tolerance, stableMs }) => {
                const el = document.querySelector(sel);
                if (!el) return false;
                if (document.documentElement.scrollWidth > window.innerWidth) return false;
                if (el.scrollWidth > el.clientWidth + tolerance) return false;
                const store = window as unknown as Record<string, SettleState | undefined>;
                const key = `__task844Settle:${sel}`;
                const now = performance.now();
                const state = store[key];
                if (!state || state.width !== el.clientWidth) {
                    store[key] = { width: el.clientWidth, since: now };
                    return false;
                }
                return now - state.since >= stableMs;
            },
            {
                sel: selector,
                tolerance: OVERFLOW_TOLERANCE_PX,
                stableMs: STABLE_SAMPLES_REQUIRED * OVERFLOW_POLL_MS,
            },
            { polling: OVERFLOW_POLL_MS, timeout: OVERFLOW_SETTLE_MS },
        )
        .catch(() => {
            // 见函数注释：这个超时不代表失败，断言阶段给出可用诊断。
        });
}

/** 采样 → 3s 收敛窗口 → 断言；失败信息带两个真实读数与最宽子元素。 */
export async function expectFaceNoHorizontalOverflow(
    page: Page,
    label: string,
    selector: string,
): Promise<FaceOverflowReading> {
    await waitForLayoutSettled(page, selector);
    const reading = await readFaceOverflow(page, selector);
    const container = reading.container
        ? ` container=<${reading.container.tag} class="${reading.container.cls}">` +
          ` ${reading.container.scrollWidth}` +
          `/${reading.container.clientWidth} overflow-x=${reading.container.overflowX}`
        : " container=<missing>";
    console.log(
        `[task-844] ${label}: documentElement.scrollWidth=${reading.docScrollWidth}` +
            ` window.innerWidth=${reading.innerWidth}${container}`,
    );
    assertFaceNoHorizontalOverflow(reading, label);
    return reading;
}
