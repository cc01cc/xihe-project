import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    GLOBAL_LAYOUT_STORAGE_KEY,
    NAV_WIDTH_DEFAULT,
    readGlobalLayout,
    readStandaloneSessionOrder,
    sanitizeSessionOrder,
    writeGlobalLayout,
    writeStandaloneSessionOrder,
} from "../useWorkspaceLayout";

vi.mock("../../lib/logger", () => ({
    logger: {
        warn: vi.fn<(message: string, cause?: unknown) => void>(),
        error: vi.fn<(message: string, cause?: unknown) => void>(),
        info: vi.fn<(message: string, detail?: unknown) => void>(),
        debug: vi.fn<(message: string, detail?: unknown) => void>(),
    },
}));

/**
 * task-152 / `D-1221` ④：独立会话顺序落在**既有的** `xihe-layout-global`（不建第二把键）。
 *
 * <p>本文件的核心不是"能不能读写"，而是**同一把键两个面互不覆盖**：
 * nav 侧（`navOpen`/`navWidth`）与 order 侧（`standaloneSessionOrder`）谁后写都不能抹掉另一方。
 * 这一条要是漏了，用户排完序、拖一下栏宽顺序就没了 —— 而且没有任何报错。</p>
 */
beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
});

function readRaw(): Record<string, unknown> | null {
    const raw = localStorage.getItem(GLOBAL_LAYOUT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

describe("standaloneSessionOrder 持久化（task-152）", () => {
    it("缺字段 ⇒ 空数组（= 没有自定义顺序）", () => {
        expect(readStandaloneSessionOrder()).toEqual([]);
    });

    it("写后读回；载荷落在既有键里（不建新键）", () => {
        writeStandaloneSessionOrder(["b", "a"]);
        expect(readStandaloneSessionOrder()).toEqual(["b", "a"]);
        expect(readRaw()?.standaloneSessionOrder).toEqual(["b", "a"]);
        expect(localStorage.length).toBe(1);
    });

    it("写 nav **不抹掉** order（否则拖一下栏宽排序就没了）", () => {
        writeStandaloneSessionOrder(["c", "b", "a"]);
        writeGlobalLayout({ navOpen: false, navWidth: 300 });

        expect(readStandaloneSessionOrder()).toEqual(["c", "b", "a"]);
        expect(readGlobalLayout()).toEqual({ navOpen: false, navWidth: 300 });
    });

    it("写 order **不抹掉** nav（同一把键的两个面互不覆盖）", () => {
        writeGlobalLayout({ navOpen: false, navWidth: 320 });
        writeStandaloneSessionOrder(["a"]);

        expect(readGlobalLayout()).toEqual({ navOpen: false, navWidth: 320 });
        expect(readStandaloneSessionOrder()).toEqual(["a"]);
    });

    it("空顺序不被写回 nav 载荷（保持旧载荷形状，不引入空字段）", () => {
        writeGlobalLayout({ navOpen: true, navWidth: NAV_WIDTH_DEFAULT });
        expect("standaloneSessionOrder" in (readRaw() ?? {})).toBe(false);
    });

    it("脏载荷：非数组 ⇒ 空；非字符串/空串/重复项丢弃", () => {
        localStorage.setItem(
            GLOBAL_LAYOUT_STORAGE_KEY,
            JSON.stringify({ navOpen: true, navWidth: 280, standaloneSessionOrder: "nope" }),
        );
        expect(readStandaloneSessionOrder()).toEqual([]);
        expect(sanitizeSessionOrder(["a", 3, "", null, "b", "a"])).toEqual(["a", "b"]);
    });

    it("整个键是坏 JSON ⇒ 顺序回落空，且读方不删键（删键只走 readGlobalLayout 那条路径）", () => {
        localStorage.setItem(GLOBAL_LAYOUT_STORAGE_KEY, "{not json");
        expect(readStandaloneSessionOrder()).toEqual([]);
        expect(localStorage.getItem(GLOBAL_LAYOUT_STORAGE_KEY)).toBe("{not json");
    });
});
