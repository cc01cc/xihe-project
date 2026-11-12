/**
 * 虚拟文件系统（内存 VFS）—— mock 车道的工作区文件树数据面。
 *
 * 为什么是内存 VFS 而不是读真实磁盘（用户 2026-11-12 复审：「业界遇到真实文件系统就没法 mock 了吗」）：
 * 业界标准做法就是给一个假的树。好处三条：① 不依赖 `H:` 与任何宿主机路径，桌面与 CI 都能跑；
 * ② 能给「很多文件 / 大文件 / 二进制」的观感而不占真实字节；③ 树的形状可以被断言（task-25 V1–V3）。
 *
 * **路径语义（重要）**：wire 上的 `path` 是 **root 相对**路径，`""` = 根；不是宿主机路径，也不带
 * `/mock/...` 前缀（那只是给人看的别名，见 `MOCK_ROOT_TREES` 注释）。前端自己逐层递归
 * （`stores/workspace.ts:192-194`），所以 `listDirectory` **只给一层**，绝不返回整棵树。
 */

/** `listDirectory` 的元素形状 = runtime `fs::FileInfo`（`packages/runtime/src/fs.rs:28-36`），不许发明字段。 */
export interface MockFsFileInfo {
    name: string;
    path: string;
    is_dir: boolean;
    is_symlink: boolean;
    size: number;
    modified: string;
    created: string | null;
}

interface MockFsNode {
    name: string;
    isDir: boolean;
    isSymlink?: boolean;
    /** 目录恒 0；文件为字节数（>1 MB 的大文件靠它验证懒加载/折叠）。 */
    size: number;
    modified: string;
    isBinary?: boolean;
    /** 文本内容；二进制为 base64；大文件留空由 `lazyRows` 现算。 */
    content?: string;
    children?: MockFsNode[];
    lazyRows?: number;
}

/** 一个错误 = 一个稳定码（`PATH_NOT_FOUND` 等）；由 `/mcp` 分派包成 `result.isError`。 */
export interface MockFsError {
    code: string;
    detail?: string;
}

const TS = "2026-11-12T09:00:00Z";
const OLD = "2026-11-03T14:05:00Z";
/** 1×1 透明 PNG：最小的合法图片载荷，用来验二进制的 base64 通道。 */
const PNG_1PX =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function byteLength(value: string): number {
    return new TextEncoder().encode(value).length;
}

function dir(name: string, children: MockFsNode[], modified = TS): MockFsNode {
    return { name, isDir: true, size: 0, modified, children };
}

function text(name: string, content: string, modified = TS): MockFsNode {
    return { name, isDir: false, size: byteLength(content), modified, content };
}

function binary(name: string, base64: string, bytes: number, modified = TS): MockFsNode {
    return { name, isDir: false, size: bytes, modified, isBinary: true, content: base64 };
}

/**
 * 大文件：`size` 立刻可见（UI 用它决定懒加载），`content` 等第一次读才生成 ——
 * 否则 mock 插件一启动就白占 1.4 MB 常驻内存。
 */
export const MOCK_BIG_FILE_BYTES = 1_468_006;

function bigCsv(name: string, rows: number): MockFsNode {
    return {
        name,
        isDir: false,
        size: MOCK_BIG_FILE_BYTES,
        modified: OLD,
        content: undefined,
        lazyRows: rows,
    };
}

function generateBigCsv(rows: number): string {
    const lines = ["timestamp,level,request_id,route,duration_ms,status"];
    for (let i = 0; i < rows; i += 1) {
        const ts = `2026-11-1${i % 10}T0${i % 10}:${String(i % 60).padStart(2, "0")}:00Z`;
        const route = ["/api/v1/sessions", "/api/v1/workspaces", "/api/v1/config/user-preference"][
            i % 3
        ];
        lines.push(
            `${ts},INFO,req-${100000 + i},${route},${20 + (i % 480)},${i % 97 === 0 ? 503 : 200}`,
        );
    }
    return lines.join("\n");
}

const MAIN_SRC = dir("src", [
    dir("features", [
        dir("workspace", [
            dir("components", [
                text(
                    "FileTreePanel.vue",
                    '<template>\n  <div class="file-tree-panel" />\n</template>\n',
                ),
                text(
                    "WorkspaceDock.vue",
                    '<template>\n  <aside class="workspace-dock" />\n</template>\n',
                ),
            ]),
            dir("pages", [
                text(
                    "WorkspaceView.vue",
                    '<template>\n  <section class="workspace-view" />\n</template>\n',
                ),
            ]),
            dir("chat", [
                text("ChatPanel.vue", '<template>\n  <div class="chat-panel" />\n</template>\n'),
                text(
                    "MessageList.vue",
                    '<template>\n  <div class="message-list" />\n</template>\n',
                ),
            ]),
        ]),
        dir("settings", [text("ConfigLayerPanels.vue", "<template>\n  <div />\n</template>\n")]),
    ]),
    dir("components", [
        dir("ui", [
            text("Button.vue", "<template>\n  <button />\n</template>\n"),
            text("MessageScroller.vue", "<template>\n  <div />\n</template>\n"),
        ]),
    ]),
    text(
        "App.vue",
        '<script setup lang="ts"></script>\n<template>\n  <RouterView />\n</template>\n',
    ),
    text(
        "main.ts",
        'import { createApp } from "vue";\nimport App from "./App.vue";\ncreateApp(App).mount("#app");\n',
    ),
]);

const MAIN_DOCS = dir("docs", [
    text("architecture.md", "# 架构\n\n四模块 Hub-Module：UI / CP / Agent / Runtime。\n"),
    text("changelog.md", "# 变更记录\n\n- 2026-11-12 mock 车道补齐文件树与消息数据\n"),
]);

const MAIN_TESTS = dir("tests", [
    text(
        "messageList.spec.ts",
        'import { describe, it } from "vitest";\ndescribe("MessageList", () => {});\n',
    ),
]);

const MAIN_PUBLIC = dir("public", [
    binary("logo.png", PNG_1PX, 68),
    dir("reports", [bigCsv("console-load-2026-11.csv", 20000)]),
]);

const MAIN_ROOT: MockFsNode = dir("", [
    MAIN_SRC,
    MAIN_DOCS,
    MAIN_TESTS,
    MAIN_PUBLIC,
    text("README.md", "# Xihe 工作区（mock）\n\n这是虚拟文件系统，不指向任何真实磁盘路径。\n"),
    text("AGENTS.md", "# 工作区约定\n\n- 改代码前先跑单测\n"),
    text("package.json", '{\n  "name": "xihe-ui",\n  "private": true\n}\n', OLD),
]);

const DOCS_ROOT: MockFsNode = dir("", [
    dir("guide", [
        text("getting-started.md", "# 上手\n\n1. mise install\n2. mise run dev:host\n"),
        text("DEV-002-developer-guide.md", "# 开发指引\n\n命令与端口见 mise.toml。\n"),
        dir("images", [binary("architecture.png", PNG_1PX, 68)]),
    ]),
    dir("notes", [
        text("2026-11-meeting.md", "# 11 月评审记录\n\n- 文件树加载失败：mock 缺 /mcp 分派\n"),
    ]),
    text("README.md", "# 团队文档根\n\n第二个 root，用来验证多根工作区可分辨。\n"),
]);

/**
 * 两个 root（PLAN-0639 多根契约；数据面 `V103 workspace_roots` 已实现，这里只是填数据）。
 * key = rootId，与 `api-server.ts` 的 `MOCK_WORKSPACE.roots` 一一对应。
 */
export const MOCK_ROOT_TREES: Record<string, MockFsNode> = {
    "mock-root-main": MAIN_ROOT,
    "mock-root-docs": DOCS_ROOT,
};

export const MOCK_PRIMARY_ROOT_ID = "mock-root-main";

function isError(value: unknown): value is MockFsError {
    return typeof value === "object" && value !== null && "code" in value;
}

/** rootId 缺省 = 主根；未知 rootId **必须报错**，静默回落会让「多根可分辨」的验收假绿。 */
function rootTree(rootId: string | undefined): MockFsNode | MockFsError {
    const id = rootId ?? MOCK_PRIMARY_ROOT_ID;
    const tree = MOCK_ROOT_TREES[id];
    if (!tree) return { code: "UNKNOWN_ROOT", detail: id };
    return tree;
}

function splitRelativePath(path: string): string[] | MockFsError {
    if (path.startsWith("/")) return { code: "PATH_OUTSIDE_ROOT", detail: path };
    const segments = path.split("/").filter((segment) => segment.length > 0);
    if (segments.some((segment) => segment === ".." || segment === ".")) {
        return { code: "PATH_OUTSIDE_ROOT", detail: path };
    }
    return segments;
}

function findNode(tree: MockFsNode, segments: string[]): MockFsNode | MockFsError {
    let node = tree;
    for (const segment of segments) {
        const next = node.children?.find((child) => child.name === segment);
        if (!next) return { code: "PATH_NOT_FOUND", detail: segments.join("/") };
        node = next;
    }
    return node;
}

function resolve(
    rootId: string | undefined,
    path: string,
): { node: MockFsNode; segments: string[] } | MockFsError {
    const tree = rootTree(rootId);
    if (isError(tree)) return tree;
    const segments = splitRelativePath(path);
    if (isError(segments)) return segments;
    const node = findNode(tree, segments);
    if (isError(node)) return node;
    return { node, segments };
}

/** **只列一层**（前端自己递归；返回整棵树会让递归重复展开、层级错）。 */
export function listDirectory(
    rootId: string | undefined,
    path: string,
): { entries: MockFsFileInfo[] } | MockFsError {
    const resolved = resolve(rootId, path);
    if (isError(resolved)) return resolved;
    if (!resolved.node.isDir) return { code: "NOT_A_DIRECTORY", detail: path };
    const parentPath = resolved.segments.join("/");
    const entries = (resolved.node.children ?? [])
        .map((child) => ({
            name: child.name,
            path: parentPath ? `${parentPath}/${child.name}` : child.name,
            is_dir: child.isDir,
            is_symlink: child.isSymlink === true,
            size: child.size,
            modified: child.modified,
            created: null,
        }))
        .sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1));
    return { entries };
}

function nodeContent(node: MockFsNode): string {
    if (node.lazyRows !== undefined) return generateBigCsv(node.lazyRows);
    return node.content ?? "";
}

/** `read_file`：文本给内容；二进制与目录都报错（逼 UI 走 `read_file_range`，这是真产品行为）。 */
export function readFileText(
    rootId: string | undefined,
    path: string,
): { content: string } | MockFsError {
    const resolved = resolve(rootId, path);
    if (isError(resolved)) return resolved;
    if (resolved.node.isDir) return { code: "IS_A_DIRECTORY", detail: path };
    if (resolved.node.isBinary) return { code: "BINARY_FILE", detail: path };
    return { content: nodeContent(resolved.node) };
}

export function readFileRange(
    rootId: string | undefined,
    path: string,
    offset?: number,
    limit?: number,
): { content: string; total_lines: number; is_binary: boolean } | MockFsError {
    const resolved = resolve(rootId, path);
    if (isError(resolved)) return resolved;
    if (resolved.node.isDir) return { code: "IS_A_DIRECTORY", detail: path };
    const raw = nodeContent(resolved.node);
    if (resolved.node.isBinary) return { content: raw, total_lines: 0, is_binary: true };
    const lines = raw.split("\n");
    const start = Math.max(0, offset ?? 0);
    const end = limit === undefined ? lines.length : start + Math.max(0, limit);
    return {
        content: lines.slice(start, end).join("\n"),
        total_lines: lines.length,
        is_binary: false,
    };
}

function parentOf(tree: MockFsNode, segments: string[]): MockFsNode | MockFsError {
    const parent = findNode(tree, segments.slice(0, -1));
    if (isError(parent)) return parent;
    if (!parent.isDir) return { code: "NOT_A_DIRECTORY", detail: segments.slice(0, -1).join("/") };
    return parent;
}

export function writeFile(
    rootId: string | undefined,
    path: string,
    content: string,
): { message: string } | MockFsError {
    const tree = rootTree(rootId);
    if (isError(tree)) return tree;
    const segments = splitRelativePath(path);
    if (isError(segments)) return segments;
    if (segments.length === 0) return { code: "IS_A_DIRECTORY", detail: path };
    const parent = parentOf(tree, segments);
    if (isError(parent)) return parent;
    const name = segments[segments.length - 1];
    const existing = parent.children?.find((child) => child.name === name);
    if (existing?.isDir) return { code: "IS_A_DIRECTORY", detail: path };
    const next = text(name, content);
    if (existing) {
        existing.size = next.size;
        existing.content = content;
        existing.modified = next.modified;
        existing.isBinary = false;
        existing.lazyRows = undefined;
    } else {
        parent.children = [...(parent.children ?? []), next];
    }
    return { message: `wrote ${path}` };
}

export function makeDirectory(
    rootId: string | undefined,
    path: string,
): { message: string } | MockFsError {
    const tree = rootTree(rootId);
    if (isError(tree)) return tree;
    const segments = splitRelativePath(path);
    if (isError(segments)) return segments;
    if (segments.length === 0) return { message: "mkdir ." };
    const parent = parentOf(tree, segments);
    if (isError(parent)) return { code: "PATH_NOT_FOUND", detail: segments.slice(0, -1).join("/") };
    const name = segments[segments.length - 1];
    if (!parent.children?.some((child) => child.name === name)) {
        parent.children = [...(parent.children ?? []), dir(name, [])];
    }
    return { message: `created ${path}` };
}

export function deleteNode(
    rootId: string | undefined,
    path: string,
): { message: string } | MockFsError {
    const tree = rootTree(rootId);
    if (isError(tree)) return tree;
    const segments = splitRelativePath(path);
    if (isError(segments)) return segments;
    if (segments.length === 0) return { code: "PATH_OUTSIDE_ROOT", detail: path };
    const parent = parentOf(tree, segments);
    if (isError(parent)) return parent;
    const name = segments[segments.length - 1];
    const before = parent.children?.length ?? 0;
    parent.children = (parent.children ?? []).filter((child) => child.name !== name);
    if ((parent.children.length ?? 0) === before) return { code: "PATH_NOT_FOUND", detail: path };
    return { message: `deleted ${path}` };
}

/** `move_file` / `copy_file` 共用：`copy` 为真时保留源节点（深拷贝，避免两个路径共享同一对象）。 */
export function transferNode(
    rootId: string | undefined,
    from: string,
    to: string,
    copy: boolean,
): { message: string } | MockFsError {
    const tree = rootTree(rootId);
    if (isError(tree)) return tree;
    const fromResolved = resolve(rootId, from);
    if (isError(fromResolved)) return fromResolved;
    const targetSegments = splitRelativePath(to);
    if (isError(targetSegments)) return targetSegments;
    if (targetSegments.length === 0) return { code: "IS_A_DIRECTORY", detail: to };
    const parent = parentOf(tree, targetSegments);
    if (isError(parent))
        return { code: "PATH_NOT_FOUND", detail: targetSegments.slice(0, -1).join("/") };
    const name = targetSegments[targetSegments.length - 1];
    const payload = copy
        ? (JSON.parse(JSON.stringify(fromResolved.node)) as MockFsNode)
        : fromResolved.node;
    payload.name = name;
    parent.children = [...(parent.children ?? []).filter((child) => child.name !== name), payload];
    if (!copy) {
        const fromSegments = splitRelativePath(from);
        if (isError(fromSegments)) return fromSegments;
        const fromParent = parentOf(tree, fromSegments);
        if (!isError(fromParent)) {
            fromParent.children = (fromParent.children ?? []).filter(
                (child) => child.name !== fromSegments[fromSegments.length - 1],
            );
        }
    }
    return { message: `${copy ? "copied" : "moved"} ${from} → ${to}` };
}

/** 测试用：把树恢复到初始形状（spec 里做写操作后不污染下一个用例）。 */
export function isMockFsError(value: unknown): value is MockFsError {
    return isError(value);
}
