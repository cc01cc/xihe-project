import { LAYER_DOMAINS, type ConfigDomain, type ConfigLayer } from "../stores/config";

/**
 * PLAN-0752 / task-230：把一条 CP config 请求 URL 归属到「层 × 域」的**纯函数**。
 *
 * <p>为什么必须单独成函数：CP config 有两套路径形态，**层的位置不一样** ——</p>
 * - 读：`GET /api/v1/config/<domain>?layer=<layer>&includeMeta=true`（stores/config.ts:277）
 *   ⇒ 层在 **query**；
 * - 写：`PUT /api/v1/config/<layer>/<domain>`（:321）、单键 `:329`
 *   ⇒ 层在 **path 段**。
 *
 * <p>因此任何「只看 pathname 里有没有 `/config/workspace/` 前缀」的判定对**读**路径
 * **恒真**：pathname 永远不含层段，过滤器拿到的是一份永远不匹配的样本集合。2026-11-10
 * 实测到已合入的 `e2e/mock/plan-0752-settings-ia.spec.ts` 的 V3「零工作区层请求」正是这个
 * 形态 —— 断言是绿的，但它只证明了「没发写请求」（假绿，见 task-230）。判定沉降到这里并配
 * 单测，是为了让下一个写同类断言的人有一个**不会恒真**的入口。</p>
 *
 * <p>容错口径：接受绝对 URL 与 `/path?search`；解析不出层就返回 `null`，**不猜**——
 * 猜层正是假绿的来源。</p>
 */

const NON_DOMAIN_SEGMENTS = new Set(["export", "import"]);

/** 是否为设置区矩阵里**全局设置面仍在用**的层（task-253 后是 `instance` / `workspace-default` / `user`）。 */
export function isConfigLayer(value: unknown): value is ConfigLayer {
    return typeof value === "string" && LAYER_DOMAINS[value as ConfigLayer] !== undefined;
}

/**
 * 解析用的层值：**含不在全局设置面的 `workspace`**。
 *
 * <p>task-253 把全局设置面的 `ConfigLayer` 收敛为 `instance | workspace-default | user`；
 * workspace 层本身仍在 CP（每工作区的覆盖层），但全局设置不得再对它发起请求。防复活守卫
 * 必须能**识别**这种请求 —— 若解析只用 `isConfigLayer` 判，`layer === "workspace"` 会永远
 * false，守卫变成死断言（绿着但什么都没验）。</p>
 */
export type RequestLayer = ConfigLayer | "workspace";

/** 不在全局设置面、但仍需被守卫识别的层值。加新值时同步 `RequestLayer`。 */
const RETIRED_LAYERS: readonly string[] = ["workspace"];

function isRequestLayer(value: unknown): value is RequestLayer {
    return isConfigLayer(value) || (typeof value === "string" && RETIRED_LAYERS.includes(value));
}

export interface ParsedConfigRequest {
    /** 解析不出就 null（例如 `/config/export`、无 `layer` 的读路径）。 */
    layer: RequestLayer | null;
    /** 首个非层段即域；`/config/export` 这类非域请求为 null。 */
    domain: string | null;
}

function splitRequest(
    rawUrl: string,
): { segments: string[]; searchParams: URLSearchParams } | null {
    try {
        const url = new URL(rawUrl, "http://localhost");
        return {
            segments: url.pathname.split("/").filter((part) => part !== ""),
            searchParams: url.searchParams,
        };
    } catch {
        return null;
    }
}

/** 解析一条 config 请求的层与域；非 config 请求返回双 null。 */
export function parseConfigRequest(rawUrl: string): ParsedConfigRequest {
    const parsed = splitRequest(rawUrl);
    if (!parsed) return { layer: null, domain: null };
    const configIndex = parsed.segments.indexOf("config");
    if (configIndex < 0) return { layer: null, domain: null };
    const first = parsed.segments[configIndex + 1];
    if (first === undefined || NON_DOMAIN_SEGMENTS.has(first)) {
        return { layer: null, domain: null };
    }
    // 写路径：/config/<layer>/<domain>[/<key>] —— 层在 path 段里。
    if (isRequestLayer(first)) {
        return { layer: first, domain: parsed.segments[configIndex + 2] ?? null };
    }
    // 读路径：/config/<domain>[/meta]?layer=<layer> —— 层只能在 query 里。
    const queryLayer = parsed.searchParams.get("layer");
    return { layer: isRequestLayer(queryLayer) ? queryLayer : null, domain: first };
}

export function configRequestLayer(rawUrl: string): RequestLayer | null {
    return parseConfigRequest(rawUrl).layer;
}

export function configRequestDomain(rawUrl: string): string | null {
    return parseConfigRequest(rawUrl).domain;
}

/**
 * 该请求是否落在**工作区层**。
 *
 * <p>两种形态都算（缺一条就会出现「漏判 ⇒ 假绿」）：</p>
 * - 写：`/api/v1/config/workspace/<domain>`（层在 path）；
 * - 读：`/api/v1/config/<domain>?layer=workspace`（层在 query，**pathname 里看不出来**）。
 */
export function isWorkspaceLayerConfigRequest(rawUrl: string): boolean {
    // 这是「工作区层请求不得出现」的**防复活断言**，不是能力查询 —— 所以刻意用包含已退役层的
    // `RequestLayer` 比较，而不是把它收窄回 `ConfigLayer`（那样会成 TS2367，且守卫恒 false）。
    return configRequestLayer(rawUrl) === "workspace";
}

/** 该请求是否指向某个具体配置域（读、读 meta、写三种形态都算）。 */
export function isConfigRequestForDomain(rawUrl: string, domain: ConfigDomain | string): boolean {
    return configRequestDomain(rawUrl) === domain;
}
