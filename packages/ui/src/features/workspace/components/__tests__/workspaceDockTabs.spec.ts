import { describe, expect, it } from "vitest";
import { SESSION_CONFIG_LABEL_KEY, dockTabLabel } from "../workspaceDockTabs";

/** 逐字回显 key 的翻译桩：只判「取到哪个 key」，不测 i18n 本身。 */
const echo = (key: string): string => key;

describe("dockTabLabel (task-138)", () => {
    it("localizes the legacy bare ids through DOCK_TAB_LABEL_KEYS", () => {
        expect(dockTabLabel("code", echo)).toBe("workspace.panelCode");
        expect(dockTabLabel("files", echo)).toBe("workspace.panelFiles");
    });

    it("localizes a pane tab by its view, ignoring the container", () => {
        expect(dockTabLabel("pane:main:code", echo)).toBe("workspace.panelCode");
        expect(dockTabLabel("pane:right:monitor", echo)).toBe("workspace.panelMonitor");
    });

    it("labels session-config with the session id suffix so two tabs stay distinguishable", () => {
        const label = dockTabLabel("pane:right:session-config:sess-1234567890", echo);
        expect(label).toBe(SESSION_CONFIG_LABEL_KEY + " · sess-123");
        // 同一容器两份不同会话 ⇒ 标签不同（否则用户无法分辨）。
        expect(label).not.toBe(dockTabLabel("pane:right:session-config:other-999", echo));
    });

    it("session-config owns the only session-settings label (panelContext retired with the tab)", () => {
        // task-6（D1453）：静态 context 页签退役 ⇒ panelContext 键已删，标签键只剩这一个。
        expect(SESSION_CONFIG_LABEL_KEY).toBe("workspace.panelSessionConfig");
        // 退役 id 没有 label 映射：原样回显，不会被静默翻成「会话设置」。
        expect(dockTabLabel("context", echo)).toBe("context");
    });

    it("echoes unknown ids instead of rendering an empty label", () => {
        expect(dockTabLabel("not-a-tab", echo)).toBe("not-a-tab");
    });
});
