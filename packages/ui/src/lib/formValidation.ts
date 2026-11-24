/**
 * task-927：表单字段的**共享校验器**与规则表（R9 / R13 / R24）。
 *
 * 为什么要有这一层：同一约束过去散落在三处 —— 输入框的 `pattern` / `maxlength`、
 * helper text 里的自然语言、提交函数里的 if。三者任何一处漂移，用户就会看到
 * 「提示写着规则、输入非法却没有任何反馈」。这里把规则收成**一份可执行表**：
 * - `FORM_FIELD_RULES` 是字段规则的单一来源（格式、长度、必填、重名预判、服务端错误码）；
 * - `validateField` / `validateForm` 在**每次输入**时求值，返回错误文案 key 与提交禁用态；
 * - `FORM_RULE_HINTS` 给 helper text 提供同源文案，`formValidation.spec.ts` 钉住
 *   i18n 里的 helper text 与规则表逐字一致（不一致即红）。
 *
 * R24：本地只做**能做的预判**（格式/长度/已加载集合内重名），服务端仍是最终权威。
 * `serverProblemToFieldIssue` 把服务端错误码折回同一规则，保证两侧结论指向同一个字段与
 * 同一条文案；本地预判永远不会替代服务端的唯一性检查。
 */

import { principalNameError, usernameError } from "./principalName";

export type FormFieldRuleId =
    | "provider.connectionKey"
    | "provider.label"
    | "provider.modelDiscoveryUrl"
    | "principal.name"
    | "username";

export type FieldIssueCode =
    | "required"
    | "whitespace"
    | "invalid"
    | "max-length"
    | "pattern"
    | "control-character"
    | "duplicate";

export interface FieldRuleHint {
    zh: string;
    en: string;
}

export interface FieldRuleSpec {
    id: FormFieldRuleId;
    required: boolean;
    /** 是否先 trim 再判定/提交（服务端对 label 会 trim，对 connection key 不会）。 */
    trim: boolean;
    maxLength?: number;
    /** 长度按 Unicode 码点计算（连接名称上限是码点，不是 UTF-16 长度）。 */
    maxLengthUnit?: "code-point" | "utf16";
    pattern?: RegExp;
    forbidControlCharacters?: boolean;
    /** 交给既有单一实现（`principalName.ts`）的规则，不再复制一份正则。 */
    custom?: (value: string) => FieldIssueCode | null;
    unique?: {
        messageKey: string;
        normalize?: (value: string) => string;
    };
    messages: Partial<Record<FieldIssueCode, string>>;
    /** 服务端错误码 → 同一规则/文案（R24：两侧结论必须指向同一条规则）。 */
    server?: {
        invalid?: string;
        duplicate?: string;
    };
    /** 有 helper text 的字段：key + 逐字文案（测试钉住 i18n 与这里一致）。 */
    hintKey?: string;
    hint?: FieldRuleHint;
}

// eslint-disable-next-line no-control-regex -- 这里就是要拦 C0/C1 与 Unicode 行/段分隔符
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f\u2028\u2029]/;

/**
 * 单一规则表。新增字段时先在这里加一行，再把 helper text 与 i18n 对齐。
 *
 * 约束来源（不是猜测）：
 * - `provider.connectionKey`：CP `ProviderConnectionService:43-44,671-677`
 *   (`[a-z0-9]+(?:-[a-z0-9]+)*`, 1–64)；重复键在 `:227-230` 的 `PROVIDER_CONNECTION_KEY_CONFLICT`。
 * - `provider.label`：CP `ProviderConnectionService:47-48,862-875`
 *   （trim 后 1–40 码点、禁控制字符）；重复名称 `:888-899` 忽略大小写。
 * - `principal.name` / `username`：`principalName.ts`（与 CP `NameFormat` 同源）。
 */
export const FORM_FIELD_RULES: Record<FormFieldRuleId, FieldRuleSpec> = {
    "provider.connectionKey": {
        id: "provider.connectionKey",
        required: true,
        trim: false,
        maxLength: 64,
        maxLengthUnit: "utf16",
        pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        unique: { messageKey: "settings.providerHub.toastLabelConflict" },
        messages: {
            required: "settings.providerHub.toastKeyInvalid",
            "max-length": "settings.providerHub.toastKeyInvalid",
            pattern: "settings.providerHub.toastKeyInvalid",
            invalid: "settings.providerHub.toastKeyInvalid",
            duplicate: "settings.providerHub.toastLabelConflict",
        },
        server: {
            invalid: "PROVIDER_CONNECTION_KEY_INVALID",
            duplicate: "PROVIDER_CONNECTION_KEY_CONFLICT",
        },
        hintKey: "settings.providerHub.keyHint",
        hint: {
            zh: "小写字母、数字和连字符；同一 Provider/作用域内不可重复。保存后不可修改。",
            en: "Lowercase letters, digits, and hyphens; unique per Provider/scope. Cannot be changed after saving.",
        },
    },
    "provider.label": {
        id: "provider.label",
        required: true,
        trim: true,
        maxLength: 40,
        maxLengthUnit: "code-point",
        forbidControlCharacters: true,
        unique: {
            messageKey: "settings.providerHub.toastLabelConflict",
            normalize: (value) => value.trim().toLowerCase(),
        },
        messages: {
            required: "settings.providerHub.toastLabelRequired",
            invalid: "settings.providerHub.toastLabelInvalid",
            "max-length": "settings.providerHub.toastLabelTooLong",
            "control-character": "settings.providerHub.toastLabelControl",
            duplicate: "settings.providerHub.toastLabelConflict",
        },
        server: {
            invalid: "PROVIDER_CONNECTION_INVALID",
            duplicate: "PROVIDER_CONNECTION_LABEL_CONFLICT",
        },
    },
    /**
     * task-953（R17）：连接级模型列表地址（可选）。只接受 http(s)；空值合法
     * （调用方回落到 `{baseUrl}/models`）。CP 尚未提供该列，提交面由 ProviderHub 显式拦截。
     */
    "provider.modelDiscoveryUrl": {
        id: "provider.modelDiscoveryUrl",
        required: false,
        trim: true,
        custom: (value) => {
            if (!value) return null;
            try {
                const url = new URL(value);
                return url.protocol === "http:" || url.protocol === "https:" ? null : "invalid";
            } catch {
                return "invalid";
            }
        },
        messages: {
            invalid: "settings.providerHub.modelDiscoveryUrlInvalid",
        },
    },
    "principal.name": {
        id: "principal.name",
        required: true,
        trim: false,
        custom: principalNameError,
        messages: {
            required: "validation.principalNameRequired",
            whitespace: "validation.principalNameWhitespace",
            pattern: "validation.principalNamePattern",
        },
        hintKey: "validation.nameAllowed",
        hint: {
            zh: "允许：英文字母 / 中文汉字 / 数字，且不能以数字开头",
            en: "Allowed: letters / Chinese characters / digits, not starting with a digit",
        },
    },
    username: {
        id: "username",
        required: true,
        trim: false,
        custom: (value) => {
            const error = usernameError(value);
            return error === "length" ? "max-length" : error;
        },
        messages: {
            required: "validation.principalNameRequired",
            whitespace: "validation.principalNameWhitespace",
            "max-length": "validation.usernameTooLong",
            pattern: "validation.principalNamePattern",
        },
        hintKey: "register.usernameRule",
        hint: {
            zh: "英文字母 / 中文汉字 / 数字，且不能以数字开头",
            en: "letters / Chinese characters / digits, not starting with a digit",
        },
    },
};

/** 扫描器与业务页共用的标记：受控输入接入共享校验器时带上规则 id。 */
export const FORM_FIELD_ATTRIBUTE = "data-form-field";

export interface FieldValidationContext {
    /** 已加载集合内的同名候选（调用方负责按 Provider/作用域过滤）。 */
    existingValues?: readonly string[];
    /**
     * 是否已经与用户交互过。非法值无论 touched 与否都会禁用提交；未 touched 的空必填
     * 字段不提前弹红字（但仍禁用提交）。
     */
    touched?: boolean;
}

export interface FieldIssue {
    code: FieldIssueCode;
    messageKey: string;
}

export interface FieldValidation {
    ruleId: FormFieldRuleId;
    valid: boolean;
    issues: FieldIssue[];
    primaryIssue: FieldIssue | null;
    /** 非空且合法时可直接提交的规范化值（label 会 trim；其余原样返回）。 */
    normalizedValue: string;
    /** 非法值 ⇒ true，调用方据此禁用提交。 */
    submitDisabled: boolean;
    /** 是否应显示字段错误态（非法 + 已输入或已 touched）。 */
    showError: boolean;
}

function codePointLength(value: string): number {
    return Array.from(value).length;
}

function issueFor(rule: FieldRuleSpec, code: FieldIssueCode): FieldIssue {
    const messageKey = rule.messages[code];
    if (!messageKey) {
        throw new Error(`Form rule ${rule.id} has no message for ${code}`);
    }
    return { code, messageKey };
}

function measureLength(rule: FieldRuleSpec, value: string): number {
    return rule.maxLengthUnit === "code-point" ? codePointLength(value) : value.length;
}

/**
 * 即时求值（没有 blur 门槛）：非法值立即返回错误态与禁用提交。
 *
 * 空必填值也会禁用提交；是否渲染红字由 `showError` 决定（未 touched 的空字段不提前弹）。
 */
export function validateField(
    ruleId: FormFieldRuleId,
    value: unknown,
    context: FieldValidationContext = {},
): FieldValidation {
    const rule = FORM_FIELD_RULES[ruleId];
    const raw = typeof value === "string" ? value : "";
    const candidate = rule.trim ? raw.trim() : raw;
    const issues: FieldIssue[] = [];

    if (rule.custom) {
        const customCode = rule.custom(candidate);
        if (customCode) issues.push(issueFor(rule, customCode));
    } else {
        if (!candidate) {
            if (rule.required) issues.push(issueFor(rule, "required"));
        } else {
            if (rule.forbidControlCharacters && CONTROL_CHARACTERS.test(candidate)) {
                issues.push(issueFor(rule, "control-character"));
            } else if (
                rule.maxLength !== undefined &&
                measureLength(rule, candidate) > rule.maxLength
            ) {
                issues.push(issueFor(rule, "max-length"));
            } else if (rule.pattern && !rule.pattern.test(candidate)) {
                issues.push(issueFor(rule, "pattern"));
            }
        }
    }

    if (rule.unique && candidate) {
        const normalize = rule.unique.normalize ?? ((item: string) => item);
        const normalized = normalize(candidate);
        const existing = context.existingValues ?? [];
        if (existing.some((item) => normalize(item) === normalized)) {
            issues.push(issueFor(rule, "duplicate"));
        }
    }

    const primaryIssue = issues[0] ?? null;
    const showError = primaryIssue !== null && (context.touched === true || raw.length > 0);

    return {
        ruleId,
        valid: issues.length === 0,
        issues,
        primaryIssue,
        normalizedValue: candidate,
        submitDisabled: issues.length > 0,
        showError,
    };
}

export interface FormFieldInput {
    /** 表单内的稳定字段名（用于把结果回传给调用方）。 */
    name: string;
    ruleId: FormFieldRuleId;
    value: unknown;
    existingValues?: readonly string[];
    touched?: boolean;
}

export interface FormValidation {
    fields: Record<string, FieldValidation>;
    submitDisabled: boolean;
}

/** 一次性校验整张表单；任一字段非法 ⇒ 禁用提交。 */
export function validateForm(fields: readonly FormFieldInput[]): FormValidation {
    const result: Record<string, FieldValidation> = {};
    let submitDisabled = false;
    for (const field of fields) {
        const validation = validateField(field.ruleId, field.value, {
            existingValues: field.existingValues,
            touched: field.touched,
        });
        result[field.name] = validation;
        submitDisabled ||= validation.submitDisabled;
    }
    return { fields: result, submitDisabled };
}

export interface ServerFieldProblem {
    code?: string | null;
    field?: string | null;
}

export interface ServerFieldIssue {
    ruleId: FormFieldRuleId;
    kind: "invalid" | "duplicate";
    messageKey: string;
    serverCode: string;
}

/**
 * 把服务端错误码折回同一规则表（R24 的另一半）。
 *
 * 只映射规则表声明过的 code；未登记的错误码返回 `null`，调用方继续走通用错误面。
 * 返回结果与本地预判共享 `ruleId` 与 `messageKey`，因此两侧的「哪个字段 / 说什么」一致。
 */
export function serverProblemToFieldIssue(problem: ServerFieldProblem): ServerFieldIssue | null {
    const code = (problem.code ?? "").trim();
    if (!code) return null;
    for (const rule of Object.values(FORM_FIELD_RULES)) {
        if (rule.server?.invalid === code) {
            return {
                ruleId: rule.id,
                kind: "invalid",
                messageKey: rule.messages.invalid ?? rule.messages.pattern ?? "",
                serverCode: code,
            };
        }
        if (rule.server?.duplicate === code) {
            return {
                ruleId: rule.id,
                kind: "duplicate",
                messageKey: rule.unique?.messageKey ?? "",
                serverCode: code,
            };
        }
    }
    return null;
}

/** 规则表声明的 helper text（i18n 的 key + 逐字文案；测试钉住两侧一致）。 */
export const FORM_RULE_HINTS = (Object.values(FORM_FIELD_RULES) as FieldRuleSpec[])
    .filter((rule): rule is typeof rule & { hintKey: string; hint: FieldRuleHint } =>
        Boolean(rule.hintKey && rule.hint),
    )
    .map((rule) => ({ ruleId: rule.id, hintKey: rule.hintKey, hint: rule.hint }));
