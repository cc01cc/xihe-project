/**
 * PLAN-0612 T6.4：localMode 相关文案的一致性（`/local-login` 409 与 onboarding 说明）。
 *
 * 这条锁的是"文案纪律"而不是排版：
 * 1. zh / en 两侧都必须有这四条文案（缺一条会在另一种语言下露 key）；
 * 2. 409 文案必须**指向可用出路**（用账号密码登录），不能只说失败；
 * 3. 不把 CP 的技术码/英文 detail 抄进用户文案（BL-150 的原始症状就是直显 CP 英文）；
 * 4. 不引入新术语：本地模式在两条文案里叫"本机/单用户"（en: local / single-user），
 *    不得另造"离线模式 / 免密模式 / offline mode"这类同义新词；
 * 5. 不回到 0614 之前的旧语义（"默认工作区 / 注册即有工作区"），首用是空白起步。
 */
import { describe, expect, it } from "vitest";
import { i18n } from "../../i18n";

type Bundle = Record<string, unknown>;

function messagesFor(locale: "zh-CN" | "en-US"): Bundle {
    return i18n.global.getLocaleMessage(locale) as Bundle;
}

function pick(bundle: Bundle, path: string): string {
    const value = path
        .split(".")
        .reduce<unknown>((node, key) => (node as Bundle | undefined)?.[key], bundle);
    if (typeof value !== "string") throw new Error(`missing i18n string: ${path}`);
    return value;
}

const COPIES = [
    "login.localModeHint",
    "login.localSingleUserRequired",
    "onboarding.hint",
    "onboarding.localHint",
] as const;

const FORBIDDEN_IN_COPY = [
    "LOCAL_SINGLE_USER_REQUIRED", // CP 技术码
    "local mode requires", // CP 英文 detail
    "single_user", // snake_case 泄漏
    "默认工作区", // 0614 之前的旧语义
    "default workspace",
] as const;

describe("localMode copy consistency (PLAN-0612 T6.4)", () => {
    it("zh/en 两侧都定义了这四条文案", () => {
        for (const locale of ["zh-CN", "en-US"] as const) {
            const bundle = messagesFor(locale);
            for (const path of COPIES) {
                expect(pick(bundle, path).trim().length).toBeGreaterThan(0);
            }
        }
    });

    it("409 文案给出可用出路（改用账号密码），不是只说失败", () => {
        expect(pick(messagesFor("zh-CN"), "login.localSingleUserRequired")).toMatch(/密码/);
        expect(pick(messagesFor("en-US"), "login.localSingleUserRequired")).toMatch(/password/i);
    });

    it("文案里不出现 CP 技术码、英文 detail 或旧的首用语义", () => {
        for (const locale of ["zh-CN", "en-US"] as const) {
            const bundle = messagesFor(locale);
            for (const path of COPIES) {
                const text = pick(bundle, path);
                for (const forbidden of FORBIDDEN_IN_COPY) {
                    expect(text, `${locale} ${path} must not contain ${forbidden}`).not.toContain(
                        forbidden,
                    );
                }
            }
        }
    });

    it("本地模式用统一术语（本机/单用户 vs local/single-user），不自造同义词", () => {
        const zh = messagesFor("zh-CN");
        const en = messagesFor("en-US");
        expect(pick(zh, "login.localModeHint")).toMatch(/本机|单用户/);
        expect(pick(zh, "login.localSingleUserRequired")).toMatch(/本机|单用户/);
        expect(pick(zh, "onboarding.hint")).toMatch(/本机/);
        expect(pick(zh, "onboarding.localHint")).toMatch(/本机|本地/);

        expect(pick(en, "login.localModeHint")).toMatch(/local/i);
        expect(pick(en, "login.localSingleUserRequired")).toMatch(/local|single-user/i);
        expect(pick(en, "onboarding.hint")).toMatch(/local/i);
        expect(pick(en, "onboarding.localHint")).toMatch(/local/i);

        // 没有另造"离线模式 / 免密模式"这类同义新词。
        for (const text of [pick(zh, "login.localModeHint"), pick(zh, "onboarding.hint")]) {
            expect(text).not.toMatch(/离线模式|免密模式/);
        }
        for (const text of [pick(en, "login.localModeHint"), pick(en, "onboarding.hint")]) {
            expect(text).not.toMatch(/offline mode|passwordless mode/i);
        }
    });
});
