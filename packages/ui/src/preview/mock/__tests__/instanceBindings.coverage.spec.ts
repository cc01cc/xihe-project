import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { mockApiPlugin } from "../api-server";
import { MOCK_INSTANCE_BINDINGS } from "../data/previewPermissions";

interface Captured {
    status: number;
    body: unknown;
}

type ApiHandler = (req: unknown, res: unknown) => void;

/** 与 sessions.coverage.spec.ts 同口径：直接拿 vite 插件注册的中间件打真实 HTTP 面。 */
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

/**
 * task-54（D-1444）：`GET /bindings?scopeType=instance` 的机器判据。
 *
 * <p>这条面是组织成员**详情抽屉段②**的数据源；在补它之前是 404（`MOCK_ENDPOINT_MISSING`）⇒
 * 段②渲染成 error 态。四条判据缺一不可：①路由真的被消费（不是造了没人用）；②**两个 subject**
 * 都在册（只有一行时「抽屉按 subjectId 过滤」这件事拍出来无法证伪）；③形状照契约
 * （`api.ts:332-348` 的 `ApiBindingSet`/`ApiBindingRow` 七字段，缺一个页面就渲染空值）；
 * ④`scopeType=workspace` **响亮 404**，不许用空集合冒充「本来就没有绑定」。</p>
 */
describe("GET /bindings?scopeType=instance（task-54 段②数据源）", () => {
    const handler = mountApiHandler();

    it("200 + scopeType=instance + scopeId=null（形状照契约）", async () => {
        const answer = await call(handler, "/bindings?scopeType=instance");
        expect(answer.status).toBe(200);
        const body = answer.body as {
            scopeType: string;
            scopeId: string | null;
            bindings: unknown[];
        };
        expect(body.scopeType).toBe("instance");
        expect(body.scopeId).toBeNull();
        expect(Array.isArray(body.bindings)).toBe(true);
    });

    it("两条绑定分属**不同 subject**（否则「按 subjectId 过滤」无法被图证伪）", async () => {
        const answer = await call(handler, "/bindings?scopeType=instance");
        const rows = (answer.body as { bindings: Array<{ subjectId: string }> }).bindings;
        const subjects = rows.map((row) => row.subjectId);
        expect(subjects).toContain("mock-user");
        expect(new Set(subjects).size).toBe(rows.length);
        // 张安（mock-user）在实例层是 USER（V87 种子的注册最小集角色）
        const own = (
            answer.body as { bindings: Array<{ subjectId: string; roleName: string }> }
        ).bindings.filter((row) => row.subjectId === "mock-user");
        expect(own.map((row) => row.roleName)).toEqual(["USER"]);
    });

    it("每行七个字段都在（缺字段页面会渲染空值，且这不叫「没有绑定」）", async () => {
        const answer = await call(handler, "/bindings?scopeType=instance");
        const rows = (answer.body as { bindings: Array<Record<string, unknown>> }).bindings;
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            for (const key of [
                "id",
                "subjectType",
                "subjectId",
                "roleId",
                "roleName",
                "grantedBy",
                "grantedAt",
            ]) {
                expect(row, key).toHaveProperty(key);
            }
            expect(typeof row.id).toBe("string");
            expect(typeof row.roleName).toBe("string");
        }
    });

    it("scopeType=workspace ⇒ 404 MOCK_ENDPOINT_MISSING（不拿空集合冒充「没有绑定」）", async () => {
        const answer = await call(handler, "/bindings?scopeType=workspace");
        expect(answer.status).toBe(404);
        expect((answer.body as { code: string }).code).toBe("MOCK_ENDPOINT_MISSING");
    });

    it("缺省 scopeType 视为 instance（抽屉不传 scopeId，只用 scopeType）", async () => {
        const answer = await call(handler, "/bindings");
        expect(answer.status).toBe(200);
        expect((answer.body as { scopeType: string }).scopeType).toBe("instance");
        expect((answer.body as { bindings: unknown[] }).bindings).toHaveLength(
            MOCK_INSTANCE_BINDINGS.bindings.length,
        );
    });
});
