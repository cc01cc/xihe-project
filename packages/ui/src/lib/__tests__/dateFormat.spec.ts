import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n";
import { applyLocale } from "../../i18n/locale";
import {
    DATE_FALLBACK,
    formatDate,
    formatDateTime,
    formatDateTimeMedium,
    formatTime,
    isValidDate,
} from "../dateFormat";

/**
 * `task-73` · 单一日期入口的读数。
 *
 * <p>判据的锚点都是**实测值**（宿主 Asia/Singapore，`2026-11-01T17:00:00Z` ⇒ 本地 11/2 01:00），
 * 不是凭印象写的「应该是某种格式」。时区断言**不许**钉 `UTC`/`+08:00` 字面量：宿主机时区换一台
 * 机器就会变 ⇒ 全部与 `Intl.DateTimeFormat` 的本地渲染**同源比较**（见最后一条）。</p>
 */

const ISO = "2026-11-01T17:00:00Z";

/** 语言只经 `applyLocale`（唯一入口），用例结束一律回中文，避免跨文件串味。 */
afterEach(() => {
    applyLocale("zh-CN");
});

describe("formatDateTime / formatDate / formatTime · 跟随界面语言", () => {
    it("zh-CN：中文界面的日期是 年/月/日 形态，不带 US 斜杠月日、不带 AM/PM", () => {
        applyLocale("zh-CN");
        expect(formatDateTime(ISO)).toBe("2026/11/2 01:00:00");
        expect(formatDate(ISO)).toBe("2026/11/2");
        expect(formatTime(ISO)).toBe("01:00");
        expect(formatTime(ISO, { seconds: true })).toBe("01:00:00");
    });

    it("en-US：同一 ISO 换成英文形态（证明读的是界面语言，不是硬编码 zh）", () => {
        applyLocale("en-US");
        expect(formatDateTime(ISO)).toBe("11/2/2026, 01:00:00 AM");
        expect(formatDate(ISO)).toBe("11/2/2026");
        expect(formatTime(ISO)).toBe("01:00 AM");
        expect(formatTime(ISO, { seconds: true })).toBe("01:00:00 AM");
    });

    it("两种语言之间切换立刻生效（helper 不缓存语言）", () => {
        applyLocale("zh-CN");
        const zh = formatDateTime(ISO);
        applyLocale("en-US");
        const en = formatDateTime(ISO);
        applyLocale("zh-CN");
        expect(formatDateTime(ISO)).toBe(zh);
        expect(en).not.toBe(zh);
    });
});

describe("formatDateTimeMedium · 月份短名这一档（task-91 起的两个调用点）", () => {
    it("两种界面语言产出不同的字符串，且各自与显式 locale 的 Intl 结果逐字符相同", () => {
        // 判据形态刻意是「与**显式** locale 的 Intl 结果相等」而不是与硬编码字面量相等：
        // 前者在任意宿主时区都成立（两边的时区来源相同），后者会随宿主时区变而假红。
        // 更关键的是：这一条与下一条合起来能把「locale 传 undefined」的变异判红 ——
        // undefined 只能产出一份固定字符串，不可能同时等于 zh-CN 与 en-US 两种结果。
        const options: Intl.DateTimeFormatOptions = {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        };
        applyLocale("zh-CN");
        const zh = formatDateTimeMedium(ISO);
        expect(zh).toBe(new Intl.DateTimeFormat("zh-CN", options).format(new Date(ISO)));
        applyLocale("en-US");
        const en = formatDateTimeMedium(ISO);
        expect(en).toBe(new Intl.DateTimeFormat("en-US", options).format(new Date(ISO)));
        expect(zh).not.toBe(en);
    });

    it("缺值走同一个占位，不需要再定义第二种形态", () => {
        applyLocale("zh-CN");
        expect(formatDateTimeMedium(null)).toBe(DATE_FALLBACK);
        expect(formatDateTimeMedium("")).toBe(DATE_FALLBACK);
        expect(formatDateTimeMedium("not-a-date")).toBe(DATE_FALLBACK);
        expect(formatDateTimeMedium(null, "不可用")).toBe("不可用");
    });
});

describe("缺值与不可解析值 · 全包唯一种占位形态", () => {
    it("null / undefined / 空串 / 垃圾串 / Invalid Date 全走同一个占位", () => {
        applyLocale("zh-CN");
        for (const value of [null, undefined, "", "not-a-date", new Date("x")]) {
            expect(formatDateTime(value)).toBe(DATE_FALLBACK);
            expect(formatDate(value)).toBe(DATE_FALLBACK);
            expect(formatTime(value)).toBe(DATE_FALLBACK);
        }
        expect(DATE_FALLBACK).toBe("—");
    });

    it("fallback 可由调用方覆盖（审计/凭据页的本地化文案，不改词）", () => {
        expect(formatDateTime(null, "不可用")).toBe("不可用");
        expect(formatTime(null, { fallback: "" })).toBe("");
    });

    it("isValidDate 只用于「没有就不渲染」的哨兵，与渲染结果不矛盾", () => {
        expect(isValidDate(ISO)).toBe(true);
        expect(isValidDate(0)).toBe(true); // 1970-01-01 是合法时间戳，不是「缺值」
        expect(isValidDate(null)).toBe(false);
        expect(isValidDate("")).toBe(false);
        expect(isValidDate("nope")).toBe(false);
    });
});

describe("时区 · 默认用本地墙上时间（不是 UTC）", () => {
    it("与 Intl 本地渲染同源（宿主时区变则两边一起变）", () => {
        applyLocale("zh-CN");
        const options: Intl.DateTimeFormatOptions = {
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        };
        const local = new Intl.DateTimeFormat("zh-CN", options).format(new Date(ISO));
        expect(formatDateTime(ISO)).toBe(local);
    });

    it("与 UTC 渲染不同（宿主不在 UTC 时区时）——这就是「不许传 UTC」的可执行判据", () => {
        applyLocale("zh-CN");
        const utc = new Intl.DateTimeFormat("zh-CN", {
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            timeZone: "UTC",
        }).format(new Date(ISO));
        if (new Date(ISO).getTimezoneOffset() === 0) {
            // 宿主就是 UTC 时区：本地与 UTC 必然相同，这条判据无从判定 ⇒ 显式跳过而不是假绿。
            expect(formatDateTime(ISO)).toBe(utc);
        } else {
            expect(formatDateTime(ISO)).not.toBe(utc);
        }
    });

    it("timeZone 显式指定时（排程 nextFire 用）只影响时区，不影响语言", () => {
        applyLocale("en-US");
        const utc = formatDateTime(ISO, undefined, { timeZone: "UTC", seconds: false });
        const shanghai = formatDateTime(ISO, undefined, {
            timeZone: "Asia/Shanghai",
            seconds: false,
        });
        expect(utc).toBe("11/1/2026, 05:00 PM");
        expect(shanghai).toBe("11/2/2026, 01:00 AM");
    });
});

describe("i18n 接线", () => {
    it("读取的是 i18n.global.locale（applyLocale 的写入点）", () => {
        applyLocale("en-US");
        expect(i18n.global.locale.value).toBe("en-US");
        expect(formatDate(ISO)).toBe("11/2/2026");
    });
});
