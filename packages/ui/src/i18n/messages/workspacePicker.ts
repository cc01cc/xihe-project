export const messages = {
    "zh-CN": {
        workspacePicker: {
            title: "选择工作区",
            subtitle: "你的账号属于多个工作区。选择一个工作区开始工作。",
            loading: "正在加载工作区…",
            empty: "你还没有工作区。创建第一个工作区即可开始。",
            createFirst: "创建你的第一个工作区",
            create: "新建工作区",
            searchPlaceholder: "搜索工作区（名称或 ID）",
            searchEmpty: "没有匹配的工作区。",
            clearSearch: "清除搜索",
            invalidLinkTitle: "工作区链接无效",
            invalidLinkHint:
                "链接里的工作区标识不是合法的工作区 ID（可能复制不完整或已过期），已回到工作区列表。请从下面重新选择，或检查链接后重试。",
            invalidLinkDismiss: "知道了",
            // task-38（用户 2026-11-20 11:32 裁定）：/workbench 从「选择工作区」升级成工作台详情页。
            // `title` 保留给「已有工作区」那一节的标题；页头换用 workbenchTitle/workbenchSubtitle。
            workbenchTitle: "工作台",
            workbenchSubtitle: "新建会话、进入已有工作区，或跳转到全局索引。",
            newSession: "新建会话",
            recentStandalone: "最近的独立会话",
            standaloneEntry: "打开",
            linksTitle: "全局索引",
            linkMembers: "成员",
            linkResources: "资源",
            linkSettings: "设置",
        },
    },
    "en-US": {
        workspacePicker: {
            title: "Choose a workspace",
            subtitle: "Your account belongs to more than one workspace. Pick one to continue.",
            loading: "Loading workspaces…",
            empty: "You do not have a workspace yet. Create the first one to get started.",
            createFirst: "Create your first workspace",
            create: "New workspace",
            searchPlaceholder: "Search workspaces (name or ID)",
            searchEmpty: "No matching workspaces.",
            clearSearch: "Clear search",
            invalidLinkTitle: "This workspace link is invalid",
            invalidLinkHint:
                "The workspace id in the link is not a valid workspace ID (truncated when copied, or expired), so you are back on the workspace list. Pick a workspace below, or check the link and try again.",
            invalidLinkDismiss: "Got it",
            // task-38 (ruled by the user 2026-11-20 11:32): /workbench is now the workbench detail page.
            // `title` stays as the heading of the "existing workspaces" section.
            workbenchTitle: "Workbench",
            workbenchSubtitle:
                "Start a session, open an existing workspace, or jump to the global index.",
            newSession: "New session",
            recentStandalone: "Recent standalone sessions",
            standaloneEntry: "Open",
            linksTitle: "Global index",
            linkMembers: "Members",
            linkResources: "Resources",
            linkSettings: "Settings",
        },
    },
};
