import type { Plugin } from "vite";
import type { ServerResponse } from "node:http";
import { CONFIG_SCHEMA_CATALOG } from "../../lib/configSchemaCatalog";
import { MOCK_VALUES } from "./data/mockValues";
import {
    mockSkillDefinition,
    mockSkillDefinitions,
    mockWorkspaceSkillDefinitions,
} from "./data/skills";
import { mockWorkspaceEnvironment, mockWorkspaceJobs } from "./data/workspaceEnvironment";
import { handleInstanceResource } from "./data/instanceResources";
import { handleAgentSkillBinding } from "./data/agentSkillBindings";
// task-25 D（D-1175 收窄重开）：会话/消息/投影夹具（长值样本供 cp-2 task-392 折行取证）。
import {
    mockSessionBranches,
    mockSessionMessages,
    mockSessionParticipants,
    mockSessions,
    mockSessionMonitor,
    mockSessionRuns,
    sessionsOfWorkspace,
    workspacelessSessions,
} from "./data/sessions";
// task-449 / D-1287（D-1281 同形）：工作区智能体夹具 —— capSource 四态 + 记忆/角色绑定 + 写面判定。
import { handleWorkspaceAgentResource } from "./data/workspaceAgents";
import {
    handleProviderConnectionResource,
    mockModelCatalogResponse,
} from "./data/providerConnections";
import { isDeniedPreviewMode, mockPermissionProjection } from "./data/previewPermissions";
import {
    MOCK_ORG_UNITS,
    MOCK_ORG_UNIT_MEMBERS,
    mockOrgUnitDescendants,
    mockOrgUnitSearch,
} from "./data/orgUnits";
import {
    mockCredentialEvents,
    mockCredentialList,
    mockCredentialReferences,
    mockMcpServerStatus,
    mockStdioServers,
} from "./data/resourceReadFaces";
import {
    deleteNode,
    isMockFsError,
    listDirectory,
    makeDirectory,
    readFileRange,
    readFileText,
    transferNode,
    writeFile,
} from "./data/workspaceTree";

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
    // task-25 C：两个声明根（PLAN-0639 多根契约；数据面 V103 workspace_roots 已实现 ⇒ 这里只是填数据）。
    // path 是 workspace 相对路径、只用于组头显示（FileTreePanel.vue:161-166 优先取它）；
    // 文件树用的是 root 相对路径，与 path 无关（见 data/workspaceTree.ts 头注释）。
    roots: [
        { id: "mock-root-main", alias: "主根", position: 0, path: "mock/main" },
        { id: "mock-root-docs", alias: "文档根", position: 1, path: "mock/docs" },
    ],
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

type MockToolOutcome =
    | { ok: true; structured?: unknown; text?: string }
    | { ok: false; code: string; detail?: string };

/**
 * task-25 A（2026-11-13）：`/mcp` 的工具面 —— 只覆盖 UI 真会调的那 8 个工具
 * （`composables/api.ts:4354-4437` 全量枚举：list_directory / read_file / read_file_range /
 * write_file / delete_file / move_file / copy_file / mkdir）。
 *
 * 未列出的工具回 `UNKNOWN_TOOL`（对应契约 400 UNKNOWN_TOOL 语义），**不静默成功** ——
 * 静默成功会让「工具其实没实现」在 UI 上表现成一切正常。
 */
function callMockTool(name: string, args: Record<string, unknown>): MockToolOutcome {
    const rootId = typeof args.rootId === "string" ? args.rootId : undefined;
    const path = typeof args.path === "string" ? args.path : "";
    const numberArg = (value: unknown): number | undefined =>
        typeof value === "number" && Number.isFinite(value) ? value : undefined;
    switch (name) {
        case "list_directory": {
            const result = listDirectory(rootId, path);
            return isMockFsError(result)
                ? { ok: false, ...result }
                : { ok: true, structured: result };
        }
        case "read_file": {
            const result = readFileText(rootId, path);
            return isMockFsError(result)
                ? { ok: false, ...result }
                : { ok: true, text: result.content };
        }
        case "read_file_range": {
            const result = readFileRange(
                rootId,
                path,
                numberArg(args.offset),
                numberArg(args.limit),
            );
            return isMockFsError(result)
                ? { ok: false, ...result }
                : { ok: true, structured: result };
        }
        case "write_file": {
            const result = writeFile(
                rootId,
                path,
                typeof args.content === "string" ? args.content : "",
            );
            return isMockFsError(result)
                ? { ok: false, ...result }
                : { ok: true, text: result.message };
        }
        case "mkdir": {
            const result = makeDirectory(rootId, path);
            return isMockFsError(result)
                ? { ok: false, ...result }
                : { ok: true, text: result.message };
        }
        case "delete_file": {
            const result = deleteNode(rootId, path);
            return isMockFsError(result)
                ? { ok: false, ...result }
                : { ok: true, text: result.message };
        }
        case "move_file":
        case "copy_file": {
            const from = typeof args.from === "string" ? args.from : "";
            const to = typeof args.to === "string" ? args.to : "";
            const result = transferNode(rootId, from, to, name === "copy_file");
            return isMockFsError(result)
                ? { ok: false, ...result }
                : { ok: true, text: result.message };
        }
        default:
            return { ok: false, code: "UNKNOWN_TOOL", detail: name };
    }
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
                // task-240：组织成员页（/members）也是真路由真组件，同一个 dev-only 入口；
                // 不加这一段它会被 Vite 兜底成 index.html，拿不到 mock 登录态与语言固定。
                if (
                    /^\/(settings|workspace|resources|members)(\/|$)/.test(url) &&
                    !url.includes(".")
                ) {
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
                    /**
                     * task-249：权限投影搬进 `data/previewPermissions.ts`（原子清单 + 受限模式判定），
                     * 这里只做一次 dispatch。受限模式的切换通道见该文件头注释：页面 URL 带
                     * `?denied=1` ⇒ 从 `Referer` 读出来并**扣留 credential_manage**（保留 403 形态可演）。
                     */
                    const denied =
                        process.env.XIHE_UI_MOCK_DENIED === "1" ||
                        isDeniedPreviewMode(req.headers.referer);
                    options.log?.(
                        `[mock-api] /me/permissions → ${denied ? "denied（扣留 credential_manage）" : "granted"}`,
                    );
                    return respond(
                        200,
                        mockPermissionProjection({
                            capabilities: Object.keys(CAPABILITIES),
                            denied,
                        }),
                    );
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

                /**
                 * task-25 A 附（2026-11-13 实测补）：进入 `/workspace/:id` 时页面会打这两个读面，mock 缺 ⇒
                 * `WorkspaceView.vue:173` 打出 `Load workspace failed (API error 404)`，工作区存储形态
                 * 也就读不到，**文件树连锁不加载**。这不是「树端点缺失」，是「工作区详情缺失」——
                 * 树自己的通路是上面的 `/mcp`。
                 */
                if (
                    path === `/workspaces/${MOCK_WORKSPACE.id}` &&
                    (req.method ?? "GET") === "GET"
                ) {
                    return respond(200, { workspace: MOCK_WORKSPACE });
                }

                /**
                 * 工作区事件 SSE：`useWorkspaceSSE` 要求 200 + `text/event-stream`，否则顶部出现
                 * 「与实时更新的连接已断开」横幅（实测 2026-11-13）。mock 只发心跳，不发业务事件 ——
                 * 发假事件会让「文件树刷新」这类逻辑在预览里跳动，预览要的是静默一致的画面。
                 */
                if (
                    path === `/workspaces/${MOCK_WORKSPACE.id}/events` &&
                    (req.method ?? "GET") === "GET"
                ) {
                    res.statusCode = 200;
                    res.setHeader("content-type", "text/event-stream; charset=utf-8");
                    res.setHeader("cache-control", "no-cache, no-transform");
                    res.setHeader("connection", "keep-alive");
                    res.setHeader("x-accel-buffering", "no");
                    // 只保持连接、**不写任何帧**：前端的解析器把 retry 行与 SSE 注释行也当事件解析，
                    // 会打 workspace_sse_invalid_json 警告（2026-11-13 实测：每次连接 2 条）。
                    // 心跳靠 TCP 保活即可，预览要的是静默一致的画面。
                    const keepAlive = setInterval(() => {
                        if (res.writableEnded) clearInterval(keepAlive);
                    }, 25_000);
                    keepAlive.unref?.();
                    res.on("close", () => clearInterval(keepAlive));
                    return;
                }

                /**
                 * 待答问句读面（openapi:2231 `GET /api/v1/user-questions`）：`listUserQuestions`
                 * 是**严格信封**校验（`api.ts:3331-3346`），形状不符会抛错 —— 所以给合法的空集，
                 * 而不是 404 或裸数组。
                 */
                /** 嵌套仓库发现读面（PLAN-0641 F4）：形状 {workspaceId, cachedAt, items}；
                 *  mock 没有未声明的嵌套仓库，给合法空集（不是 404 —— 404 会在页面留红点）。 */
                if (
                    path === `/workspaces/${MOCK_WORKSPACE.id}/nested-repos` &&
                    (req.method ?? "GET") === "GET"
                ) {
                    return respond(200, {
                        workspaceId: MOCK_WORKSPACE.id,
                        cachedAt: new Date().toISOString(),
                        items: [],
                    });
                }

                /**
                 * PLAN-0773 M3（task-240）：组织单元读面（openapi.yaml :6040）。
                 * 形状按契约：`{ nodes }` / `{ members }` —— 不是裸数组（api.ts 的信封校验会抛）。
                 * `parentId` = 直接子级、`q` = 名搜（服务端忽略 parentId），夹具见 data/orgUnits.ts。
                 */
                if (path === "/org-units" && (req.method ?? "GET") === "GET") {
                    const parentId = url.searchParams.get("parentId");
                    const q = url.searchParams.get("q");
                    if (q) return respond(200, { nodes: mockOrgUnitSearch(q) });
                    if (parentId) {
                        return respond(200, {
                            nodes: MOCK_ORG_UNITS.filter((unit) => unit.parentId === parentId),
                        });
                    }
                    return respond(200, {
                        nodes: MOCK_ORG_UNITS.filter((unit) => unit.parentId === null),
                    });
                }
                const membersMatch = /^\/org-units\/([^/]+)\/members$/.exec(path);
                if (membersMatch && (req.method ?? "GET") === "GET") {
                    const unitId = decodeURIComponent(membersMatch[1]);
                    const includeDescendants =
                        url.searchParams.get("includeDescendants") === "true";
                    const scope = includeDescendants ? mockOrgUnitDescendants(unitId) : [unitId];
                    return respond(200, {
                        members: MOCK_ORG_UNIT_MEMBERS.filter((member) =>
                            scope.includes(member.orgUnitId),
                        ),
                    });
                }

                /** 待审批摘要（api.ts:4182）：**裸数组**，元素形状不符会被逐条判 malformed；
                 *  空数组 = 合法的「没有待审批」，与 mock 账号一致。 */
                if (path === "/approvals/pending" && (req.method ?? "GET") === "GET") {
                    return respond(200, []);
                }

                if (path === "/user-questions" && (req.method ?? "GET") === "GET") {
                    return respond(200, { items: [], pendingCount: 0 });
                }

                /**
                 * task-25 A（2026-11-13）：文件树**不走 REST**，走 MCP 工具网关 ——
                 * `stores/workspace.ts:182 fetchDirectoryTree` → `api.ts:4354` → `api.ts:2662`
                 * `callRuntimeTool` → `POST /api/v1/mcp` 的 JSON-RPC `tools/call{name:"list_directory"}`，
                 * **递归在前端**（每个目录一次调用）。所以这里补的是 `/mcp` 分派，
                 * 不是 `GET /workspaces/{id}/tree` —— 契约里没有那个面，造了就是又一条假面。
                 *
                 * 外壳与 `callRuntimeTool` 的取值顺序（`api.ts:2703-2712`）对齐：
                 * 对象结果 → `structuredContent`；字符串结果 → `content[0].text`；
                 * 工具级失败 → `result.isError=true`（不是 JSON-RPC error，前端两条通路的文案不同）。
                 */
                if (path === "/mcp" && (req.method ?? "GET") === "POST") {
                    let raw = "";
                    req.on("data", (chunk) => {
                        raw += String(chunk);
                    });
                    req.on("end", () => {
                        const sendMcp = (payload: unknown) => {
                            res.statusCode = 200;
                            res.setHeader("content-type", "application/json; charset=utf-8");
                            res.setHeader("cache-control", "no-store");
                            res.end(JSON.stringify(payload));
                        };
                        let envelope: {
                            id?: unknown;
                            jsonrpc?: unknown;
                            method?: unknown;
                            params?: { name?: unknown; arguments?: unknown };
                        };
                        try {
                            envelope = JSON.parse(raw || "{}") as typeof envelope;
                        } catch {
                            // 解析失败属协议级错误：JSON-RPC error 帧（不是 isError）。
                            sendMcp({
                                jsonrpc: "2.0",
                                id: null,
                                error: { code: -32700, message: "Parse error" },
                            });
                            return;
                        }
                        const id = envelope.id ?? null;
                        if (envelope.jsonrpc !== "2.0" || typeof envelope.method !== "string") {
                            sendMcp({
                                jsonrpc: "2.0",
                                id,
                                error: { code: -32600, message: "Invalid Request" },
                            });
                            return;
                        }
                        if (envelope.method !== "tools/call") {
                            // 前端只发 `tools/call`（api.ts:2667-2675）；`initialize`/`tools/list` 明确回 -32601，
                            // 不假装支持 —— 否则日后有人会拿 mock 当 MCP 契约证据。
                            sendMcp({
                                jsonrpc: "2.0",
                                id,
                                error: {
                                    code: -32601,
                                    message: `Method not supported by mock: ${envelope.method}`,
                                },
                            });
                            return;
                        }
                        const name = String(envelope.params?.name ?? "");
                        const args = (envelope.params?.arguments ?? {}) as Record<string, unknown>;
                        const outcome = callMockTool(name, args);
                        if (!outcome.ok) {
                            options.log?.(`[mock-api] /mcp ${name} → ${outcome.code}`);
                            sendMcp({
                                jsonrpc: "2.0",
                                id,
                                result: {
                                    content: [
                                        {
                                            type: "text",
                                            text: `${outcome.code}${outcome.detail ? `: ${outcome.detail}` : ""}`,
                                        },
                                    ],
                                    isError: true,
                                },
                            });
                            return;
                        }
                        options.log?.(`[mock-api] /mcp ${name} → ok`);
                        if (outcome.structured !== undefined) {
                            sendMcp({
                                jsonrpc: "2.0",
                                id,
                                result: {
                                    content: [
                                        { type: "text", text: JSON.stringify(outcome.structured) },
                                    ],
                                    structuredContent: outcome.structured,
                                },
                            });
                            return;
                        }
                        sendMcp({
                            jsonrpc: "2.0",
                            id,
                            result: { content: [{ type: "text", text: outcome.text ?? "" }] },
                        });
                    });
                    return;
                }

                /**
                 * PLAN-0772 task-203/task-225：三条读面原先**在 mock 车道缺失** ⇒ 真页面（`/resources/agents`、
                 * 工作台外壳）一进来就吃 404，页面上出现 `API error 404` 红条（交付图会被污染，2026-11-12 实测）。
                 *
                 * 口径：只补**读面最小合法响应**，形状对齐 openapi（`{sessions}` / `{principals}` /
                 * `{layer, workspaceId, templates}`）；列表给**合法空集**而不是假行 —— mock 账号确实没有这些数据，
                 * 给假行会把「空态」这条真实形态从预览里抹掉（V11「各层数据来自各自契约」的同一判据）。
                 */
                const methodIsGet = (req.method ?? "GET") === "GET";
                if (path === "/sessions" && methodIsGet) {
                    // `api.getSessions()`：顶层 `{sessions:[…]}`（也接受裸数组，这里按信封给）。
                    // task-373 / `D-1236` 甲案：`scope=workspaceless` 是**另一份**读面（独立会话）。
                    // task-25 D（`D-1175` 收窄重开）：**不再硬回空集** —— 空集让聊天面在 mock 车道
                    // 永远没有消息体与工具卡挂载，cp-2 `task-392` 的折行取证因此只测到「短值+已渲染」
                    // 子集（`D-1146` 上界）。夹具见 `data/sessions.ts`（形状照 openapi，长值样本齐全）。
                    // 未知 scope 仍 fail-closed 400，与 CP 同口径。
                    const sessionScope = url.searchParams.get("scope");
                    if (sessionScope !== null && sessionScope !== "workspaceless") {
                        return respond(400, { code: "INVALID_REQUEST", detail: "unknown scope" });
                    }
                    return respond(200, {
                        sessions:
                            sessionScope === "workspaceless"
                                ? workspacelessSessions()
                                : sessionsOfWorkspace(MOCK_WORKSPACE.id),
                    });
                }
                // 工作区地址的会话列表（PLAN-0608 C′：UI 走 `/workspaces/{id}/sessions`）。
                const workspaceSessionsMatch = path.match(/^\/workspaces\/([^/]+)\/sessions$/);
                if (workspaceSessionsMatch && methodIsGet) {
                    return respond(200, {
                        sessions: sessionsOfWorkspace(workspaceSessionsMatch[1]),
                    });
                }
                /**
                 * 会话子资源读面（task-25 D）。四类投影的形状照 `e2e/mock/helpers/session-projections.ts`
                 * 里 2026-11-05 对真实 CP 的逐条留档 —— 不桩它们，聊天列一挂载就是真 404 +
                 * 「Failed to load …」console error（夹具缺口会伪装成产品回归，PLAN-0660 T5.6 实测）。
                 */
                const sessionItemMatch = path.match(/^\/sessions\/([^/]+)(\/.*)?$/);
                if (sessionItemMatch && methodIsGet) {
                    const sessionId = sessionItemMatch[1];
                    const suffix = sessionItemMatch[2] ?? "";
                    const session = mockSessions.find((item) => item.id === sessionId);
                    if (!session) return respond(404, { code: "SESSION_NOT_FOUND" });
                    if (suffix === "") return respond(200, session);
                    if (suffix === "/messages") {
                        // 契约（openapi listMessages）：无 limit/before ⇒ **裸数组**（legacy 全量、升序）。
                        return respond(200, mockSessionMessages[sessionId] ?? []);
                    }
                    if (suffix === "/branches") {
                        return respond(200, {
                            sessionId,
                            items: mockSessionBranches[sessionId] ?? [],
                        });
                    }
                    if (suffix === "/participants") {
                        return respond(200, {
                            participants: mockSessionParticipants,
                            capabilities: {
                                view: true,
                                manage: true,
                                mention: true,
                                speakAs: true,
                            },
                        });
                    }
                    if (suffix === "/derived-state") {
                        return respond(200, {
                            sessionId,
                            activeChildren: [],
                            terminalNotices: [],
                        });
                    }
                    if (suffix === "/follow-ups") {
                        return respond(200, {
                            sessionId,
                            queueState: "empty",
                            outstandingCount: 0,
                            capacityLimit: 5,
                            pauseReason: null,
                            items: [],
                        });
                    }
                    if (suffix === "/commands") {
                        return respond(200, {
                            commands: [
                                {
                                    name: "/export",
                                    source: "builtin",
                                    available: true,
                                    reason: null,
                                },
                                {
                                    name: "/compact",
                                    source: "builtin",
                                    available: true,
                                    reason: null,
                                },
                            ],
                        });
                    }
                    return respond(404, { code: "MOCK_ENDPOINT_MISSING", detail: suffix });
                }
                /**
                 * task-25 D 附（**浏览器实测补**）：会话一旦真的能点开，聊天面还会打这 5 条读面。
                 * 此前 `sessions=[]` 让聊天面永远打不开，于是这些缺口被空集掩盖了 —— 夹具一富化就照出来：
                 * runs / monitor / policy-mode / checkpoints / 会话级 SSE。形状来源：
                 * `e2e/mock/helpers/auth.ts` 对真实 CP 的留档（runs / monitor / policy）与 `api.ts` 的解析器
                 * （checkpoints 是**裸数组**、policy/mode 严格校验 sessionId + mode enum）。
                 */
                const chatSessionMatch = path.match(/^\/chat\/sessions\/([^/]+)\/(runs|monitor)$/);
                if (chatSessionMatch && methodIsGet) {
                    const sessionId = chatSessionMatch[1];
                    if (chatSessionMatch[2] === "runs") {
                        return respond(200, {
                            sessionId,
                            page: Number(url.searchParams.get("page") ?? 0),
                            size: Number(url.searchParams.get("size") ?? 100),
                            runs: mockSessionRuns(sessionId),
                        });
                    }
                    return respond(200, mockSessionMonitor(sessionId));
                }
                if (path === "/policy/mode" && methodIsGet) {
                    // 严格校验：sessionId 必须回显请求里的那个，mode ∈ {manual, auto}（api.ts:1948）。
                    return respond(200, {
                        sessionId: url.searchParams.get("sessionId") ?? "",
                        mode: "manual",
                        sessionRules: 0,
                    });
                }
                const checkpointsMatch = path.match(/^\/workspaces\/([^/]+)\/checkpoints$/);
                if (checkpointsMatch && methodIsGet) {
                    // api.listWorkspaceCheckpoints 要求**裸数组**（不是信封）；预览没有检查点 ⇒ 合法空集。
                    return respond(200, []);
                }
                const contextSourcesMatch = path.match(/^\/context\/([^/]+)\/sources$/);
                if (contextSourcesMatch && methodIsGet) {
                    // U1 上下文来源：**只给元数据、永不带正文**（契约 openapi:4197 与 CP
                    // ContextPublicController:66-68 同口径）。mock 没有真实上下文快照 ⇒ status 用
                    // CP 自己的缺省 "unknown"、hashPrefix 空串，而不是编一个看起来像已加载的值。
                    return respond(200, {
                        sourceKey: "AGENTS.md",
                        status: "unknown",
                        hashPrefix: "",
                    });
                }
                if (path === "/events" && methodIsGet) {
                    // 会话级 SSE：与工作区事件同口径 —— 只保活、**不写任何帧**（retry 行与注释行都会被
                    // 前端解析器当事件，打 invalid_json 警告，2026-11-13 实测）。404 更不行：
                    // fetch-event-source 对 404 会无限退避重连把日志刷满。
                    res.statusCode = 200;
                    res.setHeader("content-type", "text/event-stream; charset=utf-8");
                    res.setHeader("cache-control", "no-cache, no-transform");
                    res.setHeader("connection", "keep-alive");
                    res.setHeader("x-accel-buffering", "no");
                    const sessionKeepAlive = setInterval(() => {
                        if (res.writableEnded) clearInterval(sessionKeepAlive);
                    }, 25_000);
                    sessionKeepAlive.unref?.();
                    res.on("close", () => clearInterval(sessionKeepAlive));
                    return;
                }
                if (path === "/agent-principals" && methodIsGet) {
                    // `api.listMyAgentPrincipals()`：`{principals:[…]}`；个人视图只回 `created_by=self`。
                    return respond(200, { principals: [] });
                }
                /**
                 * task-449 / D-1287：这里原先回 `{agents:[]}`（task-225 补的合法空集）。空集让
                 * `WorkspaceAgentsPanel` 在 mock 车道**没有行可渲染** ⇒ task-417 的「冻结上限快照」标注与
                 * `capSource` 来源徽标拿不到浏览器证据，且面板消费的 21 条面里缺哪些**看不见**
                 * （D-1281：空集不是没有缺口，是看不见缺口）。现在改夹具驱动：六行覆盖 capSource 四态
                 * （explicit 非空 / explicit 空=零权限 / baseline 空=继承 / 缺省=旧响应）+ disabled + bound=false。
                 * 判定与内存集合在 `data/workspaceAgents.ts`，这里只做一次 dispatch（与 instance/skills 同形）。
                 * 未知 suffix 仍回 404 `MOCK_ENDPOINT_MISSING`，**不做通配 200**。
                 */
                if (
                    /^\/workspaces\/[^/]+\/agents(\/|$)/.test(path) ||
                    /^\/agent-principals(\/|$)/.test(path) ||
                    path === "/roles"
                ) {
                    const agentMethod = req.method ?? "GET";
                    const readAgentBody = (): Promise<Record<string, unknown>> =>
                        new Promise((resolveBody) => {
                            let raw = "";
                            req.on("data", (chunk: unknown) => {
                                raw += String(chunk);
                            });
                            req.on("end", () => {
                                try {
                                    resolveBody(
                                        raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
                                    );
                                } catch {
                                    resolveBody({});
                                }
                            });
                        });
                    // 个人主体列表（`GET /agent-principals`）形状不变：本模块只接写面与子资源。
                    if (agentMethod === "GET" && path === "/agent-principals") {
                        return respond(200, { principals: [] });
                    }
                    void handleWorkspaceAgentResource(agentMethod, path, url, readAgentBody)
                        .then((result) => {
                            if (!result) {
                                return respond(404, {
                                    type: "about:blank",
                                    title: "Not Found",
                                    status: 404,
                                    code: "MOCK_ENDPOINT_MISSING",
                                    requestId: "mock-request",
                                });
                            }
                            options.log?.(`[mock-api] ${agentMethod} ${path} → ${result.status}`);
                            return result.status === 204
                                ? respond(204, null)
                                : respond(result.status, result.body);
                        })
                        .catch((cause: unknown) => {
                            options.log?.(
                                `[mock-api] ${agentMethod} ${path} 处理失败：${String(cause)}`,
                            );
                            respond(500, {
                                code: "MOCK_HANDLER_FAILED",
                                requestId: "mock-request",
                            });
                        });
                    return;
                }
                if (path === "/agent-templates" && methodIsGet) {
                    // `api.getAgentTemplates(layer, workspaceId)`：`AgentTemplateLayerResponse`。
                    // `layer` 原样回显（调用方要么按 `layer=workspace` 要，要么拿 instance 层）。
                    const layer = url.searchParams.get("layer");
                    return respond(200, {
                        layer: layer === "user" || layer === "workspace" ? layer : "instance",
                        workspaceId: url.searchParams.get("workspaceId"),
                        templates: [],
                    });
                }
                // task-49（Lead 2026-11-11 扩授权）：工作区环境页的读取面。
                // 原先只 mock 了 /workspaces 与 /workspaces/current ⇒ 环境页吃 404、Job 三列不渲染。
                // 这里**只增**两条读端点，既有两条的返回结构不动；夹具见 data/workspaceEnvironment.ts。
                const environmentMatch = path.match(/^\/workspaces\/([^/]+)\/environment$/);
                if (environmentMatch && (req.method ?? "GET") === "GET") {
                    options.log?.("[mock-api] GET workspace environment → fixtures");
                    return respond(200, mockWorkspaceEnvironment(environmentMatch[1]));
                }
                const jobsMatch = path.match(/^\/workspaces\/([^/]+)\/jobs$/);
                if (jobsMatch && (req.method ?? "GET") === "GET") {
                    return respond(200, mockWorkspaceJobs(jobsMatch[1]));
                }
                // task-83：实例层 Skills 页的读面（`GET /skills` 默认 definitionScope=instance）。
                // 列表**不带 body**；正文只在 `?includeBody=true` 时给 —— 与 openapi 一致，
                // 免得页面在 mock lane 上养成「列表就有正文」的错误假设。
                if (path === "/skills" && (req.method ?? "GET") === "GET") {
                    // PLAN-0772 M2：`definitionScope=workspace` 是**另一个层**的读面（`getWorkspaceSkills`），
                    // 早先这里不分 scope 一律回实例定义 ⇒ 技能「本工作区」页会显示实例行并被打上「本工作区」
                    // 徽标（拿别层数据冒充本层的典型假象）。夹具按 scope 分开回。
                    if (url.searchParams.get("definitionScope") === "workspace") {
                        return respond(
                            200,
                            mockWorkspaceSkillDefinitions(url.searchParams.get("workspaceId")),
                        );
                    }
                    return respond(200, mockSkillDefinitions());
                }
                const skillMatch = path.match(/^\/skills\/([^/]+)$/);
                if (skillMatch && (req.method ?? "GET") === "GET") {
                    const includeBody = url.searchParams.get("includeBody") === "true";
                    const detail = mockSkillDefinition(
                        decodeURIComponent(skillMatch[1]),
                        includeBody,
                    );
                    if (!detail) {
                        return respond(404, {
                            type: "about:blank",
                            title: "Not Found",
                            status: 404,
                            code: "SKILL_NOT_FOUND",
                            requestId: "mock-request",
                        });
                    }
                    return respond(200, detail);
                }
                /**
                 * task-247：资源详情单页（`/resources/<id>/:pk?layer=`）要的**凭据**三条读面。
                 *
                 * <p>task-228 §7.3 报备时**故意没有**回空壳 200：空壳会让页面的 `ready` 与"夹具缺"
                 * 长得一样，等于把缺口藏起来。这里补的是真夹具（`data/resourceReadFaces.ts`），
                 * 形状照 `CredentialList` / `CredentialReferencesView` / `CredentialEventsView`。</p>
                 */
                if (path === "/credentials" && methodIsGet) {
                    return respond(200, mockCredentialList(url.searchParams.get("ownerType")));
                }
                const credentialReferencesMatch = path.match(
                    /^\/credentials\/([^/]+)\/references$/,
                );
                if (credentialReferencesMatch && methodIsGet) {
                    const references = mockCredentialReferences(
                        decodeURIComponent(credentialReferencesMatch[1]),
                    );
                    if (references === null) {
                        // 不存在的凭据 ⇒ 404（不编空集合：空集合会让"该凭据没有引用"和"凭据不存在"混淆）。
                        return respond(404, {
                            type: "about:blank",
                            title: "Not Found",
                            status: 404,
                            code: "CREDENTIAL_NOT_FOUND",
                            requestId: "mock-request",
                        });
                    }
                    return respond(200, { references });
                }
                const credentialEventsMatch = path.match(/^\/credentials\/([^/]+)\/events$/);
                if (credentialEventsMatch && methodIsGet) {
                    // limit 的 clamp 与 openapi 一致（1..500，默认 200）。
                    const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10);
                    const limit = Number.isFinite(rawLimit)
                        ? Math.min(Math.max(rawLimit, 1), 500)
                        : 200;
                    const events = mockCredentialEvents(
                        decodeURIComponent(credentialEventsMatch[1]),
                        limit,
                    );
                    if (events === null) {
                        return respond(404, {
                            type: "about:blank",
                            title: "Not Found",
                            status: 404,
                            code: "CREDENTIAL_NOT_FOUND",
                            requestId: "mock-request",
                        });
                    }
                    return respond(200, { events });
                }
                /**
                 * task-247：**MCP 工作区层**两条读面（原缺口第 4、5 条）。详情页把 pk 认作
                 * `stdio-servers` 的 `servers` 映射键，运行状态另在 `mcp/servers` 里 ——
                 * 两条都缺时页面落 `error`，只补一条会落 `ready` 但没状态字段（看似成功实则半张页）。
                 */
                const stdioServersMatch = path.match(/^\/workspaces\/([^/]+)\/stdio-servers$/);
                if (stdioServersMatch && methodIsGet) {
                    return respond(200, mockStdioServers());
                }
                const mcpServersMatch = path.match(/^\/workspaces\/([^/]+)\/mcp\/servers$/);
                if (mcpServersMatch && methodIsGet) {
                    return respond(200, mockMcpServerStatus());
                }

                // task-165：实例层三资源（D-1008：`/api/v1/instance/<资源>`）。
                // 判定与内存集合在 data/instanceResources.ts —— 这里只做一次 dispatch，
                // 免得 1000+ 行的 if 链再长 13 条。只接这三段，**不接** `/instance/` 全部：
                // `/instance/identity`、`/instance/owner` 等既有端点不能被这层抢走。
                // task-38（R1）：智能体段是 `/instance/agent-principals`（契约 openapi.yaml:4876）。
                // 旧串 `agents` 已从允许集里**删掉**而不是并存 —— 并存会让 mock 继续掩盖真栈 404。
                if (/^\/instance\/(credentials|agent-principals|mcp)(\/|$)/.test(path)) {
                    const instanceMethod = req.method ?? "GET";
                    const readJsonBody = (): Promise<Record<string, unknown>> =>
                        new Promise((resolveBody) => {
                            let raw = "";
                            req.on("data", (chunk: unknown) => {
                                raw += String(chunk);
                            });
                            req.on("end", () => {
                                try {
                                    resolveBody(
                                        raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
                                    );
                                } catch {
                                    // 坏 JSON 不该把 mock lane 打挂：按空体处理，交给判定回 400。
                                    resolveBody({});
                                }
                            });
                        });
                    void handleInstanceResource(instanceMethod, path, readJsonBody)
                        .then((result) => {
                            if (!result) {
                                return respond(404, {
                                    type: "about:blank",
                                    title: "Not Found",
                                    status: 404,
                                    code: "INSTANCE_ENDPOINT_MISSING",
                                    requestId: "mock-request",
                                });
                            }
                            options.log?.(
                                `[mock-api] ${instanceMethod} ${path} → ${result.status}`,
                            );
                            return result.status === 204
                                ? respond(204, null)
                                : respond(result.status, result.body);
                        })
                        .catch((cause: unknown) => {
                            options.log?.(
                                `[mock-api] ${instanceMethod} ${path} 处理失败：${String(cause)}`,
                            );
                            respond(500, {
                                code: "MOCK_HANDLER_FAILED",
                                requestId: "mock-request",
                            });
                        });
                    return;
                }
                // task-402 / D-1243 G2：agent 主体技能绑定（v1 principal 级路径）。
                // 实例档/工作区档由 `workspaceId` 有无派生（CP deriveScope:196），判定与内存集合
                // 在 data/agentSkillBindings.ts —— 这里只做一次 dispatch。真 HTTP 已验（stack-1）。
                if (/^\/agent-principals\/[^/]+\/skills(\/|$)/.test(path)) {
                    const bindingMethod = req.method ?? "GET";
                    const readBindingBody = (): Promise<Record<string, unknown>> =>
                        new Promise((resolveBody) => {
                            let raw = "";
                            req.on("data", (chunk: unknown) => {
                                raw += String(chunk);
                            });
                            req.on("end", () => {
                                try {
                                    resolveBody(
                                        raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
                                    );
                                } catch {
                                    resolveBody({});
                                }
                            });
                        });
                    void handleAgentSkillBinding(bindingMethod, path, url, readBindingBody)
                        .then((result) => {
                            if (!result) {
                                return respond(404, {
                                    code: "SKILL_BINDING_ENDPOINT_MISSING",
                                    requestId: "mock-request",
                                });
                            }
                            options.log?.(`[mock-api] ${bindingMethod} ${path} → ${result.status}`);
                            return result.status === 204
                                ? respond(204, null)
                                : respond(result.status, result.body);
                        })
                        .catch((cause: unknown) => {
                            options.log?.(
                                `[mock-api] ${bindingMethod} ${path} 处理失败：${String(cause)}`,
                            );
                            respond(500, {
                                code: "MOCK_HANDLER_FAILED",
                                requestId: "mock-request",
                            });
                        });
                    return;
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
                /**
                 * task-284 ②a 前置（D-1281 假可用族）：这块原先缺 `defaultApiType` 与
                 * `supportedApiTypes`（`ProviderDefinition.required` 八项里的两项，`openapi.yaml:8069`），
                 * 而 `ProviderHub:710` 读 `provider.defaultApiType.apiTypeId`、`:716` 读
                 * `supportedApiTypes.find(...)` ⇒ 点「连接」选 provider 后 `resetForm` 当场抛
                 * `Cannot read properties of undefined (reading 'apiTypeId')`，表单永不出现
                 * ⇒ **mock 车道的「新建连接」入口一直不可用**（按钮渲染了但一点就抛）。
                 *
                 * task-457（D-1304，Lead 裁同批对齐）：**改为逐字镜像 CP 真源**，不再用 mock 近似值。
                 * 真源 = `packages/control-plane/src/main/resources/provider-catalog/providers.json`
                 * （openai `:2-15`、anthropic `:16-29`、dashscope-qwen `:100-122`）。据此纠正 284 那批的
                 * 近似：`adapter` openai 是 **native-litellm**（不是 openai-compatible）、`modelDiscovery`
                 * 是 **remote-models**（不是 curated）、chat 型 `capability.vision` 是 **false**（不是 true）、
                 * `credential.placeholder` 用 CP 原文、`supports` 补 `toolsPartial`/`visionPartial`。
                 *
                 * **为什么加第三个 provider**：CP `ProviderConnectionService.create:213` 调
                 * `catalog.supportedPair(providerId, apiTypeId, version)` ⇒ **类型按 provider 约束**；
                 * CP 里唯一支持 `dashscope-multimodal-embedding` 的是 **dashscope-qwen**（providers.json:109-118），
                 * openai 只支持 openai-chat-completions（`:11`）⇒ 夹具那条 embedding 连接原先挂在 openai 上
                 * 是**非法组合**，只改 apiTypeId 会造出新漂移（runtime-1 前置核查要求）⇒ 连 providerId 一起对齐。
                 *
                 * **诚实边界（仍是 mock，不是 CP）**：① 这里只搬 CP 23 个 provider 里的 **3 个**、5 个 API Type
                 * 里的 **3 个** —— 是**子集**，不是另一套词表；② `catalogRevision: "v3"` 表示夹具带了
                 * per-API-Type tools+vision capability（契约 `:8065` 的 v3 语义），**不代表 mock 实现了 v3 全部行为**；
                 * ③ 连接的写面仍不复刻 key 唯一性 / revision CAS / 真 verify（见 data/providerConnections.ts）。
                 */
                if (path === "/provider-catalog") {
                    return respond(200, {
                        catalogRevision: "v3",
                        providers: [
                            {
                                id: "openai",
                                displayName: "OpenAI",
                                category: "recommended",
                                description: "GPT 系列模型，支持流式与工具调用。",
                                adapter: "native-litellm",
                                litellmProvider: "openai",
                                defaultBaseUrl: "https://api.openai.com/v1",
                                modelDiscovery: "remote-models",
                                supportedApiTypes: [
                                    {
                                        apiTypeId: "openai-chat-completions",
                                        version: 1,
                                        capability: { tools: true, vision: false },
                                    },
                                ],
                                defaultApiType: {
                                    apiTypeId: "openai-chat-completions",
                                    version: 1,
                                },
                                credential: {
                                    type: "api-key",
                                    required: true,
                                    placeholder: "sk-...",
                                },
                                supports: {
                                    customBaseUrl: true,
                                    streaming: true,
                                    tools: true,
                                    vision: true,
                                    toolsPartial: false,
                                    visionPartial: false,
                                },
                            },
                            {
                                id: "anthropic",
                                displayName: "Anthropic",
                                category: "recommended",
                                description: "Claude 系列模型，支持流式与工具调用。",
                                adapter: "native-litellm",
                                litellmProvider: "anthropic",
                                defaultBaseUrl: "https://api.anthropic.com/v1",
                                modelDiscovery: "remote-models",
                                supportedApiTypes: [
                                    {
                                        apiTypeId: "anthropic-messages",
                                        version: 1,
                                        capability: { tools: true, vision: false },
                                    },
                                ],
                                defaultApiType: { apiTypeId: "anthropic-messages", version: 1 },
                                credential: {
                                    type: "api-key",
                                    required: true,
                                    placeholder: "sk-ant-...",
                                },
                                supports: {
                                    customBaseUrl: true,
                                    streaming: true,
                                    tools: true,
                                    vision: true,
                                    toolsPartial: false,
                                    visionPartial: false,
                                },
                            },
                            {
                                id: "dashscope-qwen",
                                displayName: "通义千问 Qwen",
                                category: "recommended",
                                description: "阿里云百炼 Qwen 系列，兼容模式接入。",
                                adapter: "native-litellm",
                                litellmProvider: "dashscope",
                                defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
                                modelDiscovery: "remote-models",
                                supportedApiTypes: [
                                    {
                                        apiTypeId: "openai-chat-completions",
                                        version: 1,
                                        capability: { tools: true, vision: true },
                                    },
                                    {
                                        apiTypeId: "dashscope-multimodal-embedding",
                                        version: 1,
                                        defaultBaseUrl: "https://dashscope.aliyuncs.com/api/v1",
                                        modelDiscovery: "manual",
                                        capability: { tools: false, vision: false },
                                    },
                                ],
                                defaultApiType: {
                                    apiTypeId: "openai-chat-completions",
                                    version: 1,
                                },
                                credential: {
                                    type: "api-key",
                                    required: true,
                                    placeholder: "sk-...",
                                },
                                supports: {
                                    customBaseUrl: true,
                                    streaming: true,
                                    tools: true,
                                    vision: true,
                                    toolsPartial: true,
                                    visionPartial: true,
                                },
                            },
                        ],
                    });
                }
                /**
                 * task-454 / D-1301：这里原先是**无方法守卫**的静态列表 ⇒ POST 也回 200 + 原样三行
                 * （假保存：UI 弹「已保存」而列表不变，验「能建连接」必假绿），且三行 scope 是小写
                 * `instance`（CP 枚举与 `ProviderScope` 都是大写）⇒ 全被渲染成「User」徽标。
                 * 现在夹具与写面都在 `data/providerConnections.ts`，这里只做一次 dispatch
                 * （与 task-449 的工作区智能体同形）。未知 suffix 仍 404 `MOCK_ENDPOINT_MISSING`。
                 */
                if (/^\/provider-connections(\/|$)/.test(path)) {
                    const connMethod = req.method ?? "GET";
                    const readConnBody = (): Promise<Record<string, unknown>> =>
                        new Promise((resolveBody) => {
                            let raw = "";
                            req.on("data", (chunk: unknown) => {
                                raw += String(chunk);
                            });
                            req.on("end", () => {
                                try {
                                    resolveBody(
                                        raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
                                    );
                                } catch {
                                    resolveBody({});
                                }
                            });
                        });
                    void handleProviderConnectionResource(connMethod, path, url, readConnBody)
                        .then((result) => {
                            if (!result) {
                                return respond(404, {
                                    type: "about:blank",
                                    title: "Not Found",
                                    status: 404,
                                    code: "MOCK_ENDPOINT_MISSING",
                                    requestId: "mock-request",
                                });
                            }
                            options.log?.(`[mock-api] ${connMethod} ${path} → ${result.status}`);
                            return result.status === 204
                                ? respond(204, null)
                                : respond(result.status, result.body);
                        })
                        .catch((cause: unknown) => {
                            options.log?.(
                                `[mock-api] ${connMethod} ${path} 处理失败：${String(cause)}`,
                            );
                            respond(500, {
                                code: "MOCK_HANDLER_FAILED",
                                requestId: "mock-request",
                            });
                        });
                    return;
                }
                if (path === "/models") {
                    // task-454：目录与连接夹具同源（key = connectionId，条目带 connectionId），
                    // 新建连接的手填模型走 verify 回显，不在这里另造一份名字。
                    return respond(200, mockModelCatalogResponse());
                }
                /**
                 * task-457：API Type 注册表同样**逐字镜像 CP**
                 * （`control-plane/src/main/resources/api-input-types/api-input-types.json`）。
                 * 旧值有两处漂移：`openai-chat` 在 CP 不存在（真名 **openai-chat-completions**），
                 * 且 `path`/`requestShape`/`responseShape`/`streamShape` 是 mock 自造的简写
                 * （CP 的 path 不含 `/v1` 前缀，前缀由 **requiredBaseSuffix** 承载）。
                 * 同批补 `requiredBaseSuffix` —— 它是契约 **required** 字段（`openapi.yaml:8050/:8057`），
                 * 旧 mock 漏了它（UI `types/providerConnection.ts:51-60 ApiInputType` 也漏，已另报 Lead）。
                 * 只搬夹具用得到的 3 型（CP 共 5 型）：**子集，不是另一套词表**。
                 */
                if (path === "/api-input-types") {
                    return respond(200, {
                        types: [
                            {
                                apiTypeId: "openai-chat-completions",
                                version: 1,
                                operation: "chat",
                                method: "POST",
                                path: "/chat/completions",
                                requiredBaseSuffix: "/v1",
                                requestShape:
                                    "messages, model, stream, tools, temperature, max_tokens",
                                responseShape: "choices, usage",
                                streamShape: "chat.completion.chunk",
                            },
                            {
                                apiTypeId: "anthropic-messages",
                                version: 1,
                                operation: "chat",
                                method: "POST",
                                path: "/messages",
                                requiredBaseSuffix: "/v1",
                                requestShape: "messages, model, stream, tools, max_tokens",
                                responseShape: "content, usage",
                                streamShape: "message.delta",
                            },
                            {
                                apiTypeId: "dashscope-multimodal-embedding",
                                version: 1,
                                operation: "embedding",
                                method: "POST",
                                path: "/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding",
                                requiredBaseSuffix: "/api/v1",
                                requestShape: "model, input.contents, parameters.dimension",
                                responseShape: "output.embeddings, usage, requestId",
                                streamShape: "none",
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
                        const instanceEntries = entriesFor(domain);
                        const instanceMemory = memoryFor("instance", domain);
                        const userMemory = memoryFor("user", domain);
                        const workspaceDefaultMemory = memoryFor("workspace-default", domain);
                        /**
                         * task-25 B1（2026-11-13）：原实现把 `source` 恒填 `"code"`，两个问题 ——
                         * ① `"code"` **不在契约枚举里**（openapi:6357 只有 instance|user|workspace-default|workspace|env|default）；
                         * ② 恒值 ⇒ 「谁覆盖了这个键」在实例页**永远显示不出来**，是个「看起来正常、其实永远为假」的信号。
                         * 现按契约逐字（openapi:6357「Resolved provenance of the value」）给**解析后的来源**，
                         * 优先级与产品自述的层序一致：workspace-default > user > instance > default（mock 无 env overlay）。
                         * 键集合取三层并集：只在 user 层存在的覆盖键也要出现，否则「被覆盖」这件事在实例页没有落点。
                         */
                        const resolvedSource = (key: string): string => {
                            if (Object.prototype.hasOwnProperty.call(workspaceDefaultMemory, key)) {
                                return "workspace-default";
                            }
                            if (Object.prototype.hasOwnProperty.call(userMemory, key))
                                return "user";
                            if (Object.prototype.hasOwnProperty.call(instanceMemory, key))
                                return "instance";
                            if (Object.prototype.hasOwnProperty.call(instanceEntries, key))
                                return "instance";
                            return "default";
                        };
                        const allKeys = Array.from(
                            new Set([
                                ...Object.keys(instanceEntries),
                                ...Object.keys(instanceMemory),
                                ...Object.keys(userMemory),
                                ...Object.keys(workspaceDefaultMemory),
                            ]),
                        );
                        const keys = allKeys.map((key) => ({
                            key,
                            source: resolvedSource(key),
                            locked: false,
                            writable: true,
                            reason: null,
                            instanceEligible: true,
                            defaultPresent: true,
                            overridable: true,
                            // 契约 required（openapi:6354）里还有 adminLocked —— 原实现整个字段都缺。
                            adminLocked: false,
                            lockReason: null,
                        }));
                        const overriddenCount = keys.filter(
                            (item) => item.source === "user" || item.source === "workspace-default",
                        ).length;
                        options.log?.(
                            `[mock-api] GET /config/${domain}/meta?layer=${layer} → ${keys.length} 键，其中 ${overriddenCount} 键被上层覆盖`,
                        );
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
