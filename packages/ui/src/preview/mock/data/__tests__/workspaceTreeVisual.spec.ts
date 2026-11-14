import { beforeEach, describe, expect, it } from "vitest";
import {
    MOCK_ROOT_TREES,
    MOCK_ROOT_TREES_VISUAL,
    MOCK_TREE_VARIANT_KEY,
    selectRootTrees,
} from "../workspaceTree";
import {
    isDotfileName,
    isEmptyDirectoryNode,
    isRuntimeArtifactDir,
} from "../../../../features/workspace/stores/workspace";
import type { FileNode } from "../../../../types";

/**
 * task-534：视觉夹具**变体**的自检。
 *
 * 变体存在的唯一理由：默认树里 dotfile 与空目录各 0 条 ⇒ 「dotfile 置灰」「空目录淡样式」
 * 两条视觉判据在真浏览器里没有取样对象。而默认树的形状被 task-25 V1–V3 钉着，不能动。
 *
 * 判据三组：
 *  ① 变体含 ≥1 dotfile、≥1 空目录、≥1 空 logs（且空 logs 与空目录是两个不同条目）
 *  ② 默认树**仍然**没有 dotfile / 没有空目录（证明变体是加法，不是改默认）
 *  ③ 选择开关：未设/设错值 ⇒ 默认树；设 visual ⇒ 变体（产品默认路径不受影响）
 */

type FsNode = {
    name: string;
    isDir: boolean;
    children?: FsNode[];
};

/** 把 mock VFS 节点映射成前端 `FileNode` 判据能吃的形状（判据本体不在这里实现）。 */
function toFileNode(node: FsNode, parent = ""): FileNode {
    const path = parent ? `${parent}/${node.name}` : node.name;
    return {
        name: node.name,
        path,
        type: node.isDir ? "directory" : "file",
        ...(node.children ? { children: node.children.map((c) => toFileNode(c, path)) } : {}),
    } as FileNode;
}

function flatten(nodes: FileNode[]): FileNode[] {
    return nodes.flatMap((n) => [n, ...(n.children ? flatten(n.children) : [])]);
}

const visualMain = flatten([
    toFileNode(MOCK_ROOT_TREES_VISUAL["mock-root-main"] as unknown as FsNode),
]);

beforeEach(() => {
    localStorage.clear();
});

describe("task-534 mock 视觉夹具变体", () => {
    it("① 变体里有 dotfile / 空目录 / 空 logs 三类取样对象", () => {
        const dotfiles = visualMain.filter((n) => isDotfileName(n.name));
        expect(dotfiles.map((n) => n.name).sort()).toEqual([".editorconfig", ".env.local"]);

        const emptyDirs = visualMain.filter(
            (n) => isEmptyDirectoryNode(n) && !isRuntimeArtifactDir(n.name),
        );
        expect(
            emptyDirs.map((n) => n.name),
            "空目录（非 logs）要有取样对象",
        ).toContain("empty-notes");

        const emptyLogs = visualMain.filter((n) => isRuntimeArtifactDir(n.name));
        expect(
            emptyLogs.map((n) => n.name),
            "空 logs 要有取样对象（D-1234 合法例外）",
        ).toEqual(["logs"]);
        expect(
            emptyLogs.every((n) => isEmptyDirectoryNode(n)),
            "logs 必须是**空**的，否则「空 logs 隐藏」判据取不到对象",
        ).toBe(true);
    });

    it("② 默认树未被扰动：仍然 0 个 dotfile、0 个空目录（V1–V3 的钉子不动）", () => {
        const main = flatten([toFileNode(MOCK_ROOT_TREES["mock-root-main"] as unknown as FsNode)]);
        expect(
            main.filter((n) => isDotfileName(n.name)),
            "默认树不该有 dotfile",
        ).toHaveLength(0);
        expect(
            main.filter((n) => isEmptyDirectoryNode(n)),
            "默认树不该有空目录",
        ).toHaveLength(0);
    });

    it("③ 开关：默认/错误值取默认树，visual 取变体", () => {
        expect(selectRootTrees()).toBe(MOCK_ROOT_TREES);
        localStorage.setItem(MOCK_TREE_VARIANT_KEY, "nope");
        expect(selectRootTrees(), "未知值必须回落默认树，不许静默选一个").toBe(MOCK_ROOT_TREES);
        localStorage.setItem(MOCK_TREE_VARIANT_KEY, "visual");
        expect(selectRootTrees()).toBe(MOCK_ROOT_TREES_VISUAL);
    });
});
