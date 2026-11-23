/**
 * task-927：共享校验器的语义 + 规则表与 i18n helper text 同源。
 *
 * 用户裁定（2026-11-23）：所有表单输入都要在输入时校验，不能等提交才报错；
 * 能用程序约束的规范不要留在文案/注释里。所以这里不只测「函数返回值」，还钉住
 * i18n 里的 helper text 与 `FORM_FIELD_RULES` 逐字一致、服务端错误码折回同一规则。
 */
import { describe, expect, it } from "vitest";
import { i18n } from "../../i18n";
import {
    FORM_FIELD_RULES,
    FORM_RULE_HINTS,
    serverProblemToFieldIssue,
    validateField,
    validateForm,
} from "../formValidation";

function messageAt(locale: "zh-CN" | "en-US", key: string): unknown {
    const tree = i18n.global.getLocaleMessage(locale) as Record<string, unknown>;
    return key.split(".").reduce<unknown>((node, part) => {
        if (typeof node !== "object" || node === null) return undefined;
        return (node as Record<string, unknown>)[part];
    }, tree);
}

function allMessageKeys(): string[] {
    return Object.values(FORM_FIELD_RULES).flatMap((rule) =>
        Object.values(rule.messages).filter((key): key is string => typeof key === "string"),
    );
}

describe("validateField · immediate validation", () => {
    it.each([["deepseek"], ["my-connection-2"], ["a"], ["9-prod"]])(
        "accepts a lowercase slug: %s",
        (value) => {
            const result = validateField("provider.connectionKey", value);
            expect(result.valid).toBe(true);
            expect(result.submitDisabled).toBe(false);
            expect(result.issues).toEqual([]);
        },
    );

    it.each([
        ["DEEPSEEK", "pattern"],
        ["foo bar", "pattern"],
        ["-foo", "pattern"],
        ["foo-", "pattern"],
        ["foo--bar", "pattern"],
        ["a".repeat(65), "max-length"],
        ["", "required"],
    ])("rejects %j with %s on input (not blur)", (value, code) => {
        const result = validateField("provider.connectionKey", value);
        expect(result.valid).toBe(false);
        expect(result.submitDisabled).toBe(true);
        expect(result.showError).toBe(value.length > 0);
        expect(result.primaryIssue).toMatchObject({ code });
    });

    it("empty required field disables submit without pre-emptive error copy", () => {
        const result = validateField("provider.connectionKey", "", { touched: false });
        expect(result.submitDisabled).toBe(true);
        expect(result.showError).toBe(false);
        expect(validateField("provider.connectionKey", "", { touched: true }).showError).toBe(true);
    });
});

describe("validateField · uniqueness precheck (R24)", () => {
    it("flags a key already present in the loaded collection", () => {
        const result = validateField("provider.connectionKey", "deepseek", {
            existingValues: ["deepseek", "other"],
        });
        expect(result.valid).toBe(false);
        expect(result.submitDisabled).toBe(true);
        expect(result.primaryIssue).toMatchObject({
            code: "duplicate",
            messageKey: "settings.providerHub.toastLabelConflict",
        });
    });

    it("provider labels compare trimmed and case-insensitively, matching the server", () => {
        const duplicate = validateField("provider.label", "  DeepSeek  ", {
            existingValues: ["deepseek"],
        });
        expect(duplicate.primaryIssue).toMatchObject({ code: "duplicate" });

        const distinct = validateField("provider.label", "DeepSeek Pro", {
            existingValues: ["deepseek"],
        });
        expect(distinct.valid).toBe(true);
    });
});

describe("validateField · provider label server parity", () => {
    it("trims before counting code points (server trims too)", () => {
        const result = validateField("provider.label", `  ${"a".repeat(40)}  `);
        expect(result.valid).toBe(true);
        expect(result.normalizedValue).toBe("a".repeat(40));
    });

    it.each([
        ["", "required"],
        ["   ", "required"],
        ["a".repeat(41), "max-length"],
        ["line\nbreak", "control-character"],
    ])("rejects %j with %s", (value, code) => {
        const result = validateField("provider.label", value);
        expect(result.primaryIssue).toMatchObject({ code });
        expect(result.submitDisabled).toBe(true);
    });
});

describe("validateField · principal name reuses the single implementation", () => {
    it.each(["Zoe", "zoe2026", "张三", "Agent2"])("accepts %s", (value) => {
        expect(validateField("principal.name", value).valid).toBe(true);
    });

    it.each([
        [" abc ", "whitespace"],
        ["1Zoe", "pattern"],
        ["zoe wang", "pattern"],
        ["", "required"],
    ])("maps %j to %s", (value, code) => {
        expect(validateField("principal.name", value).primaryIssue).toMatchObject({ code });
    });

    it("username adds the 32-character limit from the same rule", () => {
        expect(validateField("username", "a".repeat(32)).valid).toBe(true);
        expect(validateField("username", "a".repeat(33)).primaryIssue).toMatchObject({
            code: "max-length",
            messageKey: "validation.usernameTooLong",
        });
    });
});

describe("validateForm · submit disable", () => {
    it("disables submit when any field is invalid", () => {
        const validation = validateForm([
            { name: "key", ruleId: "provider.connectionKey", value: "DEEPSEEK" },
            { name: "label", ruleId: "provider.label", value: "My connection" },
        ]);
        expect(validation.fields.key.submitDisabled).toBe(true);
        expect(validation.fields.label.submitDisabled).toBe(false);
        expect(validation.submitDisabled).toBe(true);
    });

    it("allows submit only when every field is valid", () => {
        const validation = validateForm([
            { name: "key", ruleId: "provider.connectionKey", value: "deepseek" },
            { name: "label", ruleId: "provider.label", value: "DeepSeek" },
        ]);
        expect(validation.submitDisabled).toBe(false);
    });
});

describe("serverProblemToFieldIssue · same rule, same conclusion", () => {
    it("maps key invalid/conflict to the provider.connectionKey rule", () => {
        expect(
            serverProblemToFieldIssue({ code: "PROVIDER_CONNECTION_KEY_INVALID" }),
        ).toMatchObject({
            ruleId: "provider.connectionKey",
            kind: "invalid",
            messageKey: "settings.providerHub.toastKeyInvalid",
        });
        expect(
            serverProblemToFieldIssue({ code: "PROVIDER_CONNECTION_KEY_CONFLICT" }),
        ).toMatchObject({
            ruleId: "provider.connectionKey",
            kind: "duplicate",
            messageKey: "settings.providerHub.toastLabelConflict",
        });
    });

    it("maps label invalid/conflict to the provider.label rule", () => {
        expect(
            serverProblemToFieldIssue({
                code: "PROVIDER_CONNECTION_INVALID",
                field: "label",
            }),
        ).toMatchObject({
            ruleId: "provider.label",
            kind: "invalid",
            messageKey: "settings.providerHub.toastLabelInvalid",
        });
        expect(
            serverProblemToFieldIssue({ code: "PROVIDER_CONNECTION_LABEL_CONFLICT" }),
        ).toMatchObject({
            ruleId: "provider.label",
            kind: "duplicate",
            messageKey: "settings.providerHub.toastLabelConflict",
        });
    });

    it("local invalid and server invalid reach the same field with the same rejection", () => {
        const local = validateField("provider.connectionKey", "DEEPSEEK");
        const server = serverProblemToFieldIssue({ code: "PROVIDER_CONNECTION_KEY_INVALID" });
        expect(local.submitDisabled).toBe(true);
        expect(server?.ruleId).toBe(local.ruleId);
        expect(server?.messageKey).toBe(local.primaryIssue?.messageKey);
    });

    it("returns null for unregistered codes so callers keep the generic error face", () => {
        expect(serverProblemToFieldIssue({ code: "SOMETHING_ELSE" })).toBeNull();
        expect(serverProblemToFieldIssue({})).toBeNull();
    });
});

describe("rule table ↔ i18n helper text", () => {
    it("every hint declared by the rule table matches i18n word-for-word (zh + en)", () => {
        expect(FORM_RULE_HINTS.length).toBeGreaterThan(0);
        for (const { hintKey, hint } of FORM_RULE_HINTS) {
            expect(messageAt("zh-CN", hintKey)).toBe(hint.zh);
            expect(messageAt("en-US", hintKey)).toBe(hint.en);
        }
    });

    it("every message key declared by a rule resolves in both locales", () => {
        for (const key of allMessageKeys()) {
            expect(typeof messageAt("zh-CN", key)).toBe("string");
            expect(typeof messageAt("en-US", key)).toBe("string");
        }
    });

    it("rule ids are stable and unique", () => {
        const ids = Object.values(FORM_FIELD_RULES).map((rule) => rule.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const rule of Object.values(FORM_FIELD_RULES)) {
            expect(rule.id).toBe(rule.id.trim());
        }
    });
});
