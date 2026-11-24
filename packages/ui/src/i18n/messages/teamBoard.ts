export const messages = {
    "zh-CN": {
        // task-188 S2/S3（MVP⑤）：会话指挥只读任务板 + steer 来源标注（ui-1）。
        // 只读口径写进文案：板上没有任何写操作入口，写走对话中的 agent 工具（D-1821）。
        teamBoard: {
            title: "任务板",
            counts: "已完成 {completed} · 进行中 {inProgress} · 待办 {pending}",
            legendPending: "待办",
            legendBlocked: "阻塞",
            legendInProgress: "进行中",
            legendCompleted: "已完成",
            unowned: "未认领",
            blockedBadge: "阻塞",
            expandAria: "展开 {label} 详情",
            descriptionLabel: "描述",
            noDescription: "（无描述）",
            blockedByLabel: "依赖",
            scopeWarningsLabel: "写面提示",
            createdAtLabel: "创建于 {time}",
            updatedAtLabel: "更新于 {time}",
            emptyTitle: "本队暂无任务",
            emptyDesc: "派活与认领通过对话中的 agent 工具完成。",
            errorTitle: "任务板加载失败",
            retry: "重试",
            readonlyNote: "只读展示 · 派活与认领请在对话中指派给 agent",
        },
    },
    "en-US": {
        // task-188 S2/S3 (MVP⑤): read-only team task board + steer source badge (ui-1).
        // The copy itself states the read-only contract: no write controls on the board
        // (writes go through agent tools in chat; D-1821).
        teamBoard: {
            title: "Task board",
            counts: "Done {completed} · In progress {inProgress} · To do {pending}",
            legendPending: "To do",
            legendBlocked: "Blocked",
            legendInProgress: "In progress",
            legendCompleted: "Done",
            unowned: "Unowned",
            blockedBadge: "Blocked",
            expandAria: "Expand details of {label}",
            descriptionLabel: "Description",
            noDescription: "(no description)",
            blockedByLabel: "Depends on",
            scopeWarningsLabel: "Write-scope notes",
            createdAtLabel: "Created {time}",
            updatedAtLabel: "Updated {time}",
            emptyTitle: "No tasks on this team yet",
            emptyDesc: "Dispatch and claim happen through agent tools in chat.",
            errorTitle: "Failed to load the task board",
            retry: "Retry",
            readonlyNote: "Read-only · dispatch and claim via chat with the agent",
        },
    },
};
