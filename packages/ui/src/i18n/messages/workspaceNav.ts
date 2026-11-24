export const messages = {
    "zh-CN": {
        workspaceNav: {
            // PLAN-0773 M4-4（task-190）：工作区内部二级导航与面包屑的文案。
            // 页面清单不在这里 —— 标签 key 挂在路由 `meta.workspacePage.labelKey` 上。
            ariaLabel: "工作区导航",
            breadcrumbLabel: "工作区导航位置",
            workspaceContainer: "工作区",
            // task-217（用户 10:5x）：工作区**内部这一页**是会话列表 ⇒ 页名「会话」。
            // 「工作台」只允许出现在**模块层**（全局 rail + 落地页，`sidebar.workbench` 仍是「工作台」，D-924 不变）。
            sessions: "会话",
            environment: "环境",
            scheduledTasks: "自动化任务",
            // PLAN-0773 M4-2（task-210）：本工作区资源页（`/workspace/:id/resources`）。
            resources: "资源",
            settings: "设置",
            // PLAN-0773 M4-3（task-236）：成员提升为一级页（order 45），导航标签同派生。
            members: "成员",
        },
    },
    "en-US": {
        workspaceNav: {
            ariaLabel: "Workspace navigation",
            breadcrumbLabel: "Workspace location",
            workspaceContainer: "Workspace",
            sessions: "Sessions",
            environment: "Environment",
            scheduledTasks: "Automations",
            resources: "Resources",
            settings: "Settings",
            members: "Members",
        },
    },
};
