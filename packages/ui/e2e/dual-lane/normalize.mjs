/**
 * 双侧轨迹对账（task-50）—— 归一化层。
 *
 * 目标：把一条浏览器网络事件压成「可 diff 的一行」，让 mock 车道与 real 车道的读数放进同一个
 * 比对脚本（`D-1085`：两侧各自绿 ≠ 两侧一致）。一行 = `method` + 归一化 path + `status` + 顶层键集合。
 *
 * 为什么路径要归一化：mock 夹具里的 id 是 `workspace-1`/`principal-1`，真栈是 uuid；不归一化就
 * 只能人工肉眼配，那样这层比对第二天就没人看了。
 *
 * 顶层键集合的表示（只比顶层，元素内字段不参与判据）：
 * - 对象 ⇒ 排序后的属性名，例如 `["agents"]`、`["principals"]`；
 * - 数组 ⇒ `["<array>"]`，元素字段另存在 `itemKeys` 里（默认不参与比对，信息用途）；
 * - 无 body / 非 JSON ⇒ `null`（与「空对象 `[]`」区分开：一个是没读到，一个是真的没有键）。
 */

/** 只有这两段前缀算「我们自己的 API」；HTML/静态资源/字体不进口径。 */
export const API_PREFIXES = ["/api/v1/", "/internal/v1/"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^[0-9]+$/;
/** `workspace-1` / `principal-7` / `session-abc12` 这类夹具 id。 */
const SLUG_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-[0-9][0-9a-z]*$/i;

/** 每次请求都可能变、且与形状无关的 query 键（不参与对账）。 */
export const VOLATILE_QUERY_KEYS = new Set(["locale", "_", "t", "ts", "cachebust"]);

export function isApiUrl(rawUrl) {
    const path = pathOf(rawUrl);
    return API_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function pathOf(rawUrl) {
    if (rawUrl.startsWith("/")) return rawUrl.split("?")[0];
    try {
        return new URL(rawUrl).pathname;
    } catch {
        return rawUrl.split("?")[0];
    }
}

function queryOf(rawUrl) {
    if (rawUrl.startsWith("/"))
        return rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?") + 1) : "";
    try {
        return new URL(rawUrl).search.replace(/^\?/, "");
    } catch {
        return "";
    }
}

/** 一个路径段是不是「实例 id」（uuid / 纯数字 / 夹具 slug-id）。 */
export function isIdSegment(segment) {
    return UUID_RE.test(segment) || NUMERIC_RE.test(segment) || SLUG_ID_RE.test(segment);
}

/** 路径归一化：id 段替换成 `{id}`，保留段序与大小写。 */
export function normalizePath(rawUrl) {
    return pathOf(rawUrl)
        .split("/")
        .map((segment) => (isIdSegment(segment) ? "{id}" : segment))
        .join("/");
}

/**
 * query 归一化：丢掉易变键、**只把 id 类参数的值**归一成 `{id}`、按键排序（顺序不该影响对账）。
 * 只对形如 `*id`/`*Id` 的参数归一值 —— 否则 `?page=2` 会被写成 `{id}`，把分页参数也抹掉，那是
 * 「归一化过头」：门会因此看不见「一页拿 2 条还是 20 条」这类真差异。键名保留原大小写（只对易变
 * 键集合做小写比较），否则报告里的 `workspaceId` 读起来像另一个参数。
 */
export function normalizeQuery(rawUrl) {
    const raw = queryOf(rawUrl);
    if (!raw) return "";
    const pairs = [];
    for (const chunk of raw.split("&")) {
        if (!chunk) continue;
        const eq = chunk.indexOf("=");
        const key = eq === -1 ? chunk : chunk.slice(0, eq);
        const value = eq === -1 ? "" : decodeURIComponent(chunk.slice(eq + 1));
        if (VOLATILE_QUERY_KEYS.has(key.toLowerCase())) continue;
        const normalizeValue = /id$/i.test(key) && isIdSegment(value);
        pairs.push(key + "=" + (normalizeValue ? "{id}" : value));
    }
    pairs.sort();
    return pairs.join("&");
}

/**
 * 响应顶层键集合。返回 `{ keys, itemKeys }`：
 * `keys === null` 表示「没有可判定的 JSON body」（非 JSON / 空 body / 解析失败）——
 * 与 `[]`（空对象）严格区分，否则「没读到」会被当成「形状一致」。
 */
export function topKeys(body) {
    if (Array.isArray(body)) {
        const first = body.length > 0 ? body[0] : null;
        return { keys: ["<array>"], itemKeys: keysOfObject(first) };
    }
    if (body && typeof body === "object") {
        return { keys: Object.keys(body).sort(), itemKeys: [] };
    }
    return { keys: null, itemKeys: [] };
}

function keysOfObject(value) {
    if (value && typeof value === "object" && !Array.isArray(value))
        return Object.keys(value).sort();
    return [];
}

/** 对账主键：同一 method + 归一化 path + 归一化 query 视为「同一条请求」。 */
export function traceKey(row) {
    return row.method + " " + row.path + (row.query ? "?" + row.query : "");
}

/** 把一条网络事件折成轨迹行（trace 文件里的单条记录）。 */
export function makeRow({ method, url, status, body, compared }) {
    const { keys, itemKeys } = topKeys(body);
    return {
        method: String(method).toUpperCase(),
        path: normalizePath(url),
        query: normalizeQuery(url),
        status,
        keys,
        itemKeys,
        compared: compared !== false,
    };
}
