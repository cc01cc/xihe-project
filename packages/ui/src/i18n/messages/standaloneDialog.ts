export const messages = {
    "zh-CN": {
        standaloneDialog: {
            title: "新建独立会话",
            body: "独立会话不属于任何工作区。选一个个人智能体作为这条会话的应答者。",
            // task-49：限制收窄到附件 —— CP 已允许 workspace-less Session 的 TO/CC/代发，只有附件仍 400。
            limits: "独立会话只能纯对话：不支持附件（创建后组合器也不会提供图片/文件/截屏入口）。",
            loading: "正在加载个人智能体…",
            emptyTitle: "还没有个人智能体",
            emptyBody: "独立会话需要一个个人智能体来应答。先创建一个，再回来新建会话。",
            emptyAction: "去创建智能体",
            create: "创建会话",
            creating: "正在创建…",
            failed: "操作失败",
        },
    },
    "en-US": {
        standaloneDialog: {
            title: "New standalone session",
            body: "A standalone session belongs to no workspace. Pick a personal agent to answer in it.",
            limits: "A standalone session is plain chat only: no attachments (the composer will not offer image/file/screenshot entries either).",
            loading: "Loading personal agents…",
            emptyTitle: "No personal agent yet",
            emptyBody:
                "A standalone session needs a personal agent to answer. Create one, then come back.",
            emptyAction: "Create an agent",
            create: "Create session",
            creating: "Creating…",
            failed: "Operation failed",
        },
    },
};
