/**
 * BL-339：外部入口（托盘 / 通知 / CLI / 别的应用）把「要发的内容 + 目标会话/主体」
 * 一起带进 XH —— 深链 `?compose=<base64url(JSON)>`。
 *
 * 统一口径（产品裁定）：**只预填、绝不代发**。发送仍然必须由用户自己的发送动作触发，
 * 因此这里不碰任何发送路径的权限/审计，也不新增 i18n 文案（失败只 `console.warn`）。
 *
 * 结构：
 *  1. 纯函数层（可直接单测）：`decodeComposePayload` / `normalizeComposeDeeplink` /
 *     `parseComposeDeeplink` / `stripComposeQuery`；
 *  2. composable 层：`useComposeDeeplink(options)` —— 读一次 query，交给调用方预填，
 *     成功后 **replace** 掉 `compose` 参数（不新增历史条目，防刷新重复预填）。
 */

import { watch } from "vue";
import { useRouter } from "vue-router";

export interface ComposeDeeplink {
    /** 要预填到 composer 的正文（必填）。 */
    text: string;
    /** 预填的收件人（AGENT 参与者 id；只填空位，不覆盖用户已有选择）。 */
    to?: string[];
    /** 预填的抄送（同上）。 */
    cc?: string[];
    /** 目标会话；给了就只在打开的会话与之一致时预填。 */
    sessionId?: string;
    /** 引用内容：BL-339 先只解析、不使用（扩面成本高，见 TODO）。 */
    quote?: string;
}

/** `text` 的长度上限（超出截断并 warn，不拒绝整条深链）。 */
export const COMPOSE_TEXT_LIMIT = 4000;
/** `to` / `cc` 各自的项数上限（超出截断并 warn）。 */
export const COMPOSE_RECIPIENT_LIMIT = 20;

const WARN_PREFIX = "[compose-deeplink]";

function warn(reason: string, detail?: unknown): void {
    // BL-339：失败一律「静默忽略 + 一条 warn」，不抛错、不弹窗打断用户。
    console.warn(`${WARN_PREFIX} ${reason}`, detail ?? "");
}

/** base64url → UTF-8 文本；非法输入返回 `null`（不抛）。 */
export function decodeComposePayload(raw: string): string | null {
    try {
        const normalized = raw.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
        const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * 校验并归一化已解析的 JSON。
 * @param input - `JSON.parse` 出来的任意值。
 * @returns 合法深链；任何字段不符 ⇒ `null`（并 warn 一条）。
 */
export function normalizeComposeDeeplink(input: unknown): ComposeDeeplink | null {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        warn("payload is not a JSON object");
        return null;
    }
    const record = input as Record<string, unknown>;
    if (typeof record.text !== "string") {
        warn("payload.text is missing or not a string");
        return null;
    }
    if (record.to !== undefined && !isStringArray(record.to)) {
        warn("payload.to is not a string array");
        return null;
    }
    if (record.cc !== undefined && !isStringArray(record.cc)) {
        warn("payload.cc is not a string array");
        return null;
    }
    if (record.sessionId !== undefined && typeof record.sessionId !== "string") {
        warn("payload.sessionId is not a string");
        return null;
    }
    if (record.quote !== undefined && typeof record.quote !== "string") {
        warn("payload.quote is not a string");
        return null;
    }

    let text = record.text;
    if (text.length > COMPOSE_TEXT_LIMIT) {
        warn(`payload.text exceeds ${COMPOSE_TEXT_LIMIT} chars; truncated`);
        text = text.slice(0, COMPOSE_TEXT_LIMIT);
    }

    const trimmedArray = (
        value: string[] | undefined,
        field: "to" | "cc",
    ): string[] | undefined => {
        if (value === undefined) return undefined;
        if (value.length > COMPOSE_RECIPIENT_LIMIT) {
            warn(`payload.${field} exceeds ${COMPOSE_RECIPIENT_LIMIT} entries; truncated`);
            return value.slice(0, COMPOSE_RECIPIENT_LIMIT);
        }
        return value;
    };

    const payload: ComposeDeeplink = { text };
    const to = trimmedArray(record.to as string[] | undefined, "to");
    const cc = trimmedArray(record.cc as string[] | undefined, "cc");
    if (to !== undefined) payload.to = to;
    if (cc !== undefined) payload.cc = cc;
    if (typeof record.sessionId === "string") payload.sessionId = record.sessionId;
    // TODO(BL-339)：`quote` 先只解析、不使用 —— 引用块要改发送载荷与渲染，属下一单扩面。
    return payload;
}

/**
 * 深链查询值 → 归一化载荷。
 * @param raw - `route.query.compose`（可能是数组、空串或未定义）。
 * @returns 合法载荷；非法/缺失 ⇒ `null`。
 */
export function parseComposeDeeplink(raw: unknown): ComposeDeeplink | null {
    if (raw === undefined || raw === null) return null;
    if (Array.isArray(raw)) {
        warn("multiple compose parameters; using the first");
        raw = raw[0];
    }
    if (typeof raw !== "string" || raw === "") {
        warn("payload is not a string");
        return null;
    }
    const json = decodeComposePayload(raw);
    if (json === null) {
        warn("payload is not valid base64url");
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        warn("payload is not valid JSON");
        return null;
    }
    return normalizeComposeDeeplink(parsed);
}

/**
 * 去掉 `compose` 参数的 URL 构造（纯函数，供测试与 `history.replaceState` 兜底）。
 * @param url - 绝对 URL 或 `path?query`。
 * @returns 保留 path 与其它参数、去掉 `compose` 的等价 URL。
 */
export function stripComposeQuery(url: string): string {
    const fake = new URL(url, "http://localhost");
    fake.searchParams.delete("compose");
    const search = fake.searchParams.toString();
    const relative = `${fake.pathname}${search ? `?${search}` : ""}${fake.hash}`;
    // 相对输入保持相对输出，绝对输入保持绝对（避免调用方拿错形态）。
    return /^[a-z]+:\/\//i.test(url) ? fake.toString() : relative;
}

export interface ComposeDeeplinkOptions {
    /** 当前会话 id（用于比对载荷里的 `sessionId`）。 */
    sessionId: () => string;
    /** 预填入口：返回 `true` 表示已应用（可清参）；返回 `false` 表示组件还没就绪。 */
    apply: (payload: ComposeDeeplink) => boolean;
    /** 组件是否已可预填（例如 ref 已挂载）。 */
    ready?: () => boolean;
}

/**
 * 消费 `?compose=` 深链：预填一次，然后把参数从 URL 里抹掉（不新增历史条目）。
 * @param options - 会话 id、预填入口与就绪判据。
 */
export function useComposeDeeplink(options: ComposeDeeplinkOptions): void {
    const router = useRouter();
    const raw = router.currentRoute.value.query.compose;
    if (raw === undefined) return;

    const clearParam = (): void => {
        const query = { ...router.currentRoute.value.query };
        delete query.compose;
        // `replace` 不新增历史条目：刷新/后退都不会重复预填。
        void router.replace({ query });
    };

    const payload = parseComposeDeeplink(raw);
    if (payload === null) {
        clearParam();
        return;
    }
    // 指定了其它会话 ⇒ 本会话不消费，保留参数给目标会话（不要让两个会话都预填）。
    if (payload.sessionId !== undefined && payload.sessionId !== options.sessionId()) return;

    let applied = false;
    watch(
        () => options.ready?.() ?? true,
        (ready) => {
            if (applied || !ready) return;
            if (payload.sessionId !== undefined && payload.sessionId !== options.sessionId())
                return;
            applied = options.apply(payload);
            if (applied) clearParam();
        },
        { immediate: true },
    );
}
