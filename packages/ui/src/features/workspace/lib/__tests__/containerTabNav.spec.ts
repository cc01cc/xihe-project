import { describe, expect, it } from "vitest";

import type { ContainerRow } from "../containerTabNav";
import { focusableRows, resolveMoveKey, resolveNavKey, rowEntryTabId } from "../containerTabNav";

/**
 * task-184：`D-1600` ①②③ 的**逻辑面**判据（jsdom 可跑，不需要浏览器）。
 * 效果面（真的挪了 `document.activeElement`）由 `e2e/mock/task184-container-keyboard.spec.ts` 取证。
 */

function row(
    container: "tree" | "main" | "right",
    ids: string[],
    activeId: string | null = null,
): ContainerRow {
    return { container, tabs: ids.map((id) => ({ id })), activeId };
}

describe("rowEntryTabId（`D-1600` ①：落点 = 激活页签，无则首个）", () => {
    it("有激活页签 ⇒ 落点就是它，不是第一个", () => {
        const value = row("main", ["session:s1", "environment"], "environment");
        expect(rowEntryTabId(value)).toBe("environment");
    });

    it("没有激活页签 ⇒ 首个", () => {
        expect(rowEntryTabId(row("main", ["session:s1", "environment"]))).toBe("session:s1");
    });

    it("激活页签不在本行里（脏状态）⇒ 退回首个，不返回不存在的 id", () => {
        expect(rowEntryTabId(row("main", ["session:s1"], "session:gone"))).toBe("session:s1");
    });

    it("空行 ⇒ null（空容器不渲染页签行，不该有入口）", () => {
        expect(rowEntryTabId(row("main", []))).toBeNull();
    });
});

describe("focusableRows / resolveNavKey（`D-1600` ①②：顺序取渲染出来的行 + 单行不吞键）", () => {
    it("**空容器不渲染页签行 ⇒ 顺序里没有它**（照 DOM 走会跳到不相邻的容器）", () => {
        const rows = [
            row("tree", []),
            row("main", ["session:s1"], "session:s1"),
            row("right", ["code"], "code"),
        ];
        // 过滤面：three 个容器只剩两行，且保持渲染顺序。
        expect(focusableRows(rows).map((item) => item.container)).toEqual(["main", "right"]);
        // 行为面：在 main 按 F6 ⇒ 到 right（**不是**空着的 tree）。
        expect(resolveNavKey("F6", { rows, current: "main", shift: false })).toEqual({
            kind: "focus",
            container: "right",
            tabId: "code",
            preventDefault: true,
        });
        // 从 right 再按 ⇒ 循环回 main（跳过的树不会把环打断）。
        expect(resolveNavKey("F6", { rows, current: "right", shift: false })).toMatchObject({
            kind: "focus",
            container: "main",
        });
    });

    it("三行齐全时正向循环 + 反向（Shift+F6）循环，落点用各自行的激活页签", () => {
        const rows = [
            row("tree", ["tree"], "tree"),
            row("main", ["session:s1", "environment"], "environment"),
            row("right", ["monitor", "members"], "members"),
        ];
        expect(resolveNavKey("F6", { rows, current: "tree", shift: false })).toMatchObject({
            container: "main",
            tabId: "environment",
        });
        expect(resolveNavKey("F6", { rows, current: "main", shift: false })).toMatchObject({
            container: "right",
            tabId: "members",
        });
        expect(resolveNavKey("F6", { rows, current: "right", shift: false })).toMatchObject({
            container: "tree",
        });
        expect(resolveNavKey("F6", { rows, current: "tree", shift: true })).toMatchObject({
            container: "right",
        });
    });

    it("**只有一行 ⇒ no-op 且 `preventDefault: false`**（吞掉就等于夺走浏览器级 F6）", () => {
        const rows = [row("tree", []), row("main", ["session:s1"], "session:s1")];
        expect(resolveNavKey("F6", { rows, current: "main", shift: false })).toEqual({
            kind: "none",
            reason: "single-row",
            preventDefault: false,
        });
        expect(resolveNavKey("F6", { rows, current: "main", shift: true })).toMatchObject({
            reason: "single-row",
            preventDefault: false,
        });
    });

    it("焦点不在任何行里（null）⇒ 正向进第一行、反向进最后一行", () => {
        const rows = [row("tree", ["tree"], "tree"), row("main", ["session:s1"], "session:s1")];
        expect(resolveNavKey("F6", { rows, current: null, shift: false })).toMatchObject({
            container: "tree",
        });
        expect(resolveNavKey("F6", { rows, current: null, shift: true })).toMatchObject({
            container: "main",
        });
    });

    it("非 F6 键不认领（`preventDefault: false`，别的键归别人）", () => {
        const rows = [row("tree", ["tree"], "tree"), row("main", ["session:s1"], "session:s1")];
        expect(resolveNavKey("ArrowRight", { rows, current: "tree", shift: false })).toEqual({
            kind: "none",
            reason: "not-navigation-key",
            preventDefault: false,
        });
    });
});

describe("resolveMoveKey（`D-1600` ③：不静默 no-op，理由必须可读）", () => {
    it("单栏（只有一个页签行）⇒ 理由 = 没有相邻组", () => {
        const rows = [row("main", ["session:s1"], "session:s1")];
        expect(resolveMoveKey("right", { rows, current: "main" })).toEqual({
            kind: "blocked",
            reason: "no-neighbor",
            preventDefault: false,
        });
    });

    it("多行**也** blocked：默认路径的容器归属是 `containerOf` 纯函数 ⇒ 跨组移动不可表达", () => {
        const rows = [row("tree", ["tree"], "tree"), row("main", ["session:s1"], "session:s1")];
        for (const direction of ["left", "right", "split"] as const) {
            expect(resolveMoveKey(direction, { rows, current: "main" })).toEqual({
                kind: "blocked",
                reason: "layout-model-cannot-move",
                preventDefault: false,
            });
        }
    });
});
