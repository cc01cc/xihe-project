export const messages = {
    "zh-CN": {
        chat: {
            titleChat: "对话",
            searchMessages: "搜索消息",
            searchPlaceholder: "搜索消息…",
            approvalDispatchUnknown:
                "需要重试恢复：上一次审批请求没有返回结果。请选择一个决定以重试；系统不会自动发送决定。",
            mobileSheetDescription: "在当前 workspace 中与 Agent 对话。工具绑定当前 workspace。",
            loadOlder: "加载更早的消息",
            loadingOlder: "正在加载更早的消息…",
            loadOlderFailed: "加载更早的消息失败",
            foldedOlder: "更早的 {count} 条消息已折叠，点击加载",
            expandedLimitReached: "已展开到上限（1500 条）",
            loadMessagesFailed: "加载消息失败，请重试",
            contextTruncationNotice:
                "本次回答基于被截断的历史（丢弃 {dropped} 条 / 保留 {kept} 条）",
            contextTruncationDismiss: "关闭截断提示",
            // PLAN-0572 / BL-555 G3：持久化 toolCalls 快照被 CP 截断时（MAX_CALLS=200）的提示。
            toolCallsTruncationTitle: "工具调用被截断",
            toolCallsTruncationNotice:
                "仅显示前 {visible} 条工具调用（共 {total} 条，更早的未持久化）",
            toolCallsTruncationDetail:
                "更早的调用没有持久化到消息上，界面上无法还原；如需完整清单请查看该 run 的调用轨迹。",
            toolCallsTruncationTraceHint: "完整调用轨迹（run）：",
            send: "发送",
            // task-792：空会话建议文案（两套 toolMode 都走 i18n，en 侧不得留 CJK）。
            suggest: {
                listFiles: "列出文件",
                openReadme: "打开 README",
                explainSelection: "解释选中的文件",
                workspaceEnv: "查看工作区环境",
                weather: "今天天气怎么样？",
                writeEmail: "帮我写一封邮件",
                explainConcept: "解释一下这个概念",
                summarizeCode: "总结一下这段代码",
            },
            // PLAN-0659 T1.1：run 头的折叠开关 aria-label（run 短码仅展示）。
            runHeader: {
                toggle: "展开或折叠 run {run}",
            },
            // PLAN-0659 T1.3：消息头投递语义三态（发送 / 抄送 / 被 @）。`listSeparator` 供
            // 名单按 locale 连接（不在视图里硬编码 "、" / ", "）。
            // 投递语义（TO/CC）已在 `messages.delivery` jsonb 持久（V120 / PLAN-0665 D3，
            // BL-239 已关账），跨刷新仍在；`@` 仍从正文+花名册重建、不入库。
            delivery: {
                to: "发送→{name}",
                cc: "抄送→{names}",
                // vue-i18n 里 `@` 是 link 语法修饰符，字面量必须用 `{'@'}` 转义。
                mentioned: "被 {'@'}：{name}",
                // task-66①：花名册解析不掉的原文 @token（不可信文本，纯文本渲染，不做 id 匹配）。
                unresolved: "未识别：{names}",
                unresolvedHint: "这个名字不在花名册里，消息没有发给任何人",
                listSeparator: "、",
            },
            // 2026-11-04 DSH 式过程渲染：推理行的统一标签。
            reasoning: "思考",
            // 2026-11-04 生产力密度裁定：composer 是工具条不是聊天框 —— placeholder 用简写；
            // 此前 zh 缺该 key（走 en fallback）才露出长英文句 "Type a message…"。
            placeholder: "输入消息，Enter 发送 · Shift+Enter 换行",
            delegation: {
                button: "委派",
                badge: "委派",
                delegatedTo: "委派给",
                buttonHint: "委派一个子会话去完成单独的任务",
                reasonNoCapability: "缺少在本工作区委派子会话的能力（SPAWN_AGENT）",
                reasonUnknown: "暂时无法确认委派能力，请稍后重试",
                title: "创建委派（新子会话）",
                description: "委派会为所选主体新开一个独立子会话，预算受该主体的委派策略约束。",
                principalLabel: "委派给",
                principalPlaceholder: "选择智能体主体",
                taskLabel: "任务描述",
                taskPlaceholder: "描述子会话要完成的任务（最多 4000 字）",
                budgetLabel: "预算上限",
                budgetUsage: "预算",
                budgetDepth: "深度",
                budgetHint: "受该主体的 delegationPolicy 约束",
                budgetDisabled: "该主体的委派策略已禁用委派",
                cancel: "取消",
                submit: "创建委派",
                created: "委派已创建，子会话已就绪",
                approvalPending: "审批已发起，批准后将自动创建委派",
                approvalPendingHint: "会话中已发起审批；批准后会用同一幂等键自动重试，无需重填",
                approvalRejected: "委派审批被拒绝或已过期",
                submitFailed: "委派创建失败，请稍后重试",
                // PLAN-0659 T1.4：委派 DAG（右栏）。节点状态复用 derivedStateStatus/Outcome
                // 两套既有词汇，这里只补面板自身文案。
                dagTitle: "委派 DAG",
                dagEmpty: "当前会话还没有委派子会话",
                dagRefresh: "刷新委派图",
                dagError: "委派图暂时加载失败（结构仍显示）",
                dagTruncated: "节点过多，仅显示前 {count} 个",
                // task-1 / D-1846：节点可点击进入该子会话（与 anchor 同一跳转语义，契约 A5）。
                dagOpenNode: "进入子会话：{name}",
                dagBudget: "预算 {used}/{max} · 深度 {depth}/{maxDepth}",
            },
            // PLAN-0635 M1：`/` 命令与 `@` 提及的输入面文案（两者共用一个候选面）。
            input: {
                commandsTitle: "命令",
                mentionsTitle: "会话成员",
                filesTitle: "文件与目录",
                // PLAN-0630 M5b (D30-14)：composer to/cc 栏（邮箱隐喻：to = 主要响应者，cc = 旁听名单）。
                // task-50（用户裁定 P-6）：两词制「发送 / 抄送」，且「发送」= @ 重要通知。
                // 本键是**代发身份**（单选，wire 上的 asParticipantId），不是收件人 ——
                // 旧值叫「发送」会让字典里出现两个「发送」，与新裁定自相矛盾。
                toLabel: "代发身份",
                // task-114：这一栏原本没有栏外说明（发送/抄送都有）。文案必须回答「本条以谁的
                // 账号发出」——让读不懂「代发身份」四个字的人看完就知道该选谁；不是解释词义。
                toLabelHint: "本条以所选身份的账号发出，对方看到的是它，不是你",
                // task-88：M1 的「只能选智能体」口径已废弃（task-65 起 CP 接受人类 TO ⇒ 真人只收通知、
                // 不作答）；那条 hint 连同 i18n 键一起删掉，不留一条会骗人的文案。
                toTargetsLabel: "发送",
                // task-50：两条语义说明（用户原话：发送相当于 @ 是重要通知，抄送就是普通抄送通知）。
                // vue-i18n 把 `@` 当 link 语法（同 `:1176` 的 mentioned），字面量必须转义成 {'@'}。
                // task-102：**两条都要回答「会不会被免打扰屏蔽」**——只让 ccHint 说，读者会以为只有抄送免打扰。
                // 事实两侧都不吃 muted：HUMAN TO 在 `WakeDispatchService:181-185` 直接 return notify，
                // **早于** `:205` 的 `RESPOND_MUTED` 闸；CC 走 `WakeFanOutService:485 notifyObserver`（该文件 MUTED 零命中）。
                toHint: "相当于 {'@'}，会作为重要通知送达，不会被免打扰屏蔽（可多选）",
                // 用户裁定 P-6 原话：抄送就是普通抄送通知，**不会被免打扰屏蔽**（task-65 起代码已实现）。
                ccHint: "普通抄送通知（不会被免打扰屏蔽）",
                // task-38 C3（DEV-011 §13.4）：候选为空时入口**不许静默消失** —— 禁用态入口 + 这一句说明。
                // 说「为什么现在不能抄送」与「怎么才能抄送」，不解释「抄送」这个词。
                ccEmptyHint: "暂无可抄送成员：把成员加进这个会话后就能抄送",
                // task-17（源 = task-6 候选 C-1）：**显式空 TO 的语义可见性**。清空定向栏后发送，
                // wire 上是显式 []（CP 抑制通知）⇒ 消息照常记录、但谁都不通知；界面必须说出来一次。
                // 两条文案刻意分开：提示语义（本条不通知）≠ 失败语义（发送失败），不得共用错误通道。
                toEmptyHint: "本条不会通知任何参与者（消息仍会记录在当前会话）",
                toEmptyHintDismiss: "知道了",
                // task-126 F3：深链「不可满足」提示。只点名 id（名册里查不到这些人 ⇒ 没有名字可取），
                // 第二句必须说清「为什么是 id」+「用户该做什么」，否则等于没说。
                composeDeeplinkUnsat: "{count} 个收件人不在本会话，已忽略：{ids}",
                composeDeeplinkUnsatWhy: "按 id 展示是因为名册里查不到这些人，请手动确认收件人",
                // task-49（task-48 落库后）：独立会话**已能**发给成员/抄送/代发，「发送」「抄送」两栏照常渲染；
                // 这行只剩附件这一件事要解释 —— 它是**可见原因**（不是 tooltip），不是「为什么少两个控件」。
                workspaceLessNoTargets: "独立会话不支持附件（仅纯对话）",
                workspaceLessDropped: "独立会话不支持附件，本条已去掉附件后发送",
                speakAsOverriddenByTo: "已指定发送对象（优先），本条不代发",
                ccLabel: "抄送",
                ccAdd: "添加…",
                ccRemove: "移除抄送",
                // 2026-11-04 用户裁定：收件/抄送改为「输入 + 候选浮层」，术语定为「发送 / 抄送」。
                recipientPlaceholder: "输入名字…",
                recipientUnknown: "没有找到这个成员",
                recipientRemove: "移除",
                recipientHint: "↑↓ 选择 · Enter 确认 · Tab 补全 · Esc 关闭",
                recipientEmpty: "没有匹配的成员",
                ccCollapse: "收起抄送",
                mentionAll: "所有人",
                mentionAgent: "智能体",
                mentionHuman: "人类成员",
                mentionFile: "文件",
                mentionDirectory: "目录",
                // M2 会在此下面加 filesTitle 等；本轮先把 /clear 的真实范围写进文案。
                commandClear: "清空输入草稿（含待发附件，不发送）",
                commandHelp: "显示可用命令",
                helpTitle: "可用命令",
                helpHint: "↑↓ 选择，Enter 插入，Esc 关闭",
            },
            // PLAN-0635 M3: 服务端命令注册表的文案（可用性原因 + 服务端独有命令的说明）。
            commands: {
                description: {
                    export: "导出当前会话为 Markdown 文件",
                    compact: "压缩上下文，保留摘要",
                    unknown: "服务端注册的命令（当前界面尚未实现）",
                },
                reason: {
                    approvalRequired: "需要审批后才能使用",
                    denied: "策略已拒绝该命令",
                    policyUnavailable: "策略暂不可用，无法确认权限",
                    branchLocked: "当前有运行中的对话，请稍后再试",
                    unknown: "该命令当前不可用",
                },
                branchUnavailable: "当前会话还没有可用分支，命令未执行",
                compacted: "上下文已压缩",
                failed: "命令执行失败，请稍后再试",
                unknown: "该命令尚未在当前界面实现",
            },
            branchSelectorLabel: "对话分支",
            branchMainPath: "主路径",
            branchPathOption: "分支",
            branchFromMessage: "从此消息创建分支",
            branchCreated: "分支已创建并切换",
            branchCreateFailed: "创建分支失败",
            branchLoadFailed: "无法加载对话分支，暂时无法发送消息",
            // PLAN-0663 M2/T2.1：审批过期是终态——弹窗关闭，用非模态提示告知（不再要求用户点）。
            approvalExpiredNotice: "这条审批已过期，已自动关闭；如需继续请重新发起。",
            providerAutoBound: "已自动绑定",
            providerBindingGuideTitle: "会话尚未绑定模型",
            providerBindingGuideProviderRequired:
                "这个会话还没有绑定 provider 连接，CP 会拒绝发送。可以尝试按智能体默认模型 / 生效配置自动绑定，或前往设置手动选择。",
            providerBindingGuideProfileConflict:
                "生效的 LLM Provider 配置没有可用连接，无法自动绑定。请前往设置检查 Provider 与连接状态。",
            providerBindingGuideRetry: "自动绑定",
            providerBindingGuideSettings: "去设置",
            thinking: "思考中...",
            error: "发送失败",
            stop: "停止生成",
            // task-135：composer 第 3 层元信息行（轮/步/tok-s、token 用量、缓存命中）。
            composerMeta: {
                // task-941（R68）：chip 是「谁来作答」的那一个模型，不是收件人维度。
                model: "主智能体模型",
                // task-941（R68）：TO/CC 与模型正交 —— 收件人决定谁读，不改变谁作答。
                modelPrimaryHint: "本会话由该模型作答；TO/CC 决定谁来读，不改变模型。",
                modelUnbound: "未绑定模型",
                // task-133（DSD-1507 ④）：未绑定 chip 是警示态且可点，这两句进 title / aria-label。
                modelUnboundHint: "发送前需绑定 provider 连接（点此打开模型设置）",
                modelChangeHint: "点此打开模型设置",
                rounds: "轮 {value}",
                steps: "步 {value}",
                speed: "{value} tok/s",
                tokens: "{used} / {limit}",
                cacheHit: "缓存命中 {percent}",
                // task-140（J1~J3）：模型 chip 现在报「来源」而不只是模型名 ——
                // 会话覆盖 / 主体默认 / 全局配置三档与 CP ChatModelResolutionService 同序，
                // 全无时用 modelSourceNone；清单里没发现只加中性角标（不拦发送）。
                modelSourceSession: "会话覆盖",
                modelSourcePrincipal: "主体默认",
                modelSourceProfile: "全局配置",
                modelSourceNone: "无可用来源",
                modelSourceHint: "来源：{source} · {model}",
                modelSourceResolving: "正在判定模型来源…",
                modelSourceUnknown: "来源未知",
                modelSourceUnknownHint:
                    "名册或主体默认读取失败，UI 无法判定来源；这只表示「读不到」，不代表没有来源。",
                modelOutOfCatalogBadge: "本地清单未发现",
                modelOutOfCatalogHint:
                    "本地模型清单里没有它；发送口径仍以来源为准，清单只用于候选项与角标。",
            },
            followUpQueueTitle: "接下来",
            followUpCount: "{count} / {capacity} 项未结束",
            followUpEnqueue: "排队发送",
            followUpEnqueuing: "加入中…",
            followUpPlaceholder: "添加到当前会话的后续队列…",
            followUpComposerNotice: "这条内容将在当前回合之后执行。",
            followUpPausedNotice: "新内容仍追加到队尾，不会绕过暂停中的任务。",
            followUpFullNotice: "队列已满；撤回一项或等待已排任务完成。草稿会保留。",
            followUpQueueLoadFailed: "读取后续队列失败",
            followUpQueueFailed: "后续队列操作失败",
            followUpQueued: "已加入后续队列",
            followUpAlreadyQueued: "此条此前已提交，未新建",
            sseNotConnected: "消息未发送：实时连接未建立",
            sseNotConnectedHint: "请再点一次发送，客户端会自动重连。",
            followUpWithdrawn: "已从后续队列撤回",
            followUpContinued: "后续队列已继续",
            followUpContinue: "继续剩余队列",
            followUpContinuing: "继续中…",
            followUpWithdraw: "撤回",
            followUpWithdrawing: "撤回中…",
            followUpWithdrawItem: "撤回第 {sequence} 项",
            followUpCapacityNote: "硬上限 {capacity} 项",
            followUpExecutionNote:
                "已绑定 Session 使用当前配置；未绑定 Session 使用提交时模型，Branch 与附件按入队时固定",
            followUpStatusQueued: "排队中",
            followUpStatusWaiting: "等待前一项",
            followUpStatusRunning: "正在运行",
            followUpStatusPaused: "暂停中",
            followUpStatusCompleted: "已完成",
            followUpStatusCancelled: "已取消",
            followUpStatusFailed: "执行失败",
            followUpStatusAmbiguous: "结果不确定",
            followUpStatusWithdrawn: "已撤回",
            followUpPausedCancelled: "队列暂停 · 前序回合已取消。继续会按原顺序运行剩余项。",
            followUpPausedAmbiguous: "队列暂停 · 前序回合结果不确定。确认后可继续剩余队列。",
            followUpPausedAttachment: "队列暂停 · 某个附件已不可用。修复后可继续剩余队列。",
            followUpPausedBranch: "队列暂停 · 目标 Branch 已不可用。切回有效 Branch 后可继续。",
            followUpPausedStale: "队列暂停 · Session 绑定或子回合状态已变化，请检查后再继续。",
            followUpPausedGeneric: "队列暂停 · 检查前序回合后可继续整个 FIFO 队列。",
            followUpContentUnavailable: "内容已由对话记录承载",
            guidancePanelTitle: "指导当前运行",
            guidancePanelHint: "作为来源明确的用户意图注入下一轮规划",
            guidancePlaceholder: "向当前回合注入指导…",
            guidanceSubmit: "提交指导",
            guidanceSubmitting: "提交中...",
            guidanceEmpty: "尚未提交任何指导",
            guidanceSequencePrefix: "#{sequence}",
            guidanceSourceUser: "用户",
            guidanceStatusPending: "待处理",
            guidanceStatusConsumed: "已纳入下一轮",
            guidanceStatusExpired: "已失效",
            guidanceConsumedAt: "消费于 {time}",
            guidanceExpiredAt: "失效于 {time}",
            guidanceAuthorSuffix: "by {id}",
            guidanceErrorNotActive: "回合已结束或不再接受指导",
            guidanceErrorForbidden: "无权限指导该回合",
            guidanceErrorNotFound: "回合不存在或已被清理",
            guidanceErrorNetwork: "网络异常，请稍后重试",
            guidanceErrorTooLong: "内容过长或为空",
            guidanceErrorBadRequest: "提交失败，请重试",
            guidanceErrorServer: "服务异常，请稍后重试",
            upload: "上传文件",
            image: "图片",
            voice: "语音输入",
            screenshot: "截图",
            attachFile: "附件",
            copy: "复制",
            copied: "已复制",
            apply: "应用",
            run: "运行",
            toolResult: "工具结果",
            derivedStateTitle: "子任务状态",
            derivedStateActive: "进行中的子任务",
            derivedStateTerminal: "已结束的子任务",
            derivedStateUnnamedChild: "子会话",
            derivedStateRefreshError: "子任务状态暂不可用",
            derivedStateLoading: "正在刷新子任务状态…",
            // task-1 / D-1846：派生态 anchor（子会话状态卡）。状态文案复用 derivedState* 词汇，
            // 这里只补卡片自身的两处文案（进入动作 + 超限告知）。
            anchor: {
                open: "进入子会话：{name}",
                truncated: "子会话过多，仅显示最近 {count} 条",
            },
            waitingOnChild: "等待子任务",
            derivedStateStatus: {
                accepted: "已接收",
                queued: "排队中",
                running: "运行中",
                streaming: "输出中",
                awaiting_approval: "等待审批",
                dispatching: "派发中",
                cancelling: "取消中",
            },
            derivedStateOutcome: {
                success: "成功",
                error: "失败",
                partial: "部分完成",
                ambiguous: "结果不确定",
                cancelled: "已取消",
            },
            toolStatus: {
                pending: "等待执行",
                running: "执行中...",
                completed: "已完成",
                failed: "执行失败",
                cancelled: "已取消",
                /** PLAN-0649：被策略/预算拒绝（不是执行报错），折叠态状态行专用。 */
                refused: "被拒绝",
                /**
                 * task-54 / D-1708：权限不足 ≠ 等待审批。两者在用户眼里都是「没做成」，
                 * 但只有前者要用户去改角色——状态行必须能分开，否则用户不知道下一步做什么。
                 * 「等待审批」不进这里：审批是弹窗 + pending 列表，不是折叠行的终态。
                 */
                noGrant: "权限不足",
            },
            /*
             * PLAN-0631 D31-04/07：Run 状态的**可见语言**。文案刻意沿用 `toolStatus`/`followUpStatus`
             * 已建立的既有词汇（排队中/执行中/运行中），不新造近义词；状态→文案的唯一映射在
             * `chat/runStateView.ts`（D31-01），这里只补 chat 栏位原本缺的两格。
             */
            runState: {
                queued: "排队中",
                queuedHint: "已受理，等待执行",
                reasonAgentDown: "Agent 暂不可用；恢复后会自动执行，也可以停止这一次",
                awaitingApproval: "等待审批",
            },
            toolDiagnosticsTitle: "诊断",
            toolDiagnosticsSummary: "共 {total} 条，已回灌前 {shown} 条",
            toolDiagnosticsMore: "另有 {count} 条",
            toolRawOutput: "原文",
            runRecoveryDismiss: "知道了",
            emptyGreeting: "你好，我是 xihe Agent。有什么我可以帮你的？",
            /* PLAN-0688：专属工具卡（command / patch / read）的可见文案。 */
            toolCard: {
                exitCode: "退出码",
                stdout: "标准输出",
                stderr: "标准错误",
                noOutput: "暂无输出",
                truncated: "输出已截断",
                artifactRetained: "原文已保留为产物",
                changedFiles: "{count} 个文件",
                patchesPending: "{count} 个待应用补丁",
                diffPreview: "Diff 预览",
                diffNote: "Diff 只按行前缀分类；完整内容见原文",
                totalLines: "总行数",
                binaryPreview: "二进制内容（base64）",
                previewOnly: "仅预览前 200 行 / 2000 字符",
                previewLines: "预览 {count} 行",
                success: "成功",
                failure: "失败",
            },
            /*
             * PLAN-0649：拒绝态展示。原因码 → 文案的唯一映射在
             * `lib/errorMessages.ts#toolRefusalCopyKey`（未映射码回落到通用文案 + 原码，B5 裁定）；
             * 文案里不出现配额数字（B4 裁定）。
             */
            toolRefusedTitle: "该调用被拒绝，未执行",
            toolRefusedGeneric: "该工具调用被拒绝，未产生执行",
            toolRefusedCodeLabel: "原因码：",
            toolRefusedHint: "可以调整任务范围或稍后重试；原样重试同一请求通常仍会被拒",
            toolRefusalDelegationLimit: "委托预算已用尽：这次没有再派子任务",
            toolRefusalDelegationPolicy: "委托策略当前不可用，本次没有派子任务",
            toolRefusalSpawnFailed: "派发子任务时出错，本次没有产生子任务",
            toolRefusalAcquireFailed: "获取凭据时出错，本次没有取到凭据",
            // task-54：给「被拒绝」一个能照着做的出口。两段分开——先讲本会话为何被拒，
            // 再讲去哪改以及改完为什么这次仍不生效（快照在会话创建时冻结）。
            toolRefusalGrantDenied:
                "本次运行没有被授予该工具所需的能力（读取/执行等），因此 CP 拒绝了这次调用",
            toolRefusalGrantDeniedHint:
                "到「工作区 → 智能体 → 编辑工作区角色」为这个智能体勾上对应能力后，新建一个会话再试；当前会话的权限在创建时已冻结，改角色不会追溯生效",
            jobOutputTitle: "后台任务输出",
            jobOutputLoad: "查看输出",
            jobOutputReload: "重新加载",
            jobOutputMore: "加载更多",
            jobOutputEmpty: "（暂无输出）",
            jobOutputTruncated: "输出已达 1MB 上限，仅保留开头部分",
            jobOutputLost: "任务输出已不可用（容器已销毁）",
            jobOutputExpired: "任务输出已过期（TTL 清理）",
            jobOutputUnavailable: "Runtime 暂不可达，请稍后重试",
            jobOutputLoadFailed: "加载任务输出失败",
            jobCancelButton: "取消这个 job",
            jobCancelHint: "取消仅终止该 job，不影响本轮对话",
            jobCancelConfirmHint: "确认取消？该 job（{jobId}）的输出将保留，run 继续。",
            jobCancelConfirm: "确认取消",
            jobCancelBack: "返回",
            jobCancelPending: "取消中…",
            jobCancelDone: "已取消：该 job 已终止；本轮对话继续。",
            jobCancelOrphaned: "该 job 已失联，档案已按丢失收口。",
            jobCancelFailed: "取消任务失败",
            jobCancelUnconfirmed: "取消未确认：进程可能仍在运行，可稍后重试",
            jobCancelUnavailable: "Runtime 暂不可达，请稍后重试",
            jobStatus: {
                running: "运行中",
                succeeded: "成功",
                cancelled: "已取消",
                timeout: "超时",
                orphaned: "孤儿",
            },
            backToChat: "← 返回会话",
            favorites: "收藏",
            approvalRequired: "需要您的确认",
            approve: "确认",
            reject: "拒绝",
            approvalDescription: "智能体请求执行以下操作，请确认后继续：",
            // PLAN-0665 M2 D5：多路审批串行，首卡显示「1/N 待批」。
            approvalQueueProgress: "第 {position}/{total} 张待批",
            approvalAction: "动作",
            approvalDetails: "参数预览",
            approvalEvidence: "策略依据",
            approvalGuardAdvice: "守卫建议",
            approvalGuardVerdictApprove: "建议通过",
            approvalGuardVerdictDeny: "建议拒绝",
            approvalEvidenceActionClass: "动作类别",
            approvalEvidenceShape: "工具形态",
            approvalEvidenceMatchedRule: "命中规则",
            approvalEvidenceSourceLayer: "生效层",
            approvalEvidenceReason: "原因",
            approvalEvidenceMode: "模式",
            approvalEvidenceModeAtGrant: "决定时模式",
            approvalEvidenceUnavailable:
                "策略依据暂不可用。没有收到服务端策略证据，不能推断默认值。",
            approvalOriginCpGate: "策略门禁",
            approvalOriginAgentRelay: "模型请求",
            approvalNoMatchedRule: "未命中具体规则",
            approvalLayerBuiltin: "内置层",
            approvalLayerInstance: "实例层",
            approvalLayerUser: "个人层",
            approvalLayerWorkspace: "工作区层",
            approvalLayerSession: "会话层",
            approvalLayerPerCall: "单次调用层",
            approvalModeManual: "手动审批",
            approvalModeAuto: "自动放行",
            approvalModeUnavailable: "未提供",
            approvalShapeStructured: "结构化",
            approvalShapeInterpreter: "解释器型",
            approvalShapeOpaque: "不透明",
            approvalShapeInterpreterWarning: "解释器形态：效果无法完整枚举，批准范围仅绑定参数。",
            approvalShapeOpaqueWarning: "不透明形态：工具语义未知，不能复用批准。",
            approvalTierGateDelete: "删除类动作仅支持「允许一次」，不能复用或保存规则。",
            approvalTierGateOpaque: "不透明形态仅支持「允许一次」，不能复用或保存规则。",
            approvalTierGateInterpreter:
                "解释器形态仅支持「允许一次」或「本会话允许」，不能保存持久规则。",
            approvalTierGateShapeUnavailable:
                "工具形态依据不可用，仅支持「允许一次」，不能推断会话复用或保存规则。",
            approvalAllowOnce: "允许一次",
            approvalAllowSession: "本会话允许",
            approvalSaveRule: "保存为规则",
            approvalRejectFeedbackLabel: "拒绝反馈",
            approvalRejectFeedbackOptional: "可选，反馈会传给智能体。",
            approvalRejectFeedbackTooLong: "反馈不能超过 512 个字符。",
            approvalRejectFeedbackPlaceholder: "说明拒绝原因（可选）",
            approvalSaveRuleTitle: "确认保存规则",
            approvalSaveRuleDescription: "选择规则作用域并确认资源范围。",
            approvalRuleLayer: "保存到层",
            approvalRuleResource: "资源范围",
            approvalRuleResourceUnset: "未设置",
            approvalRuleResourceRequired: "请输入非空资源范围。",
            approvalRuleResourceTooLong: "资源范围不能超过 512 个字符。",
            approvalRuleWildcardConfirmation: "确认将此规则应用于全部资源（*）。",
            approvalRuleWildcardConfirmationRequired: "请明确确认此规则适用于全部资源。",
            approvalRulePreview: "规则预览",
            approvalRuleEffect: "效果",
            approvalRuleAllow: "允许",
            approvalRuleActionClassDerived: "由服务端根据工具推导",
            approvalPersistentWarning: "这是持久规则，不只对本会话生效。请确认作用域与资源范围。",
            approvalPreflightUnavailable: "预检不可用，保存时由服务端校验。",
            approvalSaveBack: "返回",
            approvalSaveConfirm: "确认保存",
            approvalModeLabel: "审批模式",
            approvalAutoWarning:
                "自动放行已开启：符合 ask 的后续调用会自动放行，但硬保护与拒绝规则仍然生效。",
            approvalAutoClose: "关闭自动放行",
            contextTemplateLabel: "请求模板",
            contextTemplateUnavailable: "上下文模板不可用",
            approvalModeChanged: "已切换审批模式",
            contextSourcesTitle: "上下文源",
            contextSourcesToggle: "切换上下文源摘要",
            contextSourcesLoading: "加载中…",
            contextSourcesError: "源摘要不可用",
            contextSourcesFailed: "读取失败",
            contextSourcesUpdated: "规则已更新（本轮起生效）",
            contextOverflowRetry: "上下文超限，已压缩并重试一次",
            budgetExhaustedTurns: "本次运行已达到轮数上限",
            budgetExhaustedElapsed: "本次运行已达到累计耗时上限",
            budgetExhaustedTokens: "本次运行已达到 Token 上限",
            budgetExhaustedHint: "可在下方输入框继续发送，接续本次会话",
            noProgressReason: "检测到重复或无进展动作，运行已停止",
            streamErrorGeneric: "本次运行未能完成，请重试；若持续失败请查看监控日志",
            principalMissing: "此会话尚未绑定可用的智能体（Agent principal）",
            principalMissingHint:
                "请在工作区设置 → 智能体管理绑定一个智能体，或联系工作区管理员开通绑定权限后重试",
            // PLAN-0750 V10 (A1-lite): toast 通道专用（与上面的卡片通道分开），经
            // `errorCopyKey()` 走 key ⇒ 跟随 locale。动作导向：给出可操作路径。
            principalMissingToast:
                "此会话尚未绑定可用的智能体：请在工作区设置 → 智能体管理绑定一个智能体后再发送",
            principalDisabledToast:
                "此会话绑定的智能体已停用：请在工作区设置 → 智能体管理解绑后重新绑定一个可用的智能体",
            // task-102：CP 对「TO 指向自己的行」返回 400 `PARTICIPANT_SELF_TARGET`（`ChatController:743`）。
            // 候选里已经剔掉自己的真人行，这句是**兜底**（直接调 API 的客户端、或名册口径变化后的旧页面）。
            participantSelfTargetToast:
                "不能把通知发给自己：你自己的真人身份已从收件人候选里移除，请改选其他参与者",
            // task-102 邻格：`as` = 自己的真人行且 TO 缺席 ⇒ CP 400 `AS_SELF_WITHOUT_TARGET`
            // （`ChatController:689-705`，task-110）。`as` 候选按 Lead 裁定不动 ⇒ 这条**可达**，必须给文案。
            asSelfWithoutTargetToast:
                "「发送」和「抄送」都空着时，代发身份不能选自己：这条消息没有任何人能作答。请选一个发送对象，或换成别的代发身份",
            resourceExhausted: "{kind}并发已满，约 {seconds} 秒后重试",
            resourceExhaustedNoWait: "{kind}并发已满，请稍后重试",
            resourceExhaustedHint: "也可以在上方模型/连接选择器里换一个连接后再试。",
            resourceKindConnection: "连接",
            resourceKindModel: "模型",
            resourceKindFileWrite: "文件写入",
            resourceKindProcess: "进程",
            resourceKindJob: "任务",
            resourceKindMcp: "MCP 调用",
            resourceKindUnknown: "资源",
            contextCompactionCircuitOpen: "自动压缩已暂停（上下文未见改善）",
            contextCompactionCircuitClosed: "自动压缩已恢复",
            approvalUnclassifiedNotice:
                "未分类工具：默认按 ask 处理，且不能保存会话级或持久规则。仅工作区 OWNER / ADMIN 可分类。",
            approvalClassifyAndAllow: "分类并放行",
            approvalClassifyTitle: "分类工具并放行本次调用",
            approvalClassifyDescription:
                "分类会持久化到当前工作区并影响后续策略判定；本次放行仍然只生效一次。",
            approvalClassifyActionClass: "动作类别",
            approvalClassifyActionClassPlaceholder: "例如 read、write、exec",
            approvalClassifyActionClassRequired: "请输入动作类别。",
            approvalClassifyShape: "工具形态",
            approvalClassifyAuthorityHint:
                "分类权：工作区 OWNER / ADMIN；服务端会校验权限，无权限时分类不会生效。",
            approvalClassifyBack: "返回",
            approvalClassifySubmit: "确认分类并放行一次",
            approvalClassifyFailed: "分类失败，未放行本次调用",
            approvalClassifyRequiresOnce: "未分类工具只能选择「允许一次」。",
            pendingApprovalReopenLabel: "待审批",
            pendingApprovalReopenAction: "查看",
            dispatchQueue: {
                // task-161 / D-1785：排队位置是事实（position = 前面还有几个），不是推导线。
                ahead: "排队等待执行，前面还有 {count} 个",
                jump: "查看",
            },
            checkpointMarkerChangedPrefix: "相邻切片差异",
            checkpointMarkerChangedUnit: "个文件",
            checkpointMarkerRollbackable: "可恢复",
            checkpointMarkerRevertEntry: "恢复…",
            checkpointMarkerNoSnapshot: "本轮未产生切片",
            checkpointMarkerUnrollable: "本轮无法捕获切片",
            checkpointMarkerReverted: "已恢复到该切片",
            checkpointCountRestored: "已恢复",
            checkpointCountDeleted: "已删除",
            checkpointCountFailed: "失败",
            checkpointReasonUnavailable: "切片能力不可用",
            checkpointReasonGitUnavailable: "未检测到可用的 git",
            checkpointReasonGitTooOld: "git 版本过低",
            checkpointReasonGitFailed: "git 操作失败",
            checkpointReasonWorkspaceUnknown: "工作区不可用",
            checkpointReasonNestedRepoLimit: "嵌套仓库超出限制",
            checkpointReasonInvalidRequest: "切片请求无效",
            checkpointReasonExpired: "切片已过期",
            checkpointPreviewTitle: "恢复到该切片",
            checkpointPreviewDescription:
                "恢复到该时刻，将丢弃此时刻之后的全部改动。默认操作为取消。",
            checkpointPreviewConcurrentWriteRisk:
                "恢复期间允许并发写入；预览与结果会标注可能受影响的路径。",
            checkpointPreviewLoading: "正在生成恢复预览…",
            checkpointPreviewFailed: "恢复预览加载失败",
            checkpointPreviewRetry: "重试",
            checkpointPreviewRestore: "将恢复",
            checkpointPreviewDelete: "将删除",
            checkpointPreviewTypeConflict: "类型变化",
            checkpointPreviewTypeConflictIncomplete:
                "预览未返回全部类型变化路径，无法完成确认；请重试预览。",
            checkpointPreviewPathsTitle: "路径清单",
            checkpointPreviewExpand: "展开全部",
            checkpointPreviewCollapse: "收起",
            checkpointPreviewTruncated: "清单过长，仅展示已返回的条目。",
            checkpointPreviewNoEntries: "没有需要恢复的路径。",
            checkpointPreviewOpaqueNestedRepos: "不参与恢复的目录",
            checkpointPreviewConfirm: "执行恢复",
            checkpointEntryRestore: "恢复",
            checkpointEntryDelete: "删除",
            checkpointEntryNoop: "无需动作",
            checkpointEntryTypeConflict: "类型变化冲突",
            checkpointTypeConflictAck: "我确认按目标切片处理这些路径（会替换当前路径类型）",
            checkpointNestedRepoImpactTitle: "本次恢复会触及以下未声明嵌套仓库",
            checkpointNestedRepoDirty: "有未提交改动",
            checkpointNestedRepoHeadMoved: "HEAD 已漂移",
            checkpointNestedRepoForceAck: "我确认强制覆盖这些仓库中未提交的改动",
            checkpointNestedRepoDriftAck: "我确认这些仓库恢复后会与当前 HEAD 不同",
            checkpointResultTitle: "恢复结果",
            checkpointResultDescription: "逐项结果与疑点；可查看差异后重试失败项。",
            checkpointResultRestored: "已恢复",
            checkpointResultDeleted: "已删除",
            checkpointResultFailed: "失败",
            checkpointResultSuspect: "并发写疑点",
            checkpointResultPartial: "本次为部分恢复：失败项可重试。",
            checkpointResultViewDiff: "查看差异",
            checkpointResultDiffLoading: "正在加载差异…",
            checkpointResultDiffFailed: "差异加载失败",
            checkpointResultDiffSlice: "切片内容",
            checkpointResultDiffTruncated: "内容过长，差异仅显示前 400 行。",
            checkpointResultSliceRef: "切片引用",
            checkpointResultDuration: "耗时",
            checkpointResultRetry: "重试未完成项",
            checkpointResultDismiss: "放弃",
            checkpointRevertDone: "恢复完成",
            checkpointRevertPartial: "恢复完成，但有未完成项",
            checkpointRevertFailed: "恢复执行失败",
            approvalAutoOffFailed: "关闭自动放行失败，自动放行仍然开启，请重试",
        },
    },
    "en-US": {
        chat: {
            titleChat: "Chat",
            searchMessages: "Search messages",
            searchPlaceholder: "Search messages…",
            approvalDispatchUnknown:
                "Recovery retry required: the previous approval dispatch did not report a result. Choose a decision to retry it; no decision is sent automatically.",
            mobileSheetDescription:
                "Chat with the Agent in the current workspace. Tools are bound to this workspace.",
            loadOlder: "Load earlier messages",
            loadingOlder: "Loading earlier messages…",
            loadOlderFailed: "Failed to load earlier messages",
            foldedOlder: "{count} earlier messages are folded; click to load",
            expandedLimitReached: "Expanded to the limit (1500 messages)",
            loadMessagesFailed: "Failed to load messages; please retry",
            contextTruncationNotice:
                "This answer used a truncated history ({dropped} dropped / {kept} kept)",
            contextTruncationDismiss: "Dismiss truncation notice",
            // PLAN-0572 / BL-555 G3: notice for a persisted toolCalls snapshot cut by CP MAX_CALLS.
            toolCallsTruncationTitle: "Tool calls truncated",
            toolCallsTruncationNotice:
                "Showing the first {visible} tool calls ({total} in total; earlier ones are not persisted)",
            toolCallsTruncationDetail:
                "Earlier calls were not persisted on the message and cannot be restored in the UI; see this run's trace for the full list.",
            toolCallsTruncationTraceHint: "Full call trace (run):",
            send: "Send",
            // task-792: empty-session suggestion copy (both toolMode sets go through i18n; no CJK in en).
            suggest: {
                listFiles: "List files",
                openReadme: "Open README",
                explainSelection: "Explain selected file",
                workspaceEnv: "View workspace environment",
                weather: "What's the weather today?",
                writeEmail: "Draft an email for me",
                explainConcept: "Explain this concept",
                summarizeCode: "Summarize this code",
            },
            runHeader: {
                toggle: "Expand or collapse run {run}",
            },
            // PLAN-0659 T1.3: delivery semantics (to / cc / mentioned). TO/CC are durable in
            // `messages.delivery` jsonb (V120 / PLAN-0665 D3, BL-239 closed), so they survive a
            // reload; @ is still rebuilt from the message body + roster (never persisted).
            delivery: {
                to: "To → {name}",
                cc: "Cc → {names}",
                // task-66①: raw @tokens the roster could not resolve (untrusted text; plain-text
                // render, never id-matched).
                unresolved: "Unrecognized: {names}",
                unresolvedHint: "This name is not in the roster; nothing was sent to it.",
                mentioned: "Mentioned: {name}",
                listSeparator: ", ",
            },
            reasoning: "Reasoning",
            delegation: {
                button: "Delegate",
                badge: "Delegated",
                delegatedTo: "Delegated to",
                buttonHint: "Delegate a child session for a standalone task",
                reasonNoCapability:
                    "Missing the capability to delegate in this workspace (SPAWN_AGENT)",
                reasonUnknown:
                    "Delegation capability cannot be confirmed right now, try again later",
                title: "Create delegation (new child session)",
                description:
                    "A delegation opens a fresh child session for the chosen principal; the budget follows that principal's delegation policy.",
                principalLabel: "Delegate to",
                principalPlaceholder: "Select an agent principal",
                taskLabel: "Task",
                taskPlaceholder:
                    "Describe what the child session should do (up to 4000 characters)",
                budgetLabel: "Budget",
                budgetUsage: "Budget",
                budgetDepth: "Depth",
                budgetHint: "Governed by that principal's delegationPolicy",
                budgetDisabled: "That principal's delegation policy disables delegation",
                cancel: "Cancel",
                submit: "Create delegation",
                created: "Delegation created, child session is ready",
                approvalPending:
                    "Approval requested; it will be created automatically once granted",
                approvalPendingHint:
                    "An approval was opened in this session; granting it replays the same idempotency key — no need to refill",
                approvalRejected: "The delegation approval was rejected or expired",
                submitFailed: "Could not create the delegation, try again later",
                // PLAN-0659 T1.4: delegation DAG (right dock). Node statuses reuse the existing
                // derivedStateStatus/Outcome vocabulary; only panel copy is added here.
                dagTitle: "Delegation DAG",
                dagEmpty: "This session has no delegated child sessions yet",
                dagRefresh: "Refresh the delegation graph",
                dagError: "The delegation graph could not be loaded (structure is still shown)",
                dagTruncated: "Too many nodes — showing the first {count}",
                // task-1 / D-1846: a node is now clickable and opens that child session.
                dagOpenNode: "Open the child session: {name}",
                dagBudget: "Budget {used}/{max} · depth {depth}/{maxDepth}",
            },
            placeholder: "Message · Enter to send · Shift+Enter for newline",
            // PLAN-0635 M1: input-surface copy for `/` commands and `@` mentions (one shared menu).
            input: {
                commandsTitle: "Commands",
                mentionsTitle: "Session members",
                filesTitle: "Files and folders",
                // PLAN-0630 M5b (D30-14): composer to/cc bars (email metaphor: to = primary responder, cc = observers).
                // task-50: two-word regime — "Send" (@ = important notification) / "Cc" (ordinary notification).
                // This key is the speak-as identity (single-select asParticipantId), not a recipient list.
                toLabel: "Send as",
                // task-114: this bar had no out-of-field note (Send / Cc both had one). The copy must
                // answer "whose account this message goes out from" — not define the term.
                toLabelHint:
                    "This message goes out from the selected identity's account — recipients see it, not you",
                toTargetsLabel: "Send",
                // task-102: BOTH hints answer the same question (do-not-disturb). Only ccHint used to,
                // which read as "only CC bypasses DND" — both bypass it (see zh block for CP line refs).
                toHint: "Equivalent to {'@'} — delivered as an important notification, not muted by do-not-disturb (multi-select)",
                ccHint: "Ordinary CC notification (not muted by do-not-disturb)",
                // task-38 C3: when there is nobody to cc the entry must NOT vanish silently.
                ccEmptyHint:
                    "No one to cc yet: add a member to this session and CC becomes available",
                // task-17 (source: task-6 candidate C-1): make an explicit empty TO visible.
                toEmptyHint:
                    "This message notifies no participant (it is still recorded in this session)",
                toEmptyHintDismiss: "Got it",
                // task-126 F3: deep-link "unsatisfiable" hint. Ids only — these people are not in the
                // session roster, so there is no display name to show; the second line says why and what
                // the user should do next.
                composeDeeplinkUnsat:
                    "{count} recipient(s) are not in this session and were ignored: {ids}",
                composeDeeplinkUnsatWhy:
                    "Ids are shown because these people cannot be found in the roster; please confirm the recipients manually",
                workspaceLessNoTargets:
                    "A standalone Session does not support attachments (plain chat only)",
                workspaceLessDropped:
                    "Standalone Sessions do not support attachments; this message was sent without them",
                speakAsOverriddenByTo:
                    "Send targets are set (they take precedence); this message is not sent as anyone",
                ccLabel: "Cc",
                ccAdd: "Add…",
                ccRemove: "Remove cc",
                recipientPlaceholder: "Type a name…",
                recipientUnknown: "No such member",
                recipientRemove: "Remove",
                recipientHint: "↑↓ to choose · Enter to confirm · Tab to complete · Esc to close",
                recipientEmpty: "No matching member",
                ccCollapse: "Collapse cc",
                mentionAll: "Everyone",
                mentionAgent: "Agent",
                mentionHuman: "Human",
                mentionFile: "File",
                mentionDirectory: "Folder",
                // M2 adds filesTitle etc. below; this round only makes /clear's real scope explicit.
                commandClear: "Clear the draft and pending attachments (does not send)",
                commandHelp: "Show available commands",
                helpTitle: "Available commands",
                helpHint: "↑↓ to select, Enter to insert, Esc to close",
            },
            // PLAN-0635 M3: server command registry copy (availability reasons + server-only hints).
            commands: {
                description: {
                    export: "Export this session as a Markdown file",
                    compact: "Compact the context and keep a summary",
                    unknown: "Command registered by the server (not implemented in this UI yet)",
                },
                reason: {
                    approvalRequired: "Approval is required before this command can run",
                    denied: "Policy denied this command",
                    policyUnavailable: "Policy is unavailable, so permission cannot be confirmed",
                    branchLocked: "A chat run is active; try again when it finishes",
                    unknown: "This command is currently unavailable",
                },
                branchUnavailable: "This session has no usable branch yet; the command was not run",
                compacted: "Context compacted",
                failed: "Command failed; please try again",
                unknown: "This command is not implemented in the current UI yet",
            },
            branchSelectorLabel: "Chat branch",
            branchMainPath: "Main path",
            branchPathOption: "Branch",
            branchFromMessage: "Create branch from this message",
            branchCreated: "Branch created and selected",
            branchCreateFailed: "Failed to create branch",
            branchLoadFailed: "Branches could not be loaded; chat is temporarily unavailable",
            // PLAN-0663 M2/T2.1: an expired approval is terminal — the modal closes and a
            // non-modal notice explains it instead of asking for a decision that cannot be taken.
            approvalExpiredNotice:
                "This approval request expired and was closed automatically; start it again if you still need it.",
            providerAutoBound: "Auto-bound",
            providerBindingGuideTitle: "This session has no model binding",
            providerBindingGuideProviderRequired:
                "This session has no provider connection, so the server refuses to send. Try auto-binding from the agent default model / effective profile, or pick one in Settings.",
            providerBindingGuideProfileConflict:
                "The effective LLM Provider profile has no usable connection, so auto-binding is impossible. Check the provider and its connections in Settings.",
            providerBindingGuideRetry: "Auto-bind",
            providerBindingGuideSettings: "Open Settings",
            thinking: "Thinking...",
            error: "Failed to send",
            stop: "Stop generating",
            // task-135: composer layer 3 meta row (rounds/steps/tok-s, token usage, cache hit).
            composerMeta: {
                // task-941 (R68): this chip names the model that answers — not the recipients.
                model: "Primary agent model",
                // task-941 (R68): TO/CC are orthogonal — recipients decide who reads, not who answers.
                modelPrimaryHint:
                    "This session is answered by this model; TO/CC decide who reads it, not which model answers.",
                modelUnbound: "No model bound",
                // task-133 (DSD-1507 ④): the unbound chip is a warning state and is clickable.
                modelUnboundHint:
                    "Bind a provider connection before sending (click to open model settings)",
                modelChangeHint: "Click to open model settings",
                rounds: "rounds {value}",
                steps: "steps {value}",
                speed: "{value} tok/s",
                tokens: "{used} / {limit}",
                cacheHit: "cache hit {percent}",
                // task-140 (J1~J3): the chip now names the SOURCE, not just the model —
                // session override / agent default / global profile in the same order as
                // CP ChatModelResolutionService; all-empty falls back to modelSourceNone.
                // A model missing from the local catalog only earns a neutral badge.
                modelSourceSession: "session override",
                modelSourcePrincipal: "agent default",
                modelSourceProfile: "global profile",
                modelSourceNone: "no source",
                modelSourceHint: "Source: {source} · {model}",
                modelSourceResolving: "Resolving the model source…",
                modelSourceUnknown: "source unknown",
                modelSourceUnknownHint:
                    'The roster or the agent default could not be read, so the UI cannot tell the source; this only means "unreadable", not "no source".',
                modelOutOfCatalogBadge: "not in local catalog",
                modelOutOfCatalogHint:
                    "The local model catalog does not list it; the source still decides what is sent — the catalog only feeds candidates and this badge.",
            },
            followUpQueueTitle: "Up next",
            followUpCount: "{count} / {capacity} unfinished",
            followUpEnqueue: "Queue message",
            followUpEnqueuing: "Queueing…",
            followUpPlaceholder: "Add a follow-up to this session…",
            followUpComposerNotice: "This message will run after the current ChatRun.",
            followUpPausedNotice: "New messages join the tail; paused items are not bypassed.",
            followUpFullNotice: "Queue full. Withdraw an item or wait; your draft will remain.",
            followUpQueueLoadFailed: "Could not load the Follow-up queue",
            followUpQueueFailed: "Follow-up queue action failed",
            followUpQueued: "Added to the Follow-up queue",
            followUpAlreadyQueued: "This Follow-up was already submitted; nothing new was queued",
            sseNotConnected: "Message not sent: the live connection is not established",
            sseNotConnectedHint: "Send again — the client retries the connection automatically.",
            followUpWithdrawn: "Removed from the Follow-up queue",
            followUpContinued: "Follow-up queue resumed",
            followUpContinue: "Continue remaining queue",
            followUpContinuing: "Continuing…",
            followUpWithdraw: "Withdraw",
            followUpWithdrawing: "Withdrawing…",
            followUpWithdrawItem: "Withdraw item {sequence}",
            followUpCapacityNote: "Hard limit: {capacity} items",
            followUpExecutionNote:
                "Bound Sessions use current settings; unbound Sessions retain the submitted model. Branch and files are fixed when queued",
            followUpStatusQueued: "Queued",
            followUpStatusWaiting: "Waiting for previous item",
            followUpStatusRunning: "Running",
            followUpStatusPaused: "Paused",
            followUpStatusCompleted: "Completed",
            followUpStatusCancelled: "Cancelled",
            followUpStatusFailed: "Failed",
            followUpStatusAmbiguous: "Outcome uncertain",
            followUpStatusWithdrawn: "Withdrawn",
            followUpPausedCancelled:
                "Queue paused · the previous turn was cancelled. Continue to resume FIFO order.",
            followUpPausedAmbiguous:
                "Queue paused · the previous turn has an uncertain outcome. Confirm to continue.",
            followUpPausedAttachment:
                "Queue paused · an attachment is unavailable. Fix it before continuing.",
            followUpPausedBranch:
                "Queue paused · the target Branch is unavailable. Select a valid Branch to continue.",
            followUpPausedStale:
                "Queue paused · Session binding or child run state changed. Review before continuing.",
            followUpPausedGeneric:
                "Queue paused · review the previous turn before continuing FIFO.",
            followUpContentUnavailable: "Content is available in the chat history",
            guidancePanelTitle: "Guide current run",
            guidancePanelHint: "Inject explicit user intent into the next planning round",
            guidancePlaceholder: "Inject guidance into the current turn...",
            guidanceSubmit: "Submit guidance",
            guidanceSubmitting: "Submitting...",
            guidanceEmpty: "No guidance submitted yet",
            guidanceSequencePrefix: "#{sequence}",
            guidanceSourceUser: "User",
            guidanceStatusPending: "Pending",
            guidanceStatusConsumed: "Consumed into next round",
            guidanceStatusExpired: "Expired",
            guidanceConsumedAt: "Consumed at {time}",
            guidanceExpiredAt: "Expired at {time}",
            guidanceAuthorSuffix: "by {id}",
            guidanceErrorNotActive: "The turn has ended or no longer accepts guidance",
            guidanceErrorForbidden: "No permission to guide this turn",
            guidanceErrorNotFound: "Turn not found or has been cleaned up",
            guidanceErrorNetwork: "Network error, please retry later",
            guidanceErrorTooLong: "Content too long or empty",
            guidanceErrorBadRequest: "Submission failed, please retry",
            guidanceErrorServer: "Server error, please retry later",
            upload: "Upload file",
            image: "Image",
            voice: "Voice input",
            screenshot: "Screenshot",
            attachFile: "Attachment",
            copy: "Copy",
            copied: "Copied",
            apply: "Apply",
            run: "Run",
            toolResult: "Tool Result",
            derivedStateTitle: "Child task status",
            derivedStateActive: "Active child tasks",
            derivedStateTerminal: "Completed child tasks",
            derivedStateUnnamedChild: "Child session",
            derivedStateRefreshError: "Child task status is temporarily unavailable",
            derivedStateLoading: "Refreshing child task status…",
            // task-1 / D-1846: derived-run anchor (child-session status card). Status copy reuses the
            // derivedState* vocabulary; only the card's own two strings live here.
            anchor: {
                open: "Open the child session: {name}",
                truncated: "Too many child sessions — showing the latest {count}",
            },
            waitingOnChild: "Waiting for child task",
            derivedStateStatus: {
                accepted: "Accepted",
                queued: "Queued",
                running: "Running",
                streaming: "Streaming",
                awaiting_approval: "Awaiting approval",
                dispatching: "Dispatching",
                cancelling: "Cancelling",
            },
            derivedStateOutcome: {
                success: "Succeeded",
                error: "Failed",
                partial: "Partially completed",
                ambiguous: "Outcome uncertain",
                cancelled: "Cancelled",
            },
            toolStatus: {
                pending: "Pending",
                running: "Running...",
                completed: "Completed",
                failed: "Failed",
                cancelled: "Cancelled",
                /** PLAN-0649: refused by policy/budget (not an execution error). */
                refused: "Refused",
                // task-54 / D-1708: no-permission is not the same conclusion as awaiting approval.
                noGrant: "No permission",
            },
            /* PLAN-0631 D31-04/07: visible language for a Run's state (see the zh block note). */
            runState: {
                queued: "Queued",
                queuedHint: "Accepted — waiting to start",
                reasonAgentDown:
                    "The Agent is unavailable right now; this will start once it recovers — you can also stop it",
                awaitingApproval: "Waiting for approval",
            },
            toolDiagnosticsTitle: "Diagnostics",
            toolDiagnosticsSummary: "{total} total, first {shown} fed back",
            toolDiagnosticsMore: "{count} more",
            toolRawOutput: "Raw output",
            runRecoveryDismiss: "Got it",
            emptyGreeting: "Hi, I'm xihe Agent. What can I help you with?",
            /* PLAN-0688: visible copy for the dedicated command/patch/read cards. */
            toolCard: {
                exitCode: "Exit code",
                stdout: "stdout",
                stderr: "stderr",
                noOutput: "No output yet",
                truncated: "Output truncated",
                artifactRetained: "Raw output retained as artifact",
                changedFiles: "{count} files",
                patchesPending: "{count} patches pending",
                diffPreview: "Diff preview",
                diffNote: "Diff is classified by line prefix; full content in raw output",
                totalLines: "Total lines",
                binaryPreview: "Binary content (base64)",
                previewOnly: "Preview limited to 200 lines / 2000 characters",
                previewLines: "Preview {count} lines",
                success: "Success",
                failure: "Failure",
            },
            /* PLAN-0649: refusal copy; the code→copy map lives in `lib/errorMessages.ts`. */
            toolRefusedTitle: "This call was refused and never ran",
            toolRefusedGeneric: "The tool call was refused; nothing was executed",
            toolRefusedCodeLabel: "Reason code:",
            toolRefusedHint:
                "Adjust the task or retry later; retrying the same request verbatim will usually be refused again",
            toolRefusalDelegationLimit:
                "The delegation budget is exhausted, so no child task was spawned",
            toolRefusalDelegationPolicy:
                "The delegation policy is unavailable, so no child task was spawned",
            toolRefusalSpawnFailed: "Spawning the child task failed, so no child task was created",
            toolRefusalAcquireFailed:
                "Fetching the credential failed, so no credential was delivered",
            toolRefusalGrantDenied:
                "This run was not granted the capability this tool needs (read/exec), so CP refused the call",
            toolRefusalGrantDeniedHint:
                'Grant the capability under "Workspace → Agents → Edit workspace role", then start a new session and retry; the current session\'s permissions were frozen at creation, so a role edit does not apply retroactively',
            jobOutputTitle: "Background job output",
            jobOutputLoad: "View output",
            jobOutputReload: "Reload",
            jobOutputMore: "Load more",
            jobOutputEmpty: "(no output yet)",
            jobOutputTruncated: "Output reached the 1 MiB cap; only the beginning is kept",
            jobOutputLost: "Job output is no longer available (container destroyed)",
            jobOutputExpired: "Job output expired (cleaned after TTL)",
            jobOutputUnavailable: "Runtime is temporarily unavailable; try again later",
            jobOutputLoadFailed: "Failed to load the job output",
            jobCancelButton: "Cancel this job",
            jobCancelHint: "Only this job is terminated; the chat continues",
            jobCancelConfirmHint:
                "Cancel this job ({jobId})? Its output is kept and the run continues.",
            jobCancelConfirm: "Confirm cancel",
            jobCancelBack: "Back",
            jobCancelPending: "Cancelling…",
            jobCancelDone: "Cancelled: the job was terminated; this chat continues.",
            jobCancelOrphaned: "The job is gone; the archive was closed as orphaned.",
            jobCancelFailed: "Failed to cancel the job",
            jobCancelUnconfirmed:
                "Cancellation unconfirmed: the process may still be running; retry later",
            jobCancelUnavailable: "Runtime is temporarily unavailable; try again later",
            jobStatus: {
                running: "Running",
                succeeded: "Succeeded",
                cancelled: "Cancelled",
                timeout: "Timeout",
                orphaned: "Orphaned",
            },
            backToChat: "← Back to Session",
            favorites: "Favorites",
            approvalRequired: "Approval Required",
            approve: "Approve",
            reject: "Reject",
            approvalDescription:
                "The agent wants to perform the following action. Review it before continuing:",
            approvalQueueProgress: "Approval {position} of {total} pending",
            approvalAction: "Action",
            approvalDetails: "Parameter preview",
            approvalEvidence: "Policy evidence",
            approvalGuardAdvice: "Guard advice",
            approvalGuardVerdictApprove: "Suggests approving",
            approvalGuardVerdictDeny: "Suggests rejecting",
            approvalEvidenceActionClass: "Action class",
            approvalEvidenceShape: "Tool shape",
            approvalEvidenceMatchedRule: "Matched rule",
            approvalEvidenceSourceLayer: "Effective layer",
            approvalEvidenceReason: "Reason",
            approvalEvidenceMode: "Mode",
            approvalEvidenceModeAtGrant: "Mode at decision",
            approvalEvidenceUnavailable:
                "Policy evidence is unavailable. No server-side evidence was received, so no default can be inferred.",
            approvalOriginCpGate: "Policy gate",
            approvalOriginAgentRelay: "Model request",
            approvalNoMatchedRule: "No specific rule matched",
            approvalLayerBuiltin: "Built-in layer",
            approvalLayerInstance: "Instance layer",
            approvalLayerUser: "Personal layer",
            approvalLayerWorkspace: "Workspace layer",
            approvalLayerSession: "Session layer",
            approvalLayerPerCall: "Per-call layer",
            approvalModeManual: "Manual approval",
            approvalModeAuto: "Auto allow",
            approvalModeUnavailable: "Not provided",
            approvalShapeStructured: "Structured",
            approvalShapeInterpreter: "Interpreter",
            approvalShapeOpaque: "Opaque",
            approvalShapeInterpreterWarning:
                "Interpreter shape: effects cannot be fully enumerated, so approval is bound to the parameters.",
            approvalShapeOpaqueWarning:
                "Opaque shape: tool semantics are unknown, so approval cannot be reused.",
            approvalTierGateDelete:
                "Delete actions can only be allowed once; session reuse and saved rules are unavailable.",
            approvalTierGateOpaque:
                "Opaque tools can only be allowed once; session reuse and saved rules are unavailable.",
            approvalTierGateInterpreter:
                "Interpreter tools allow once or session reuse only; persistent saved rules are unavailable.",
            approvalTierGateShapeUnavailable:
                "Tool shape evidence is unavailable; only allow once can be offered, and session reuse or saved rules cannot be inferred.",
            approvalAllowOnce: "Allow once",
            approvalAllowSession: "Allow in this session",
            approvalSaveRule: "Save as rule",
            approvalRejectFeedbackLabel: "Rejection feedback",
            approvalRejectFeedbackOptional: "Optional. This feedback is sent to the agent.",
            approvalRejectFeedbackTooLong: "Feedback must be 512 characters or fewer.",
            approvalRejectFeedbackPlaceholder:
                "Explain why you are rejecting this request (optional)",
            approvalSaveRuleTitle: "Confirm saved rule",
            approvalSaveRuleDescription: "Choose the rule scope and confirm its resource range.",
            approvalRuleLayer: "Save to layer",
            approvalRuleResource: "Resource range",
            approvalRuleResourceUnset: "Not set",
            approvalRuleResourceRequired: "Enter a non-blank resource range.",
            approvalRuleResourceTooLong: "Resource range must be 512 characters or fewer.",
            approvalRuleWildcardConfirmation:
                "Confirm that this rule applies to all resources (*).",
            approvalRuleWildcardConfirmationRequired:
                "Explicitly confirm that this rule applies to all resources.",
            approvalRulePreview: "Rule preview",
            approvalRuleEffect: "Effect",
            approvalRuleAllow: "Allow",
            approvalRuleActionClassDerived: "Derived by the server from the tool",
            approvalPersistentWarning:
                "This is a persistent rule and will apply beyond this session. Confirm the scope and resource range.",
            approvalPreflightUnavailable:
                "Preflight is unavailable; the server validates this when saving.",
            approvalSaveBack: "Back",
            approvalSaveConfirm: "Confirm save",
            approvalModeLabel: "Approval mode",
            approvalAutoWarning:
                "Auto allow is active: later ask decisions are allowed automatically, while hard protections and deny rules still apply.",
            approvalAutoClose: "Turn off auto allow",
            contextTemplateLabel: "Request template",
            contextTemplateUnavailable: "Context template unavailable",
            approvalModeChanged: "Approval mode changed",
            contextSourcesTitle: "Context sources",
            contextSourcesToggle: "Toggle context source summary",
            contextSourcesLoading: "Loading…",
            contextSourcesError: "Source summary unavailable",
            contextSourcesFailed: "read failed",
            contextSourcesUpdated: "Rules updated (applies this turn)",
            contextOverflowRetry: "Context limit exceeded; compacted and retrying once",
            budgetExhaustedTurns: "This run reached its turn limit",
            budgetExhaustedElapsed: "This run reached its elapsed-time limit",
            budgetExhaustedTokens: "This run reached its token limit",
            budgetExhaustedHint: "Continue in the input below to resume this session",
            noProgressReason: "Repeated or no-progress actions detected; the run was stopped",
            streamErrorGeneric:
                "This run did not finish. Retry; if it keeps failing, check the monitor logs.",
            principalMissing: "This session has no active Agent principal bound",
            principalMissingHint:
                "Bind an Agent in Workspace settings → Agent management, or ask a workspace admin to grant binding permission, then retry",
            // PLAN-0750 V10 (A1-lite): toast-channel copy (separate from the card channel above);
            // resolved through `errorCopyKey()` so it follows the active locale.
            principalMissingToast:
                "This session has no active Agent principal bound: bind one in Workspace settings → Agent management, then send again",
            principalDisabledToast:
                "The Agent principal bound to this session is disabled: unbind it in Workspace settings → Agent management, then bind an available one",
            // task-102: CP answers 400 `PARTICIPANT_SELF_TARGET` when TO names your own row (`ChatController:743`).
            // The candidate list already drops your own HUMAN row; this copy is the fallback (direct API callers).
            participantSelfTargetToast:
                "You cannot notify yourself: your own HUMAN identity is no longer offered as a recipient — pick another participant",
            // task-102 neighbour: `as` = your own HUMAN row with no TO target ⇒ CP 400
            // `AS_SELF_WITHOUT_TARGET` (`ChatController:689-705`, task-110). The `as` candidates stay
            // untouched, so this is REACHABLE and needs real copy.
            asSelfWithoutTargetToast:
                "With no send or CC target, the speak-as identity cannot be yourself: nothing could answer. Pick a send target, or choose a different speak-as identity",
            resourceExhausted: "{kind} capacity is full; retry in about {seconds}s",
            resourceExhaustedNoWait: "{kind} capacity is full; try again shortly",
            resourceExhaustedHint:
                "You can also switch to another connection in the model/connection picker above and retry.",
            resourceKindConnection: "Connection",
            resourceKindModel: "Model",
            resourceKindFileWrite: "File write",
            resourceKindProcess: "Process",
            resourceKindJob: "Job",
            resourceKindMcp: "MCP call",
            resourceKindUnknown: "Resource",
            contextCompactionCircuitOpen: "Auto-compaction paused (no improvement seen)",
            contextCompactionCircuitClosed: "Auto-compaction resumed",
            approvalUnclassifiedNotice:
                "Unclassified tool: it defaults to ask and cannot grant session or saved rules. Only a workspace OWNER / ADMIN can classify it.",
            approvalClassifyAndAllow: "Classify and allow",
            approvalClassifyTitle: "Classify the tool and allow this call",
            approvalClassifyDescription:
                "Classification is persisted for the current workspace and affects later policy evaluation; this approval still applies only once.",
            approvalClassifyActionClass: "Action class",
            approvalClassifyActionClassPlaceholder: "e.g. read, write, exec",
            approvalClassifyActionClassRequired: "Enter an action class.",
            approvalClassifyShape: "Tool shape",
            approvalClassifyAuthorityHint:
                "Classification authority: workspace OWNER / ADMIN; the server enforces this and the classification will not apply without it.",
            approvalClassifyBack: "Back",
            approvalClassifySubmit: "Confirm classification and allow once",
            approvalClassifyFailed: "Classification failed; this call was not allowed",
            approvalClassifyRequiresOnce: "Unclassified tools can only be allowed once.",
            pendingApprovalReopenLabel: "Pending approval",
            pendingApprovalReopenAction: "Review",
            dispatchQueue: {
                ahead: "Queued to run — {count} ahead",
                jump: "View",
            },
            checkpointMarkerChangedPrefix: "Adjacent slice difference",
            checkpointMarkerChangedUnit: "file(s)",
            checkpointMarkerRollbackable: "restore available",
            checkpointMarkerRevertEntry: "Restore…",
            checkpointMarkerNoSnapshot: "No slice was captured for this run",
            checkpointMarkerUnrollable: "This run could not be captured",
            checkpointMarkerReverted: "Restored to this slice",
            checkpointCountRestored: "restored",
            checkpointCountDeleted: "deleted",
            checkpointCountFailed: "failed",
            checkpointReasonUnavailable: "slice capability unavailable",
            checkpointReasonGitUnavailable: "no usable git detected",
            checkpointReasonGitTooOld: "git version too old",
            checkpointReasonGitFailed: "git operation failed",
            checkpointReasonWorkspaceUnknown: "workspace unavailable",
            checkpointReasonNestedRepoLimit: "nested repository limit reached",
            checkpointReasonInvalidRequest: "invalid slice request",
            checkpointReasonExpired: "slice expired",
            checkpointPreviewTitle: "Restore to this slice",
            checkpointPreviewDescription:
                "Restore to this moment; all changes after this moment will be discarded. The default action is cancel.",
            checkpointPreviewConcurrentWriteRisk:
                "Concurrent writes are allowed during restore; preview and result will mark affected paths.",
            checkpointPreviewLoading: "Building the revert preview…",
            checkpointPreviewFailed: "Failed to load the revert preview",
            checkpointPreviewRetry: "Retry",
            checkpointPreviewRestore: "Will restore",
            checkpointPreviewDelete: "Will delete",
            checkpointPreviewTypeConflict: "Type changes",
            checkpointPreviewTypeConflictIncomplete:
                "The preview did not return every type-change path, so confirmation cannot be completed. Retry the preview.",
            checkpointPreviewPathsTitle: "Paths",
            checkpointPreviewExpand: "Show all",
            checkpointPreviewCollapse: "Collapse",
            checkpointPreviewTruncated: "The plan is long; only the returned entries are shown.",
            checkpointPreviewNoEntries: "No paths need restoring.",
            checkpointPreviewOpaqueNestedRepos: "Directories excluded from restore",
            checkpointPreviewConfirm: "Execute restore",
            checkpointEntryRestore: "Restore",
            checkpointEntryDelete: "Delete",
            checkpointEntryNoop: "No action",
            checkpointEntryTypeConflict: "Type change conflict",
            checkpointNestedRepoImpactTitle:
                "This restore touches the following undeclared nested repositories",
            checkpointNestedRepoDirty: "Uncommitted changes",
            checkpointNestedRepoHeadMoved: "HEAD drifted",
            checkpointNestedRepoForceAck:
                "I confirm forcing the restore over their uncommitted changes",
            checkpointNestedRepoDriftAck:
                "I acknowledge these repositories will differ from their current HEAD",
            checkpointTypeConflictAck:
                "I confirm these paths should use the target slice type (the current type will be replaced)",
            checkpointResultTitle: "Restore result",
            checkpointResultDescription:
                "Per-item outcomes and suspects; inspect diffs and retry failed items.",
            checkpointResultRestored: "Restored",
            checkpointResultDeleted: "Deleted",
            checkpointResultFailed: "Failed",
            checkpointResultSuspect: "Concurrent-write suspect",
            checkpointResultPartial: "This was a partial restore: failed items can be retried.",
            checkpointResultViewDiff: "View diff",
            checkpointResultDiffLoading: "Loading diff…",
            checkpointResultDiffFailed: "Failed to load the diff",
            checkpointResultDiffSlice: "slice content",
            checkpointResultDiffTruncated:
                "Content is long; the diff shows the first 400 lines only.",
            checkpointResultSliceRef: "Slice ref",
            checkpointResultDuration: "Duration",
            checkpointResultRetry: "Retry unfinished items",
            checkpointResultDismiss: "Dismiss",
            checkpointRevertDone: "Restore completed",
            checkpointRevertPartial: "Restore completed with unfinished items",
            checkpointRevertFailed: "Restore execution failed",
            approvalAutoOffFailed: "Could not turn off auto allow; it is still on. Please retry.",
        },
    },
};
