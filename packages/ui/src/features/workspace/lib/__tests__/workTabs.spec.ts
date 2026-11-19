import { describe, expect, it } from "vitest";

import { DOCK_TAB_IDS } from "../../../../composables/useWorkspaceLayout";
import { containerOf } from "../containers";
import {
    MAIN_MAX_TABS,
    PANEL_VIEWS,
    SESSION_VIEWS,
    containerOfWorkTab,
    isPanelView,
    isSessionView,
    isWorkTabId,
    migrateLegacyOpenTabs,
    normalizeWorkTabs,
    parseWorkTab,
    sessionIdOfWorkTab,
    viewOfWorkTab,
    workTabIdForPanel,
    workTabIdForSession,
} from "../workTabs";

/**
 * task-69 S1：页签 id 三元组（sessionId 可空 + view，workspace 由持久键承担）的纯函数层。
 *
 * 本卡只交付这一层（消费者接线在 task-140），所以判据必须是结构事实，不能借 UI 断言充数：
 * 同一会话的 chat 与 context 是两个不同 id、归属分别落 main/right、旧格式 session:<sid>
 * 仍可解析成 chat（迁移读），而写入口只有三元组一种形状。
 */
describe("task-69 · workTabs 三元组 id", () => {
    it("写入口只产三元组：session 视图带 view 段，默认 chat", () => {
        expect(workTabIdForSession("s1")).toBe("session:s1:chat");
        expect(workTabIdForSession("s1", "context")).toBe("session:s1:context");
        expect(workTabIdForSession("s1", "delegation")).toBe("session:s1:delegation");
        expect(workTabIdForPanel("files")).toBe("panel:files");
    });

    it("同一会话的不同视图是两个 id（并存的结构前提，不等于 UI 已达成）", () => {
        const chat = workTabIdForSession("s1", "chat");
        const context = workTabIdForSession("s1", "context");
        expect(chat).not.toBe(context);
        expect(sessionIdOfWorkTab(chat)).toBe("s1");
        expect(sessionIdOfWorkTab(context)).toBe("s1");
        expect(viewOfWorkTab(chat)).toBe("chat");
        expect(viewOfWorkTab(context)).toBe("context");
    });

    it("工作区视图没有 session 维度", () => {
        expect(sessionIdOfWorkTab(workTabIdForPanel("code"))).toBeNull();
        expect(viewOfWorkTab(workTabIdForPanel("code"))).toBe("code");
    });

    it("归属由 view 派生：chat 落 main，其余（会话视图与工作区视图）落 right", () => {
        expect(containerOfWorkTab(workTabIdForSession("s1", "chat"))).toBe("main");
        for (const view of SESSION_VIEWS) {
            if (view === "chat") continue;
            expect(containerOfWorkTab(workTabIdForSession("s1", view))).toBe("right");
        }
        for (const view of PANEL_VIEWS) {
            expect(containerOfWorkTab(workTabIdForPanel(view))).toBe("right");
        }
    });

    it("旧格式 session:<sid>（无 view 段）解析成 chat，迁移后是新格式", () => {
        expect(parseWorkTab("session:legacy-1")).toEqual({
            id: "session:legacy-1:chat",
            sessionId: "legacy-1",
            view: "chat",
        });
        expect(migrateLegacyOpenTabs(["session:legacy-1"])).toEqual(["session:legacy-1:chat"]);
    });

    it("非法 id 一律 null：空串、缺 sid、面板值域外、C3 之前的页面 id", () => {
        const bad = [
            "",
            "session:",
            "session:a:",
            ":chat",
            "panel:",
            "panel:bogus",
            "environment",
            "settings",
            "scheduled-tasks",
            "workspace-x",
        ];
        for (const id of bad) expect(parseWorkTab(id), id).toBeNull();
        // 有冒号但末段不是合法视图 ⇒ 非法，**不**猜成「含冒号的 session id」：
        // 那会把损坏载荷渲染成一个点开就死的页签。
        expect(parseWorkTab("session:a:bogus")).toBeNull();
    });

    it("isWorkTabId / isSessionView / isPanelView 与解析结果同口径", () => {
        expect(isWorkTabId("session:s1:chat")).toBe(true);
        expect(isWorkTabId("panel:files")).toBe(true);
        expect(isWorkTabId("session:s1")).toBe(true);
        expect(isWorkTabId("environment")).toBe(false);
        expect(isWorkTabId(42)).toBe(false);
        for (const view of SESSION_VIEWS) expect(isSessionView(view)).toBe(true);
        for (const view of PANEL_VIEWS) expect(isPanelView(view)).toBe(true);
        expect(isSessionView("files")).toBe(false);
        expect(isPanelView("context")).toBe(false);
    });
});

describe("task-69 · 值域与既有面板清单同源", () => {
    it("非 chat 的每个 view 都是 DOCK_TAB_IDS 的成员（不复制第二份面板 IA 清单）", () => {
        const dockIds = new Set<string>(DOCK_TAB_IDS);
        for (const view of SESSION_VIEWS) {
            if (view === "chat") continue;
            expect(dockIds.has(view), view).toBe(true);
        }
        for (const view of PANEL_VIEWS) expect(dockIds.has(view), view).toBe(true);
        // chat 是聊天列自己的页签，不是 dock 面板 —— 它不在 DOCK_TAB_IDS 里是正确事实，不是漏项。
        expect(dockIds.has("chat")).toBe(false);
    });

    it("chat 是唯一落在 main 的视图；两族合计覆盖全部 DOCK_TAB_IDS", () => {
        const covered = new Set<string>([...SESSION_VIEWS, ...PANEL_VIEWS]);
        for (const id of DOCK_TAB_IDS) expect(covered.has(id), id).toBe(true);
        const mainViews = SESSION_VIEWS.filter(
            (view) => containerOfWorkTab(workTabIdForSession("s1", view)) === "main",
        );
        expect(mainViews).toEqual(["chat"]);
    });
});

describe("task-69 · 与 containers.ts 的归属口径一致", () => {
    it("非 chat 视图的归属与旧 containerOf(面板 id) 逐项相等（两处清单不许分叉）", () => {
        for (const view of SESSION_VIEWS) {
            if (view === "chat") continue;
            expect(containerOfWorkTab(workTabIdForSession("s1", view)), view).toBe(
                containerOf(view),
            );
        }
        for (const view of PANEL_VIEWS) {
            expect(containerOfWorkTab(workTabIdForPanel(view)), view).toBe(containerOf(view));
        }
    });
});

describe("task-69 · normalizeWorkTabs / migrateLegacyOpenTabs", () => {
    it("非数组 ⇒ 空集合；非法项丢弃且保序", () => {
        expect(normalizeWorkTabs(undefined)).toEqual([]);
        expect(normalizeWorkTabs("session:a")).toEqual([]);
        expect(
            normalizeWorkTabs([null, 1, "environment", "panel:files", "session:a:chat"]),
        ).toEqual(["panel:files", "session:a:chat"]);
    });

    it("旧格式与新格式指向同一页签时去重（迁移不产生双页签）", () => {
        expect(normalizeWorkTabs(["session:a", "session:a:chat"])).toEqual(["session:a:chat"]);
    });

    it("上限按容器各自算：main 8 / right 6，互不吃额度", () => {
        const mainTabs = Array.from(
            { length: MAIN_MAX_TABS + 3 },
            (_, index) => "session:s" + index,
        );
        expect(normalizeWorkTabs(mainTabs)).toHaveLength(MAIN_MAX_TABS);

        const rightViews = PANEL_VIEWS.length + SESSION_VIEWS.length - 1;
        const rightTabs: string[] = [];
        for (const view of PANEL_VIEWS) rightTabs.push(workTabIdForPanel(view));
        for (const view of SESSION_VIEWS) {
            if (view !== "chat") rightTabs.push(workTabIdForSession("s1", view));
        }
        expect(rightTabs).toHaveLength(rightViews);
        expect(normalizeWorkTabs(rightTabs)).toHaveLength(Math.min(rightViews, 6));

        const mixed = normalizeWorkTabs([...mainTabs, ...rightTabs]);
        expect(mixed.filter((id) => id.endsWith(":chat"))).toHaveLength(MAIN_MAX_TABS);
        expect(mixed.filter((id) => containerOfWorkTab(id) === "right")).toHaveLength(
            Math.min(rightViews, 6),
        );
    });

    it("空集合是合法结果（全部关闭后仍是空数组，不是 undefined）", () => {
        expect(normalizeWorkTabs([])).toEqual([]);
    });
});
