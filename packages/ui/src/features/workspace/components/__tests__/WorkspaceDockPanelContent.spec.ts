import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import WorkspaceDockPanelContent from "../WorkspaceDockPanelContent.vue";

/**
 * task-144 ②（P1）：**files 面板必须有内容分支**。
 *
 * <p>缺陷形态（真浏览器实测）：DOCK_TAB_IDS 已含 files（lib/containers.ts 的 FILES_PANEL_ID，
 * D-1777/D-1778），而本组件没有 files 分支 ⇒ dockview 路径把该面板渲染成**空壳**
 * （[data-dockview-panel="files"] innerHTML 长度 11、textContent 空），而手写路径的 #files slot
 * 却是真的树 —— 同一条面板契约两处不一致。jsdom 能钉的是**组件契约**：给定 id="files" 必须画出树，
 * 且折叠动作必须**上报**（唯一 writer 在 Workbench）。
 *
 * 反向控制：同一个查询换一个不存在的 testid 必须查不到（防「有树就判过」）。
 */
const i18n = createI18n({
    legacy: false,
    locale: "en",
    messages: {
        en: {
            workspace: { noSession: "No active session" },
        },
    },
});

const stubs = {
    FileTreePanel: {
        emits: ["collapse"],
        template:
            '<div data-testid="file-tree-stub"><button data-testid="file-tree-collapse-stub" @click="$emit(\'collapse\')" /></div>',
    },
    FileEditor: { template: '<div data-testid="file-editor-stub" />' },
    WorkspaceChangesPanel: { template: '<div data-testid="changes-panel-stub" />' },
    SessionMonitorPanel: { template: '<div data-testid="session-monitor-stub" />' },
    SessionParticipantsPanel: { template: '<div data-testid="participants-panel-stub" />' },
    SessionContextPanel: { template: '<div data-testid="context-panel-stub" />' },
    DelegationDagPanel: { template: '<div data-testid="delegation-panel-stub" />' },
    WorkspaceAgentsPanel: { template: '<div data-testid="agents-panel-stub" />' },
};

function mountContent(id: string) {
    return mount(WorkspaceDockPanelContent, {
        props: { id, sessionId: "session-1", workspaceId: "workspace-1" },
        global: { plugins: [i18n], stubs },
    });
}

describe("WorkspaceDockPanelContent files 面板（task-144 ②）", () => {
    it("id=files ⇒ 渲染文件树，且外层就是手写路径用的 workspace-file-tree 壳", () => {
        const wrapper = mountContent("files");
        const shell = wrapper.get('[data-testid="workspace-file-tree"]');
        expect(shell.find('[data-testid="file-tree-stub"]').exists()).toBe(true);
        // 反向控制：换一个不存在的 testid 必须查不到。
        expect(wrapper.find('[data-testid="workspace-file-tree-absent"]').exists()).toBe(false);
    });

    it("files 面板的折叠**上报**给宿主（本组件不写布局状态）", async () => {
        const wrapper = mountContent("files");
        await wrapper.get('[data-testid="file-tree-collapse-stub"]').trigger("click");
        expect(wrapper.emitted("collapseTree")).toHaveLength(1);
    });

    it("files 分支不吃掉别的面板：id=code 仍是编辑器，不含树", () => {
        const wrapper = mountContent("code");
        expect(wrapper.find('[data-testid="file-editor-stub"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="workspace-file-tree"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="file-tree-stub"]').exists()).toBe(false);
    });
});
