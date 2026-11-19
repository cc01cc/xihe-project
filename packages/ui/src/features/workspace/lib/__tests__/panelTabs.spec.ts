import { describe, expect, it } from "vitest";

import { DOCK_TAB_IDS } from "../../../../composables/useWorkspaceLayout";
import { CONTAINER_IDS } from "../containers";
import {
    PANE_CONTAINERS,
    SESSION_CONFIG_VIEW,
    isPaneTabId,
    isPaneView,
    paneTabContainer,
    paneTabId,
    paneTabSessionId,
    paneTabView,
    parsePaneTab,
} from "../panelTabs";
import { parseWorkTab } from "../workTabs";

/**
 * task-138 / `D-1907` rev7·rev8·rev10：容器内页签 id 第三形态 `pane:<container>:<view>[:<sid>]`。
 *
 * 判据是**结构事实**（本卡只交付纯函数层，消费者接线在 129/140 面）：
 * 写读严格对称、容器进 id、`session-config` 必须绑会话、静态面板不许绑、
 * 旧裸 8 值不被本解析器认领（零迁移），以及与 task-69 `panel:` 域的互斥。
 */
describe("task-138 · panelTabs 容器内页签 id", () => {
    it("写入口：静态面板不带 sid，session-config 必须带", () => {
        expect(paneTabId("right", "code")).toBe("pane:right:code");
        expect(paneTabId("main", "files")).toBe("pane:main:files");
        expect(paneTabId("main", SESSION_CONFIG_VIEW, "s1")).toBe("pane:main:session-config:s1");
        // 契约违反一律 null（调用点必须显式处理，不允许先拼出来再说）。
        expect(paneTabId("right", SESSION_CONFIG_VIEW)).toBeNull();
        expect(paneTabId("right", SESSION_CONFIG_VIEW, "")).toBeNull();
        expect(paneTabId("right", "code", "s1")).toBeNull();
        expect(paneTabId("center" as never, "code")).toBeNull();
        expect(paneTabId("right", "bogus" as never)).toBeNull();
    });

    it("解析与写入口严格对称（8 静态 view × 2 容器往返）", () => {
        for (const container of PANE_CONTAINERS) {
            for (const view of DOCK_TAB_IDS) {
                const id = paneTabId(container, view);
                expect(id).not.toBeNull();
                const parsed = parsePaneTab(id);
                expect(parsed).toEqual({ id, container, view, sessionId: null });
                expect(paneTabContainer(id as string)).toBe(container);
                expect(paneTabView(id as string)).toBe(view);
                expect(paneTabSessionId(id as string)).toBeNull();
            }
            const configId = paneTabId(container, SESSION_CONFIG_VIEW, "s1");
            expect(parsePaneTab(configId)).toEqual({
                id: configId,
                container,
                view: SESSION_CONFIG_VIEW,
                sessionId: "s1",
            });
        }
    });

    it("容器进 id：同一 view 在两栏是两个不同 id（并存的结构前提）", () => {
        const main = paneTabId("main", SESSION_CONFIG_VIEW, "s1");
        const right = paneTabId("right", SESSION_CONFIG_VIEW, "s1");
        expect(main).not.toBe(right);
        expect(paneTabContainer(main as string)).toBe("main");
        expect(paneTabContainer(right as string)).toBe("right");
    });

    it("会话 id 含冒号也解析得回来（只认 session-config: 前缀，其余整段归 sid）", () => {
        const id = "pane:right:session-config:ws:sess:9";
        expect(parsePaneTab(id)).toEqual({
            id,
            container: "right",
            view: SESSION_CONFIG_VIEW,
            sessionId: "ws:sess:9",
        });
    });

    it("非法载荷一律 null（不把垃圾渲染成点开就死的页签）", () => {
        const bad = [
            "",
            "pane:",
            "pane:right",
            "pane:right:",
            "pane::code",
            "pane:center:code",
            "pane:right:bogus",
            "pane:right:code:extra",
            "pane:right:session-config",
            "pane:right:session-config:",
            "files",
            "code",
            "session:s1:chat",
            "panel:code",
            "session-config:s1",
        ];
        for (const value of bad) expect(parsePaneTab(value)).toBeNull();
        expect(isPaneTabId(bad[0])).toBe(false);
        expect(paneTabContainer("files")).toBeNull();
        expect(paneTabView("code")).toBeNull();
    });

    it("旧裸 8 值不被本解析器认领 ⇒ 读侧等价 pane:right:<id>，零迁移不重写用户键", () => {
        for (const view of DOCK_TAB_IDS) {
            expect(parsePaneTab(view)).toBeNull();
        }
    });

    it("与 task-69 的 panel:/session: 域互斥（前缀不相交，谁都不吃对方载荷）", () => {
        expect(parseWorkTab("pane:right:code")).toBeNull();
        expect(parseWorkTab("pane:right:session-config:s1")).toBeNull();
        expect(parsePaneTab("panel:code")).toBeNull();
        expect(parsePaneTab("session:s1:chat")).toBeNull();
    });

    it("view 值域 = DOCK_TAB_IDS ∪ {session-config}（单一值域的包含断言）", () => {
        for (const view of DOCK_TAB_IDS) expect(isPaneView(view)).toBe(true);
        expect(isPaneView(SESSION_CONFIG_VIEW)).toBe(true);
        expect(isPaneView("bogus")).toBe(false);
        expect(isPaneView(null)).toBe(false);
    });

    it("容器清单与 containers.ts 的 CONTAINER_IDS 逐项相等（防两份清单漂移）", () => {
        expect([...PANE_CONTAINERS]).toEqual([...CONTAINER_IDS]);
    });
});
