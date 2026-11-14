import { Readable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { mockApiPlugin } from "../api-server";
import { API_REQUEST_TEMPLATE_FIXTURE } from "../data/apiRequestTemplates";
import {
    mockModelCatalogResponse,
    providerConnectionRows,
    resetProviderConnectionFixture,
} from "../data/providerConnections";

/**
 * task-454 / D-1301 的机器判据。承重的是**假成功反例**：旧实现 `POST /provider-connections`
 * 回 200 + 原样静态列表（无方法守卫），UI 弹「已保存」而列表不变 ⇒ 谁拿它验「能建连接」都假绿。
 * 所以这里不只断言状态码，**每条写面都断言 GET 回读真的变了**（+1 / −1 / label 变 / revision 递增）。
 *
 * <p>另钉：scope 大写对齐 CP 枚举、≥2 条 INSTANCE chat 连接各带 ≥2 个 chat 模型（task-284 判据②a
 * 的数据面前置）、`/models` 的 key = connectionId 且条目带 connectionId（`ProviderHub:312-313` 的取法）、
 * 15 个字段齐（runtime-1 复核清单①）、未知 id 用 CP 原码 404、未知 suffix 仍 404 不通配。</p>
 */

interface Captured {
    status: number;
    body: unknown;
}

type ApiHandler = (req: unknown, res: unknown) => void;

function mountApiHandler(): ApiHandler {
    let handler: ApiHandler | null = null;
    const plugin = mockApiPlugin();
    const server = {
        middlewares: {
            use: (first: unknown, second?: unknown) => {
                if (first === "/api/v1" && typeof second === "function") {
                    handler = second as ApiHandler;
                }
            },
        },
    };
    (plugin as unknown as { configureServer: (s: unknown) => void }).configureServer(server);
    if (!handler) throw new Error("mock api middleware 未注册");
    return handler;
}

function call(handler: ApiHandler, url: string, method = "GET", body?: unknown): Promise<Captured> {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? [] : [JSON.stringify(body)];
        const req = Readable.from(payload);
        const reqAny = req as unknown as Record<string, unknown>;
        reqAny.method = method;
        reqAny.url = url;
        reqAny.headers = {};
        const res = {
            statusCode: 200,
            headers: {} as Record<string, string>,
            setHeader(key: string, value: string) {
                this.headers[key] = value;
            },
            end(text?: string) {
                try {
                    resolve({
                        status: (this as unknown as { statusCode: number }).statusCode,
                        body: text ? JSON.parse(text) : null,
                    });
                } catch (cause) {
                    reject(cause);
                }
            },
        };
        handler(req, res);
    });
}

const handler = mountApiHandler();
const LIST = "/provider-connections";
const rows = (body: unknown) =>
    (body as { connections: Array<Record<string, unknown>> }).connections;
const chatRows = (body: unknown) => rows(body).filter((row) => row.operation === "chat");

function createInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        providerId: "anthropic",
        connectionKey: "probe-created",
        apiTypeId: "anthropic-messages",
        apiTypeVersion: 1,
        label: "探针新建连接",
        scope: "INSTANCE",
        baseUrl: "",
        modelDiscovery: "manual",
        manualModels: ["probe-model-a", "probe-model-b"],
        apiKey: "probe-key",
        ...overrides,
    };
}

beforeEach(() => {
    resetProviderConnectionFixture();
});

describe("mock provider 连接夹具被路由消费（task-454）", () => {
    it("GET 回四行，scope 全大写 INSTANCE（不再是小写 instance 被当 USER 徽标）", async () => {
        const answer = await call(handler, LIST);
        expect(answer.status).toBe(200);
        expect(rows(answer.body)).toEqual(providerConnectionRows());
        expect(rows(answer.body).length).toBe(4);
        for (const row of rows(answer.body)) {
            expect(row.scope).toBe("INSTANCE");
        }
    });

    it("≥2 条 INSTANCE chat 连接，且各带 ≥2 个 chat 模型（task-284 判据②a 数据面）", async () => {
        const answer = await call(handler, LIST);
        const chat = chatRows(answer.body);
        expect(chat.length).toBeGreaterThanOrEqual(2);
        const catalog = (await call(handler, "/models")).body as {
            providers: Record<
                string,
                {
                    connectionId: string;
                    models: Array<{ name: string; capabilities: Record<string, boolean> }>;
                }
            >;
        };
        for (const row of chat) {
            const entry = catalog.providers[String(row.id)];
            expect(entry, String(row.id)).toBeDefined();
            expect(entry.connectionId).toBe(row.id);
            const chatModels = entry.models.filter((model) => model.capabilities.chat === true);
            expect(chatModels.length).toBeGreaterThanOrEqual(2);
        }
    });

    it("每行 15 个字段齐（runtime-1 复核清单①），且 /models 的 key 就是行 id", async () => {
        const required = [
            "id",
            "providerId",
            "connectionKey",
            "apiTypeId",
            "apiTypeVersion",
            "operation",
            "label",
            "scope",
            "baseUrl",
            "modelDiscovery",
            "manualModels",
            "hasKey",
            "enabled",
            "status",
            "revision",
        ];
        const answer = await call(handler, LIST);
        for (const row of rows(answer.body)) {
            for (const key of required) expect(row, key).toHaveProperty(key);
        }
        const catalog = mockModelCatalogResponse();
        for (const [key, entry] of Object.entries(catalog.providers)) {
            expect(entry.connectionId).toBe(key);
            expect(rows(answer.body).some((row) => row.id === key)).toBe(true);
        }
    });

    /**
     * 判据前提被 task-457 裁定改过，这里**明写为什么改**，不是为了让红变绿：
     * 旧判据是「embedding / image 两行模型目录逐字保留（加行不改现有行）」—— 那是 454 期间
     * 「不动 runtime-1 已复核的行」的承诺。457 裁定 `operation: image` 非法（CP 加载注册表即拒），
     * 该行改 chat ⇒ **它现在是 chat 型连接**，继续钉「只有一个 image 模型」等于钉住一个非法状态。
     * 新判据：① 未受影响的主连接逐字不变；② 该行**保留** gpt-image-1 的 image 能力（图像语义搬到模型能力上）；
     * ③ 该行同时带 ≥2 个 chat 模型（否则「chat 连接选不出对话模型」是新的假可用，D-1281 同族）。
     */
    it("主连接模型目录逐字不变；image 行改 chat 后保留图像模型且带 ≥2 个 chat 模型", async () => {
        const catalog = mockModelCatalogResponse();
        expect(catalog.providers["conn-claude-primary"].models.map((m) => m.name)).toEqual([
            "claude-sonnet-4-5",
            "claude-haiku-4-5",
        ]);
        // **精确相等，不用成员匹配**（runtime-1 复核指出 toContainEqual 是放宽）：数据按裁定合法变化时
        // 正确做法是**更新期望值**而不是降低匹配强度 —— 否则该行从此失去「多余模型 / 能力被改」的检出能力。
        expect(catalog.providers["conn-image-primary"].models).toEqual([
            { name: "gpt-4o", capabilities: { chat: true } },
            { name: "gpt-4o-mini", capabilities: { chat: true } },
            { name: "gpt-image-1", capabilities: { image: true } },
        ]);
    });

    it("POST 真的落库：201 回裸连接，且 GET 回读多一行（旧实现 200 但行数不变 = 假成功）", async () => {
        const before = rows((await call(handler, LIST)).body).length;
        const created = await call(handler, LIST, "POST", createInput());
        expect(created.status).toBe(201);
        const row = created.body as Record<string, unknown>;
        // 裸对象，不是 {connection:…} 信封（providerConnectionService.ts:77-84）。
        expect(row.connectionKey).toBe("probe-created");
        expect(row.scope).toBe("INSTANCE");
        expect(row.status).toBe("UNVERIFIED");
        expect(row.revision).toBe(1);
        const after = rows((await call(handler, LIST)).body);
        expect(after.length).toBe(before + 1);
        expect(after.some((item) => item.id === row.id)).toBe(true);
    });

    it("POST 缺必填 / scope 非法 ⇒ 400 INVALID_REQUEST，且不落库", async () => {
        const before = rows((await call(handler, LIST)).body).length;
        const missing = await call(handler, LIST, "POST", { providerId: "anthropic" });
        expect(missing.status).toBe(400);
        expect((missing.body as { code: string }).code).toBe("INVALID_REQUEST");
        const badScope = await call(handler, LIST, "POST", createInput({ scope: "instance" }));
        expect(badScope.status).toBe(400);
        expect(rows((await call(handler, LIST)).body).length).toBe(before);
    });

    it("PATCH 真的改值：label 变 + revision 递增 + 行数不变；未知 id ⇒ 404 CP 原码", async () => {
        const url = LIST + "/conn-claude-primary";
        const patched = await call(handler, url, "PATCH", { label: "改名后的主连接" });
        expect(patched.status).toBe(200);
        expect((patched.body as { label: string }).label).toBe("改名后的主连接");
        expect((patched.body as { revision: number }).revision).toBe(2);
        const after = rows((await call(handler, LIST)).body);
        expect(after.length).toBe(4);
        expect(after.find((row) => row.id === "conn-claude-primary")?.label).toBe("改名后的主连接");
        const unknown = await call(handler, LIST + "/nope", "PATCH", { label: "x" });
        expect(unknown.status).toBe(404);
        expect((unknown.body as { code: string }).code).toBe("PROVIDER_CONNECTION_NOT_FOUND");
    });

    it("DELETE 回 204 且真的少一行；未知 id ⇒ 404（不再 200 假成功）", async () => {
        const removed = await call(handler, LIST + "/conn-claude-secondary", "DELETE");
        expect(removed.status).toBe(204);
        const after = rows((await call(handler, LIST)).body);
        expect(after.length).toBe(3);
        expect(after.some((row) => row.id === "conn-claude-secondary")).toBe(false);
        const unknown = await call(handler, LIST + "/nope", "DELETE");
        expect(unknown.status).toBe(404);
        expect((unknown.body as { code: string }).code).toBe("PROVIDER_CONNECTION_NOT_FOUND");
    });

    it("verify 回 {connection, models}：有 key ⇒ READY，模型名与目录一致（UI 建改后立刻调它）", async () => {
        const answer = await call(handler, LIST + "/conn-claude-primary/verify", "POST");
        expect(answer.status).toBe(200);
        const body = answer.body as {
            connection: Record<string, unknown>;
            models: Array<{ name: string }>;
        };
        expect(body.connection.status).toBe("READY");
        expect(body.models.map((model) => model.name)).toEqual([
            "claude-sonnet-4-5",
            "claude-haiku-4-5",
        ]);
    });

    it("新建手填模型连接：verify 回手填模型（目录里没有它，不跨连接借模型）", async () => {
        const created = await call(handler, LIST, "POST", createInput());
        const id = (created.body as { id: string }).id;
        const verified = await call(handler, LIST + "/" + id + "/verify", "POST");
        const body = verified.body as {
            connection: Record<string, unknown>;
            models: Array<{ name: string }>;
        };
        expect(body.connection.status).toBe("READY");
        expect(body.models.map((model) => model.name)).toEqual(["probe-model-a", "probe-model-b"]);
    });

    it("delete-impact 回 12 字段（计数恒 0 是 mock 局限）；未知 id ⇒ 404", async () => {
        const answer = await call(handler, LIST + "/conn-claude-primary/delete-impact");
        expect(answer.status).toBe(200);
        const body = answer.body as Record<string, unknown>;
        expect(Object.keys(body).sort()).toEqual(
            [
                "bindingCount",
                "bindingUserScopes",
                "blocked",
                "connectionId",
                "connectionKey",
                "defaultTemplateRef",
                "profileCount",
                "profileScopes",
                "providerId",
                "sessionCount",
            ].sort(),
        );
        expect(body.connectionId).toBe("conn-claude-primary");
        expect(body.blocked).toBe(false);
        const unknown = await call(handler, LIST + "/nope/delete-impact");
        expect(unknown.status).toBe(404);
    });

    it("未实现的 suffix 仍回 null ⇒ 上层 404 MOCK_ENDPOINT_MISSING（不做通配 200）", async () => {
        // task-459 前本用例拿 `api-type-change-impact` 当「未实现」的例子；那条现已实现（回 200）
        // ⇒ 换成**真正未知**的 suffix，三条判据（404 / CP 侧不懂的 code / 不通配 200）原样保留。
        // 这是 D-1319「数据/产品变了就改期望」而不是放宽：新 suffix 永远不该被实现。
        const answer = await call(handler, LIST + "/conn-claude-primary/not-a-real-suffix");
        expect(answer.status).toBe(404);
        expect((answer.body as { code: string }).code).toBe("MOCK_ENDPOINT_MISSING");
    });

    it("写面方法守卫：列表只接 GET/POST，item 只接 PATCH/DELETE（其余 ⇒ 404 不是 200）", async () => {
        expect((await call(handler, LIST, "PUT", createInput())).status).toBe(404);
        expect((await call(handler, LIST + "/conn-claude-primary", "POST")).status).toBe(404);
        expect((await call(handler, LIST + "/conn-claude-primary/verify", "GET")).status).toBe(404);
    });

    it("复位回到种子四行（写面不污染下一个用例）", async () => {
        await call(handler, LIST, "POST", createInput());
        await call(handler, LIST + "/conn-claude-primary", "DELETE");
        resetProviderConnectionFixture();
        const after = rows((await call(handler, LIST)).body);
        expect(after.length).toBe(4);
        expect(after.some((row) => row.id === "conn-claude-primary")).toBe(true);
    });
});

/**
 * task-284 ②a 的 mock 前置（Lead 裁②）：`/provider-catalog` 的形状判据。
 *
 * <p>为什么在这里钉：浏览器实测点「连接」选 provider 后表单**永不出现**，pageerror =
 * `Cannot read properties of undefined (reading 'apiTypeId')` —— mock 的两个 provider 缺
 * `defaultApiType` 与 `supportedApiTypes`，而 `ProviderHub:710/:716` 直接读它们 ⇒ `resetForm` 抛。
 * 即 **mock 车道的「新建连接」入口一直不可用**（按钮渲染了但一点就抛，D-1281 假可用族）。</p>
 *
 * <p>判据照契约 `openapi.yaml:8061-8120`，不发明字段：`ProviderDefinition.required` 八项、
 * `supportedApiTypes` minItems 1、`defaultApiType` 必须是 `supportedApiTypes` 里的一对、
 * `catalogRevision` enum `[v1,v2,v3]`（旧值 `mock-1` 不在 enum 内）、`credential.type` enum
 * `[api-key,none]`（旧值 `api_key` 不在 enum 内）、`ProviderSupports.required` = customBaseUrl+streaming
 * （旧形状 `{chat,embedding,image}`  entirely 不是契约字段）。</p>
 */
describe("mock provider 目录形状照契约（task-284 ②a 前置）", () => {
    const REQUIRED = [
        "id",
        "displayName",
        "adapter",
        "modelDiscovery",
        "credential",
        "supports",
        "supportedApiTypes",
        "defaultApiType",
    ];

    it("GET /provider-catalog：catalogRevision 在 enum 内，两个 provider 八项必填齐", async () => {
        const answer = await call(handler, "/provider-catalog");
        expect(answer.status).toBe(200);
        const body = answer.body as {
            catalogRevision: string;
            providers: Array<Record<string, unknown>>;
        };
        expect(["v1", "v2", "v3"]).toContain(body.catalogRevision);
        expect(body.providers.length).toBeGreaterThanOrEqual(2);
        for (const provider of body.providers) {
            for (const key of REQUIRED) expect(provider, key).toHaveProperty(key);
        }
    });

    it("defaultApiType 是 supportedApiTypes 里的一对，且类型 id 与 /api-input-types 同源", async () => {
        const catalog = (await call(handler, "/provider-catalog")).body as {
            providers: Array<{
                id: string;
                defaultApiType: { apiTypeId: string; version: number };
                supportedApiTypes: Array<{ apiTypeId: string; version: number }>;
            }>;
        };
        const types = (await call(handler, "/api-input-types")).body as {
            types: Array<{ apiTypeId: string; version: number }>;
        };
        for (const provider of catalog.providers) {
            expect(provider.supportedApiTypes.length).toBeGreaterThanOrEqual(1);
            const pair = provider.defaultApiType;
            expect(pair.apiTypeId).toBeTruthy();
            expect(pair.version).toBeGreaterThanOrEqual(1);
            expect(
                provider.supportedApiTypes.some(
                    (item) => item.apiTypeId === pair.apiTypeId && item.version === pair.version,
                ),
                provider.id + " defaultApiType 必须在 supportedApiTypes 里",
            ).toBe(true);
            for (const item of provider.supportedApiTypes) {
                expect(
                    types.types.some((type) => type.apiTypeId === item.apiTypeId),
                    provider.id + " 的 " + item.apiTypeId + " 应在 /api-input-types 里",
                ).toBe(true);
            }
        }
    });

    it("credential.type 与 supports 用契约字段（不是 api_key / {chat,embedding,image}）", async () => {
        const catalog = (await call(handler, "/provider-catalog")).body as {
            providers: Array<{
                credential: { type: string; required: boolean };
                supports: Record<string, unknown>;
            }>;
        };
        for (const provider of catalog.providers) {
            expect(["api-key", "none"]).toContain(provider.credential.type);
            expect(typeof provider.credential.required).toBe("boolean");
            expect(typeof provider.supports.customBaseUrl).toBe("boolean");
            expect(typeof provider.supports.streaming).toBe("boolean");
        }
    });
});

/**
 * task-457（D-1304 / Lead 裁同批对齐）：**mock 必须镜像 CP 真源**，不是「内部自洽就算对」。
 *
 * <p>真源（只读实读，develop）：① `ApiInputTypeService.java:21` `OPERATIONS = List.of("chat",
 * "embedding")` + `:41-49 validate()` 加载注册表即校验 ⇒ CP 启动就拒 `image`；② 注册表
 * `src/main/resources/api-input-types/api-input-types.json` 只有 5 型：openai-chat-completions /
 * anthropic-messages / mimo-responses / dashscope-multimodal-embedding / dashscope-generation；
 * ③ `ProviderConnectionService.create:213` 调 `catalog.supportedPair(providerId, apiTypeId, version)`
 * ⇒ **类型按 provider 约束**（不是全局任选）；④ `provider-catalog/providers.json` 里 openai 只支持
 * openai-chat-completions（`:11`），唯一支持 dashscope-multimodal-embedding 的是 **dashscope-qwen**
 * （`:109-118`）⇒ 「openai 的连接用 embedding 型」在 CP 是非法组合。</p>
 *
 * <p>这四条判据就是四处漂移的照妖镜：operation=image（非法枚举）、openai-chat / openai-embeddings
 * （CP 无此 id）、embedding 行挂在 openai（provider×type 非法组合）、operation 与类型不一致
 * （CP 由类型推导，客户端声明不算）。**先红后绿**，不是修完补测。</p>
 */
describe("mock provider 夹具镜像 CP 真源（task-457）", () => {
    interface CatalogShape {
        providers: Array<{
            id: string;
            supportedApiTypes: Array<{
                apiTypeId: string;
                version: number;
                capability?: { tools?: boolean; vision?: boolean };
            }>;
        }>;
    }
    interface TypesShape {
        types: Array<{ apiTypeId: string; version: number; operation: string }>;
    }

    async function faces() {
        const catalog = (await call(handler, "/provider-catalog")).body as CatalogShape;
        const types = (await call(handler, "/api-input-types")).body as TypesShape;
        const list = (await call(handler, "/provider-connections")).body as {
            connections: Array<{
                id: string;
                providerId: string;
                apiTypeId: string;
                apiTypeVersion: number;
                operation: string;
            }>;
        };
        return { catalog, types, connections: list.connections };
    }

    it("每行 operation 都在 CP 枚举 [chat, embedding] 内（image 非法）", async () => {
        const { connections } = await faces();
        for (const row of connections) {
            expect(["chat", "embedding"], row.id + " operation=" + row.operation).toContain(
                row.operation,
            );
        }
    });

    it("type id 词表用 CP 注册表真名（不是 openai-chat / openai-embeddings）", async () => {
        const { catalog, types, connections } = await faces();
        const declared = new Set(types.types.map((type) => type.apiTypeId));
        expect(declared.has("openai-chat"), "CP 无 openai-chat，真名 openai-chat-completions").toBe(
            false,
        );
        expect(declared.has("openai-embeddings"), "CP 无此型").toBe(false);
        for (const id of declared) {
            expect(
                [
                    "openai-chat-completions",
                    "anthropic-messages",
                    "mimo-responses",
                    "dashscope-multimodal-embedding",
                    "dashscope-generation",
                ],
                id,
            ).toContain(id);
        }
        for (const provider of catalog.providers) {
            for (const pair of provider.supportedApiTypes) {
                expect(declared.has(pair.apiTypeId), provider.id + " / " + pair.apiTypeId).toBe(
                    true,
                );
            }
        }
        for (const row of connections) {
            expect(declared.has(row.apiTypeId), row.id + " / " + row.apiTypeId).toBe(true);
        }
    });

    it("每行 (providerId, apiTypeId, version) 是 catalog 里的 supported pair（CP create:213 同门）", async () => {
        const { catalog, connections } = await faces();
        for (const row of connections) {
            const provider = catalog.providers.find((item) => item.id === row.providerId);
            expect(
                provider,
                row.id + " providerId=" + row.providerId + " 不在 catalog",
            ).toBeDefined();
            expect(
                provider?.supportedApiTypes.some(
                    (pair) =>
                        pair.apiTypeId === row.apiTypeId && pair.version === row.apiTypeVersion,
                ),
                row.id + " 的 provider×type 组合在 CP 非法",
            ).toBe(true);
        }
    });

    it("每行 operation 与其 API Type 的 operation 一致（CP 由类型推导，不由客户端声明）", async () => {
        const { types, connections } = await faces();
        for (const row of connections) {
            const type = types.types.find(
                (item) => item.apiTypeId === row.apiTypeId && item.version === row.apiTypeVersion,
            );
            expect(type, row.id + " 的类型不在注册表").toBeDefined();
            expect(row.operation, row.id + " operation 应与类型一致").toBe(type?.operation);
        }
    });

    it("capability 照 CP providers.json（openai/anthropic 的 chat 型 vision=false，不是 mock 拍的 true）", async () => {
        const { catalog } = await faces();
        for (const id of ["openai", "anthropic"]) {
            const provider = catalog.providers.find((item) => item.id === id);
            expect(provider, id).toBeDefined();
            expect(provider?.supportedApiTypes.length, id).toBe(1);
            const pair = provider?.supportedApiTypes[0];
            expect(pair?.capability?.tools, id + " providers.json:11/:25").toBe(true);
            expect(pair?.capability?.vision, id + " providers.json:11/:25").toBe(false);
        }
    });
});

describe("mock api-type-change-impact 面 + API 请求模板夹具（task-459）", () => {
    let handler: ApiHandler;
    beforeEach(() => {
        resetProviderConnectionFixture();
        handler = mountApiHandler();
    });

    function chatRow() {
        const row = providerConnectionRows().find((item) => item.operation === "chat");
        if (!row) throw new Error("夹具里没有 chat 连接，用例前提不成立");
        return row;
    }

    it("回契约 6 字段（openapi.yaml:8191），currentType 取行、targetType 取 query", async () => {
        const row = chatRow();
        const answer = await call(
            handler,
            `/provider-connections/${row.id}/api-type-change-impact?apiTypeId=openai-chat-completions&version=1`,
        );
        expect(answer.status).toBe(200);
        const body = answer.body as Record<string, unknown>;
        // 键集合逐一钉住：多一个字段（mock 自造）或少一个（契约 required 漏给）都红。
        expect(Object.keys(body).sort()).toEqual([
            "compatibleTemplates",
            "connectionRevision",
            "currentType",
            "incompatibleOverrides",
            "sessionRebindCount",
            "targetType",
        ]);
        expect(body.connectionRevision).toBe(row.revision);
        expect(body.currentType).toEqual({
            apiTypeId: row.apiTypeId,
            version: row.apiTypeVersion,
        });
        expect(body.targetType).toEqual({ apiTypeId: "openai-chat-completions", version: 1 });
        // mock 不建模引用：这两项是局限不是事实，钉住以免有人当「真无影响」消费。
        expect(body.incompatibleOverrides).toEqual([]);
        expect(body.sessionRebindCount).toBe(0);
    });

    it("compatibleTemplates 由已发布夹具派生：含匹配项、**不含 draft**", async () => {
        const row = chatRow();
        const answer = await call(
            handler,
            `/provider-connections/${row.id}/api-type-change-impact?apiTypeId=openai-chat-completions&version=1`,
        );
        const templates = (answer.body as { compatibleTemplates: Array<Record<string, unknown>> })
            .compatibleTemplates;
        // 非空是本卡的核心判据：空集时「选了模板才发 PATCH」的门永远过不去。
        expect(templates.length).toBeGreaterThan(0);
        const published = API_REQUEST_TEMPLATE_FIXTURE.filter(
            (item) =>
                item.status === "published" &&
                item.apiTypeId === "openai-chat-completions" &&
                item.apiTypeVersion === 1,
        );
        expect(templates.map((item) => item.templateId)).toEqual(published.map((item) => item.id));
        expect(templates.every((item) => item.layer === "instance")).toBe(true);
        const draft = API_REQUEST_TEMPLATE_FIXTURE.filter((item) => item.status === "draft");
        expect(draft.length).toBeGreaterThan(0);
        for (const item of draft) {
            expect(templates.map((option) => option.templateId)).not.toContain(item.id);
        }
    });

    it("未知连接 404 用 CP 原码；缺 query / version 非法 400", async () => {
        const missing = await call(
            handler,
            "/provider-connections/conn-does-not-exist/api-type-change-impact?apiTypeId=openai-chat-completions&version=1",
        );
        expect(missing.status).toBe(404);
        expect((missing.body as { code: string }).code).toBe("PROVIDER_CONNECTION_NOT_FOUND");
        const row = chatRow();
        for (const bad of [
            "",
            "?version=1",
            "?apiTypeId=openai-chat-completions",
            "?apiTypeId=openai-chat-completions&version=0",
            "?apiTypeId=openai-chat-completions&version=abc",
        ]) {
            const answer = await call(
                handler,
                `/provider-connections/${row.id}/api-type-change-impact${bad}`,
            );
            expect(answer.status).toBe(400);
            expect((answer.body as { code: string }).code).toBe("INVALID_REQUEST");
        }
    });

    it("非 GET 不通配（回 null ⇒ 上层 404 MOCK_ENDPOINT_MISSING）", async () => {
        const row = chatRow();
        const answer = await call(
            handler,
            `/provider-connections/${row.id}/api-type-change-impact?apiTypeId=openai-chat-completions&version=1`,
            "POST",
            {},
        );
        expect(answer.status).toBe(404);
        expect((answer.body as { code: string }).code).toBe("MOCK_ENDPOINT_MISSING");
    });

    it("config 读面真的给 templates（根因②的直接判据）：entries.templates 是非空 JSON", async () => {
        const answer = await call(
            handler,
            "/config/api-request-templates?layer=instance&includeMeta=true",
        );
        expect(answer.status).toBe(200);
        const entries = (answer.body as { entries: Record<string, string> }).entries;
        expect(typeof entries.templates).toBe("string");
        const parsed = JSON.parse(entries.templates) as Array<{ id: string; status: string }>;
        expect(parsed.map((item) => item.id)).toEqual(
            API_REQUEST_TEMPLATE_FIXTURE.map((item) => item.id),
        );
        // UI 侧 `listVisibleTemplates()` 会再 filter published ⇒ 至少一条能进选项。
        expect(parsed.filter((item) => item.status === "published").length).toBeGreaterThan(0);
        // user 层仍是 {}（mock 的层语义没改，别为了「两层都有」去改 mergedEntries）。
        const userLayer = await call(
            handler,
            "/config/api-request-templates?layer=user&includeMeta=true",
        );
        expect((userLayer.body as { entries: Record<string, string> }).entries).toEqual({});
    });
});
