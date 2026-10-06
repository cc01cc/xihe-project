import {
    expect,
    test,
    type Locator,
    type Page,
    type PageAssertionsToHaveScreenshotOptions,
} from "@playwright/test";

type ScreenshotOptions = PageAssertionsToHaveScreenshotOptions;

export async function expectPlatformScreenshot(
    actual: Locator | Page,
    name: string | string[],
    options?: ScreenshotOptions,
): Promise<void> {
    if (process.platform !== "linux") {
        const info = test.info();
        if (
            !info.annotations.some((annotation) => annotation.type === "visual-baseline-platform")
        ) {
            info.annotations.push({
                type: "visual-baseline-platform",
                description: `Screenshot comparison runs on Linux; current platform is ${process.platform}`,
            });
        }
        return;
    }

    await expect(actual).toHaveScreenshot(name, options);
}
