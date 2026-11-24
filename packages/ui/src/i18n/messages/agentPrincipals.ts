export const messages = {
    "zh-CN": {
        agentPrincipals: {
            title: "智能体主体",
            heading: "智能体主体",
            // task-17 M-1（自审批01）：列表卡标题与 section/eyebrow 同名 ×3 ⇒ 异化降冗余。
            listHeading: "已创建的智能体",
            // task-17 M-2（自审批01）：去掉「CP 按创建者过滤」内部实现细节，只留用户面事实。
            desc: "你在本平台的智能体账号，创建后可绑定到工作区。本页只列出你自己创建的智能体；创建不需要选择工作区。",
            create: "创建智能体",
            refresh: "刷新",
            empty: "你还没有创建过智能体",
            name: "名称",
            namePlaceholder: "例如 ResearchAgent",
            submit: "创建",
            creating: "创建中…",
            cancel: "取消",
            created: "已创建「{name}」",
            createFailed: "创建失败，请重试",
            loadFailed: "列表加载失败，请重试",
            loading: "加载中…",
            createdAt: "创建于 {date}",
            templateFallback: "默认模板",
            disabledBadge: "已停用",
        },
    },
    "en-US": {
        agentPrincipals: {
            title: "Agent principals",
            heading: "Agent principals",
            // task-17 M-1 (self-review 01): list-card title duplicated the section/eyebrow label x3.
            listHeading: "Created agents",
            // task-17 M-2 (self-review 01): drop the internal control-plane filtering detail.
            desc: "Your agent accounts on this platform; create one, then bind it to a workspace. Only the agents you created yourself are listed. Creating one needs no workspace.",
            create: "Create agent",
            refresh: "Refresh",
            empty: "You have not created any agents yet",
            name: "Name",
            namePlaceholder: "e.g. ResearchAgent",
            submit: "Create",
            creating: "Creating…",
            cancel: "Cancel",
            created: 'Created "{name}"',
            createFailed: "Creation failed, please retry",
            loadFailed: "Could not load the list, please retry",
            loading: "Loading…",
            createdAt: "Created {date}",
            templateFallback: "Default template",
            disabledBadge: "Disabled",
        },
    },
};
