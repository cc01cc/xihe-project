import {
    ApiError,
    type SkillImportItemPayload,
    type SkillImportRequestPayload,
    type SkillImportResultPayload,
} from "../../composables/api";

/**
 * task-167 · 技能导入的**本地预检**与**错误码映射**（`POST /api/v1/skills/import`）。
 *
 * <p>两条硬口径：</p>
 * <ol>
 *   <li><b>不直显 CP 英文 `detail`</b>（本仓 AGENTS.md / D-800 口径）：所有对外文案按
 *       {@link SkillImportErrorView.code} 取 i18n key；`detail` 只进 logger，不进 UI。</li>
 *   <li><b>预检与 CP 同判据**不是**"客户端说了算"</b>：本地只拦「发出去必然被逐条拒」的形状，
 *       服务端仍是权威（同一条既能被本地拦，也能被 CP 的 `rejected[].code` 拒）。所以本地预检
 *       直接产出 **CP 的稳定枚举码**，与 `rejected[].code` 共用同一张 i18n 表 —— 用户看到的措辞
 *       不因"哪一侧先发现"而变。</li>
 * </ol>
 *
 * <p>判据来源：`docs/api/openapi.yaml` 的 `SkillImportRequest` / `SkillImportItem` /
 * `SkillImportRejection`；CP 实现 `SkillImportValidator`（批大小上限 64、正文/描述上限、
 * `trusted` 仅实例管理员）。</p>
 */

/** openapi `SkillImportRequest.skills.maxItems`。 */
export const SKILL_IMPORT_MAX_BATCH = 64;
/** openapi `SkillImportItem.name.maxLength` + `^[a-z0-9][a-z0-9._-]{0,63}$`。 */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
export const SKILL_BODY_MAX_LENGTH = 262144;

/**
 * 本地预检产出的码 = **CP 稳定枚举** ∪ 三个「本地才有」的码。
 * 后三个不是编造的错误面：`SKILL_IMPORT_JSON_INVALID` / `..._SHAPE_INVALID` 是"根本发不出去"，
 * `SKILL_IMPORT_BATCH_TOO_LARGE` 与 CP 的 `SKILL_IMPORT_TOO_LARGE` **同义**（本地提前拦，省一次 400）。
 */
export const LOCAL_IMPORT_CODES = {
    jsonInvalid: "SKILL_IMPORT_JSON_INVALID",
    shapeInvalid: "SKILL_IMPORT_SHAPE_INVALID",
    batchTooLarge: "SKILL_IMPORT_BATCH_TOO_LARGE",
    /**
     * `T2b.3`：个人层**整批 400** 的本地预检码。CP 的 `refusePersonalTrusted` 连 `trusted=false`
     * 都拒（P-189-1）⇒ 不能等 CP 拒，否则用户看到的是一个"请求级失败"却不知道是哪条带了这个键。
     */
    trustedNotAllowed: "SKILL_IMPORT_TRUSTED_NOT_ALLOWED",
} as const;

/** 导入的目标层：决定 `definitionScope.type`，也决定 `trusted` 是否被本地拦下。 */
export type SkillImportTargetScope = "instance" | "user";

/** `rejected[].code` 的十个稳定取值（openapi `SkillImportRejection.code`）。 */
export const SKILL_REJECTION_CODES = [
    "SKILL_NAME_INVALID",
    "SKILL_DESCRIPTION_REQUIRED",
    "SKILL_DESCRIPTION_TOO_LONG",
    "SKILL_DESCRIPTION_EDGE_WHITESPACE",
    "SKILL_DESCRIPTION_CONTROL_CHARACTER",
    "SKILL_BODY_EMPTY",
    "SKILL_BODY_TOO_LARGE",
    "SKILL_ATTACHMENT_INVALID",
    "SKILL_SOURCE_PATH_INVALID",
    "SKILL_TRUSTED_FORBIDDEN",
] as const;

/** i18n `settings.skills.import.rejected.*` 下必须齐全的键集合（单测守住，防漏译）。 */
export const SKILL_REJECTION_I18N_KEYS: Record<string, string> = {
    SKILL_NAME_INVALID: "nameInvalid",
    SKILL_DESCRIPTION_REQUIRED: "descriptionRequired",
    SKILL_DESCRIPTION_TOO_LONG: "descriptionTooLong",
    SKILL_DESCRIPTION_EDGE_WHITESPACE: "descriptionEdgeWhitespace",
    SKILL_DESCRIPTION_CONTROL_CHARACTER: "descriptionControlCharacter",
    SKILL_BODY_EMPTY: "bodyEmpty",
    SKILL_BODY_TOO_LARGE: "bodyTooLarge",
    SKILL_ATTACHMENT_INVALID: "attachmentInvalid",
    SKILL_SOURCE_PATH_INVALID: "sourcePathInvalid",
    SKILL_TRUSTED_FORBIDDEN: "trustedForbidden",
    [LOCAL_IMPORT_CODES.jsonInvalid]: "jsonInvalid",
    [LOCAL_IMPORT_CODES.shapeInvalid]: "shapeInvalid",
    [LOCAL_IMPORT_CODES.batchTooLarge]: "batchTooLarge",
    [LOCAL_IMPORT_CODES.trustedNotAllowed]: "trustedNotAllowed",
};

export type SkillImportDraftResult =
    | { ok: true; payload: SkillImportRequestPayload }
    | { ok: false; code: string; hint?: string };

/**
 * 控制字符判据用 Unicode 类别 \p{Cc}（而不是把 0x00-0x1F 的区间写进字符集）：后者会在源码里留
 * 真控制字符区间，被 oxlint 的 no-control-regex 判红。\p{Cc} 覆盖 C0（含换行/制表）与 DEL，
 * 与 openapi「no line breaks or control chars」同义。
 */
const CONTROL_CHARACTER = /\p{Cc}/u;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

/** 单条定义预检：形状 + CP 同判据（返回第一个命中的 CP 码，附带 `sourcePath` 便于定位）。 */
function checkItem(
    raw: Record<string, unknown>,
    index: number,
    targetScope: SkillImportTargetScope = "instance",
): { code: string; hint?: string } | SkillImportItemPayload {
    const label = `#${index + 1}`;
    const name = raw.name,
        description = raw.description,
        body = raw.body,
        sourcePath = raw.sourcePath;
    if (typeof name !== "string" || !SKILL_NAME_PATTERN.test(name)) {
        return { code: "SKILL_NAME_INVALID", hint: label };
    }
    if (typeof description !== "string" || description.trim() === "") {
        return { code: "SKILL_DESCRIPTION_REQUIRED", hint: label };
    }
    if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
        return { code: "SKILL_DESCRIPTION_TOO_LONG", hint: label };
    }
    if (description !== description.trim()) {
        return { code: "SKILL_DESCRIPTION_EDGE_WHITESPACE", hint: label };
    }
    if (CONTROL_CHARACTER.test(description)) {
        return { code: "SKILL_DESCRIPTION_CONTROL_CHARACTER", hint: label };
    }
    if (typeof body !== "string" || body.trim() === "") {
        return { code: "SKILL_BODY_EMPTY", hint: label };
    }
    if (body.length > SKILL_BODY_MAX_LENGTH) {
        return { code: "SKILL_BODY_TOO_LARGE", hint: label };
    }
    if (typeof sourcePath !== "string" || sourcePath.trim() === "") {
        return { code: "SKILL_SOURCE_PATH_INVALID", hint: label };
    }
    // 与 CP 同口径的路径约束：相对路径、无 `..`、无盘符/绝对前缀。
    if (
        sourcePath.startsWith("/") ||
        sourcePath.includes("..") ||
        /^[a-zA-Z]:/.test(sourcePath) ||
        sourcePath.startsWith("\\")
    ) {
        return { code: "SKILL_SOURCE_PATH_INVALID", hint: label };
    }
    const attachments = raw.attachments;
    if (attachments !== undefined) {
        if (!Array.isArray(attachments)) {
            return { code: "SKILL_ATTACHMENT_INVALID", hint: label };
        }
        for (const entry of attachments) {
            const row = asRecord(entry);
            if (
                !row ||
                typeof row.path !== "string" ||
                typeof row.sizeBytes !== "number" ||
                typeof row.sha256 !== "string" ||
                !/^[0-9a-f]{64}$/.test(row.sha256)
            ) {
                return { code: "SKILL_ATTACHMENT_INVALID", hint: label };
            }
        }
    }
    if (targetScope === "user" && raw.trusted !== undefined) {
        // P-189-1：个人层请求体里**不允许出现 trusted 这个键**（连 false 也 400 整批）
        // ⇒ 本地先拦，并把措辞说成"删掉这个键"，而不是让用户去猜哪一条坏。
        return { code: LOCAL_IMPORT_CODES.trustedNotAllowed, hint: label };
    }
    if (raw.trusted !== undefined && typeof raw.trusted !== "boolean") {
        return { code: "SKILL_IMPORT_SHAPE_INVALID", hint: label };
    }
    const item: SkillImportItemPayload = {
        name,
        description,
        body,
        sourcePath,
    };
    if (Array.isArray(attachments)) {
        item.attachments = attachments as SkillImportItemPayload["attachments"];
    }
    // 个人层**永不**带 trusted（CP 侧恒存 false，且带了就整批 400）。
    if (targetScope !== "user" && typeof raw.trusted === "boolean") item.trusted = raw.trusted;
    return item;
}

/**
 * 把用户给的 JSON 文本变成可提交的批：**先整体解析，再整批校验**。
 *
 * <p>为什么整批而不是逐条放过：CP 对「批大小 > 64」是**整批 400**，不是逐条拒绝；本地若先放行
 * 66 条再让 CP 拒，用户会以为"填的都坏了"。所以超限在这里就断，措辞与 CP 的 `SKILL_IMPORT_TOO_LARGE` 对齐。</p>
 */
export function parseSkillImportDraft(
    text: string,
    targetScope: SkillImportTargetScope = "instance",
): SkillImportDraftResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { ok: false, code: LOCAL_IMPORT_CODES.jsonInvalid };
    }
    const root = asRecord(parsed);
    if (!root) return { ok: false, code: LOCAL_IMPORT_CODES.shapeInvalid };
    const scope = asRecord(root.definitionScope);
    if (!scope || scope.type !== targetScope) {
        // 作用域必须与**当前页面所在层**一致：实例面板只导 instance，个人面板只导 user。
        // workspace 作用域要 workspaceId，属工作区设置面的活，两个面板都不接受。
        return { ok: false, code: LOCAL_IMPORT_CODES.shapeInvalid, hint: "definitionScope" };
    }
    const skills = root.skills;
    if (!Array.isArray(skills) || skills.length === 0) {
        return { ok: false, code: LOCAL_IMPORT_CODES.shapeInvalid, hint: "skills" };
    }
    if (skills.length > SKILL_IMPORT_MAX_BATCH) {
        return {
            ok: false,
            code: LOCAL_IMPORT_CODES.batchTooLarge,
            hint: String(skills.length),
        };
    }
    const items: SkillImportItemPayload[] = [];
    for (let index = 0; index < skills.length; index += 1) {
        const row = asRecord(skills[index]);
        if (!row)
            return { ok: false, code: LOCAL_IMPORT_CODES.shapeInvalid, hint: `#${index + 1}` };
        const checked = checkItem(row, index, targetScope);
        if ("code" in checked) return { ok: false, code: checked.code, hint: checked.hint };
        items.push(checked);
    }
    return {
        ok: true,
        payload: { definitionScope: { type: targetScope }, skills: items },
    };
}

/** 请求级失败的本地化视图：**只带 i18n key 与可替换参数，不带 CP 的英文 detail**。 */
export interface SkillImportErrorView {
    /** 机器码：CP `problem.code` 或本地码；`UNKNOWN` 表示连码都没拿到。 */
    code: string;
    /** i18n 前缀：`settings.skills.import.error.<slug>`。 */
    slug: string;
    /** 供文案插值的参数（如批大小、HTTP 状态）。 */
    params: Record<string, string>;
}

/**
 * 请求级失败 → 本地化视图。三条例行的码是**真实存在**的：
 * - `SKILL_IMPORT_FORBIDDEN`（403，`SkillImportService:91`）：调用者不持有实例库写权（原子 `MANAGE_SKILL_LIBRARY`）。
 * - `SKILL_IMPORT_TOO_LARGE`（400，`SkillImportValidator:105`）：批大小超 64，整批拒。
 * - `INVALID_REQUEST`（400，`SkillController:56/60`）：缺 `definitionScope`/`skills`，或 workspace 作用域缺 workspaceId。
 *
 * <p>⚠️ 契约核对结论（见证据 §2）：**该端点没有 409 与 413**。同名重导是**幂等更新**
 * （`action=unchanged/updated`），不是冲突；正文超限是**逐条** `SKILL_BODY_TOO_LARGE` 拒绝，
 * 不是 HTTP 413。所以这里不给"重名冲突""包体过大"两套假状态，只在兜底文案里点名这两件事。</p>
 */
export function mapSkillImportError(error: unknown): SkillImportErrorView {
    const code =
        error instanceof ApiError
            ? error.problem.code
            : error instanceof Error && "code" in error && typeof error.code === "string"
              ? error.code
              : "UNKNOWN";
    const status =
        error instanceof ApiError && typeof error.problem.status === "number"
            ? String(error.problem.status)
            : "";
    switch (code) {
        case "SKILL_IMPORT_FORBIDDEN":
            return { code, slug: "forbidden", params: {} };
        case "SKILL_IMPORT_TOO_LARGE":
            return { code, slug: "batchTooLarge", params: {} };
        case "INVALID_REQUEST":
            return { code, slug: "invalidRequest", params: {} };
        case "AUTHORIZATION_REQUIRED":
        case "UNAUTHORIZED":
            return { code, slug: "sessionExpired", params: {} };
        case "UNKNOWN":
            return { code, slug: "network", params: {} };
        default:
            // 兜底也必须说人话：码原样展示（可复制给管理员），英文 detail 不进 UI。
            return { code, slug: "fallback", params: { code, status } };
    }
}

/** 提交结果的摘要行（成功路径）；`rejectedCount > 0` 时仍算"提交成功"，因为批里其它条目已生效。 */
export function summarizeImport(result: SkillImportResultPayload): {
    created: number;
    updated: number;
    unchanged: number;
    rejected: number;
    oversize: number;
} {
    return result.summary;
}
