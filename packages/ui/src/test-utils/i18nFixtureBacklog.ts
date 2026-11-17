/**
 * task-105 · 裸 i18n 键护栏的**待办台账**（棘轮：只许缩小）。
 *
 * 列出的 spec 渲染出了裸键（局部 messages 夹具缺键），`expectNoRawI18nKey` 暂按警告处理；
 * **未列出的 spec 一律严格**：挂载即断言，裸键就红。补齐夹具后删掉对应条目即可。
 *
 * 实测来源：2026-11-12 接线后全量单测 38 个 spec / 168 条用例命中（真实现存问题，非误报）。
 */
export const i18nFixtureBacklog: Record<string, { keys: string[]; note: string }> = {
    "__tests__/titlePlaceholderLabels.spec.ts": {
        keys: [
            "common.files",
            "sidebar.newChat",
            "workspace.addWorkspace",
            "workspace.agentManagement",
            "workspace.importSource",
            "workspace.noActiveFile",
            "workspace.toggleCode",
            "workspace.toggleDelegation",
            "workspace.toggleDiff",
            "workspace.toggleMembers",
            "workspace.toggleMonitor",
            "workspace.toolbarMore",
        ],
        note: "渲染出 12 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "components/__tests__/ImageUpload.spec.ts": {
        keys: ["chat.image"],
        note: "渲染出 1 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "components/__tests__/KnowledgeBaseView.spec.ts": {
        keys: ["settings.ia.noAtomBody", "settings.ia.noAtomTitle"],
        note: "渲染出 2 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "components/__tests__/VoiceInput.spec.ts": {
        keys: ["chat.voice"],
        note: "渲染出 1 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "components/settings/__tests__/ConfigDomainPanel.anchor.spec.ts": {
        keys: ["settings.configCardExpandHint", "settings.configCardFieldCount"],
        note: "渲染出 2 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "components/settings/__tests__/ConfigDomainPanelReset.spec.ts": {
        keys: ["settings.configCardExpandHint", "settings.configCardFieldCount"],
        note: "渲染出 2 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "components/settings/__tests__/SettingsSidebar.spec.ts": {
        keys: [
            "settings.ia.entryCount",
            "settings.ia.gapNoteKnowledge",
            "settings.ia.gapNoteMcp",
            "settings.ia.layerWorkspaceDefault",
        ],
        // task-108：本台账里原来那条「实例级智能体缺口说明」的键已随死文案一起删除（消费者 task-165 摘除、
        // 真入口 task-91 上线）。**这里故意不写出完整键名** —— `i18n-scan` 第 ③ 类会把源码里长得像键的字面量
        // 当引用查两侧 locale，写了就 `unresolved-key` 红（task-108 实测拦下过一次）。task-129 删聚合键时
        // 用的也是「描述而不写字面量」这个写法，照它。
        note: "渲染出 5 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。（原 7 键中的两个「知识库·MCP」聚合键已由 task-129 从两侧 locale 删除：无任何 IA 条目引用 ⇒ 死键、渲染不出来，故同批从台账移除；「实例级智能体缺口说明」那条由 task-108 同法移除。）【task-108 实测存疑项】本条 keys 与当前渲染**不一致**：2026-11-15 vitest 实测该 spec 只渲染出 `settings.groupModelConfig`、`settings.groupAgentConfig`（2 个，且都不在本列表内）⇒ 这 4 条是历史记录、不是当前事实。闸门按 spec 路径整体放行，故不影响绿，但**别把它当读数用**。",
    },
    "features/workspace/__tests__/WorkspaceView.spec.ts": {
        keys: [
            "common.files",
            "files.titleFiles",
            "sidebar.newChat",
            "workspace.addWorkspace",
            "workspace.eventsReconnecting",
            "workspace.importSource",
            "workspace.noActiveFile",
            "workspace.sseReconnectingHint",
            "workspace.sseReconnectingTitle",
            "workspace.toggleDelegation",
            "workspace.toggleMembers",
            "workspace.toolbarMore",
            "workspace.treeResize",
        ],
        note: "渲染出 13 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "features/workspace/chat/__tests__/InputArea.spec.ts": {
        keys: ["chat.delegation.button", "chat.delegation.reasonUnknown"],
        note: "渲染出 2 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "features/workspace/chat/__tests__/InputAreaCommands.spec.ts": {
        keys: ["chat.delegation.button", "chat.delegation.reasonUnknown"],
        note: "渲染出 2 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "features/workspace/chat/__tests__/InputAreaMention.spec.ts": {
        keys: ["chat.delegation.button", "chat.delegation.reasonUnknown", "chat.input.ccLabel"],
        note: "渲染出 3 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "features/workspace/chat/__tests__/InputAreaSlash.spec.ts": {
        keys: ["chat.delegation.button", "chat.delegation.reasonUnknown"],
        note: "渲染出 2 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "features/workspace/chat/__tests__/InputAreaSpeakAs.spec.ts": {
        keys: [
            "chat.delegation.button",
            "chat.delegation.reasonUnknown",
            "chat.input.recipientPlaceholder",
            "chat.input.recipientRemove",
            "chat.input.toLabel",
        ],
        note: "渲染出 5 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "features/workspace/chat/__tests__/InputAreaToCc.spec.ts": {
        keys: [
            "chat.delegation.button",
            "chat.delegation.reasonUnknown",
            "chat.input.recipientHint",
            "chat.input.recipientPlaceholder",
            "chat.input.recipientRemove",
            "chat.input.toTargetsLabel",
        ],
        note:
            "渲染出 6 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。" +
            "（2026-11-15 task-88：toAgentsOnlyHint 随「只能选智能体」口径一并删除 ⇒ 7 → 6。）",
    },
    "features/workspace/chat/__tests__/InputAreaToTargets.spec.ts": {
        keys: [
            "chat.delegation.button",
            "chat.delegation.reasonUnknown",
            "chat.input.recipientHint",
            "chat.input.recipientPlaceholder",
        ],
        note: "渲染出 4 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "features/workspace/chat/__tests__/MessageListVirtual.spec.ts": {
        keys: ["common.messages"],
        note: "渲染出 1 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "features/workspace/components/__tests__/SseSubscriberLimitNotice.spec.ts": {
        keys: [
            "workspace.sseDisconnectedHint",
            "workspace.sseDisconnectedTitle",
            "workspace.sseNoticeRetry",
            "workspace.sseReconnectingHint",
            "workspace.sseReconnectingTitle",
            "workspace.sseSubscriberLimitHint",
            "workspace.sseSubscriberLimitTitle",
        ],
        note: "渲染出 7 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "features/workspace/components/__tests__/WorkspaceMcpPanel.spec.ts": {
        keys: [
            "settings.mcpServersTitle",
            "settings.mcpStatusEmpty",
            "settings.mcpStatusEmptyHint",
            "settings.mcpStatusRefresh",
        ],
        note: "渲染出 4 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "features/workspace/components/__tests__/WorkspaceWorkbench.spec.ts": {
        keys: [
            "common.files",
            "files.titleFiles",
            // task-162 ②：dock 形态三键已随 locale 删除（浮窗退场），此台账条目同步收账。
            "workspace.importSource",
            "workspace.noActiveFile",
            "workspace.panelMembers",
            "workspace.participantsEmptyNoSession",
            "workspace.toggleMembers",
            "workspace.toolbarMore",
            "workspace.treeResize",
        ],
        note: "渲染出 9 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "layouts/__tests__/AppLayout.spec.ts": {
        keys: [
            "common.openNavigation",
            "nav.open",
            "sidebar.collapse",
            "sidebar.empty",
            "sidebar.logout",
            "sidebar.newChat",
            "sidebar.search",
            "sidebar.settings",
            "workspace.environmentState",
            "workspace.scheduledTasks.nav",
            "workspace.settingsTitle",
            "workspace.tabBarLabel",
            "workspace.tabChatFallback",
            "workspace.tabClose",
        ],
        note: "渲染出 14 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "layouts/__tests__/SettingsLayout.backToChat.spec.ts": {
        keys: ["settings.commandk.trigger"],
        note: "渲染出 1 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "views/settings/__tests__/SettingsDomainView.layerSettled.spec.ts": {
        keys: [
            "settings.ia.fourLayerDetail",
            "settings.ia.fourLayerInstance",
            "settings.ia.fourLayerLowToHigh",
            "settings.ia.fourLayerOrderLabel",
            "settings.ia.fourLayerUser",
            "settings.ia.fourLayerWorkspace",
            "settings.ia.fourLayerWorkspaceDefault",
        ],
        note: "渲染出 7 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "components/__tests__/WorkspacePicker.spec.ts": {
        keys: ["workspacePicker.loading", "workspacePicker.title"],
        note: "渲染出 2 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "features/workspace/__tests__/DiffViewer.spec.ts": {
        keys: ["workspace.diffLoadFailed"],
        note: "渲染出 1 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "features/workspace/__tests__/MobileChatSheet.sheet-height.spec.ts": {
        keys: ["chat.titleChat", "common.openChat"],
        note: "渲染出 2 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "features/workspace/__tests__/MobileChatSheet.spec.ts": {
        keys: [
            "chat.titleChat",
            "common.openChat",
            "workspace.agentUnbound",
            "workspace.membersEntryLabel",
        ],
        note: "渲染出 4 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "components/settings/__tests__/ApiRequestTemplatesPanel.spec.ts": {
        keys: [
            "common.apiType",
            "settings.apiRequest.description",
            "settings.apiRequest.empty",
            "settings.apiRequest.fallbackEmpty",
            "settings.apiRequest.format",
            "settings.apiRequest.name",
            "settings.apiRequest.new",
            "settings.apiRequest.publish",
            "settings.apiRequest.rawHelp",
            "settings.apiRequest.revisions",
            "settings.apiRequest.saveDraft",
            "settings.apiRequest.source",
            "settings.apiRequest.statusPublished",
            "settings.apiRequest.templates",
            "settings.apiRequest.variables",
            "settings.apiTypeOpenaiChatCompletions",
            "settings.domainContextTemplates",
        ],
        note: "渲染出 17 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "components/settings/__tests__/EmbeddingSettingsPanel.spec.ts": {
        keys: ["common.loading", "settings.domainEmbedding", "settings.embeddingInstanceNote"],
        note: "渲染出 3 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "components/settings/__tests__/LlmDefaultProfilePanel.spec.ts": {
        keys: [
            "common.loading",
            "settings.llmInstanceDefaultDesc",
            "settings.llmInstanceDefaultTitle",
            "settings.providerInstanceNote",
        ],
        note: "渲染出 4 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "views/auth/__tests__/LoginView.spec.ts": {
        keys: [
            "login.hint",
            "login.login",
            "login.noAccount",
            "login.password",
            "login.register",
            "login.title",
            "login.username",
        ],
        note: "渲染出 7 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "views/auth/__tests__/OnboardingView.spec.ts": {
        keys: [
            "onboarding.email",
            "onboarding.hint",
            "onboarding.name",
            "onboarding.password",
            "onboarding.submit",
            "onboarding.title",
        ],
        note: "渲染出 6 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "views/auth/__tests__/RegisterView.spec.ts": {
        keys: [
            "login.hasAccount",
            "login.hint",
            "login.login",
            "register.confirmPassword",
            "register.email",
            "register.password",
            "register.submit",
            "register.title",
            "register.username",
            "register.usernameHint",
            "register.usernameRule",
        ],
        note: "渲染出 11 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "features/workspace/chat/__tests__/CodeBlock.spec.ts": {
        keys: ["chat.apply", "chat.copy"],
        note: "渲染出 2 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "features/workspace/chat/__tests__/CodeBlockToken.spec.ts": {
        keys: ["chat.apply", "chat.copy"],
        note: "渲染出 2 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "features/workspace/chat/__tests__/SessionContextTemplate.spec.ts": {
        keys: [
            "chat.contextTemplateLabel",
            "sessionSettings.templateSelectPlaceholder",
            "sessionSettings.templateUnbound",
        ],
        note: "渲染出 3 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
    "features/workspace/chat/__tests__/SessionItem.spec.ts": {
        keys: ["sidebar.pendingApprovalBadge"],
        note: "渲染出 1 个裸键：夹具 messages 缺键（组件 t() 拿不到值原样回显）。补齐这些键即可从台账移除。",
    },
};
