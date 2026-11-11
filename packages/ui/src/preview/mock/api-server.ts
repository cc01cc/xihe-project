import type { Plugin } from "vite";
import type { ServerResponse } from "node:http";
import { CONFIG_SCHEMA_CATALOG } from "../../lib/configSchemaCatalog";
import { MOCK_VALUES } from "./data/mockValues";

/**
 * task-137 rev2（Lead 2026-11-11 拍板）：**真实 UI + mock 数据** —— 数据在**网络层** mock。
 *
 * 为什么放这里：用户纠正过「mock UI 稿 = 真实的最终 UI，只是数据是 mock」；预览页要渲染产品
 * 真页面（真 router / NavRail / SettingsSidebar / ConfigLayerPanels），不能有平行组件，也不能
 * 在产品代码里加 mock 分支。所以唯一合法位置是 vite dev server 中间件：只在
 * `XIHE_UI_MOCK_API=1` 且 command === "serve" 时挂载，正常 dev / build 完全不存在该插件。
 *
 * 端点集合按「设置区 5 个 SHOTS 域所需」收敛；缺端点时页面会显错误横幅 —— 先补端点再拍，
 * 不带着错误横幅出图（Lead 口径）。
 */
export interface MockApiOptions {
    /** 便于测试/拍图时确认挂的是 mock lane。 */
    log?: (line: string) => void;
}

const CAPABILITIES = {
    isInstanceAdmin: true,
    isInstanceSuper: true,
    canCreateWorkspace: true,
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(body));
}

/**
 * 内存持久：D-914 ② 交互深度 B 轻量版 —— 保存走真 PUT，写到内存（不校验、不回 400），
 * 刷新页面能读回（dev server 进程活着期间有效；重启即回到 fixtures 初值）。
 */
const layerMemory = new Map<string, Record<string, Record<string, string>>>();

function memoryFor(layer: string, domain: string): Record<string, string> {
    const layerMap = layerMemory.get(layer) ?? {};
    layerMemory.set(layer, layerMap);
    layerMap[domain] = layerMap[domain] ?? {};
    return layerMap[domain];
}

function mergedEntries(layer: string, domain: string): Record<string, string> {
    const base = layer === "instance" ? entriesFor(domain) : {};
    return { ...base, ...memoryFor(layer, domain) };
}

/** 把 schema 字段的 mock 值拍平成 CP `GET /config/{domain}` 的 string map。 */
function entriesFor(domain: string): Record<string, string> {
    const fields = CONFIG_SCHEMA_CATALOG[domain] ?? [];
    const values = MOCK_VALUES[domain] ?? {};
    const entries: Record<string, string> = {};
    const hasAggregate = (key: string): boolean => {
        const dot = key.indexOf(".");
        return dot > 0 && key.slice(0, dot) in values;
    };
    for (const field of fields) {
        // 面板按聚合键取值（defaults / models 整块 JSON）时，dotted 展开键不再单独下发，
        // 否则「本域 N 项配置」会比真实现多算 N 行。
        if (hasAggregate(field.key)) continue;
        const value = values[field.key];
        if (value === undefined) continue;
        entries[field.key] = typeof value === "string" ? value : JSON.stringify(value);
    }
    // schema 与「产品面板字段」不完全同名（例：context-policy 的 schema 是 dotted 键
    // defaults.softThresholdPct，面板要的是整块 defaults/models JSON）⇒ fixtures 里多出来的
    // 键也要下发，否则面板取不到值只会渲染空编辑器。
    const catalogKeys = new Set(fields.map((field) => field.key));
    for (const [key, value] of Object.entries(values)) {
        if (key in entries || catalogKeys.has(key)) continue;
        entries[key] = typeof value === "string" ? value : JSON.stringify(value);
    }
    return entries;
}

export function mockApiPlugin(options: MockApiOptions = {}): Plugin {
    return {
        name: "xihe-mock-api",
        apply: "serve",
        configureServer(server) {
            // 真路由可点开：mock lane 下 /settings/** 与 /workspace/** 的 HTML 入口一律回
            // preview-real.html（它只做「注入 mock 登录态」这一件 dev-only 的事）。
            // 只在 XIHE_UI_MOCK_API=1 时存在 ⇒ 正常 dev 的 index.html 行为逐字节不变。
            server.middlewares.use((req, _res, next) => {
                const url = req.url ?? "/";
                if (/^\/(settings|workspace)(\/|$)/.test(url) && !url.includes(".")) {
                    req.url = "/preview-real.html";
                }
                next();
            });
            server.middlewares.use("/api/v1", (req, res) => {
                const url = new URL(req.url ?? "/", "http://mock.local");
                const path = url.pathname.replace(/^\/api\/v1/, "") || "/";
                options.log?.(`[mock-api] ${req.method ?? "GET"} ${path}`);
                const respond = (status: number, body: unknown) =>
                    sendJson(res as ServerResponse, status, body);

                // 会话与权限：真页面只要有 token 就会走这两条。
                if (path === "/auth/me") {
                    return respond(200, {
                        id: "mock-user",
                        name: "张安",
                        email: "mock@xihe.dev",
                        capabilities: CAPABILITIES,
                    });
                }
                if (path === "/me/permissions") {
                    return respond(200, {
                        userId: "mock-user",
                        instanceCapabilities: Object.keys(CAPABILITIES),
                        instancePermissions: [
                            { actionClass: "MANAGE_ROLES", resource: "*" },
                            { actionClass: "MANAGE_AGENTS", resource: "*" },
                            { actionClass: "MANAGE_INSTANCE_CONFIG", resource: "*" },
                            { actionClass: "VIEW_INSTANCE_AUDIT", resource: "*" },
                        ],
                    });
                }

                // embedding 面板（EmbeddingSettingsPanel）依赖的 3 个契约端点（D-916 补）：
                // 有效 profile 解析 / 连接测试 / （写路径复用 PUT /config/instance/embedding）。
                if (path === "/config/embedding/effective") {
                    return respond(200, {
                        profile: {
                            providerId: "openai",
                            connectionKey: "conn-embed-primary",
                            model: "text-embedding-3-small",
                        },
                        profileScope: "instance",
                        resolved: {
                            providerId: "openai",
                            connectionKey: "conn-embed-primary",
                            providerConnectionId: "conn-embed-primary",
                            connectionOwnerScope: "instance",
                            connectionRevision: 1,
                            modelId: "text-embedding-3-small",
                            dimension: 768,
                            profileScope: "instance",
                            modelSource: "pinned-contract",
                        },
                        contract: { modelId: "text-embedding-3-small", dimension: 768 },
                    });
                }
                if (path === "/config/embedding/test" && (req.method ?? "GET") === "POST") {
                    return respond(200, {
                        status: "ok",
                        model: "text-embedding-3-small",
                        dimension: 768,
                        requestId: "mock-embed-test-1",
                    });
                }

                // Provider 面（llm-provider 页 = ProviderHub）：目录 / 连接 / 模型目录 / 输入类型。
                if (path === "/provider-catalog") {
                    return respond(200, {
                        catalogRevision: "mock-1",
                        providers: [
                            {
                                id: "anthropic",
                                displayName: "Anthropic",
                                category: "recommended",
                                description: "Anthropic Claude 系列模型",
                                adapter: "native-litellm",
                                litellmProvider: "anthropic",
                                defaultBaseUrl: "https://api.anthropic.com/v1",
                                modelDiscovery: "curated",
                                credential: { type: "api_key", required: true },
                                supports: { chat: true, embedding: false, image: false },
                            },
                            {
                                id: "openai",
                                displayName: "OpenAI",
                                category: "recommended",
                                description: "OpenAI GPT / 图像生成",
                                adapter: "openai-compatible",
                                litellmProvider: "openai",
                                defaultBaseUrl: "https://api.openai.com/v1",
                                modelDiscovery: "curated",
                                credential: { type: "api_key", required: true },
                                supports: { chat: true, embedding: true, image: true },
                            },
                        ],
                    });
                }
                if (path === "/provider-connections") {
                    return respond(200, {
                        connections: [
                            {
                                id: "conn-claude-primary",
                                providerId: "anthropic",
                                connectionKey: "conn-claude-primary",
                                apiTypeId: "anthropic-messages",
                                apiTypeVersion: 1,
                                operation: "chat",
                                label: "Claude 主连接",
                                scope: "instance",
                                baseUrl: null,
                                modelDiscovery: "curated",
                                manualModels: [],
                                hasKey: true,
                                enabled: true,
                                status: "READY",
                                revision: 1,
                            },
                            {
                                id: "conn-embed-primary",
                                providerId: "openai",
                                connectionKey: "conn-embed-primary",
                                apiTypeId: "openai-embeddings",
                                apiTypeVersion: 1,
                                operation: "embedding",
                                label: "嵌入模型主连接",
                                scope: "instance",
                                baseUrl: null,
                                modelDiscovery: "curated",
                                manualModels: [],
                                hasKey: true,
                                enabled: true,
                                status: "READY",
                                revision: 1,
                            },
                            {
                                id: "conn-image-primary",
                                providerId: "openai",
                                connectionKey: "conn-image-primary",
                                apiTypeId: "openai-chat",
                                apiTypeVersion: 1,
                                operation: "image",
                                label: "图像生成连接",
                                scope: "instance",
                                baseUrl: null,
                                modelDiscovery: "curated",
                                manualModels: [],
                                hasKey: true,
                                enabled: true,
                                status: "READY",
                                revision: 1,
                            },
                        ],
                    });
                }
                if (path === "/models") {
                    return respond(200, {
                        providers: {
                            "conn-claude-primary": {
                                providerId: "anthropic",
                                connectionId: "conn-claude-primary",
                                status: "ready",
                                models: [
                                    { name: "claude-sonnet-4-5", capabilities: { chat: true } },
                                    { name: "claude-haiku-4-5", capabilities: { chat: true } },
                                ],
                            },
                            "conn-image-primary": {
                                providerId: "openai",
                                connectionId: "conn-image-primary",
                                status: "ready",
                                models: [{ name: "gpt-image-1", capabilities: { image: true } }],
                            },
                        },
                    });
                }
                if (path === "/api-input-types") {
                    return respond(200, {
                        types: [
                            {
                                apiTypeId: "anthropic-messages",
                                version: 1,
                                operation: "chat",
                                method: "POST",
                                path: "/v1/messages",
                                requestShape: "messages",
                                responseShape: "messages",
                                streamShape: "sse",
                            },
                            {
                                apiTypeId: "openai-chat",
                                version: 1,
                                operation: "chat",
                                method: "POST",
                                path: "/v1/chat/completions",
                                requestShape: "chat",
                                responseShape: "chat",
                                streamShape: "sse",
                            },
                        ],
                    });
                }

                // 写路径（D-914 B 轻量版）：真组件保存走 PUT /config/{layer}/{domain}，
                // 这里只按产品契约收下 map 并落内存（不校验、不回 400）。
                const writeMatch = path.match(
                    /^\/config\/(instance|user|workspace)\/([a-z0-9-]+)$/,
                );
                if (writeMatch && (req.method ?? "GET") === "PUT") {
                    const [, layer, domain] = writeMatch;
                    let body: Record<string, string> = {};
                    let raw = "";
                    req.on("data", (chunk) => {
                        raw += String(chunk);
                    });
                    req.on("end", () => {
                        try {
                            body = raw ? (JSON.parse(raw) as Record<string, string>) : {};
                        } catch {
                            body = {};
                        }
                        Object.assign(memoryFor(layer, domain), body);
                        options.log?.(
                            `[mock-api] PUT /config/${layer}/${domain} → ${Object.keys(body).length} 键`,
                        );
                        return respond(200, {
                            domain,
                            layer,
                            entries: mergedEntries(layer, domain),
                        });
                    });
                    return;
                }

                // 配置域：GET /config/{domain}（全量）、带 layer 的 entries、meta。
                const configMatch = path.match(/^\/config\/([a-z0-9-]+)(?:\/meta)?$/);
                if (configMatch) {
                    const domain = configMatch[1];
                    const isMeta = path.endsWith("/meta");
                    if (isMeta) {
                        // meta 是产品已登记契约（ConfigKeyMeta，PLAN-0554）：真组件用 writable/locked
                        // 决定渲染可编辑控件还是只读行。空 keys ⇒ 全只读 ⇒ B 轻量版编辑不了，
                        // 所以这里按 schema 生成 meta（值本身仍来自 fixtures 层）。
                        const layer = url.searchParams.get("layer") ?? "instance";
                        const keys = Object.keys(entriesFor(domain)).map((key) => ({
                            key,
                            source: layer === "instance" ? "code" : "instance",
                            locked: false,
                            writable: true,
                            reason: null,
                            instanceEligible: true,
                            defaultPresent: true,
                            overridable: true,
                        }));
                        return respond(200, { keys });
                    }
                    const layer = url.searchParams.get("layer");
                    if (layer) {
                        return respond(200, {
                            domain,
                            layer,
                            entries: mergedEntries(layer, domain),
                            envOverridden: {},
                        });
                    }
                    return respond(200, mergedEntries("instance", domain));
                }

                options.log?.(`[mock-api] 未 mock 的端点：${path}`);
                return respond(404, { code: "MOCK_ENDPOINT_MISSING", endpoint: path });
            });
        },
    };
}
