import { Readable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { mockApiPlugin } from "../api-server";

/**
 * task-25 A/B1 的机器判据（mock 车道）：
 *
 * ① `/mcp` 分派真的能供上文件树 —— 树通路的唯一真实形态是 JSON-RPC `tools/call{list_directory}`，
 *    **不是** REST 树端点（`stores/workspace.ts:182` → `api.ts:2662` `callRuntimeTool`）。
 * ② `list_directory` **只给一层**：递归在前端（`workspace.ts:192-194`），mock 返回整棵树会让递归重复展开。
 * ③ 未知 `rootId` 必须报错（静默回落主根会让「多根可分辨」的验收变成假绿）。
 * ④ `meta.source` 不再恒 `"code"`：user 层写了一键之后，实例层 meta 必须能表达「被 user 覆盖」。
 *    同时 `GET /config/{domain}?layer=instance` 的**值**必须逐字节不变（层隔离）。
 */

interface Captured {
    status: number;
    body: Record<string, unknown>;
}

type ApiHandler = (req: unknown, res: unknown) => void;

/** 直接拿 vite 插件注册的 `/api/v1` 中间件，用假 req/res 打真实的 HTTP 面。 */
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

function call(handler: ApiHandler, method: string, url: string, body?: unknown): Promise<Captured> {
    return new Promise((resolve, reject) => {
        const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
        const req = Readable.from(chunks);
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
                        body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
                    });
                } catch (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            },
        };
        handler(req, res);
    });
}

interface McpResult {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: { entries?: Array<Record<string, unknown>> };
    isError?: boolean;
}

async function callTool(
    handler: ApiHandler,
    name: string,
    args: Record<string, unknown> = {},
): Promise<{ result?: McpResult; error?: { code: number; message: string } }> {
    const response = await call(handler, "POST", "/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
    });
    return response.body as { result?: McpResult; error?: { code: number; message: string } };
}

describe("mock /mcp 分派（task-25 A）", () => {
    let handler: ApiHandler;
    beforeEach(() => {
        handler = mountApiHandler();
    });

    it("list_directory 只给一层（递归在前端，不是 mock 返回整棵树）", async () => {
        const root = await callTool(handler, "list_directory", { path: "" });
        const entries = root.result?.structuredContent?.entries ?? [];
        expect(entries.length).toBeGreaterThan(5);
        const names = entries.map((entry) => entry.name);
        expect(names).toContain("src");
        expect(names).toContain("README.md");
        // 关键：根层不许出现第二层之后的名字，否则前端递归会重复展开、层级错。
        expect(names).not.toContain("features");
        expect(names).not.toContain("App.vue");
        // 目录在前、文件在后；path 是 root 相对路径（不带前导 /，也不带 /mock/ 前缀）。
        const firstFile = entries.findIndex((entry) => entry.is_dir === false);
        const lastDir = entries.map((entry) => entry.is_dir === true).lastIndexOf(true);
        expect(lastDir).toBeLessThan(firstFile);
        for (const entry of entries) {
            expect(String(entry.path).startsWith("/")).toBe(false);
            expect(["name", "path", "is_dir", "is_symlink", "size", "modified", "created"]).toEqual(
                expect.arrayContaining(Object.keys(entry)),
            );
        }
    });

    it("3 层嵌套可按前端递归方式逐层取到", async () => {
        const level1 = await callTool(handler, "list_directory", { path: "" });
        expect(level1.result?.structuredContent?.entries).toBeDefined();
        const level2 = await callTool(handler, "list_directory", { path: "src" });
        expect(level2.result?.structuredContent?.entries?.map((e) => e.name)).toContain("features");
        const level3 = await callTool(handler, "list_directory", { path: "src/features" });
        expect(level3.result?.structuredContent?.entries?.map((e) => e.name)).toContain(
            "workspace",
        );
        const level4 = await callTool(handler, "list_directory", {
            path: "src/features/workspace",
        });
        expect(level4.result?.structuredContent?.entries?.map((e) => e.name)).toContain(
            "components",
        );
    });

    it("未知 rootId 必须报错，不静默回落主根；第二个根内容可分辨", async () => {
        const unknown = await callTool(handler, "list_directory", {
            path: "",
            rootId: "mock-root-nope",
        });
        expect(unknown.result?.isError).toBe(true);
        expect(unknown.result?.content?.[0]?.text).toContain("UNKNOWN_ROOT");
        const primary = await callTool(handler, "list_directory", { path: "" });
        const secondary = await callTool(handler, "list_directory", {
            path: "",
            rootId: "mock-root-docs",
        });
        const primaryNames = (primary.result?.structuredContent?.entries ?? []).map((e) => e.name);
        const secondaryNames = (secondary.result?.structuredContent?.entries ?? []).map(
            (e) => e.name,
        );
        expect(secondaryNames).toContain("guide");
        expect(primaryNames).not.toContain("guide");
    });

    it("read_file 文本可读、二进制报错、大文件走 read_file_range（懒生成）", async () => {
        const text = await callTool(handler, "read_file", { path: "README.md" });
        expect(text.result?.isError).toBeFalsy();
        expect(text.result?.content?.[0]?.text).toContain("mock");
        const binary = await callTool(handler, "read_file", { path: "public/logo.png" });
        expect(binary.result?.isError).toBe(true);
        expect(binary.result?.content?.[0]?.text).toContain("BINARY_FILE");
        const range = await callTool(handler, "read_file_range", {
            path: "public/reports/console-load-2026-11.csv",
        });
        const payload = JSON.parse(String(range.result?.content?.[0]?.text)) as {
            total_lines: number;
            is_binary: boolean;
        };
        expect(payload.is_binary).toBe(false);
        expect(payload.total_lines).toBe(20001);
    });

    it("未知工具 isError、非 tools/call 方法回 -32601（不假装支持）", async () => {
        const unknownTool = await callTool(handler, "no_such_tool");
        expect(unknownTool.result?.isError).toBe(true);
        expect(unknownTool.result?.content?.[0]?.text).toContain("UNKNOWN_TOOL");
        const initialize = await call(handler, "POST", "/mcp", {
            jsonrpc: "2.0",
            id: 2,
            method: "initialize",
        });
        const error = (initialize.body as { error?: { code: number } }).error;
        expect(error?.code).toBe(-32601);
    });

    it("写路径能落：mkdir → write_file → read_file → delete_file", async () => {
        expect((await callTool(handler, "mkdir", { path: "scratch" })).result?.isError).toBeFalsy();
        expect(
            (await callTool(handler, "write_file", { path: "scratch/probe.txt", content: "probe" }))
                .result?.isError,
        ).toBeFalsy();
        const read = await callTool(handler, "read_file", { path: "scratch/probe.txt" });
        expect(read.result?.content?.[0]?.text).toBe("probe");
        expect(
            (await callTool(handler, "delete_file", { path: "scratch/probe.txt" })).result?.isError,
        ).toBeFalsy();
        const gone = await callTool(handler, "read_file", { path: "scratch/probe.txt" });
        expect(gone.result?.isError).toBe(true);
    });
});

describe("mock 配置层的层隔离与覆盖可见性（task-25 B1）", () => {
    let handler: ApiHandler;
    beforeEach(() => {
        handler = mountApiHandler();
    });

    it("user 层写入不改实例层值，但实例层 meta 必须能说出「被 user 覆盖」", async () => {
        const before = await call(handler, "GET", "/config/user-preference?layer=instance");
        const beforeEntries = before.body.entries as Record<string, string>;
        expect(beforeEntries.theme).toBe("dark");

        // 写成 light 而不是 dark —— fixture 本来就是 dark，写 dark 无法区分「值变了」与「没变」。
        const write = await call(handler, "PUT", "/config/user/user-preference", {
            theme: "light",
        });
        expect(write.status).toBe(200);

        const after = await call(handler, "GET", "/config/user-preference?layer=instance");
        const afterEntries = after.body.entries as Record<string, string>;
        expect(afterEntries.theme).toBe("dark");
        expect(afterEntries).toEqual(beforeEntries);

        const userLayer = await call(handler, "GET", "/config/user-preference?layer=user");
        expect((userLayer.body.entries as Record<string, string>).theme).toBe("light");

        const meta = await call(handler, "GET", "/config/user-preference/meta?layer=instance");
        const keys = meta.body.keys as Array<{ key: string; source: string; adminLocked: boolean }>;
        const themeMeta = keys.find((item) => item.key === "theme");
        const languageMeta = keys.find((item) => item.key === "language");
        // 契约枚举里没有 "code"（openapi:6357）；实例页要能显示「被用户覆盖」就得看到 source=user。
        expect(themeMeta?.source).toBe("user");
        expect(languageMeta?.source).toBe("instance");
        expect(keys.some((item) => item.source === "code")).toBe(false);
        // openapi:6354 的 required 里有 adminLocked，原实现整个字段都缺。
        expect(typeof themeMeta?.adminLocked).toBe("boolean");
    });
});
