import { writableAtOf, type MockDomain } from "./types";

/**
 * agent-runtime（智能体运行时）—— 单域数据，供设置页域内容区渲染。
 *
 * ## 键集口径
 * 键**只**取自 `packages/control-plane/src/main/resources/config-schemas/agent-runtime.json`
 * 的 `properties`：[实测] 2026-11-11 用脚本展开到叶子，**30 个叶子**；该 schema 的 30 个属性
 * 全是标量或标量数组（`loopExemptTools` 是字符串数组，不是嵌套对象），因此 30 行 `key`
 * 全是顶层键、无嵌套路径。`additionalProperties:false`（schema:44）⇒ 屏上多画的键写进去必被拒。
 *
 * ## 契约差异（必须如实说明，不靠排版绕过）
 * 本卡下发的说明里要求每字段有 `source` 与 `state: "real" | "gap"`；`./types` 的 `MockField`
 * **没有** `source` 字段，`state` 只接受 `"gap" | "unconfigured"`（"real" 不存在）。
 * 按「字段名不得自创」，这里的处理是：
 * - 出处放**每行上方的注释**（`// [源码] <path>:<line>`），机器可核、不上屏（行号不进 help）；
 * - `state` 只给 gap 行写 `"gap"`，其余行**省略**（省略即「后端真有此键」）。
 *
 * ## writableAt 判据（不手填）
 * 一律 `writableAtOf("agent-runtime", key)`：
 * - 该域同时在 `USER_WRITABLE_DOMAINS` 与 `WORKSPACE_WRITABLE_DOMAINS` 里
 *   （`ConfigService.java:90-96`）⇒ Set 推导为 `["instance","workspace","user"]`；
 * - 但 `INSTANCE_ONLY_KEYS`（`ConfigService.java:98-118`）里 12 个键**只允许实例层**：
 *   instructions / runMaxTurnsCeiling / runMaxElapsedSecondsCeiling / runMaxTokensCeiling /
 *   loopRepeatEscalateCeiling / loopErrorRunEscalateCeiling / loopStaleResultEscalateCeiling /
 *   loopWindowSizeCeiling / wakeChainMaxDepth / maxConcurrentRunsPerSession /
 *   delegationMaxCountCeiling / delegationMaxDepthCeiling（非实例层写入抛
 *   `ConfigAccessException`，`ConfigService.java:963-974`）。
 *
 * **契约缺陷（必须修，不在本文件里修）**：`./types` 的 `INSTANCE_ONLY_KEYS` 目前只登记了
 * `instructions`，上面另外 11 个键它不知道 ⇒ 本文件调用 `writableAtOf()` 后，这 11 行会被推导成
 * `["instance","workspace","user"]`，而 CP 在用户/工作区层写它们会直接拒。按「不许手填 writableAt、
 * 不许自建覆盖表」，这里不改结果、也不复制一份键表，而是把缺陷报上去：`types.ts` 的
 * `INSTANCE_ONLY_KEYS["agent-runtime"]` 需要补齐为上面 12 个键；补齐后本文件**零改动**即正确。
 * 在那之前，这 11 行的 writableAt 是错的，不要当成事实读。
 *
 * 该域**没有统一的按层解析方法**：run 预算/循环检测/指纹走 Agent 的 run 快照合并
 * （`app_state.py:877-916,970-1040`），工具超时与输出上限走 CP `resolve(domain,key,user,ws)`
 * （`McpToolTimeoutService.java:128-139`），而唤醒深度/并发阀门/派生上限/唤醒等待则是
 * `resolve(...,null,null)`（实例层，`WakeChainService.java:270-289`、
 * `SessionRunConcurrencyGate.java:50-70`、`DelegationBudgetService.java:287-309`、
 * `WakeFanOutService.java:560-569`）。⇒ 按裁定 ④：`layerDerivedOnly: true`，屏上标 [推导]，
 * 不显示「继承自上层」这类没出处的标记。
 *
 * ## 唯一 gap 行
 * `wakeDispatchWaitSeconds`：CP 真的会读它（实例层，默认 60s），但 schema 里**没有**这个键 ⇒
 * API 写不进去。这是「用户会在这里找、后端没有」的设计缺口，有代码出处，不是为对齐计数编出来的行。
 */
export const domains: MockDomain[] = [
    {
        id: "agent-runtime",
        label: "智能体运行时",
        summary:
            "运行预算、循环检测与并发阀门：多数阈值由实例层定硬上限、用户与工作区只能往下调；另有 12 个键只能在实例层改。",
        layerDerivedOnly: true,
        layout: "form",
        groups: [
            {
                label: "工具与 Worker",
                fields: [
                    {
                        // [源码] config-schemas/agent-runtime.json:4（enum "true"|"false"，字符串不是布尔）
                        // [源码] agent/src/xihe_agent/main.py:339-357（启动时按它决定是否加载 Worker 目录）
                        // [源码] agent/src/xihe_agent/api/registry.py:23-39（请求带 workspaceId/userId 时按 run 快照判）
                        key: "useRegistry",
                        label: "Worker 注册表",
                        help: "开启后 Agent 启动时扫描 Worker 目录、把每个 Worker 注册成独立执行体，并开放 /registry 路由；关着时这些路由一律 404。写入值是字符串 true/false；改完要重启 Agent——注册表只在启动阶段初始化，运行时改只会影响路由判定。",
                        control: "select",
                        value: "false",
                        options: ["true", "false"],
                        writableAt: writableAtOf("agent-runtime", "useRegistry"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:5
                        // [源码] agent/src/xihe_agent/api/chat.py:543-547（仅 toolMode=workspace 时读，命中即抛错）
                        // [源码] agent/src/xihe_agent/agent/supervisor.py:16-30（审批不支持、/chat 走不到该图）
                        key: "useSupervisor",
                        label: "Supervisor 编排",
                        help: "只在「workspace 工具模式」的会话里被读取；纯对话（不挂工具）完全不受它影响。当前开着会让这类会话直接失败——缓冲式 Supervisor 执行器不支持审批，产品路径还没接通，等于一个只能关不能开的开关。",
                        control: "select",
                        value: "false",
                        options: ["true", "false"],
                        writableAt: writableAtOf("agent-runtime", "useSupervisor"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:6（enum "true"|"false"）
                        // [源码] agent/src/xihe_agent/app_state.py:848-874（缺省/空白/非法值都按开启）
                        // [源码] control-plane/.../chat/ProviderRequestFingerprintRecorder.java:14-30（只存哈希/计数/字节，不存正文）
                        key: "providerRequestFingerprintEnabled",
                        label: "记录提供商请求指纹",
                        help: "每次运行的首个模型请求会留一份「六层请求指纹」（各段哈希、角色直方、槽位填充状态），用来对比同一输入是否真的发出同一份请求。它只记哈希与计数、不记提示词正文；采集失败只丢这条诊断，不会让会话失败。留空或写非法值等同开启。",
                        control: "select",
                        value: "true",
                        options: ["true", "false"],
                        writableAt: writableAtOf(
                            "agent-runtime",
                            "providerRequestFingerprintEnabled",
                        ),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:7
                        // [源码] agent/src/xihe_agent/main.py:347-349（仅在启用注册表时读取）
                        // [源码] agent/src/xihe_agent/registry/registry.py:12-36（留空落 ./agents）
                        key: "workersDir",
                        label: "Worker 目录",
                        help: "Worker 定义文件所在目录，留空用默认 ./agents。只在「Worker 注册表」开启时被读取，而且同样要重启 Agent 才重新扫描——运行中往目录里加文件不会自动出现。",
                        control: "text",
                        value: "./agents",
                        writableAt: writableAtOf("agent-runtime", "workersDir"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:8
                        // [源码] ConfigService.java:98-101（INSTANCE_ONLY_KEYS 含 instructions）
                        // [源码] control-plane/.../chat/ChatController.java:1662-1668（run 指令取自 Agent 账号的系统提示）
                        key: "instructions",
                        label: "实例级指令",
                        help: "只能在实例层配置：用户层与工作区层写它会被 409 拒掉。当前没有模块读取这个键——每次运行下发给 Agent 的指令取自该账号绑定的 Agent 系统提示，所以在这里保存成功也不会改变 Agent 行为。",
                        control: "textarea",
                        value: "",
                        writableAt: writableAtOf("agent-runtime", "instructions"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:9（1–30 秒）
                        // [源码] control-plane/.../timeout/ToolTimeoutPolicy.java:30-41,119-133（配置值 >30 视为无效，落 30s 代码默认）
                        // [源码] control-plane/.../mcp/McpToolTimeoutService.java:100-139（远程服务器自带超时 >30 时回落到这里）
                        key: "systemToolTimeoutS",
                        label: "系统工具超时（秒）",
                        help: "CP 自带的系统工具（不是远程 MCP 服务器自己的）一次调用最多等多久，取值 1–30 秒；实际等待还要在外层加 CP +2 秒、Agent +4 秒的余量。单次调用显式指定的超时优先于它；填超过 30 会被当成无效值、回到 30。",
                        control: "number",
                        value: 30,
                        writableAt: writableAtOf("agent-runtime", "systemToolTimeoutS"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:10（整数，最小 1）
                        // [源码] control-plane/.../timeout/ToolTimeoutPolicy.java:28-29
                        // [源码] control-plane/.../mcp/McpProxyController.java:1909-1925（未配置则不下发头）
                        key: "toolOutputLimitBytes",
                        label: "工具输出上限（字节）",
                        help: "单次工具返回给模型的正文最多多少字节，超出的部分在网关层被截断。留空表示不下发这个限制，沿用调用方与沙盒各自的默认值——想统一收紧才需要填。",
                        control: "number",
                        value: 131072,
                        writableAt: writableAtOf("agent-runtime", "toolOutputLimitBytes"),
                    },
                ],
            },
            {
                label: "单次运行预算",
                fields: [
                    {
                        // [源码] config-schemas/agent-runtime.json:11
                        // [源码] agent/src/xihe_agent/app_state.py:813-830,877-916（超出上限时夹到上限并记 run_budget_clamp）
                        // [源码] ConfigService.java:177-189（代码默认 25）
                        key: "runMaxTurns",
                        label: "单次运行最大轮次",
                        help: "一次运行里模型最多「想一步、调一次工具」几轮，代码默认 25。超过就被实例层的轮次硬上限夹住（硬上限 >0 时取两者较小值）——想突破必须先在实例层放宽硬上限。",
                        control: "number",
                        value: 25,
                        writableAt: writableAtOf("agent-runtime", "runMaxTurns"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:12
                        // [源码] agent/src/xihe_agent/app_state.py:877-916；ConfigService.java:185（默认 600 秒）
                        key: "runMaxElapsedSeconds",
                        label: "单次运行最长耗时（秒）",
                        help: "一次运行最长跑多少秒，代码默认 600。超时按失败收敛而不是继续挂起；同样受实例层耗时硬上限夹取。",
                        control: "number",
                        value: 600,
                        writableAt: writableAtOf("agent-runtime", "runMaxElapsedSeconds"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:13
                        // [源码] agent/src/xihe_agent/app_state.py:877-916；ConfigService.java:186（默认 38303，按真实运行 p95×1.5 校准）
                        key: "runMaxTokens",
                        label: "单次运行 token 上限",
                        help: "一次运行累计可用 token，代码默认 38303（真实运行 p95 的 1.5 倍）。调大更贵、更容易在一轮里塞满上下文；调小会让长任务提前收敛。",
                        control: "number",
                        value: 38303,
                        writableAt: writableAtOf("agent-runtime", "runMaxTokens"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:14
                        // [源码] ConfigService.java:101-104（实例层专属）；app_state.py:897-911（0 = 不夹取）
                        key: "runMaxTurnsCeiling",
                        label: "轮次硬上限",
                        help: "只能在实例层改：用户与工作区填的轮次超过它就被夹到这个值。填 0 表示不设上限（下层写多少就多少），代码默认 100。",
                        control: "number",
                        value: 100,
                        writableAt: writableAtOf("agent-runtime", "runMaxTurnsCeiling"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:15
                        // [源码] ConfigService.java:101-104；app_state.py:897-911（0 = 不夹取）
                        key: "runMaxElapsedSecondsCeiling",
                        label: "耗时硬上限（秒）",
                        help: "只能在实例层改：单次运行的耗时上限最多能开到多少秒，代码默认 3600。填 0 表示不设上限。",
                        control: "number",
                        value: 3600,
                        writableAt: writableAtOf("agent-runtime", "runMaxElapsedSecondsCeiling"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:16
                        // [源码] ConfigService.java:101-104；app_state.py:897-911（0 = 不夹取）
                        key: "runMaxTokensCeiling",
                        label: "token 硬上限",
                        help: "只能在实例层改：单次运行能用的 token 上限最多开到多少，代码默认 51070。填 0 表示不设上限——放开意味着一次运行可以不封顶地烧额度。",
                        control: "number",
                        value: 51070,
                        writableAt: writableAtOf("agent-runtime", "runMaxTokensCeiling"),
                    },
                ],
            },
            {
                label: "循环与无进展检测",
                fields: [
                    {
                        // [源码] config-schemas/agent-runtime.json:17（最小 1，无上限）
                        // [源码] agent/src/xihe_agent/context/loop_detection.py:9-26,57-66（warn 只提示、不阻断）
                        key: "loopRepeatWarn",
                        label: "重复调用提示阈值",
                        help: "连续发出同一个工具调用（参数规范化后完全相同）第几次开始提醒模型换个做法，代码默认 2。提醒只是提示，回合照常继续；这一档没有硬上限。",
                        control: "number",
                        value: 2,
                        writableAt: writableAtOf("agent-runtime", "loopRepeatWarn"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:18
                        // [源码] loop_detection.py:9-26（refuse = 本次调用被拒、运行继续）
                        key: "loopRepeatRefuse",
                        label: "重复调用拒绝阈值",
                        help: "同一个调用连续第几次时直接拒绝这一次（运行不终止），代码默认 3。被拒的那次也会计入连续次数，所以调低到 2 基本等于第二次就拦住。",
                        control: "number",
                        value: 3,
                        writableAt: writableAtOf("agent-runtime", "loopRepeatRefuse"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:19
                        // [源码] loop_detection.py:23-26（escalate = 二级信号，运行按无进展收敛）
                        // [源码] app_state.py:994-1017（被 loopRepeatEscalateCeiling 夹取）
                        key: "loopRepeatEscalate",
                        label: "重复调用升级阈值",
                        help: "同一个调用连续第几次时升级成「无进展」信号、让运行停下来，代码默认 5。受实例层重复升级硬上限夹取，调高只是把死循环拖得更久。",
                        control: "number",
                        value: 5,
                        writableAt: writableAtOf("agent-runtime", "loopRepeatEscalate"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:20
                        // [源码] loop_detection.py:18（error-streak：连续同类失败，warn @3）
                        key: "loopErrorRunWarn",
                        label: "连续失败提示阈值",
                        help: "连续出现同类错误第几次开始提示模型，代码默认 3。只提示不阻断；这一档没有硬上限。",
                        control: "number",
                        value: 3,
                        writableAt: writableAtOf("agent-runtime", "loopErrorRunWarn"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:21
                        // [源码] loop_detection.py:18；app_state.py:994-1017（被 loopErrorRunEscalateCeiling 夹取）
                        key: "loopErrorRunEscalate",
                        label: "连续失败升级阈值",
                        help: "同类错误连续第几次时升级成无进展、结束这次运行，代码默认 5。受实例层失败升级硬上限夹取。",
                        control: "number",
                        value: 5,
                        writableAt: writableAtOf("agent-runtime", "loopErrorRunEscalate"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:22
                        // [源码] loop_detection.py:18-19（stale-result：幂等/只读工具连续返回相同结果）
                        key: "loopStaleResultWarn",
                        label: "相同结果提示阈值",
                        help: "只读类工具连续返回完全相同的结果第几次开始提示，代码默认 2。只对幂等/只读工具生效，写操作不参与这个判定。",
                        control: "number",
                        value: 2,
                        writableAt: writableAtOf("agent-runtime", "loopStaleResultWarn"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:23
                        // [源码] loop_detection.py:18-19；app_state.py:994-1017（被 loopStaleResultEscalateCeiling 夹取）
                        key: "loopStaleResultEscalate",
                        label: "相同结果升级阈值",
                        help: "只读工具连续返回相同结果第几次时升级成无进展、结束运行，代码默认 5。受实例层同名硬上限夹取。",
                        control: "number",
                        value: 5,
                        writableAt: writableAtOf("agent-runtime", "loopStaleResultEscalate"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:24
                        // [源码] loop_detection.py:16-19,66（窗口 = 最近 N 次调用）
                        // [源码] app_state.py:994-1017（被 loopWindowSizeCeiling 夹取）
                        key: "loopWindowSize",
                        label: "观察窗口大小",
                        help: "判重时回看最近多少次调用，代码默认 20。窗口越大越不容易误判偶发重复，但记忆占用也更大；受实例层窗口硬上限夹取。",
                        control: "number",
                        value: 20,
                        writableAt: writableAtOf("agent-runtime", "loopWindowSize"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:33-42（字符串数组，最多 64 项，不允许通配 *）
                        // [源码] loop_detection.py:92-102（内置豁免集恒并集，配置只追加）
                        // [源码] app_state.py:1028-1040（非法 JSON 只告警、回落内置集）
                        key: "loopExemptTools",
                        label: "循环豁免工具",
                        help: "列在这里的工具不计入重复调用检测，适合轮询、探活这类「本来就该反复调」的工具。只能往内置豁免集里追加，内置项删不掉；写 * 通配或超过 64 项会被 schema 拒，JSON 写坏则整体回落内置集。",
                        control: "textarea",
                        value: '["my_poll_tool"]',
                        writableAt: writableAtOf("agent-runtime", "loopExemptTools"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:25
                        // [源码] ConfigService.java:105-108（实例层专属）
                        // [源码] app_state.py:994-1017（0 = 不夹取）
                        key: "loopRepeatEscalateCeiling",
                        label: "重复升级硬上限",
                        help: "只能在实例层改：下层填的重复升级阈值最多能到多少，代码默认 10。填 0 表示不夹取。",
                        control: "number",
                        value: 10,
                        writableAt: writableAtOf("agent-runtime", "loopRepeatEscalateCeiling"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:26
                        // [源码] ConfigService.java:105-108；app_state.py:994-1017（0 = 不夹取）
                        key: "loopErrorRunEscalateCeiling",
                        label: "失败升级硬上限",
                        help: "只能在实例层改：连续失败升级阈值最多能到多少，代码默认 10；0 表示不夹取。",
                        control: "number",
                        value: 10,
                        writableAt: writableAtOf("agent-runtime", "loopErrorRunEscalateCeiling"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:27
                        // [源码] ConfigService.java:105-108；app_state.py:994-1017（0 = 不夹取）
                        key: "loopStaleResultEscalateCeiling",
                        label: "相同结果升级硬上限",
                        help: "只能在实例层改：只读工具「相同结果升级」阈值最多能到多少，代码默认 10；0 表示不夹取。",
                        control: "number",
                        value: 10,
                        writableAt: writableAtOf("agent-runtime", "loopStaleResultEscalateCeiling"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:28
                        // [源码] ConfigService.java:105-108；app_state.py:994-1017（0 = 不夹取）
                        key: "loopWindowSizeCeiling",
                        label: "观察窗口硬上限",
                        help: "只能在实例层改：下层能设的观察窗口最大是多少次调用，代码默认 50。填 0 表示不夹取——窗口开到很大时每次判重都要多扫一遍。",
                        control: "number",
                        value: 50,
                        writableAt: writableAtOf("agent-runtime", "loopWindowSizeCeiling"),
                    },
                ],
            },
            {
                label: "并发、唤醒与派生",
                fields: [
                    {
                        // [源码] config-schemas/agent-runtime.json:30（1–4）
                        // [源码] ConfigService.java:113-116（实例层专属，解析时不带用户/工作区上下文）
                        // [源码] control-plane/.../chat/SessionRunConcurrencyGate.java:24-70（超限 409 CHAT_IN_PROGRESS；1 = 回到单飞）
                        key: "maxConcurrentRunsPerSession",
                        label: "单会话并发运行数",
                        help: "同一个会话最多允许几条运行同时在跑，取值 1–4，代码默认 2。到顶再发消息会被 409 CHAT_IN_PROGRESS 拒掉；填 1 就是回到「一次只能跑一条」的旧行为。只能在实例层改——它在没有用户/工作区上下文的路径上解析。",
                        control: "number",
                        value: 2,
                        writableAt: writableAtOf("agent-runtime", "maxConcurrentRunsPerSession"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:29（1–10）
                        // [源码] ConfigService.java:109-112（实例层专属）
                        // [源码] control-plane/.../chat/WakeChainService.java:263-289（非法/0 一律回落 3，0 不代表不限）
                        key: "wakeChainMaxDepth",
                        label: "唤醒链最大深度",
                        help: "一条唤醒链最多能往下唤醒几层，取值 1–10，代码默认 3；超过的那一层被记成 depth_exceeded 拒绝。0 不是「不限」——非法值一律回落到 3。只能在实例层改。",
                        control: "number",
                        value: 3,
                        writableAt: writableAtOf("agent-runtime", "wakeChainMaxDepth"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:31
                        // [源码] ConfigService.java:117-118（实例层专属）
                        // [源码] control-plane/.../chat/DelegationBudgetService.java:64-66,287-309（0 = 不夹取；0 的 ceiling 不是「禁止派生」）
                        key: "delegationMaxCountCeiling",
                        label: "派生子会话数硬上限",
                        help: "把「一个会话之下最多并行派生几个子会话」夹到这个数，代码默认 0＝不夹取（沿用账号策略里的值，策略默认 8）。注意它只夹取、不禁止：想彻底禁派生要改账号策略，不是把它设成 0。只能在实例层改。",
                        control: "number",
                        value: 0,
                        writableAt: writableAtOf("agent-runtime", "delegationMaxCountCeiling"),
                    },
                    {
                        // [源码] config-schemas/agent-runtime.json:32
                        // [源码] ConfigService.java:117-118；DelegationBudgetService.java:64-66,287-309（0 = 不夹取）
                        key: "delegationMaxDepthCeiling",
                        label: "派生深度硬上限",
                        help: "把派生链的最大深度夹到这个数，代码默认 0＝不夹取（沿用账号策略里的值，策略默认 3）。0 只表示不夹，不会把派生关掉；只能在实例层改。",
                        control: "number",
                        value: 0,
                        writableAt: writableAtOf("agent-runtime", "delegationMaxDepthCeiling"),
                    },
                ],
            },
            {
                label: "本页应该有、后端没有的开关",
                fields: [
                    {
                        // [源码] control-plane/.../chat/WakeFanOutService.java:39（默认 60 秒）
                        // [源码] control-plane/.../chat/WakeFanOutService.java:560-569（resolve("agent-runtime","wakeDispatchWaitSeconds",null,null)）
                        // [源码] config-schemas/agent-runtime.json:44（additionalProperties:false ⇒ 写这个键被拒）
                        key: "wakeDispatchWaitSeconds",
                        label: "唤醒派发等待（秒）",
                        help: "后端无此键：代码确实会读它——唤醒一个会话后最多等它派发多久才放弃，默认 60 秒——但 agent-runtime 的 schema 里没有这个键，写进去会被 additionalProperties 拒。排障「唤醒一直等到超时」时人会来这一页找它，所以它应该在这里有一个可调输入。",
                        control: "number",
                        value: 60,
                        writableAt: writableAtOf("agent-runtime", "wakeDispatchWaitSeconds"),
                        state: "gap",
                    },
                ],
            },
        ],
    },
];
