export const messages = {
    "zh-CN": {
        sidebar: {
            // task-89：工作区侧栏面板是无名 complementary ⇒ 补可访问名（描述内容，不描述位置）。
            panelLabel: "工作区与会话面板",
            newChat: "新建会话",
            noWorkspace: "当前没有可用工作区",
            search: "搜索会话...",
            // task-89：区头三个常驻动作 + 行内 ⋯ 的可访问名（英文侧同键同批）。
            searchSessions: "搜索会话",
            workspaceSettings: "工作区设置",
            moreActions: "更多操作",
            // task-152（`D-1221` ④）：拖拽/键盘移动后的 a11y 播报（`aria-live`）。
            orderMoved: "已移到第 {position} 位",
            today: "今天",
            yesterday: "昨天",
            earlier: "更早",
            rename: "重命名",
            delete: "删除",
            fork: "分叉为新会话",
            forking: "正在创建分叉会话",
            forkCreated: "已创建并打开分叉会话",
            forkFailed: "分叉会话失败",
            forkBranchUnavailable: "无法确定当前会话的有效分支",
            forkAnchorUnavailable: "当前分支没有可见的已完成用户或助手消息",
            deleteConfirm: "确定要删除这个会话吗？",
            deleteConfirmTitle: "删除会话？",
            deleteChildWarning:
                "删除当前会话只会清除自身及收件箱通知；由它派生的子会话和运行会保留，并可继续独立运行。",
            deletePending: "删除中…",
            deleteFailed: "删除会话失败",
            // task-45：改名失败原先用的是英文硬编码兜底（"Failed to rename session"）。
            renameFailed: "重命名会话失败",
            empty: "暂无会话",
            // task-352 / `D-1206`：左栏是「工作区分组 + 会话项」。两个空态只在各自状态渲染，
            // **不得合并成一块**（合并 = 两态又变回同一块）；出口也不同（建工作区 / 建会话）。
            emptyNoWorkspace: {
                title: "还没有工作区",
                body: "工作区是左栏的一级分组。新建一个工作区后，它的会话会作为一组出现在这里。",
                action: "新建工作区",
            },
            emptyNoSession: {
                title: "这个工作区暂无会话",
                body: "新建一个会话就能开始对话；会话会归到它所在工作区的分组下。",
            },
            emptyNoMatch: "没有匹配的会话",
            groupsLoading: "正在加载工作区…",
            groupsFailed: "工作区列表加载失败",
            groupSessionsLoading: "正在加载会话…",
            groupSessionsFailed: "这个分组的会话加载失败",
            groupNewSession: "在此工作区新建会话",
            // task-373 / `D-1236`：命名取「独立」而不是「仅对话」（说的是能力上限，来了工具就过期）
            // 或「未分组」（说的是缺失，暗示待归类）—— 它是与工作区平级的正面属性。en = Standalone。
            standaloneGroup: "独立会话",
            newChatStandalone: "新建独立会话",
            standaloneLoading: "正在加载独立会话…",
            standaloneFailed: "独立会话加载失败",
            // 非当前工作区的分组是**展开时拉取的快照**：折叠再展开不重拉（判据③），
            // 所以别处对该组会话的增删要刷新后才看得到。这条提示是「不静默陈旧」的最低成本做法。
            groupSnapshotHint: "展开时加载；该工作区在别处有变动时，刷新页面后才会显示最新列表",
            // D-1220 ②（task-365 B）：左栏「工作区」区头 —— 一级列表自己的动作（新建工作区 /
            // 导入源）放在区头，不放在页内右上角、也不混进工作区行上的 `+`（那是新建会话）。
            workspacesSection: "工作区",
            // task-172 / `DSD-1464`：会话区头的区名。计数**不**进这个 key —— 数字单独渲染
            //（随数据变，写进译文会漂移；两侧同批加，无占位）。
            sessionsSection: "会话",
            settings: "设置",
            // PLAN-0762 T2.3 / D-924：模块名只能是「工作台」；「工作区」只是工作台模块内的对象。
            workbench: "工作台",
            // PLAN-0773 M3（task-240）：全局模块「组织成员」（实例级组织树 + 单元成员，
            // Lead 裁 (a) 全局模块落点；与工作区成员资格页 workspaceNav.members 是两个面）。
            orgMembers: "组织成员",
            // PLAN-0772 M2：第三个顶层入口。资源面已搬出 /settings（层 tab 在页内）。
            resources: "资源",
            workspace: "工作区",
            logout: "退出登录",
            collapse: "收起导航面板",
            expand: "展开导航面板",
            // task-189 / D-896：全局条的二级菜单触发器（折叠态用 sr-only，靠 aria-label 命名）。
            moduleMenu: "打开模块页面菜单",
            pendingApprovalBadge: "待审批",
            pendingApprovalBanner: "有会话等待审批",
            pendingApprovalCount: "项待处理",
            pendingApprovalGoTo: "前往处理",
            pendingApprovalLive: "待审批数量已更新",
            admin: "管理",
            clearSearch: "清除搜索",
            resize: "调整导航面板宽度",
            toggle: "切换导航面板",
            mobileTitle: "侧边栏",
            mobileDescription: "移动端侧边栏。",
        },
    },
    "en-US": {
        sidebar: {
            // task-89: the workspace sidebar panel was an unnamed complementary landmark.
            panelLabel: "Workspace and session panel",
            newChat: "New session",
            noWorkspace: "No workspace available yet",
            search: "Search sessions...",
            // task-89: the three always-visible header actions + the row "more" control name.
            searchSessions: "Search sessions",
            workspaceSettings: "Workspace settings",
            moreActions: "More actions",
            // task-152 (`D-1221` ④): screen-reader announcement after a drag/keyboard move.
            orderMoved: "Moved to position {position}",
            today: "Today",
            yesterday: "Yesterday",
            earlier: "Earlier",
            rename: "Rename",
            delete: "Delete",
            fork: "Fork to new session",
            forking: "Creating fork",
            forkCreated: "Fork created and opened",
            forkFailed: "Failed to fork session",
            forkBranchUnavailable: "The current session has no valid selected branch",
            forkAnchorUnavailable:
                "The selected branch has no visible completed user or assistant message",
            deleteConfirm: "Are you sure you want to delete this session?",
            deleteConfirmTitle: "Delete this session?",
            deleteChildWarning:
                "Deleting this session clears only itself and its Inbox notices. Spawned child sessions and runs remain and can continue independently.",
            deletePending: "Deleting…",
            deleteFailed: "Failed to delete the session",
            // task-45: replaces the hard-coded English fallback ("Failed to rename session").
            renameFailed: "Failed to rename the session",
            empty: "No sessions",
            // task-352 / `D-1206`: the rail is "workspace groups + session rows". The two empty
            // states render only in their own state and must never be merged into one block
            // (that would collapse them again); their exits differ (create workspace / session).
            emptyNoWorkspace: {
                title: "No workspaces yet",
                body: "A workspace is a top-level group in this rail. Create one and its sessions will appear as a group here.",
                action: "Create a workspace",
            },
            emptyNoSession: {
                title: "No sessions in this workspace yet",
                body: "Create a session to start chatting; it will be listed under its workspace group.",
            },
            emptyNoMatch: "No matching sessions",
            groupsLoading: "Loading workspaces…",
            groupsFailed: "Failed to load workspaces",
            groupSessionsLoading: "Loading sessions…",
            groupSessionsFailed: "Failed to load this group’s sessions",
            groupNewSession: "New session in this workspace",
            standaloneGroup: "Standalone",
            newChatStandalone: "New standalone session",
            standaloneLoading: "Loading standalone sessions…",
            standaloneFailed: "Failed to load standalone sessions",
            groupSnapshotHint:
                "Loaded on expand; if this workspace changes elsewhere, reload the page to see the latest list",
            workspacesSection: "Workspaces",
            // task-172 / `DSD-1464`: session-list section header; the count is rendered separately.
            sessionsSection: "Sessions",
            settings: "Settings",
            workbench: "Workbench",
            orgMembers: "Org members",
            // PLAN-0772 M2: third top-level entry; resources moved out of /settings.
            resources: "Resources",
            workspace: "Workspace",
            logout: "Logout",
            collapse: "Collapse navigation panel",
            expand: "Expand navigation panel",
            moduleMenu: "Open module pages menu",
            pendingApprovalBadge: "Pending approval",
            pendingApprovalBanner: "A session is waiting for approval",
            pendingApprovalCount: "items pending",
            pendingApprovalGoTo: "Review now",
            pendingApprovalLive: "Pending approval count updated",
            admin: "Admin",
            clearSearch: "Clear search",
            resize: "Resize navigation panel",
            toggle: "Toggle navigation panel",
            mobileTitle: "Sidebar",
            mobileDescription: "Displays the mobile sidebar.",
        },
    },
};
