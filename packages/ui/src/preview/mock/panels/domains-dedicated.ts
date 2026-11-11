import { writableAtOf, type MockDomain } from "../data/types";

/**
 * 专用面板域（整块编辑）三份数据：embedding / agent-templates / api-request-templates。
 *
 * 分工（Lead 2026-11-11）：llm-provider 归另一份面板负责；本文件只写这三个域，且**只写数据、不建画布**
 * —— 列表态 / 详情态的版式原由设计稿 `screens/DomainPanelCanvas.vue` 渲染，该文件已随 `38c5b833` 删除；
 * 本文件现在只留数据。
 *
 * 徽标：面板域的资源计数由统一派生函数 `badgeOf()` 计算（量资源条数，单位取 `panel.unit`）；
 * 本文件**不提供第二个派生实现** —— 早先的 `panelBadgeOf()` 要求写死 unit，导致没有该 unit 的面板域
 * （如 `llm-provider`）长期显示「—」；该函数已删除，勿重新引入。
 *
 * 三条硬纪律的落点：
 * 1. 真组件：本文件不含任何标记，版式全部由 canvas 用 @/components/ui/** 渲染；
 * 2. 结论句标来源：summary / help 里凡是「结论」都带 [源码 file:line] / [文档] / [推导]；
 * 3. 与 PLAN-0762 无冲突：本文件不表态布局模型（rail 两模块 / 左栏三档宽都在外壳件里）。
 *
 * 事实基线（[源码] 2026-11-11 逐条核对，工作树 t233-ui-mock @ 884e7327f）：
 * - 12 个 UI 域：ConfigService.java:76-79；explicit-only：:82-83；
 *   整块编辑域：:86-88（注释原话「Whole-unit domains edited by dedicated panels, not the generic Instance rows」）；
 * - explicit-only 是**抛异常**的单层语义：:630-640 的 rejectEffectiveAgentTemplates /
 *   rejectEffectiveContextTemplates —— 原串（供核对，不上屏）：
 *   "Agent templates must be read from one explicit config layer"；
 *   "Context templates must be read from one explicit config layer"；
 * - embedding 整域只有 1 个整块键：config-schemas/embedding.json 的 profile；
 *   contract{modelId,dimension} 由 CP 下发、客户端不得重声明（services/embeddingProfile.ts:20-21）；
 *   候选连接 = enabled && status === "READY" && operation === "embedding"（同文件 :39-45）；
 * - api-request-templates **没有 config-schema 文件**（config-schemas/ 13 份里无它），
 *   读面走 ConfigController.java:313-316 → ApiRequestTemplateService.readLayer
 *   ⇒ 该域的键没有机器可读权威源，权威是服务接口 services/apiRequestTemplates.ts:10-19。
 *
 * 示例资源说明：rows 里的连接名 / 模板名是**示例值**（[推导]），
 * 只有 providerId / apiTypeId / 模型 id 取自产品真值（config-schemas、
 * provider-catalog/providers.json、services/embeddingProfile.ts 的 FALLBACK_MODEL/FALLBACK_DIMENSION）。
 * 真实连接数据走 /api/v1/provider-connections，不在 config 域。
 */

const EMBEDDING_MODEL = "tongyi-embedding-vision-flash-2026-03-06";

/**
 * embedding 的层可写性：解析链覆盖已在 `data/types.ts` 的 `RESOLVE_OVERRIDES` 内置
 * （chain = [workspace, user]，source = EmbeddingProfileService.java:97-104），
 * 所以这里直接调 `writableAtOf()` 即可 —— 本地不再做任何收窄（2026-11-11 裁定 ④ 落地后删除）。
 */

const embedding: MockDomain = {
    id: "embedding",
    label: "向量化",
    // 「本面板只在非实例层渲染」与「候选过滤条件」是读者会问的两件事，写进 summary 由 canvas 直接渲染。
    summary:
        "整块编辑：一条连接 + 一个模型构成整层画像。本面板仅在非实例层渲染 [源码]。解析链只读 workspace → user、实例层不参与 [源码]，所以在用户层保存后即生效，实例层写这个键不会被读取；候选只含已启用且状态 READY 的 embedding 连接 [源码]，未就绪的连接不会出现在列表里。",
    layout: "panel",
    groups: [],
    panel: {
        // [裁定 2026-11-11] pick 语义：本域不创建连接，只从已有连接里选一条。
        // 连接在「LLM 提供商」域新建（[源码 ConfigLayerPanels.vue:430-472 的 ProviderHub]）。
        primaryAction: "pick",
        // [契约] unit 是「个连接」这种带量词的单位，不带数字前缀；数字由画布用 rows.length 拼。
        unit: "个连接",
        // 清除后由工作区层提供（解析链 workspace → user，不读 instance）[源码 EmbeddingProfileService.java:97-104]
        actions: [
            { label: "保存本层", variant: "default" },
            { label: "清除本层", variant: "outline", hint: "保存后本层为空，改由工作区层提供" },
        ],
        addLabel: "去「LLM 提供商」新建向量化连接",
        columns: [
            { key: "name", label: "连接" },
            { key: "provider", label: "提供商" },
            { key: "apiType", label: "API 类型" },
            { key: "status", label: "状态" },
        ],
        rows: [
            {
                id: "emb-01",
                cells: {
                    name: "dashscope-embedding",
                    provider: "通义千问 Qwen",
                    apiType: "dashscope-multimodal-embedding@1",
                    status: "已启用 · READY",
                },
            },
            {
                id: "emb-02",
                cells: {
                    name: "dashscope-embedding-backup",
                    provider: "通义千问 Qwen",
                    apiType: "dashscope-multimodal-embedding@1",
                    status: "已启用 · READY",
                },
            },
            {
                id: "emb-03",
                cells: {
                    name: "dashscope-embedding-staging",
                    provider: "通义千问 Qwen",
                    apiType: "dashscope-multimodal-embedding@1",
                    status: "已启用 · READY",
                },
            },
        ],
        detail: {
            note: "改完保存后本层生效；清除本层则改由工作区层提供（解析链 workspace → user，不读实例层）。",
            groups: [
                {
                    label: "当前层画像（profile，整块键）",
                    fields: [
                        {
                            key: "profile.providerId",
                            label: "提供商",
                            help: "[源码 provider-catalog/providers.json] 决定这份画像属于哪个提供方；与连接一起构成唯一身份。embedding 目前只有一条可用 API 输入类型（dashscope-multimodal-embedding@1），所以选择面很窄。",
                            control: "select",
                            value: "dashscope-qwen",
                            options: ["dashscope-qwen"],
                            writableAt: writableAtOf("embedding", "profile.providerId"),
                        },
                        {
                            key: "profile.connectionKey",
                            label: "连接",
                            help: "[源码 services/embeddingProfile.ts:39-45 · EmbeddingProfileService.java:97-109] 凭据与出口都绑在连接上；换连接等于换 key、换配额。清空本层画像 = 回到解析链的上一层（全局设置没有工作区上下文，所以就是本层自己的值）。候选只含已启用且 READY 的 embedding 连接。",
                            control: "select",
                            value: "dashscope-embedding",
                            options: [
                                "dashscope-embedding",
                                "dashscope-embedding-backup",
                                "dashscope-embedding-staging",
                            ],
                            writableAt: writableAtOf("embedding", "profile.connectionKey"),
                        },
                        {
                            key: "profile.model",
                            label: "模型（由 CP 契约固定）",
                            help: "[源码 EmbeddingProfileService.java:90-93 · services/embeddingProfile.ts:20-21] 不是自由选项：CP 只接受固定模型，传别的直接 400 EMBEDDING_MODEL_UNSUPPORTED；维度 768 同样由契约下发，客户端不得重声明。",
                            control: "select",
                            value: EMBEDDING_MODEL,
                            options: [EMBEDDING_MODEL],
                            writableAt: writableAtOf("embedding", "profile.model"),
                        },
                    ],
                },
            ],
        },
    },
};

const agentTemplates: MockDomain = {
    id: "agent-templates",
    label: "智能体模板",
    // explicit-only：结论 + 源码标签；Java 异常串原样留在文件头注释里，不上屏。
    summary:
        "整块编辑的模板域，本层独立存储：不跨层合并、不继承，上层改了不影响本层 [源码]。模板与角色整块保存在本层。",
    layout: "panel",
    groups: [],
    panel: {
        unit: "个模板",
        // explicit-only：每层各存一份，清除只是「本层不再存」，不会继承任何层 [源码 ConfigService.java:630-634]
        actions: [
            { label: "保存本层", variant: "default" },
            {
                label: "删除本层副本",
                variant: "outline",
                hint: "不跨层合并、不继承，删除即本层没有",
            },
        ],
        addLabel: "新建模板",
        columns: [
            { key: "name", label: "模板" },
            { key: "toolMode", label: "工具模式" },
            { key: "role", label: "角色" },
            { key: "model", label: "模型" },
        ],
        rows: [
            {
                id: "tpl-01",
                cells: {
                    name: "code-reviewer",
                    toolMode: "workspace",
                    role: "reviewer",
                    model: "claude-sonnet-4.6",
                },
            },
            {
                id: "tpl-02",
                cells: {
                    name: "doc-writer",
                    toolMode: "none",
                    role: "writer",
                    model: "gpt-5.1",
                },
            },
            {
                id: "tpl-03",
                cells: {
                    name: "release-notes",
                    toolMode: "workspace",
                    role: "writer",
                    model: "deepseek-v4-pro",
                },
                // [源码 config-schemas/agent-templates.json $defs.hookSubscriptions] 该模板带 hooks 订阅，
                // 而 UI 面板类型（AgentTemplatesPanel.vue:17-26）里没有 hooks 字段 ⇒ 后端有、编辑面无。
                state: "gap",
            },
        ],
        detail: {
            note: "本层独立存储：不跨层合并、不继承；改完保存只影响本层。",
            groups: [
                {
                    label: "模板基本信息",
                    fields: [
                        {
                            key: "templates[].name",
                            label: "模板名",
                            help: "新建智能体时用来选模板；同名不会互相覆盖，重复名只影响辨认。",
                            control: "text",
                            value: "code-reviewer",
                            writableAt: writableAtOf("agent-templates", "templates[].name"),
                        },
                        {
                            key: "templates[].description",
                            label: "描述",
                            help: "给选模板的人看的一句话；不参与运行，不影响模型行为。",
                            control: "textarea",
                            value: "审阅 diff 与测试缺口，只读工作区。",
                            writableAt: writableAtOf("agent-templates", "templates[].description"),
                        },
                    ],
                },
                {
                    label: "运行配置",
                    fields: [
                        {
                            key: "templates[].systemPrompt",
                            label: "系统提示词",
                            help: "智能体的固定指令；改错会直接改变它所有会话的行为，且不随会话回滚。",
                            control: "textarea",
                            value: "你是代码审阅者：先找回归，再找测试缺口。",
                            writableAt: writableAtOf("agent-templates", "templates[].systemPrompt"),
                        },
                        {
                            key: "templates[].toolMode",
                            label: "工具模式",
                            help: "none = 纯对话，不提供工作区工具；workspace = 允许读工作区（权限仍由角色决定）。",
                            control: "select",
                            value: "workspace",
                            options: ["none", "workspace"],
                            writableAt: writableAtOf("agent-templates", "templates[].toolMode"),
                        },
                        {
                            key: "templates[].provider",
                            label: "提供方",
                            help: "可留空；留空时按会话/default 连接解析，填了则固定走该提供方。",
                            control: "text",
                            value: "anthropic",
                            writableAt: writableAtOf("agent-templates", "templates[].provider"),
                        },
                        {
                            key: "templates[].model",
                            label: "模型",
                            help: "与提供方一起固定模型身份；留空则由连接默认模型决定。",
                            control: "text",
                            value: "claude-sonnet-4.6",
                            writableAt: writableAtOf("agent-templates", "templates[].model"),
                        },
                    ],
                },
                {
                    label: "权限角色",
                    fields: [
                        {
                            key: "templates[].roleId",
                            label: "绑定角色",
                            help: "[源码 AgentTemplatesPanel.vue:509-646 · config-schemas/agent-templates.json $defs.template.roleId] 这里显示的是角色名，提交的是 template.roleId（schema 要求 UUID 格式）；权限本身在「角色」区维护，改角色会影响所有引用它的模板。",
                            control: "select",
                            value: "reviewer",
                            options: ["reviewer", "writer"],
                            writableAt: writableAtOf("agent-templates", "templates[].roleId"),
                        },
                        {
                            key: "templates[].hooks",
                            label: "钩子订阅（advisors）",
                            help: "[源码 config-schemas/agent-templates.json $defs.hookSubscriptions] schema 允许模板声明 advisors（本轮示例结构，kind 按 D25-10 是开放字符串），但 UI 面板类型里没有该字段 ⇒ 后端有结构、当前没有编辑面。",
                            control: "textarea",
                            value: '{"advisors":[{"kind":"memory","on":["before_model"]}]}',
                            // [推导] gap = 后端有这个结构、UI 没有任何编辑面 ⇒ 任何层都不可写，故为空集。
                            // 不用 writableAtOf()：它回答的是「这个键在哪些层可写」，而本键压根没有编辑面；
                            // 填 Set 会让画布把 user 层之外的层当成「继承自上层」，在 explicit-only 域上是错的陈述。
                            writableAt: [],
                            state: "gap",
                        },
                    ],
                },
            ],
        },
    },
};

const apiRequestTemplates: MockDomain = {
    id: "api-request-templates",
    label: "API 请求模板",
    // explicit-only：结论 + 源码标签；异常串原文留在文件头注释里。
    summary:
        "整块编辑的请求模板域，本层独立存储：不跨层合并、不继承，上层改了不影响本层 [源码]。本域没有 config-schema，键的权威是服务接口 [源码]。",
    layout: "panel",
    groups: [],
    panel: {
        unit: "个模板",
        // explicit-only：同上，清除 = 本层不再存，不继承 [源码 ConfigService.java:636-640]
        actions: [
            { label: "保存本层", variant: "default" },
            {
                label: "删除本层副本",
                variant: "outline",
                hint: "不跨层合并、不继承，删除即本层没有",
            },
        ],
        addLabel: "新建模板",
        columns: [
            { key: "name", label: "模板" },
            { key: "apiType", label: "API 输入类型" },
            { key: "version", label: "版本" },
            { key: "status", label: "状态" },
        ],
        rows: [
            {
                id: "art-01",
                cells: {
                    name: "openai-chat-default",
                    apiType: "openai-chat-completions@1",
                    version: "v3",
                    status: "已发布",
                },
            },
            {
                id: "art-02",
                cells: {
                    name: "anthropic-messages-default",
                    apiType: "anthropic-messages@1",
                    version: "v2",
                    status: "已发布",
                },
            },
            {
                id: "art-03",
                cells: {
                    name: "dashscope-embedding-input",
                    apiType: "dashscope-multimodal-embedding@1",
                    version: "v1",
                    status: "草稿",
                },
            },
        ],
        detail: {
            note: "本层独立存储：不跨层合并、不继承；改完保存只影响本层。",
            groups: [
                {
                    label: "模板身份",
                    fields: [
                        {
                            key: "templates[].name",
                            label: "模板名",
                            help: "给绑定关系看：连接默认模板与模型级绑定按模板名辨认；引用按 id+version，所以改名不会断引用。",
                            control: "text",
                            value: "openai-chat-default",
                            writableAt: writableAtOf("api-request-templates", "templates[].name"),
                        },
                        {
                            key: "templates[].apiTypeId",
                            label: "API 输入类型",
                            help: "[源码 services/apiRequestTemplates.ts:48-53] 决定模板能填哪些变量、以及发布时由哪个 validator 校验；改类型等于换一套请求形状。",
                            control: "select",
                            value: "openai-chat-completions@1",
                            options: [
                                "openai-chat-completions@1",
                                "anthropic-messages@1",
                                "mimo-responses@1",
                                "dashscope-multimodal-embedding@1",
                            ],
                            writableAt: writableAtOf(
                                "api-request-templates",
                                "templates[].apiTypeId",
                            ),
                        },
                    ],
                },
                {
                    label: "请求体",
                    fields: [
                        {
                            key: "templates[].bodySource",
                            label: "请求体正文",
                            help: "[源码 ContextTemplatesPanel.vue:46-57 · 文档 packages/ui/AGENTS.md] 可用变量：user_input / agent_instructions / skill_catalog / agent_memory / model / conversation_history / tools / rag_context。发布前必须过 CP validator，UI 不会自动改你的原文。",
                            control: "textarea",
                            value: [
                                "{",
                                '  "model": "{{model}}",',
                                '  "messages": {{conversation_history}},',
                                '  "tools": {{tools}}',
                                "}",
                            ].join("\n"),
                            writableAt: writableAtOf(
                                "api-request-templates",
                                "templates[].bodySource",
                            ),
                        },
                    ],
                },
                {
                    label: "发布状态",
                    fields: [
                        {
                            key: "templates[].status",
                            label: "状态",
                            help: "[文档 packages/control-plane/AGENTS.md · 源码 ProviderHub.vue:159-171] 取值 draft / published 是接口枚举原值（列表里显示成草稿/已发布）。草稿可改；发布后的修订不可变，要改就发新版本。引用关系（哪些连接/模型绑了这个模板）在本域看不到，绑定存在「LLM 提供商」域的 providerModelBindings。",
                            control: "select",
                            value: "published",
                            options: ["draft", "published"],
                            // [task-81 ⑦-3] 列表里写「已发布」、控件却显示 published ⇒ 同一产品两种写法
                            optionLabels: { draft: "草稿", published: "已发布" },
                            writableAt: writableAtOf("api-request-templates", "templates[].status"),
                        },
                    ],
                },
            ],
        },
    },
};

/** 三个专用面板域（顺序与 12 域清单一致：embedding / agent-templates / api-request-templates）。 */
export const DEDICATED_DOMAINS: MockDomain[] = [embedding, agentTemplates, apiRequestTemplates];

export default DEDICATED_DOMAINS;
