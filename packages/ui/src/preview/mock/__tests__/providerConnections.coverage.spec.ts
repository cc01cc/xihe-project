import { Readable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { mockApiPlugin } from "../api-server";
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

    it("原有 embedding / image 两行的模型目录逐字保留（加行不改现有行）", async () => {
        const catalog = mockModelCatalogResponse();
        expect(catalog.providers["conn-claude-primary"].models.map((m) => m.name)).toEqual([
            "claude-sonnet-4-5",
            "claude-haiku-4-5",
        ]);
        expect(catalog.providers["conn-image-primary"].models).toEqual([
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
        const answer = await call(
            handler,
            LIST + "/conn-claude-primary/api-type-change-impact?apiTypeId=openai-chat&version=1",
        );
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
