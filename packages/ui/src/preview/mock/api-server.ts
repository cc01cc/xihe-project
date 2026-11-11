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

/** task-149：mock lane 的「当前工作区」（字段对齐 ApiWorkspace，storageMode 用产品默认 direct_attach）。 */
const MOCK_WORKSPACE = {
    id: "mock-ws-main",
    name: "Xihe 主工作区",
    description: "mock lane 工作区（真实 API 形状）",
    ownerId: "mock-user",
    storageBackend: "direct",
    storageMode: "direct_attach",
    executionMode: "host",
    workspaceRole: "OWNER",
    canWrite: true,
    hostPath: null,
    roots: [{ id: "mock-root-main", alias: "主根", position: 0, path: null }],
    createdAt: "2026-11-01T09:00:00Z",
    updatedAt: "2026-11-11T09:00:00Z",
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

/** 写路径 body → CP 的 string map：嵌套对象展开成点号键（含 profile:{...}）。 */
function flattenWrite(
    source: Record<string, unknown>,
    prefix = "",
    out: Record<string, string> = {},
): Record<string, string> {
    for (const [rawKey, value] of Object.entries(source)) {
        const key = prefix ? `${prefix}.${rawKey}` : rawKey;
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
            flattenWrite(value as Record<string, unknown>, key, out);
            continue;
        }
        out[key] =
            value === null || value === undefined
                ? ""
                : typeof value === "string"
                  ? value
                  : JSON.stringify(value);
    }
    return out;
}

interface MockEmbeddingProfile {
    providerId: string;
    connectionKey: string;
    model: string;
}

/** 读回 profile：优先 profile（JSON 字符串），退化到点号键（fixtures 形状）。 */
function parseEmbeddingProfile(entries: Record<string, string>): MockEmbeddingProfile | null {
    const raw = entries.profile;
    if (raw) {
        try {
            const parsed = JSON.parse(raw) as Partial<MockEmbeddingProfile>;
            if (parsed?.providerId && parsed?.connectionKey && parsed?.model) {
                return parsed as MockEmbeddingProfile;
            }
        } catch {
            // 不是 JSON 就落回点号键；不是错误，不需要日志噪音。
        }
    }
    const providerId = entries["profile.providerId"];
    const connectionKey = entries["profile.connectionKey"];
    const model = entries["profile.model"];
    if (providerId && connectionKey && model) return { providerId, connectionKey, model };
    return null;
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
                            // PLAN-0766（task-160）：写入共享 workspace-default 层的唯一原子（CP 侧随 task-159 落地）。
                            { actionClass: "MANAGE_WORKSPACE_DEFAULT_CONFIG", resource: "*" },
                            { actionClass: "VIEW_INSTANCE_AUDIT", resource: "*" },
                        ],
                    });
                }

                // task-149：运行期端点（dev-2 inventory §9 判为「已登记、缺口在 mock 层」）。
                // /workspaces 与 /workspaces/current 是产品 api.ts 在用的读取面；
                // 返回一条「当前工作区」，让设置页 / 工作区相关能力探测不再吃 404。
                if (path === "/workspaces" && (req.method ?? "GET") === "GET") {
                    return respond(200, [MOCK_WORKSPACE]);
                }
                if (path === "/workspaces/current" && (req.method ?? "GET") === "GET") {
                    return respond(200, { workspace: MOCK_WORKSPACE });
                }
                if (path === "/user-events") {
                    // 最小 SSE stub：首帧 event: connected 后保持连接。**不能回 404** ——
                    // 客户端的 fetch-event-source 对 404 会进无限退避重连，把日志刷满。
                    res.statusCode = 200;
                    res.setHeader("content-type", "text/event-stream; charset=utf-8");
                    res.setHeader("cache-control", "no-cache, no-transform");
                    res.setHeader("connection", "keep-alive");
                    res.setHeader("x-accel-buffering", "no");
                    res.write(": mock lane user-events stub\n\n");
                    res.write("event: connected\ndata: {}\n\n");
                    const heartbeat = setInterval(() => {
                        try {
                            res.write(": ping\n\n");
                        } catch {
                            // 客户端已经断开：由下面的 close 清理，这里不需要额外动作。
                        }
                    }, 15000);
                    req.on("close", () => {
                        clearInterval(heartbeat);
                        res.end();
                    });
                    options.log?.("[mock-api] SSE /user-events → connected（stub 保活）");
                    return;
                }
                if (path === "/telemetry/logs" && (req.method ?? "GET") === "POST") {
                    // 空实现：不落盘、不转发，只把 body 读完回 200，避免请求挂着。
                    req.on("data", () => {});
                    req.on("end", () => respond(200, { status: "ok" }));
                    return;
                }

                // embedding 面板（EmbeddingSettingsPanel）依赖的 3 个契约端点（D-916 补）：
                // 有效 profile 解析 / 连接测试 / （写路径复用 PUT /config/instance/embedding）。
                if (path === "/config/embedding/effective") {
                    // 由「写入后的层数据」解析，不再返回静态 fixture —— 否则 PUT 成功后
                    // 页面仍显示旧 profile（task-146 的另一条验收：PUT 后 effective 也要读到新值）。
                    const instanceProfile = parseEmbeddingProfile(
                        mergedEntries("instance", "embedding"),
                    );
                    const userProfile = parseEmbeddingProfile(mergedEntries("user", "embedding"));
                    const profile = userProfile ?? instanceProfile;
                    const profileScope = userProfile ? "user" : instanceProfile ? "instance" : null;
                    const contract = { modelId: "text-embedding-3-small", dimension: 768 };
                    if (!profile || !profileScope) {
                        return respond(200, {
                            profile: null,
                            profileScope: null,
                            resolved: null,
                            contract,
                            code: "EMBEDDING_PROFILE_UNSET",
                        });
                    }
                    return respond(200, {
                        profile,
                        profileScope,
                        resolved: {
                            providerId: profile.providerId,
                            connectionKey: profile.connectionKey,
                            providerConnectionId: profile.connectionKey,
                            connectionOwnerScope: "instance",
                            connectionRevision: 1,
                            modelId: profile.model,
                            dimension: contract.dimension,
                            profileScope,
                            modelSource: "pinned-contract",
                        },
                        contract,
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
                // PLAN-0766（task-160）：加共享 workspace-default 层；wire 值小写，与契约
                // b05aad952 的 PUT /config/workspace-default/{domain} 一致（CP 侧随 task-159 注册）。
                const writeMatch = path.match(
                    /^\/config\/(instance|user|workspace-default)\/([a-z0-9-]+)$/,
                );
                if (writeMatch && (req.method ?? "GET") === "PUT") {
                    const [, layer, domain] = writeMatch;
                    let raw = "";
                    req.on("data", (chunk) => {
                        raw += String(chunk);
                    });
                    req.on("end", () => {
                        let parsed: Record<string, unknown> = {};
                        try {
                            parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
                        } catch {
                            parsed = {};
                        }
                        // 平铺体（logging 那种）原样落库；嵌套体（{profile:{…}}）展开成点号键 ——
                        // 不展开就会出现「PUT 200 但 GET ?layer 仍是 fixture 值」的假保真（task-146）。
                        const flat = flattenWrite(parsed);
                        if (
                            domain === "embedding" &&
                            (Object.keys(flat).length === 0 || flat.profile === "")
                        ) {
                            // 「清除并恢复继承」产品发 {}：必须把本层 profile 的点号键一起清掉，
                            // 否则 fixtures 的旧点号键还会被解析成旧值。
                            flat.profile = "";
                            flat["profile.providerId"] = "";
                            flat["profile.connectionKey"] = "";
                            flat["profile.model"] = "";
                        } else if (domain === "embedding" && flat.profile) {
                            const profile = parseEmbeddingProfile({ profile: flat.profile });
                            if (profile) {
                                flat["profile.providerId"] = profile.providerId;
                                flat["profile.connectionKey"] = profile.connectionKey;
                                flat["profile.model"] = profile.model;
                                flat.model = profile.model;
                            }
                        }
                        Object.assign(memoryFor(layer, domain), flat);
                        options.log?.(
                            `[mock-api] PUT /config/${layer}/${domain} → ${Object.keys(flat).length} 键`,
                        );
                        return respond(200, {
                            domain,
                            layer,
                            entries: mergedEntries(layer, domain),
                        });
                    });
                    return;
                }

                // PLAN-0766：清掉 workspace-default 层的单个键（回落到 user/instance/code）。
                const wsDefaultDelete = path.match(
                    /^\/config\/workspace-default\/([a-z0-9-]+)\/([A-Za-z0-9_.-]+)$/,
                );
                if (wsDefaultDelete && (req.method ?? "GET") === "DELETE") {
                    const [, domain, key] = wsDefaultDelete;
                    const memory = memoryFor("workspace-default", domain);
                    delete memory[key];
                    options.log?.(`[mock-api] DELETE /config/workspace-default/${domain}/${key}`);
                    return respond(200, { deleted: true });
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
                        const workspaceDefaultMemory = memoryFor("workspace-default", domain);
                        const keys = Object.keys(entriesFor(domain)).map((key) => ({
                            key,
                            // 来源按「该键在本层有没有显式值」判：workspace-default 有值 ⇒ 来源就是它，
                            // 否则沿用继承来的 instance fixture（证明「只显示生效值的来源」）。
                            source:
                                layer === "workspace-default"
                                    ? Object.prototype.hasOwnProperty.call(
                                          workspaceDefaultMemory,
                                          key,
                                      )
                                        ? "workspace-default"
                                        : "instance"
                                    : layer === "instance"
                                      ? "code"
                                      : "instance",
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

                // task-157：approval-policy 域「工具分类」页签（ToolFacesView）需要的唯一 mock
                // 端点。响应按 PolicyToolFaceView 的数组形状（PLAN-0328 M1）返回空目录 ——
                // mock lane 没有真实工具注册表，空数组即「暂无工具记录」，不虚构分类行。
                if (path === "/policy/tool-faces" && (req.method ?? "GET") === "GET") {
                    return respond(200, []);
                }

                options.log?.(`[mock-api] 未 mock 的端点：${path}`);
                return respond(404, { code: "MOCK_ENDPOINT_MISSING", endpoint: path });
            });
        },
    };
}
