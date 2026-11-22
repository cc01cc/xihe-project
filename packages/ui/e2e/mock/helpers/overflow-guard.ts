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

/**
 * 合同 §3：核心面在 1366×768 与 1920×1080 无横向滚动。
 *
 * 判据：`document.scrollingElement.scrollWidth <= clientWidth + 1`（+1 吸收子像素取整）。
 * 给 3s 收敛窗口去掉挂载过渡态，但**永久溢出仍会失败**（不是放宽阈值）。
 * 失败信息带两个真实读数，便于定位是哪一面/哪一档。
 */
export async function expectNoDocHorizontalOverflow(
    page: Page,
    label: string,
): Promise<OverflowReading> {
    let reading = await readDocOverflow(page);
    const deadline = Date.now() + 3_000;
    while (reading.scrollWidth > reading.clientWidth + 1 && Date.now() < deadline) {
        await page.waitForTimeout(100);
        reading = await readDocOverflow(page);
    }
    console.log(
        `[task-753] ${label}: scrollWidth=${reading.scrollWidth} clientWidth=${reading.clientWidth}`,
    );
    expect(
        reading.scrollWidth,
        `${label} 横向溢出：scrollWidth=${reading.scrollWidth} clientWidth=${reading.clientWidth}`,
    ).toBeLessThanOrEqual(reading.clientWidth + 1);
    return reading;
}
