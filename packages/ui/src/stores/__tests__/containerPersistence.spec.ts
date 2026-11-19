import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    WORKSPACE_LAYOUT_STORAGE_PREFIX,
    defaultWorkspaceLayout,
    defaultWorkspaceLayoutForViewport,
    hasWorkspaceLayout,
    readWorkspaceLayout,
    writeWorkspaceLayout,
    writeWorkspaceOpenTabs,
    type WorkspaceLayoutState,
} from "../../composables/useWorkspaceLayout";

/**
 * task-126（task-85 定因：**持久片被覆盖**，不是渲染落后）。
 *
 * <p>同一把键 `xihe-layout-ws:<id>` 有两个 writer，各自只该拥有自己那一片：</p>
 * <ul>
 *   <li>页签栏（`WorkspaceTabBar.persistOpenTabs`）→ `writeWorkspaceOpenTabs`：**只写 openTabs 分片**，
 *       保留几何；</li>
 *   <li>工作台（`WorkspaceWorkbench` 的 `layout` ref + 250ms 合并 writer）→ `writeWorkspaceLayout`：
 *       写**整份快照**，而它的 `openTabs` 是**挂载时读到的那一份**（`initialLayout()`），此后页签栏
 *       再写盘也不会回流到它。</li>
 * </ul>
 *
 * <p>于是任何一次几何变更（开/合 dock、拖动宽度、切栏）都会把工作台手里的**过期页签快照**整份写回，
 * 覆盖页签栏刚写的那一片 —— 这就是 O3：关掉的页签刷新后复活、新开的页签刷新后消失。</p>
 *
 * <p>本 spec 直接驱动**两个持久化函数**（不挂组件、不等 250ms），把「两片互不覆盖」钉成回归判据；
 * 组件级/真栈的时序矩阵在 `e2e/real/container-persistence.spec.ts`。</p>
 *
 * <p>jsdom 的 localStorage 就是持久化层本身：`read`/`write` 走的是与浏览器同一份实现，这里没有
 * 需要 mock 的边界（与 `composables/__tests__/useWorkspaceLayout.spec.ts` 同口径）。</p>
 */

vi.mock("../../lib/logger", () => ({
    logger: {
        warn: vi.fn<(message: string, cause?: unknown) => void>(),
        error: vi.fn<(message: string, cause?: unknown) => void>(),
        info: vi.fn<(message: string, detail?: unknown) => void>(),
        debug: vi.fn<(message: string, detail?: unknown) => void>(),
    },
}));

const WORKSPACE_ID = "ws-container-persistence";
const STORAGE_KEY = `${WORKSPACE_LAYOUT_STORAGE_PREFIX}${WORKSPACE_ID}`;
/** 页签 id 由 `workTabIdForSession(sid)` 生成（旧单段形态，`useWorkspaceLayout` 仍以此为准）。 */
const TAB_A = "session:session-a";
const TAB_B = "session:session-b";

/**
 * 工作台挂载/换 workspace 时的快照来源（`WorkspaceWorkbench.vue:146-158` 的 `initialLayout`）：
 * 没有几何就用首开默认，有几何就整份读。**返回之后这份对象不再与持久层同步** —— 这正是缺陷的
 * 发生条件，所以用例里必须显式持有它、再让页签栏去改动持久层。
 */
function workbenchSnapshot(workspaceId: string, viewportWidth: number): WorkspaceLayoutState {
    return hasWorkspaceLayout(workspaceId)
        ? readWorkspaceLayout(workspaceId)
        : defaultWorkspaceLayoutForViewport(viewportWidth);
}

/** 工作台的一次几何变更（deep watch → `layoutWriter.schedule` → `writeWorkspaceLayout`）。 */
function workbenchGeometryChange(
    workspaceId: string,
    snapshot: WorkspaceLayoutState,
    patch: Partial<WorkspaceLayoutState>,
): void {
    writeWorkspaceLayout(workspaceId, { ...snapshot, ...patch });
}

function storedRaw(): string {
    return localStorage.getItem(STORAGE_KEY) ?? "";
}

beforeEach(() => {
    localStorage.clear();
});

describe("container persistence (task-126 / O3: two writers, one key)", () => {
    /**
     * 1) **关页签不复活**：关掉 B → 触发一次布局变更 → reload ⇒ openTabs 不含 B。
     *
     * <p>几何先落盘，所以工作台拿到的是「[A, B]」快照；页签栏随后只把 [A] 写进分片；
     * 用户再合上 dock（离散动作，`layoutWriter.flush()` 立即落盘）⇒ 整份快照回来，
     * 带着过期的 [A, B]。刷新读到的就是这份 ⇒ B 复活。</p>
     */
    it("keeps a closed tab closed after a later layout change (no resurrection)", () => {
        writeWorkspaceLayout(WORKSPACE_ID, {
            ...defaultWorkspaceLayout(),
            dockCollapsed: false,
            dockTabs: ["files"],
            activeDockTab: "files",
        });
        writeWorkspaceOpenTabs(WORKSPACE_ID, [TAB_A, TAB_B]);

        // 工作台在此刻挂载：手里是 [A, B]。
        const snapshot = workbenchSnapshot(WORKSPACE_ID, 1920);
        expect(snapshot.openTabs).toEqual([TAB_A, TAB_B]);

        // 用户关掉 B：页签栏只写分片。
        writeWorkspaceOpenTabs(WORKSPACE_ID, [TAB_A]);
        expect(readWorkspaceLayout(WORKSPACE_ID).openTabs).toEqual([TAB_A]);

        // 用户合上 dock：工作台用它那份过期快照整份落盘。
        workbenchGeometryChange(WORKSPACE_ID, snapshot, { dockCollapsed: true });

        // 刷新（重新读持久层）：关掉的 B 不得复活；几何仍是刚写的值。
        const reloaded = readWorkspaceLayout(WORKSPACE_ID);
        expect(reloaded.openTabs).toEqual([TAB_A]);
        expect(reloaded.dockCollapsed).toBe(true);
    });

    /**
     * 2) **无几何首开**：没有持久几何 ⇒ 开两个会话页签 ⇒ 开 dock ⇒ reload，两页签仍在。
     *
     * <p>复现 A 支 `[A,B] → []`：首开时工作台手里是默认快照（openTabs `[]`，因为默认集是空集），
     * 页签栏把 [A, B] 写进分片；用户开 dock = 第一次几何写 ⇒ 整份默认快照把分片覆盖成 []，
     * 刷新后页签全丢，只剩「我明明开着两个会话」的印象。</p>
     */
    it("keeps the first-run tabs when the first dock open writes the geometry", () => {
        // 首开：没有任何持久片（连键都没有）。
        expect(hasWorkspaceLayout(WORKSPACE_ID)).toBe(false);
        expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

        // 工作台首开快照（1600 档：dock 收起，dockTabs 已就位）。
        const snapshot = workbenchSnapshot(WORKSPACE_ID, 1600);
        expect(snapshot.openTabs).toEqual([]);

        // 用户先后打开两个会话：页签栏写分片（此时键还不存在 ⇒ 首次写会建键）。
        writeWorkspaceOpenTabs(WORKSPACE_ID, [TAB_A]);
        writeWorkspaceOpenTabs(WORKSPACE_ID, [TAB_A, TAB_B]);
        expect(readWorkspaceLayout(WORKSPACE_ID).openTabs).toEqual([TAB_A, TAB_B]);

        // 用户点开右栏：第一笔几何写。
        workbenchGeometryChange(WORKSPACE_ID, snapshot, { dockCollapsed: false });

        const reloaded = readWorkspaceLayout(WORKSPACE_ID);
        expect(reloaded.dockCollapsed).toBe(false);
        expect(reloaded.openTabs).toEqual([TAB_A, TAB_B]);
    });

    /**
     * 3) **30 次 reload 零漂移**：settle 之后反复 reload，页签载荷逐字不变、写入次数为 0。
     *
     * <p>真实时序（early 700ms vs settled 3300ms、写入次数 0）由 `e2e/real/container-persistence.spec.ts`
     * 的矩阵脚本承担（要真计时器 + 真浏览器）；这里钉的是它背后的**纯持久层契约**：
     * 一条已经 settle 的键，读一万次也不会被任何 writer 改写 —— 一旦哪天读路径里混进「读后补写」
     * 或「首开默认回填」，次数立刻不为 0。</p>
     */
    it("does not rewrite a settled key across 30 reloads (zero drift, zero writes)", () => {
        writeWorkspaceLayout(WORKSPACE_ID, {
            ...defaultWorkspaceLayout(),
            dockCollapsed: false,
            dockTabs: ["files"],
            activeDockTab: "files",
        });
        writeWorkspaceOpenTabs(WORKSPACE_ID, [TAB_A, TAB_B]);

        const settled = storedRaw();
        const setItem = vi.spyOn(Storage.prototype, "setItem");

        for (let reload = 0; reload < 30; reload += 1) {
            // 每次 reload：工作台重新读一遍快照（真实的 `initialLayout`），页签栏也重读一次。
            const snapshot = workbenchSnapshot(WORKSPACE_ID, 1920);
            expect(snapshot.openTabs).toEqual([TAB_A, TAB_B]);
            expect(readWorkspaceLayout(WORKSPACE_ID).openTabs).toEqual([TAB_A, TAB_B]);
            expect(storedRaw()).toBe(settled);
        }

        expect(setItem).not.toHaveBeenCalled();
        setItem.mockRestore();
    });
});
