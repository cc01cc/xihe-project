import { afterEach, describe, expect, it } from "vitest";
import {
    MAX_ROW_HEIGHT_CACHE_ENTRIES,
    MAX_ROW_HEIGHT_PX,
    MIN_ROW_HEIGHT_PX,
    clearRowHeights,
    forgetRowHeight,
    rememberRowHeight,
    rowHeightCacheSize,
    rowHeightOf,
} from "../composables/messageRowHeightCache";

/**
 * task-179：占位高缓存必须挂在**行身份**上（不是元素）——
 * 虚拟化卸载行后 `contain-intrinsic-size: auto` 的逐元素记忆会丢，
 * 重挂载时只有这份缓存能把「上次真实高」补回来。
 */
afterEach(() => {
    clearRowHeights();
});

describe("task-179 行高占位缓存", () => {
    it("记住的行高能按 key 读回，且与元素无关（同一 key 换个元素仍能命中）", () => {
        expect(rowHeightOf("row-a")).toBeUndefined();
        rememberRowHeight("row-a", 662);
        expect(rowHeightOf("row-a")).toBe(662);
        rememberRowHeight("row-a", 148);
        expect(rowHeightOf("row-a")).toBe(148);
        expect(rowHeightOf("row-b")).toBeUndefined();
    });

    it("四舍五入到整 px（亚像素测量值不能让占位抖动）", () => {
        rememberRowHeight("row-a", 661.6);
        expect(rowHeightOf("row-a")).toBe(662);
        rememberRowHeight("row-b", 78.4);
        expect(rowHeightOf("row-b")).toBe(78);
    });

    it("非法测量值一律丢弃并保留旧值（NaN / Infinity / 0 / 负数）", () => {
        rememberRowHeight("row-a", 662);
        for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
            rememberRowHeight("row-a", value);
        }
        expect(rowHeightOf("row-a")).toBe(662);
        expect(rowHeightOf("row-never")).toBeUndefined();
    });

    it("上钳到 MAX_ROW_HEIGHT_PX（异常测量不许把占位撑爆）", () => {
        rememberRowHeight("row-a", MAX_ROW_HEIGHT_PX * 100);
        expect(rowHeightOf("row-a")).toBe(MAX_ROW_HEIGHT_PX);
        rememberRowHeight("row-b", MIN_ROW_HEIGHT_PX);
        expect(rowHeightOf("row-b")).toBe(MIN_ROW_HEIGHT_PX);
    });

    it("超过条目上限时按插入顺序淘汰最旧的（缓存必须有界）", () => {
        for (let index = 0; index < MAX_ROW_HEIGHT_CACHE_ENTRIES + 3; index += 1) {
            rememberRowHeight(`row-${index}`, 100 + index);
        }
        expect(rowHeightCacheSize()).toBe(MAX_ROW_HEIGHT_CACHE_ENTRIES);
        expect(rowHeightOf("row-0")).toBeUndefined();
        expect(rowHeightOf("row-2")).toBeUndefined();
        expect(rowHeightOf("row-3")).toBe(103);
    });

    it("多行交错写入 + 非法值乱序到达：每个 key 各自保留最后一次**有效**值（逐 key 隔离）", () => {
        // 真实场景：虚拟化一屏 20+ 行同时上报测量，其中隐藏行/未布局行会报 0。
        const rows = ["row-a", "row-b", "row-c"];
        for (const key of rows) rememberRowHeight(key, 662);
        // 交错：合法值与非法值交替到达
        rememberRowHeight("row-a", 0);
        rememberRowHeight("row-b", 148);
        rememberRowHeight("row-c", Number.NaN);
        rememberRowHeight("row-a", -1);
        rememberRowHeight("row-b", 0);
        rememberRowHeight("row-c", 83);
        expect(rowHeightOf("row-a")).toBe(662);
        expect(rowHeightOf("row-b")).toBe(148);
        expect(rowHeightOf("row-c")).toBe(83);
    });

    it("forget / clear 只影响对应条目", () => {
        rememberRowHeight("row-a", 662);
        rememberRowHeight("row-b", 148);
        expect(rowHeightCacheSize()).toBe(2);
        forgetRowHeight("row-a");
        expect(rowHeightOf("row-a")).toBeUndefined();
        expect(rowHeightOf("row-b")).toBe(148);
        clearRowHeights();
        expect(rowHeightCacheSize()).toBe(0);
    });
});
