/**
 * PLAN-0631 色彩方案开关：解析优先级、清除语义与 `<html>` 投影。
 *
 * 这个开关的三条规则是"默认主题不变"的实现基础，所以按规则各锁一条：
 * 1. `?color=` 优先于 localStorage；
 * 2. `default`/`off`/`none` 显式清除（不回落到旧持久化值）；
 * 3. 非法值一律降级为默认主题（不猜测拼写）。
 */
import { describe, expect, it, afterEach } from "vitest";
import { applyColorScheme, resolveColorScheme } from "../colorScheme";

describe("resolveColorScheme", () => {
    it("query 优先于持久化值", () => {
        expect(resolveColorScheme("?color=c2", "c1")).toBe("c2");
    });

    it("没有 query 时回落到持久化值", () => {
        expect(resolveColorScheme("", "c3")).toBe("c3");
    });

    it("default/off/none 显式清除，不回落到持久化值", () => {
        expect(resolveColorScheme("?color=default", "c1")).toBeNull();
        expect(resolveColorScheme("?color=off", "c2")).toBeNull();
        expect(resolveColorScheme("?color=none", "c3")).toBeNull();
    });

    it("非法值与空值都降级为默认主题", () => {
        expect(resolveColorScheme("?color=c4", "nope")).toBeNull();
        expect(resolveColorScheme("", null)).toBeNull();
        expect(resolveColorScheme("?color=%20", "")).toBeNull();
    });

    it("大小写与空白不影响解析", () => {
        expect(resolveColorScheme("?color=%20C1%20", null)).toBe("c1");
        expect(resolveColorScheme("", " C2 ")).toBe("c2");
    });
});

describe("applyColorScheme", () => {
    afterEach(() => {
        document.documentElement.removeAttribute("data-xh-color");
    });

    it("设置与移除 <html data-xh-color>", () => {
        applyColorScheme("c1");
        expect(document.documentElement.getAttribute("data-xh-color")).toBe("c1");
        applyColorScheme(null);
        expect(document.documentElement.hasAttribute("data-xh-color")).toBe(false);
    });
});
