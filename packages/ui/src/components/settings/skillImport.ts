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

/**
 * 单条定义的**字段判据**（`name` / `description` / `body`），与 CP `SkillImportValidator` 同规则。
 *
 * <p>抽出来是给「导入」与「新建」两处共用（`task-312`）：新建只差一个 `sourcePath` 的来历
 * （导入来自文件、新建由 name 派生），三个字段的判据必须**逐字相同** —— 否则同一条名字在两个
 * 入口一边收一边拒，用户只会觉得产品坏了。解析结果同时把值收敛为 `string`，调用方无需再断言类型。</p>
 */
type FieldParse = { ok: true; value: string } | { ok: false; code: string };

function parseName(raw: unknown): FieldParse {
    return typeof raw === "string" && SKILL_NAME_PATTERN.test(raw)
        ? { ok: true, value: raw }
        : { ok: false, code: "SKILL_NAME_INVALID" };
}

function parseDescription(raw: unknown): FieldParse {
    if (typeof raw !== "string" || raw.trim() === "") {
        return { ok: false, code: "SKILL_DESCRIPTION_REQUIRED" };
    }
    if (raw.length > SKILL_DESCRIPTION_MAX_LENGTH) {
        return { ok: false, code: "SKILL_DESCRIPTION_TOO_LONG" };
    }
    // 与 CP 同口径：**拒绝而不替用户 trim**（`SkillImportValidator` 的 B 裁定原文：
    // "reject, do not trim" —— 静默 trim 会让入库存的与调用方以为的不一致）。
    if (raw !== raw.trim()) return { ok: false, code: "SKILL_DESCRIPTION_EDGE_WHITESPACE" };
    if (CONTROL_CHARACTER.test(raw)) {
        return { ok: false, code: "SKILL_DESCRIPTION_CONTROL_CHARACTER" };
    }
    return { ok: true, value: raw };
}

function parseBody(raw: unknown): FieldParse {
    if (typeof raw !== "string" || raw.trim() === "") {
        return { ok: false, code: "SKILL_BODY_EMPTY" };
    }
    if (raw.length > SKILL_BODY_MAX_LENGTH) return { ok: false, code: "SKILL_BODY_TOO_LARGE" };
    return { ok: true, value: raw };
}

/** 单条定义预检：形状 + CP 同判据（返回第一个命中的 CP 码，附带 `sourcePath` 便于定位）。 */
function checkItem(
    raw: Record<string, unknown>,
    index: number,
    targetScope: SkillImportTargetScope = "instance",
): { code: string; hint?: string } | SkillImportItemPayload {
    const label = `#${index + 1}`;
    const sourcePath = raw.sourcePath;
    const parsedName = parseName(raw.name);
    if (!parsedName.ok) return { code: parsedName.code, hint: label };
    const parsedDescription = parseDescription(raw.description);
    if (!parsedDescription.ok) return { code: parsedDescription.code, hint: label };
    const parsedBody = parseBody(raw.body);
    if (!parsedBody.ok) return { code: parsedBody.code, hint: label };
    const name = parsedName.value,
        description = parsedDescription.value,
        body = parsedBody.value;
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

/**
 * 「新建」单条个人技能时 `sourcePath` 的根目录。
 *
 * <p>`manual/` 是**可信度标记**而不是装饰：它是"这条定义是人手工建的、没有对应文件"留在数据里的
 * 唯一痕迹。用 `skills/` 会让下一个人以为磁盘上真有个 `skills/<name>/SKILL.md`（那是导入的形态）。</p>
 */
export const SKILL_CREATE_SOURCE_ROOT = "manual";

/** 新建技能的 `sourcePath` = `manual/<name>/SKILL.md`（目录名必须等于 `name`，见下）。 */
export function deriveCreateSourcePath(name: string): string {
    return `${SKILL_CREATE_SOURCE_ROOT}/${name}/SKILL.md`;
}

/**
 * 与 CP `SkillImportValidator.normalizePath`（`:248-271`）**同判据**的路径自检：段级 `..`、
 * 绝对路径、盘符前缀一律不许。
 *
 * <p><b>两种判据并存是有意的，不是不一致</b>：**派生路径（本函数）用段级判据对齐 CP；粘贴路径
 * （{@link checkItem}）用 `includes("..")` 子串判据，故意更严**（粘进来的是不可信输入，宁可严）。
 * **不要"统一"它们** —— 统一必然二选一地翻车：改用子串 ⇒ CP 合法的名字（如 `a..b`，
 * `NAME_PATTERN` 允许连续点）会被本地误拒，等于 UI 自己发明一条 CP 没有的规则；改用段级 ⇒
 * 拆掉一条对不可信输入的防线。裁定：`2026-11-12` 导入侧那条子串判据**一个字不改**。</p>
 */
function isSafeRelativeSourcePath(path: string): boolean {
    if (path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:/.test(path)) return false;
    const parts = path.split(/\/+/).filter((part) => part !== "" && part !== ".");
    return parts.length > 0 && !parts.includes("..");
}

/** 「新建」草稿的判据结果：失败时带**字段名**，对话框据此把错误贴到对应输入框旁。 */
export type SkillCreateDraftResult =
    | { ok: true; payload: SkillImportRequestPayload }
    | { ok: false; code: string; field: "name" | "description" | "body" | "sourcePath" };

/**
 * `task-312` · 「新建」一条个人技能 → 与 `POST /skills/import` **同形的单条批**（裁定 A：
 * 不新增 REST 端点）。
 *
 * <p>三条硬口径：</p>
 * <ol>
 *   <li><b>`definition_scope_id` 从不出现</b>：`SkillDefinitionScopePayload` 的 `user` 分支
 *       类型上就没有 id 字段（P-189-1：CP 从 token 取归属人），所以这里给的是 `{ type: "user" }`
 *       而不是"带 id 但省略"。</li>
 *   <li><b>`trusted` 从不出现</b>：个人层连 `false` 都整批 400（`SkillController.refusePersonalTrusted`），
 *       本函数不接收该字段 ⇒ 调用方连传的机会都没有。</li>
 *   <li><b>`sourcePath` 由 name 派生</b>（`manual/<name>/SKILL.md`）：CP 要求当路径尾段是
 *       `SKILL.md` 时其目录名必须等于 `name`（`SkillImportValidator.validateName:117-127`），
 *       派生保证这一条恒成立；name 的字符集不含 `/`（`NAME_PATTERN`），所以派生不会引入新段。</li>
 * </ol>
 */
export function buildPersonalSkillCreateRequest(fields: {
    name: string;
    description: string;
    body: string;
}): SkillCreateDraftResult {
    const parsedName = parseName(fields.name);
    if (!parsedName.ok) return { ok: false, code: parsedName.code, field: "name" };
    const parsedDescription = parseDescription(fields.description);
    if (!parsedDescription.ok) {
        return { ok: false, code: parsedDescription.code, field: "description" };
    }
    const parsedBody = parseBody(fields.body);
    if (!parsedBody.ok) return { ok: false, code: parsedBody.code, field: "body" };
    const name = parsedName.value;
    const sourcePath = deriveCreateSourcePath(name);
    if (!isSafeRelativeSourcePath(sourcePath)) {
        // 防御性自检：name 已被 NAME_PATTERN 限死，正常走不到这里；真走到了说明派生规则被改坏，
        // 宁可本地红，也不要让 CP 用 rejected[].code 兜。
        return { ok: false, code: "SKILL_SOURCE_PATH_INVALID", field: "sourcePath" };
    }
    return {
        ok: true,
        payload: {
            definitionScope: { type: "user" },
            skills: [
                {
                    name: fields.name,
                    description: fields.description,
                    body: fields.body,
                    sourcePath,
                },
            ],
        },
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
