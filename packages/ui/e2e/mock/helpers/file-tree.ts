/**
 * task-185 / F1：文件树播种 + Runtime MCP 工具桩 —— **复用产品既有机制，不自造第二套树数据面**。
 *
 * 播种钩子（产品侧既有）：`src/features/workspace/stores/workspace.ts:461-473` 的 `loadTree`
 * 读 `localStorage["xihe-mock-filetree"]`（mock profile only 的 E2E seeding hook，注释原文
 * "lets Playwright inject a tree without a live CP+MCP chain"）⇒ 命中即 return，不走 CP+MCP。
 * 多根另有 `xihe-mock-filetree-roots`（同文件 :623）。
 *
 * MCP 桩形状照既有通过用例 `e2e/mock/full-ui-acceptance.spec.ts:551-565`：
 * 请求 `{jsonrpc, method:"tools/call", params:{name, arguments}}`（`src/composables/api.ts:2914-2919`），
 * 响应包 `{jsonrpc:"2.0", id, result:{content:[{type:"text",text}]}}` —— 消费端取 `body.result.content[0].text`。
 *
 * 既有内联同款 3 处（plan0639-multi-root-tree.spec.ts:24-38 / full-ui-acceptance.spec.ts:545-560 /
 * plan-0641-t44-nested-declare.spec.ts:38）；本 helper 是收敛入口，**不回改**既有 spec（避免 churn）。
 *
 * 调用纪律：必须在 `page.goto` 之前（addInitScript / route 注册），且在 `setupMockAuth` 之后
 * 注册 route（Playwright 后注册优先，盖过夹具兜底）。
 */
import type { Page } from "@playwright/test";
import type { FileNode } from "../../../src/types";

/** 用官方 mock 钩子播种文件树（workspace.ts:463）。必须在 page.goto 之前调用。 */
export async function seedMockFileTree(page: Page, nodes: FileNode[]): Promise<void> {
    await page.addInitScript((tree) => {
        localStorage.setItem("xihe-mock-filetree", JSON.stringify(tree));
    }, nodes);
}

/**
 * 按 Runtime MCP 工具名分发桩响应（形状照 full-ui-acceptance.spec.ts:551-565）。
 * handler 返回 string ⇒ 原样进 text；返回 object ⇒ JSON.stringify 进 text。
 * 未命中的工具名回 `{ entries: [] }`（与既有用例的默认臂一致）。
 */
export async function stubMockMcpTools(
    page: Page,
    handlers: Record<string, (args: Record<string, unknown>) => unknown>,
): Promise<void> {
    await page.route("**/api/v1/mcp", async (route) => {
        const request = route.request().postDataJSON() as {
            id?: number;
            params?: { name?: string; arguments?: Record<string, unknown> };
        };
        const tool = request.params?.name ?? "";
        const args = request.params?.arguments ?? {};
        const handler = handlers[tool];
        const value: unknown = handler ? handler(args) : { entries: [] };
        const text = typeof value === "string" ? value : JSON.stringify(value);
        const result = { content: [{ type: "text", text }] };
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ jsonrpc: "2.0", id: request.id ?? 1, result }),
        });
    });
}

/**
 * RSI 演示树的文件内容（F3「选文件读内容」用）：键 = 树内 path，值 = read_file 返回文本。
 * 内容含可断言的多行结构与指纹前缀，非占位符。
 */
export const RSI_DEMO_FILE_CONTENTS: Record<string, string> = {
    "README.md": [
        "# RSI demo workspace",
        "",
        "README body line 1 with enough width to exercise truncation rendering.",
        "README body line 2.",
    ].join("\n"),
    "src/main.ts": [
        "RSI-FINGERPRINT src/main.ts",
        "export function main(): void {",
        '    console.log("xihe");',
        "}",
    ].join("\n"),
    "src/lib/parse.ts": [
        "RSI-FINGERPRINT src/lib/parse.ts",
        "export function parse(input: string): string[] {",
        String.raw`    return input.split("\n");`,
        "}",
    ].join("\n"),
    "src/lib/util.ts": 'export const VERSION = "0.1.0";\n',
    "src/components/Panel.vue": [
        "<template>",
        "  <div>RSI-FINGERPRINT Panel</div>",
        "</template>",
    ].join("\n"),
    "docs/guide.md": "# Guide\n\nRSI-FINGERPRINT docs/guide.md\n",
    "docs/new-note.md": "# New note\n\nuntracked file content\n",
};

/** read_file 的分发器：按 args.path 查 RSI_DEMO_FILE_CONTENTS，缺省回 "# empty"。 */
export function demoReadFile(args: Record<string, unknown>): unknown {
    const path = String(args.path ?? "");
    return RSI_DEMO_FILE_CONTENTS[path] ?? `# empty file: ${path}`;
}

/**
 * 真实形状默认树：10 节点 / 3 层嵌套 / 4 种 mimeType / 带 size + modified —— 非空壳。
 * 能压出长路径截断、目录展开、文件类型图标这些真实可读性问题（空壳压不出）。
 */
export const RSI_DEMO_TREE: FileNode[] = [
    {
        name: "README.md",
        path: "README.md",
        type: "file",
        mimeType: "text/markdown",
        size: 1284,
        modified: "2026-11-17T09:12:00Z",
    },
    {
        name: "package.json",
        path: "package.json",
        type: "file",
        mimeType: "application/json",
        size: 642,
        modified: "2026-11-17T08:40:00Z",
    },
    {
        name: "src",
        path: "src",
        type: "directory",
        children: [
            {
                name: "main.ts",
                path: "src/main.ts",
                type: "file",
                mimeType: "text/typescript",
                size: 318,
                modified: "2026-11-17T09:00:00Z",
            },
            {
                name: "lib",
                path: "src/lib",
                type: "directory",
                children: [
                    {
                        name: "parse.ts",
                        path: "src/lib/parse.ts",
                        type: "file",
                        mimeType: "text/typescript",
                        size: 2048,
                        modified: "2026-11-17T09:05:00Z",
                    },
                    {
                        name: "util.ts",
                        path: "src/lib/util.ts",
                        type: "file",
                        mimeType: "text/typescript",
                        size: 764,
                        modified: "2026-11-17T08:55:00Z",
                    },
                ],
            },
            {
                name: "components",
                path: "src/components",
                type: "directory",
                children: [
                    {
                        name: "Panel.vue",
                        path: "src/components/Panel.vue",
                        type: "file",
                        mimeType: "text/x-vue",
                        size: 3110,
                        modified: "2026-11-17T09:08:00Z",
                    },
                ],
            },
        ],
    },
    {
        name: "docs",
        path: "docs",
        type: "directory",
        children: [
            {
                name: "guide.md",
                path: "docs/guide.md",
                type: "file",
                mimeType: "text/markdown",
                size: 1536,
                modified: "2026-11-17T08:45:00Z",
            },
            {
                name: "new-note.md",
                path: "docs/new-note.md",
                type: "file",
                mimeType: "text/markdown",
                size: 210,
                modified: "2026-11-18T00:10:00Z",
            },
        ],
    },
];
