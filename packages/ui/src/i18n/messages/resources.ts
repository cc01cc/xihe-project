export const messages = {
    "zh-CN": {
        // PLAN-0772 M2：资源模块（搬出 /settings 之后的新顶层入口）。
        // tab 文案写**所属主体**（我的 / 本工作区 / 全平台），不写层名 —— 这是用户 7/7 表态
        // 里唯一被改的一条（Q4 技能也要分层），其余四屏沿用同一套措辞。
        resources: {
            navGroup: "资源",
            // task-89：资源区两个无名地标（左侧栏 complementary、页头 banner）补可访问名。
            navScopeLabel: "资源导航面板",
            headerLabel: "资源区页头",
            // task-96：`nameAgents`（「智能体」）已删 —— 资源区不再有智能体页（用户裁定
            // 「智能体是组织成员，不是资源」）。层内名仍在 `settings.ia.resourceAgents`
            // （平台智能体）里，由设置域实例资源页复用。
            // task-145 / DSD-1511：D-1432 / task-41 的「已迁到工作区设置」指路文案（5 条）连同
            // 指路卡一起删除 —— 已迁层不再出现在页签与说明条，深链静默回落 INSTANCE / USER。
            // task-52 / batch-02 ③：把两条说明压成一条**可折叠摘要**（默认收起）。
            // 摘要行说明「这里有说明」，展开才给明细与直链 —— 导航说明不该压过功能主体。
            resourcesHintSummary: "关于本页资源的层级与去处",
            resourcesHintShow: "查看说明",
            resourcesHintHide: "收起说明",
            // 技能「本工作区」层只读面板（Lead 裁定一：读面补上，写面如实写明未接线）。
            workspaceSkillsTitle: "本工作区技能",
            workspaceSkillsCount: "{count} 个",
            workspaceSkillsSubtitle: "这里只读列出本工作区自建的技能定义。",
            workspaceSkillsWriteUnavailable:
                "写面未接线：导入对话框的 scope 由 JSON 里的 definitionScope 决定，本页不预填 workspace scope。",
            workspaceSkillsLoading: "正在读取本工作区技能…",
            workspaceSkillsForeignIgnored:
                "接口返回了 {count} 条不属于本工作区的条目，已忽略（本层只显示本工作区自建的定义）。",
            workspaceSkillsErrorTitle: "读取本工作区技能失败",
            workspaceSkillsRetry: "重试",
            workspaceSkillsEmptyTitle: "本工作区还没有技能",
            workspaceSkillsEmptyBody:
                "本工作区自建的技能会出现在这里。只有接口正常返回空列表时才显示这句话。",
            breadcrumbRoot: "资源",
            breadcrumbLabel: "面包屑",
            layerUser: "我的",
            layerWorkspace: "本工作区",
            layerInstance: "全平台",
            layerTab: {
                credentials: {
                    USER: "我的凭据",
                    WORKSPACE: "本工作区凭据",
                    INSTANCE: "全平台凭据",
                },
                mcp: { WORKSPACE: "本工作区 MCP", INSTANCE: "全平台 MCP" },
                skills: {
                    USER: "我的技能",
                    WORKSPACE: "本工作区技能",
                    INSTANCE: "全平台技能",
                },
                // task-96：`agents` 段已删 —— `ResourceLayerTabs` 的 `resourceId` 是 `ResourceId`，
                // 智能体撤出资源面后这个键**物理不可达**（三层标签由落点页各自持有）。
            },
            tabsLabel: "资源层",
            disabledHint: "这些层当前不可切换，下方说明了原因。",
            reasonNoWorkspace: "该层的数据按工作区归属：当前没有工作区上下文",
            // task-22（C-4 同族，树外）：点名能力位用用户语言，不写 wire 标识 instance:admin。
            reasonCapability: "需要实例管理员能力",
            skills: {
                panelMine: "我的技能",
                subtitleMine:
                    "个人技能库只属于你：其他用户、本工作区和其他工作区都看不到这些定义。",
                count: "{count} 条",
                loading: "正在读取个人技能…",
                loadErrorTitle: "读取个人技能失败",
                loadErrorBody:
                    "读取请求失败。这不代表你没有个人技能 —— 请重试；仍然失败请查看服务健康。",
                retry: "重试",
                emptyTitle: "个人技能库还是空的",
                emptyBody: "用「导入技能」把已有的技能定义（JSON）导入进来；只有你自己能看到它们。",
                importMine: "导入技能",
                importDisabledReason:
                    "写入需要「管理个人技能」权限；读取不受该权限限制（撤销权限后仍可读自己已有的个人技能）。",
                importEntryNote:
                    "导入时归属人由服务端按当前登录账号确定，请求里不带也不接受他人的 id。",
                foreignIgnored: "{count} 条不属于个人库的行被忽略（它们不属于这一层）",
                importResultTitle: "导入结果",
                importResultLine:
                    "新建 {created} · 更新 {updated} · 未变 {unchanged} · 被拒 {rejected} · 超长 {oversize}",
                importRefreshed: "列表已刷新。",
                rejectedHeading: "被拒条目",
                rejectedRow: "{path}：{reason}",
                /**
                 * task-312 · 个人层「新建技能」（按钮 + 单条表单对话框）。
                 * `sameNameBody` 必须同时说出「会更新」与「原内容不可恢复」——只说"同名已存在"
                 * 会被读成合并或另存（Lead 的验收口径）。
                 */
                create: {
                    cta: "新建技能",
                    title: "新建个人技能",
                    description: "只有你能看到它。提交时归属人由服务端按当前登录账号确定。",
                    nameLabel: "名称",
                    nameHint:
                        "小写字母或数字开头，可含 . _ -，最长 64 字符；它同时决定存放目录名（派生为 manual/名称/SKILL.md）。",
                    descriptionLabel: "一句话说明",
                    descriptionHint: "单行、无首尾空格、无控制字符；列表按这一行展示。",
                    bodyLabel: "正文",
                    bodyHint: "SKILL.md 去掉 frontmatter 的部分；不能为空。",
                    submit: "创建",
                    submitting: "正在创建…",
                    cancel: "取消",
                    sameNameTitle: "已存在同名技能",
                    sameNameBody:
                        "已存在同名技能「{name}」（当前版本 v{version}）。继续提交会更新它（版本 +1），原内容不可恢复。",
                    sameNameConfirm: "继续更新",
                    unchangedTitle: "内容没有变化",
                    unchanged: "已存在同名技能且正文相同，本次没有做任何修改。",
                    rejectedTitle: "这条定义没有被写入",
                    rejectedNote: "单条新建被拒 = 什么都没建；按上面的原因改完再提交即可。",
                },
                workspaceSourceNote:
                    "本层只含本区自建定义；平台库的定义通过智能体绑定可见 —— 技能没有继承语义，所以本页不画来源列。",
            },
            workspaceMissing: {
                title: "先选择一个工作区",
                body: "本工作区层的资源按工作区归属；当前页签里没有工作区上下文。",
                action: "去工作台选择工作区",
            },
            knowledgeGap: {
                title: "知识库暂不可用",
                // task-26（批 1）：「缺口」是内部概念词，用户语言是「目前还不可用」。
                // D-1879 裁定一（task-47）：文案只写**用户能感知的后果**。可核验性属于测试面与
                // 证据面，不属于文案面 —— 原先的 basisLabel「怎么核」+ 每条 basis（类名、grep 命令、
                // 契约文件名、源码行号、接口路径）是**审查者的验证义务**，写进正文会让面向用户的
                // 页面长成工程工作日志。删除判据见 DEV-011 §14；「不承诺时间」这条纪律保留。
                intro: "这个版本还没有知识库：没有可以新建、命名或共享的「库」，也没有列出库内文档的地方。下面说明缺的是哪几块，以及它对你意味着什么。这里不写排期，也不承诺时间。",
                gaps: {
                    noLibrary: {
                        title: "① 还没有「库」这个东西",
                        body: "你在别处熟悉的「新建知识库 → 上传文档 → 选库问答」在这里没有对应功能位 —— 服务端还没有这个对象，不是界面把它藏起来了。",
                    },
                    noDocList: {
                        title: "② 看不到库里收了哪些文档",
                        body: "即便有内容，也没有地方列出「收了哪些文档、各分成多少块」。所以本页不画文档列表，免得给你一个看着能用、点开是空的列表。",
                    },
                    partition: {
                        title: "③ 索引按「人 + 工作区」分开，不按库共享",
                        body: "同一个工作区里，不同的人看到的是各自的索引，不是一份共享库。「把库共享给同事」目前没有落点。",
                    },
                    noWriteEntry: {
                        title: "④ 上传入口暂时没有挂载点",
                        body: "上传与删除的能力还在，但目前没有任何页面把它接出来 —— 这是当前入口的真实状态，不是排期。",
                    },
                    chatSide: {
                        title: "⑤ 提问不会触发知识库检索",
                        body: "这一版里没有可检索的知识库：在会话里问「只有资料里才有」的问题时，不会发生任何检索，也就不会拿到来自知识库的答案。会话本身照常可用。",
                    },
                },
            },
            /**
             * task-228：资源**详情单页**（`/resources/<id>/:pk?layer=<LAYER>`）。
             * 文案只描述**已接线的读面**与四种状态；不出现「暂不支持」这种会把"没有读面"说成
             * "将来会有"的措辞（未接线就是未接线）。
             */
            detail: {
                backToList: "返回列表",
                loading: "正在读取资源详情…",
                link: "详情",
                linkAria: "{name} 的详情",
                boolean: { true: "是", false: "否" },
                notFound: {
                    title: "找不到这条资源",
                    body: "该层没有这条记录（可能已删除，或地址里的 pk 拼错）。返回列表可以确认当前层有哪些资源。",
                },
                unwired: {
                    title: "这一层没有详情面",
                    body: "本页只显示已经接通的功能；上面这条说明是当前「资源 + 层」的真实状态，不是加载失败。",
                    reasons: {
                        noWorkspace:
                            "该层的资源按工作区归属：当前页签没有工作区上下文，页面无法确定该取哪一个工作区。",
                        // task-26（批 1）：不印内部编号（G3），也不印实现细节（无表/无 CRUD）——
                        // 用户要的是"为什么这里没有详情页"，不是数据库长什么样。
                        knowledgeGap:
                            "知识库没有实体：目前只有按工作区分区的接口，因此没有可单独打开的详情页。",
                        layerMissing:
                            "该资源没有这一层（层解析应已回落到默认层）—— 出现这句说明状态自相矛盾，请报告。",
                    },
                },
                error: {
                    title: "读取详情失败",
                    body: "读取这条详情失败。下面是后端健康检查的结果，用来区分「服务不健康」与「只有这一条读不到」。",
                    retry: "重试",
                },
                health: {
                    ok: "CP 健康检查：{status}",
                    unreachable: "CP 健康检查：不可达",
                },
                sections: {
                    references: "引用",
                    events: "审计事件",
                    roles: "角色绑定",
                    skills: "技能绑定",
                    attachments: "附件",
                    body: "正文",
                    mcpConfig: "配置",
                },
                empty: {
                    references: "这条凭据目前没有引用",
                    events: "没有审计事件",
                    roles: "没有角色绑定",
                    skills: "没有技能绑定",
                    attachments: "没有附件",
                },
                /** task-42：键**在**但值为空 ⇒ 显式画「（空）」，不让它静默消失。 */
                emptyValue: "（空）",
                absent: {
                    title: "接口没有返回这几个字段",
                    body: "下面这些字段，接口这次没有返回 —— 和「返回了但值是空的」不是一回事，所以页面不猜、也不拿空值顶上，只把它们逐条点名。至于这是后端还没做，还是本来就不要求这个字段，本页看不出来；要分清得看这个接口的字段定义，不在这里下结论。",
                },
                notes: {
                    instanceCredential:
                        "实例层凭据没有「谁在引用它」和「审计记录」这两块数据，所以本页不显示这两个区块（这不等于「没有引用」。）",
                    partialRead: "部分区块读取失败：只显示读取成功的区块，失败的不渲染。",
                    workspaceSkillBody:
                        "工作区层没有「单条技能的正文」这项数据（正文只存在于实例层定义），因此本页不显示正文。",
                },
                fields: {
                    label: "名称",
                    kind: "类型",
                    deliveryTier: "交付方式",
                    status: "状态",
                    owner: "归属",
                    fingerprint: "指纹",
                    revision: "修订号",
                    references: "引用数",
                    createdAt: "创建时间",
                    replacedAt: "替换时间",
                    name: "名称",
                    description: "描述",
                    scope: "作用域",
                    workspace: "工作区",
                    skillId: "技能 ID",
                    version: "版本",
                    trusted: "受信",
                    oversize: "超大",
                    bodyTokens: "正文字符估算",
                    sourcePath: "来源路径",
                    contentHash: "内容哈希",
                    updatedAt: "更新时间",
                    template: "模板",
                    principalId: "主体 ID",
                    modelProvider: "模型提供方",
                    modelName: "模型名",
                    defaultModel: "默认模型",
                    allowedModels: "可用模型数",
                    bound: "已绑定",
                    disabled: "已禁用",
                    hooks: "Hook 订阅",
                    contextPolicy: "上下文策略",
                    transport: "传输",
                    url: "地址",
                    enabled: "已启用",
                    credentialId: "凭据 ID",
                    state: "运行状态",
                    attempt: "尝试次数",
                    lastError: "最近错误",
                    since: "状态起始时间",
                    epoch: "世代",
                },
            },
        },
    },
    "en-US": {
        // PLAN-0772 M2: the resources module (a new top-level entry after leaving /settings).
        resources: {
            navGroup: "Resources",
            // task-89: name the two unnamed landmarks in the resources area (sidebar complementary, header banner).
            navScopeLabel: "Resources navigation panel",
            headerLabel: "Resources header",
            // task-145 / DSD-1511: the five "moved to workspace settings" notice strings were
            // deleted together with the notice card; the retired layer is no longer a tab here.
            resourcesHintSummary: "Where this page's resources live",
            resourcesHintShow: "Show details",
            resourcesHintHide: "Hide details",
            workspaceSkillsTitle: "Workspace skills",
            workspaceSkillsCount: "{count} total",
            workspaceSkillsSubtitle:
                "This read-only list shows skill definitions created in this workspace.",
            workspaceSkillsWriteUnavailable:
                "Writing is not wired yet: the import dialog derives its scope from the definitionScope in the JSON, so this page never pre-fills a workspace scope.",
            workspaceSkillsLoading: "Loading workspace skills…",
            workspaceSkillsForeignIgnored:
                "{count} entries returned by the API do not belong to this workspace and were ignored (this layer only shows definitions created here).",
            workspaceSkillsErrorTitle: "Could not load workspace skills",
            workspaceSkillsRetry: "Retry",
            workspaceSkillsEmptyTitle: "This workspace has no skills yet",
            workspaceSkillsEmptyBody:
                "Skill definitions created in this workspace show up here. This state only appears when the API really returned an empty list.",
            breadcrumbRoot: "Resources",
            breadcrumbLabel: "Breadcrumb",
            layerUser: "Mine",
            layerWorkspace: "This workspace",
            layerInstance: "Platform-wide",
            layerTab: {
                credentials: {
                    USER: "My credentials",
                    WORKSPACE: "Workspace credentials",
                    INSTANCE: "Platform credentials",
                },
                mcp: { WORKSPACE: "Workspace MCP", INSTANCE: "Platform MCP" },
                skills: {
                    USER: "My skills",
                    WORKSPACE: "Workspace skills",
                    INSTANCE: "Platform skills",
                },
                // task-96：`agents` 段已删（与 zh 同步）—— 资源面不再有智能体，层标签键不可达。
            },
            tabsLabel: "Resource layer",
            disabledHint: "These layers cannot be selected right now; the reason is shown below.",
            reasonNoWorkspace:
                "This layer is scoped to a workspace, and there is no workspace context right now",
            // task-22 (same family as C-4, outside the settings subtree): user language, no wire token.
            reasonCapability: "Requires instance-admin capability",
            skills: {
                panelMine: "My skills",
                subtitleMine:
                    "The personal library belongs to you alone: other users, this workspace and every other workspace cannot see these definitions.",
                count: "{count} total",
                loading: "Loading personal skills…",
                loadErrorTitle: "Could not load personal skills",
                loadErrorBody:
                    "The read request failed. This does not mean you have no personal skills — retry; if it keeps failing, check service health.",
                retry: "Retry",
                emptyTitle: "Your personal library is still empty",
                emptyBody:
                    "Use “Import skills” to bring existing skill definitions (JSON) in here; only you can see them.",
                importMine: "Import skills",
                importDisabledReason:
                    "Writing requires the “Manage personal skills” permission; reading is not gated by it (after a revocation you can still read your own personal skills).",
                importEntryNote:
                    "On import the owner is determined server-side from the signed-in account; the request carries no id of anyone else and does not accept one.",
                foreignIgnored:
                    "{count} row(s) outside the personal library were ignored (they do not belong to this layer)",
                importResultTitle: "Import result",
                importResultLine:
                    "created {created} · updated {updated} · unchanged {unchanged} · rejected {rejected} · oversize {oversize}",
                importRefreshed: "The list has been refreshed.",
                rejectedHeading: "Rejected items",
                rejectedRow: "{path}: {reason}",
                /**
                 * task-312 · the personal-layer "new skill" entry (button + single-item form dialog).
                 * `sameNameBody` must say both "will update it" and "cannot be recovered": "a skill
                 * with this name already exists" alone reads as merge or save-as.
                 */
                create: {
                    cta: "New skill",
                    title: "New personal skill",
                    description:
                        "Only you can see it. On submit the owner is determined server-side from the signed-in account.",
                    nameLabel: "Name",
                    nameHint:
                        "Starts with a lowercase letter or digit; may contain . _ -; at most 64 characters. It also decides the directory name (derived as manual/<name>/SKILL.md).",
                    descriptionLabel: "One-line description",
                    descriptionHint:
                        "Single line, no leading/trailing spaces, no control characters; the list shows this line.",
                    bodyLabel: "Body",
                    bodyHint: "The SKILL.md body without the frontmatter; must not be empty.",
                    submit: "Create",
                    submitting: "Creating…",
                    cancel: "Cancel",
                    sameNameTitle: "A skill with this name already exists",
                    sameNameBody:
                        "A skill named “{name}” already exists (current version v{version}). Submitting will update it (version +1); the previous content cannot be recovered.",
                    sameNameConfirm: "Update it",
                    unchangedTitle: "Nothing changed",
                    unchanged:
                        "A skill with this name and an identical body already exists; nothing was modified.",
                    rejectedTitle: "The definition was not written",
                    rejectedNote:
                        "A rejected single create means nothing was written; fix the reason above and submit again.",
                },
                workspaceSourceNote:
                    "This layer holds workspace-owned definitions only; platform definitions reach agents through bindings — skills have no inheritance semantics, so this page shows no source column.",
            },
            workspaceMissing: {
                title: "Pick a workspace first",
                body: "Workspace-scoped resources belong to a workspace; this tab has no workspace context.",
                action: "Go to the workbench and pick a workspace",
            },
            knowledgeGap: {
                title: "Knowledge base is not available yet",
                // D-1879 ruling 1 (task-47): copy states only what a **user can perceive**.
                // Verifiability belongs to the test surface and the evidence pack, not to product
                // copy. The old basisLabel "How to verify" plus each basis line (class names, grep
                // commands, contract file names, source file:line, endpoint paths) was the
                // reviewer's verification duty written into body text — which is what made this
                // user-facing page read like an engineering work log. See DEV-011 §14.
                intro: "This build has no knowledge base: there is no library you can create, name or share, and no place that lists the documents inside one. Below is what is missing and what that means for you. No schedule is written down here and no date is promised.",
                gaps: {
                    noLibrary: {
                        title: "1. There is no library object yet",
                        body: "The flow you may know from elsewhere — create a library, upload documents, ask questions against one — has no entry point here, because the server has no such object. It is not hidden behind the interface.",
                    },
                    noDocList: {
                        title: "2. No way to see which documents are in a library",
                        body: "Even where content exists, nothing lists which documents were ingested or how many chunks each became. This page therefore shows no document list rather than one that looks usable and opens empty.",
                    },
                    partition: {
                        title: "3. Indexes are split by person and workspace, not by library",
                        body: "Inside one workspace, different people see their own index rather than one shared library. Sharing a library with a teammate has no home today.",
                    },
                    noWriteEntry: {
                        title: "4. The upload entry has no mount point today",
                        body: "Upload and delete still exist in the product, but no page wires them up — that is the current state of the entry point, not a schedule.",
                    },
                    chatSide: {
                        title: "5. Asking a question never searches a knowledge base",
                        body: "There is no searchable knowledge base in this build: asking about something only a document could answer triggers no retrieval, so no knowledge-base answer comes back. The conversation itself keeps working.",
                    },
                },
            },
            /**
             * task-228: the resource **detail page** (`/resources/<id>/:pk?layer=<LAYER>`).
             * Copy only describes wired read faces and the four states; it never turns
             * "no read face" into "coming soon".
             */
            detail: {
                backToList: "Back to the list",
                loading: "Loading resource detail…",
                link: "Details",
                linkAria: "Details for {name}",
                boolean: { true: "Yes", false: "No" },
                notFound: {
                    title: "Resource not found",
                    body: "This layer has no such record (it may be deleted, or the pk in the address is mistyped). Go back to the list to see what this layer really has.",
                },
                unwired: {
                    title: "This layer has no detail surface",
                    body: "This page only shows features that are actually wired up; the line above describes the real state of this resource and layer, not a load failure.",
                    reasons: {
                        noWorkspace:
                            "This layer is scoped to a workspace and the current tab has no workspace context, so the page cannot pick which workspace to read.",
                        // task-26 (batch 1): no internal gap id, no storage/CRUD detail.
                        knowledgeGap:
                            "Knowledge bases have no entity yet - only workspace-scoped endpoints exist today, so there is no detail page to open.",
                        layerMissing:
                            "This resource does not have this layer (layer resolution should have fallen back to the default); seeing this line means the state contradicts itself - please report it.",
                    },
                },
                error: {
                    title: "Could not load the detail",
                    body: "Could not read this detail. The health check below tells apart an unhealthy service from a single unreadable record.",
                    retry: "Retry",
                },
                health: {
                    ok: "CP health: {status}",
                    unreachable: "CP health: unreachable",
                },
                sections: {
                    references: "References",
                    events: "Audit events",
                    roles: "Role bindings",
                    skills: "Skill bindings",
                    attachments: "Attachments",
                    body: "Body",
                    mcpConfig: "Configuration",
                },
                empty: {
                    references: "This credential has no references",
                    events: "No audit events",
                    roles: "No role bindings",
                    skills: "No skill bindings",
                    attachments: "No attachments",
                },
                notes: {
                    instanceCredential:
                        "Instance-layer credentials have no “who uses it” or “audit history” data, so this page shows neither block (that is not the same as “no references”).",
                    partialRead:
                        "Some blocks could not be read: only the successful ones render, the failed ones are omitted.",
                    workspaceSkillBody:
                        "The workspace layer has no per-skill body data (bodies exist only on instance definitions), so this page shows no body.",
                },
                /** task-42: a key that IS present but empty renders an explicit "(empty)" instead of vanishing. */
                emptyValue: "(empty)",
                absent: {
                    title: "These fields were not returned",
                    body: "These fields were not returned by the API this time — that is different from “returned but empty”, so the page neither guesses nor fills in a blank value; it names them one by one. Whether the backend has not implemented them yet or the API simply does not require the field is not visible from this page; telling those apart needs the field definitions for this endpoint, and we do not draw that conclusion here.",
                },
                fields: {
                    label: "Label",
                    kind: "Kind",
                    deliveryTier: "Delivery",
                    status: "Status",
                    owner: "Owner",
                    fingerprint: "Fingerprint",
                    revision: "Revision",
                    references: "References",
                    createdAt: "Created",
                    replacedAt: "Replaced",
                    name: "Name",
                    description: "Description",
                    scope: "Scope",
                    workspace: "Workspace",
                    skillId: "Skill ID",
                    version: "Version",
                    trusted: "Trusted",
                    oversize: "Oversize",
                    bodyTokens: "Body size estimate",
                    sourcePath: "Source path",
                    contentHash: "Content hash",
                    updatedAt: "Updated",
                    template: "Template",
                    principalId: "Principal ID",
                    modelProvider: "Model provider",
                    modelName: "Model name",
                    defaultModel: "Default model",
                    allowedModels: "Allowed models",
                    bound: "Bound",
                    disabled: "Disabled",
                    hooks: "Hooks",
                    contextPolicy: "Context policy",
                    transport: "Transport",
                    url: "URL",
                    enabled: "Enabled",
                    credentialId: "Credential ID",
                    state: "Runtime state",
                    attempt: "Attempts",
                    lastError: "Last error",
                    since: "State since",
                    epoch: "Epoch",
                },
            },
        },
    },
};
