/**
 * PLAN-0631 色彩方案开关：默认 = C2′，C1/C3 仅 `?color=` 对比用，旧持久化键清除式迁移。
 *
 * 规则逐条锁：
 * 1. `?color=c1|c3` 投影到 `<html data-xh-color>`（opt-in 覆盖）；
 * 2. `c2`（已升格为默认）/`default`/`off`/`none`/未知值一律回到默认 C2′（不设属性）；
 * 3. 不再读写持久化：启动时 `initColorScheme` 只删 `xihe-color-scheme`，不读值。
 */
import { describe, expect, it, afterEach } from "vitest";
import { applyColorScheme, initColorScheme, resolveColorScheme } from "../colorScheme";

describe("resolveColorScheme", () => {
    it("c1/c3 解析为 opt-in 覆盖", () => {
        expect(resolveColorScheme("?color=c1")).toBe("c1");
        expect(resolveColorScheme("?color=c3")).toBe("c3");
    });

    it("c2 已升格为默认：解析为 null（不设属性）", () => {
        expect(resolveColorScheme("?color=c2")).toBeNull();
    });

    it("default/off/none 显式清除", () => {
        expect(resolveColorScheme("?color=default")).toBeNull();
        expect(resolveColorScheme("?color=off")).toBeNull();
        expect(resolveColorScheme("?color=none")).toBeNull();
    });

    it("非法值与空值都降级为默认 C2′", () => {
        expect(resolveColorScheme("?color=c4")).toBeNull();
        expect(resolveColorScheme("")).toBeNull();
        expect(resolveColorScheme("?color=%20")).toBeNull();
    });

    it("大小写与空白不影响解析", () => {
        expect(resolveColorScheme("?color=%20C1%20")).toBe("c1");
        expect(resolveColorScheme("?color= C3 ")).toBe("c3");
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

describe("initColorScheme（清除式迁移）", () => {
    afterEach(() => {
        localStorage.removeItem("xihe-color-scheme");
        document.documentElement.removeAttribute("data-xh-color");
    });

    it("旧持久化键只删不读：残留 c1/c2/c3 一律清除，界面仍落默认 C2′", () => {
        for (const legacy of ["c1", "c2", "c3"]) {
            localStorage.setItem("xihe-color-scheme", legacy);
            const scheme = initColorScheme();
            expect(scheme, `残留 ${legacy} 不得生效`).toBeNull();
            expect(
                localStorage.getItem("xihe-color-scheme"),
                `残留 ${legacy} 必须被清除`,
            ).toBeNull();
            expect(document.documentElement.hasAttribute("data-xh-color")).toBe(false);
        }
    });

    it("不再写入持久化键", () => {
        initColorScheme();
        expect(localStorage.getItem("xihe-color-scheme")).toBeNull();
    });
});
