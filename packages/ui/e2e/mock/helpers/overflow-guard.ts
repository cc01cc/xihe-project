import { expect, type Page } from "@playwright/test";

export interface OverflowReading {
    scrollWidth: number;
    clientWidth: number;
}

/** 读页面根滚动容器（`document.scrollingElement`）的横向读数。 */
export async function readDocOverflow(page: Page): Promise<OverflowReading> {
    return page.evaluate(() => {
        const el = document.scrollingElement ?? document.documentElement;
        return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
}

/** 子像素取整容差与挂载过渡收敛窗口（轮询判定，不是固定 sleep）。 */
const OVERFLOW_TOLERANCE_PX = 1;
const OVERFLOW_SETTLE_MS = 3_000;
const OVERFLOW_POLL_MS = 100;

/**
 * 合同 §3：核心面在 1366×768 与 1920×1080 无横向滚动。
 *
 * 判据：`document.scrollingElement.scrollWidth <= clientWidth + 1`（+1 吸收子像素取整）。
 * 用 `expect.poll` 给 3s 收敛窗口去掉挂载过渡态，但**永久溢出仍会失败**（不是放宽阈值）。
 * 失败信息带两个真实读数，便于定位是哪一面/哪一档。
 */
export async function expectNoDocHorizontalOverflow(
    page: Page,
    label: string,
): Promise<OverflowReading> {
    await expect
        .poll(
            async () => {
                const reading = await readDocOverflow(page);
                return reading.scrollWidth - (reading.clientWidth + OVERFLOW_TOLERANCE_PX);
            },
            {
                message: `${label} 横向溢出持续超过 ${OVERFLOW_SETTLE_MS}ms`,
                timeout: OVERFLOW_SETTLE_MS,
                intervals: [OVERFLOW_POLL_MS],
            },
        )
        .toBeLessThanOrEqual(0);
    const reading = await readDocOverflow(page);
    console.log(
        `[task-753] ${label}: scrollWidth=${reading.scrollWidth} clientWidth=${reading.clientWidth}`,
    );
    expect(
        reading.scrollWidth,
        `${label} 横向溢出：scrollWidth=${reading.scrollWidth} clientWidth=${reading.clientWidth}`,
    ).toBeLessThanOrEqual(reading.clientWidth + OVERFLOW_TOLERANCE_PX);
    return reading;
}
