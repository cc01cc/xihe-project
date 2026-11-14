import {
    INSTANCE_DOMAINS,
    LAYER_DOMAINS,
    type ConfigDomain,
    type ConfigLayer,
} from "../stores/config";

/**
 * PLAN-0752 M1 骨架的纯逻辑层：层 × 域矩阵、路由解析、左栏分组。
 *
 * <p>为什么单独成模块（task-66）：路由注册、左栏、404 判定三处必须用**同一份**矩阵，
 * 否则"左栏能看到但路由 404"这类不一致会随域分批实施反复出现。矩阵本身不在前端另造：
 * `LAYER_DOMAINS`（stores/config）已是 CP 白名单的镜像 —— **实例 12 / 用户 9 /
 * 工作区层 4**（工作区层 = `workspace-default` 与 per-workspace 层共用同一张矩阵），
 * 本模块只做**查询与分组**。</p>
 *
 * <p><b>2026-11-13 D-1122 49A / PLAN-0766 T2.4 后工作区层是 4 域</b>（agent-runtime /
 * approval-policy / agent-templates / job-policy）：模型 4 域（llm-provider / context-policy /
 * embedding / rag）退出了工作区层。注意 `logging` 只有实例层（`WORKSPACE_WRITABLE_DOMAINS`
 * 从不含它），`context-templates` 是 service-only（通用 config API 不收）。改这里之前先核
 * CP `ConfigService.java` 的 `WORKSPACE_WRITABLE_DOMAINS` 与 `WORKSPACE_DEFAULT_WRITABLE_DOMAINS`。</p>
 */

/**
 * 设置区可出现的层 = **`ConfigLayer` 减去 per-workspace 层**（`Exclude`，不是另写一份字面量）。
 *
 * <p>历史：task-253（用户 2026-11-10 裁定）把 workspace 层从全局设置里删掉；PLAN-0766 又加了
 * 部署级的 `workspace-default`。PLAN-0773 M4-1（task-190）需要在**工作区内部**用 per-workspace
 * 层 ⇒ `ConfigLayer` 新增 `workspace`，而**全局设置仍然是三层**，所以这里用 `Exclude` 收窄。</p>
 *
 * <p><b>为什么必须是 `Exclude` 而不是把 `ConfigLayer` 拆成两个类型</b>：`ConfigLayer` 是 store
 * （`layerConfig`/`layerMeta`/`layerLoadingByLayer`/`LAYER_DOMAINS`）的键，per-workspace 层确
 * 实在 store 里存在；而「设置区能出现哪些层」是**路由/IA 的投影**（`SETTINGS_LAYERS` 与路由注册
 * 都由它派生）。两个概念共用一个底层枚举 + 一个 `Exclude`，比维护两份几乎相同的枚举更少漂移。</p>
 *
 * <p><b>加层与收窄必须同一批提交</b>：中间态让 `SettingsLayer = ConfigLayer` 自动变四层 ⇒
 * task-253 删掉的「工作区层」会从后门回到全局设置页，且**不会有任何报错**。</p>
 */
export type SettingsLayer = Exclude<ConfigLayer, "workspace">;

/**
 * 全局设置可出现的三层。PLAN-0766（task-160）：在实例/用户两层之间插入共享的
 * `workspace-default` 层（wire 值与路由段同名，小写）。它不是 per-workspace 层
 * （那层已由 task-253 从 UI 退役），而是部署级的一份默认值行集：对没有显式 workspace
 * 覆盖的所有工作区生效，可读任意已认证用户、可写仅 `MANAGE_WORKSPACE_DEFAULT_CONFIG`
 * 持有者（能力原子求值，不是角色名判断）。
 */
export const SETTINGS_LAYERS_LOW_TO_HIGH: readonly SettingsLayer[] = [
    "instance",
    "user",
    "workspace-default",
];

/**
 * **显示顺序 = 层进顺序（低 → 高，当前层在最后）**：instance → user → workspace-default。
 *
 * task-77：唯一真相在上面那个 `SETTINGS_LAYERS_LOW_TO_HIGH`（低 → 高：instance < personal <
 * workspace-default，与 `LlmDefaultProfilePanel` 的取值优先级
 * `workspace > workspace-default > personal > instance` 同义）。左栏自上而下就是升序，
 * 所以这里只做一次拷贝 —— **禁止**在本文件或渲染处再手写第二份字面量数组；右栏徽标要
 * 高 → 低显示时，由消费方对这个数组取反序。
 */
export const SETTINGS_LAYERS: readonly SettingsLayer[] = [...SETTINGS_LAYERS_LOW_TO_HIGH];

/** 用户层不可写的域（= 用户层矩阵里没有的那些）：logging / approval-policy / job-policy。 */
export function isInstanceOnlyForUser(domain: ConfigDomain): boolean {
    return !LAYER_DOMAINS.user.includes(domain);
}

/** 域的本地化 key（左栏、面包屑、域页 h2 共用）。 */
export const DOMAIN_LABEL_KEY: Record<ConfigDomain, string> = {
    "llm-provider": "settings.domainLlmProvider",
    "context-policy": "settings.domainContextPolicy",
    embedding: "settings.domainEmbedding",
    rag: "settings.domainRag",
    "agent-runtime": "settings.domainAgentRuntime",
    "agent-profile": "settings.domainAgentProfile",
    "user-preference": "settings.domainUserPreference",
    logging: "settings.domainLogging",
    "approval-policy": "settings.domainApprovalPolicy",
    "agent-templates": "settings.domainAgentTemplates",
    "api-request-templates": "settings.domainContextTemplates",
    "job-policy": "settings.domainJobPolicy",
};

export type ResolveLayerRouteResult =
    | { ok: true; layer: SettingsLayer; domain: ConfigDomain }
    | { ok: false; reason: "unknown-layer" | "unknown-domain" | "domain-not-in-layer" };

export function isSettingsLayer(value: unknown): value is SettingsLayer {
    return typeof value === "string" && (SETTINGS_LAYERS as readonly string[]).includes(value);
}

export function isConfigDomain(value: unknown): value is ConfigDomain {
    return typeof value === "string" && (INSTANCE_DOMAINS as readonly string[]).includes(value);
}

/**
 * 某域在哪些层可写（**顺序 = `SETTINGS_LAYERS` 顺序（低 → 高）**，与左栏自上而下同源）。
 * 要「高 → 低」渲染（右栏徽标那种）的消费方必须自己取反序 —— 本函数不做这件事。
 */
export function layersForDomain(domain: ConfigDomain): SettingsLayer[] {
    return SETTINGS_LAYERS.filter((layer) => LAYER_DOMAINS[layer].includes(domain));
}

export function domainsForLayer(layer: SettingsLayer): readonly ConfigDomain[] {
    return LAYER_DOMAINS[layer];
}

/** 该域在该层是否存在于矩阵里（不存在 ⇒ 路由不注册 ⇒ 404，V3/V25）。 */
export function domainRouteExists(layer: unknown, domain: unknown): boolean {
    return resolveLayerRoute(layer, domain).ok;
}

/**
 * 路由参数 → 域。三处（路由注册 / 左栏 / 404 兜底）共用，纯函数便于单测。
 *
 * <p>返回 `reason` 而不是布尔，是为了让 404 视图能区分"层不认识"与"域不认识"，
 * 也给后续 M2 的 T2.3（logging 在 user 层）留可读的错误分类。</p>
 */
export function resolveLayerRoute(layer: unknown, domain: unknown): ResolveLayerRouteResult {
    if (!isSettingsLayer(layer)) return { ok: false, reason: "unknown-layer" };
    if (!isConfigDomain(domain)) return { ok: false, reason: "unknown-domain" };
    if (!domainRouteExistsInMatrix(layer, domain)) {
        return { ok: false, reason: "domain-not-in-layer" };
    }
    return { ok: true, layer, domain };
}

function domainRouteExistsInMatrix(layer: SettingsLayer, domain: ConfigDomain): boolean {
    return LAYER_DOMAINS[layer].includes(domain);
}

/**
 * 从 URL 路径反推层（V3/V25 的 404 兜底用）。
 *
 * <p>为什么需要它：`/settings/:pathMatch(.*)*` 这类兜底路由没有「层×域」参数，若给它写死
 * `meta.settingsLayer = "instance"`，`/settings/user/logging` 的 404 页会顶着「实例配置」的层标题
 * ——文案/左栏都对，只有层身份在说胡话（2026-11-10 量测实测，task-66 V03d/V03e）。
 * 层是外框，只有**一个**地方决定它：路由 meta 有则用，没有则从这里按路径推导。</p>
 */
export function settingsLayerForPath(path: string): SettingsLayer {
    if (path.startsWith("/settings/workspace-default")) return "workspace-default";
    return path.startsWith("/settings/user") ? "user" : "instance";
}

/**
 * task-227（用户 2026-11-13 裁定「**合页，不合域**」）：把三个「模型配置」域放**一页三段**。
 *
 * <p><b>为什么不合并域</b>：`{domain}` 合法集合由 CP 的 `config-schemas/*.json` + yaml `enum` 决定，
 * 且**锁定 / 继承 / env 覆盖都是按域求值** —— 合并域会让「只想让管理员锁 LLM 连接、不锁上下文策略」
 * 做不到（那样"锁一半"没有表达方式）。所以这里只做**页面组装**：域 id 一个都不合并，
 * 三个域各自的 `meta` / 保存 / 层矩阵语义原样不变。</p>
 *
 * <p><b>组 id 不是域 id</b>：`model-config` 不在 `INSTANCE_DOMAINS` 里，也**不进** `LAYER_DOMAINS`
 * —— 它只出现在**路由段**与左栏条目标识上。因此 `resolveLayerRoute("instance", "model-config")`
 * 仍然返回 `unknown-domain`（路由侧另走 `isModelConfigGroup()`），这条边界是刻意的：
 * 一旦它被当成域，`/config/model-config/meta` 这类请求就会打到 CP 上必然 400。</p>
 */
export const MODEL_CONFIG_GROUP_ID = "model-config";

/**
 * 组内域的**唯一一份**清单（顺序 = 页内段顺序 = 左栏组入口顺序）。
 * 每层实际出现几段由 `modelConfigDomainsForLayer()` 用 `LAYER_DOMAINS` 求**交集**得出，
 * **不**在组件里再写第二份字面量 —— 否则「某层矩阵改了、页面还画三段」这种漂移会静默发生。
 */
export const MODEL_CONFIG_DOMAINS: readonly ConfigDomain[] = [
    "llm-provider",
    "context-policy",
    "api-request-templates",
];

/**
 * 组**只在哪几层成组**（D-1122 口径，2026-11-13）：instance / user 两层。
 *
 * <p>「层能不能成组」与「矩阵里有没有这些域」是**两个问题**，2026-11-13 起两者已经一致但**仍旧分开
 * 写**：矩阵（`LAYER_DOMAINS`）在 T2.4 之后已把模型域从工作区层移除（workspace-default /
 * workspace 都是 4 域，`modelConfigDomainsForLayer('workspace-default')` = 空），所以今天
 * `MODEL_CONFIG_LAYERS` 只是把「政策」写死一次，让它在矩阵再次变化时**不需要跟着改**。
 * 反过来若把两者合并（组只在矩阵非空时出现），矩阵一改就会**静默**让组页消失或出现 ——
 * 「政策」与「事实」分开写，才能各说各话且漂移可见。</p>
 */
export const MODEL_CONFIG_LAYERS: readonly SettingsLayer[] = ["instance", "user"];

/** 该层是否允许出现模型配置组（政策判据，先于此层矩阵里有没有这些域）。 */
export function isModelConfigGroupLayer(layer: SettingsLayer): boolean {
    return MODEL_CONFIG_LAYERS.includes(layer);
}

/** 组在该层实际承载的域（交集）：instance 3 段 / user 3 段 / workspace-default **0 段**（T2.4 后工作区层无模型域）。 */
export function modelConfigDomainsForLayer(layer: SettingsLayer): ConfigDomain[] {
    return MODEL_CONFIG_DOMAINS.filter((domain) => LAYER_DOMAINS[layer].includes(domain));
}

export function isModelConfigGroup(value: unknown): value is typeof MODEL_CONFIG_GROUP_ID {
    return value === MODEL_CONFIG_GROUP_ID;
}

/** 组页路径（与域页同构：`/settings/<layer>/model-config`）。 */
export function settingsGroupPath(layer: SettingsLayer): string {
    return `/settings/${layer}/${MODEL_CONFIG_GROUP_ID}`;
}

/**
 * 左栏条目（**组折叠的唯一实现处**）：把 `MODEL_CONFIG_DOMAINS` 在**该层存在**的那些域折成**一个**组条目，
 * 其余域照旧一条一域。三个层都调这一个函数，所以「左栏有组入口但路由没有」这类不一致不可能单独发生。
 *
 * <p>只有一个成员时不折叠（`members.length >= 2` 才成组）——那种组点进去只有一段，
 * 等于多一次点击还没有收益。</p>
 */
export interface SettingsNavItem {
    id: string;
    labelKey: string;
    path: string;
}

export function navItemsForLayer(layer: SettingsLayer): SettingsNavItem[] {
    // D-1122：workspace-default 即使矩阵里还有这些域，也不生成组条目（政策在 MODEL_CONFIG_LAYERS）。
    const members = isModelConfigGroupLayer(layer) ? modelConfigDomainsForLayer(layer) : [],
        items: SettingsNavItem[] = [];
    for (const domain of domainsForLayer(layer)) {
        if (members.includes(domain)) continue;
        items.push({
            id: domain,
            labelKey: DOMAIN_LABEL_KEY[domain],
            path: settingsDomainPath(layer, domain),
        });
    }
    if (members.length >= 2) {
        const firstMember = domainsForLayer(layer).indexOf(members[0]);
        items.splice(firstMember < 0 ? 0 : firstMember, 0, {
            id: MODEL_CONFIG_GROUP_ID,
            labelKey: "settings.groupModelConfig",
            path: settingsGroupPath(layer),
        });
    }
    return items;
}

/** 全局设置页的域路径（instance / workspace-default / user 三层都进 `/settings`）。 */
export function settingsDomainPath(layer: SettingsLayer, domain: ConfigDomain): string {
    return `/settings/${layer}/${domain}`;
}

/** 层默认页：实例层与非管理员都落到矩阵里的第一个域。 */
export function defaultLayerPath(layer: SettingsLayer): string {
    const first = LAYER_DOMAINS[layer][0];
    return first ? settingsDomainPath(layer, first) : "/settings/user/llm-provider";
}

/** PLAN-0766 T3.3：写 workspace-default 层的唯一能力原子（CP 用自己的 catalog 求值，UI 不复制名单）。 */
export const WORKSPACE_DEFAULT_CONFIG_ATOM = "MANAGE_WORKSPACE_DEFAULT_CONFIG";

export function isWorkspaceDefaultLayer(layer: SettingsLayer): boolean {
    return layer === "workspace-default";
}

/**
 * PLAN-0772 M2：资源面（`/resources/*`）自己的层轴。
 *
 * <p><b>为什么不直接沿用 `SETTINGS_LAYERS`</b>（task-188 实测）：配置层的枚举是
 * instance / user / workspace-default，其中 `workspace-default` 是「部署级默认值行集」，不是资源归属；
 * 而资源面要的 `workspace` 恰好是 task-253 从全局设置里退役的那一层。两侧不是同一个集合，
 * 硬映射会把 `workspace-default` 当成资源层、把 `workspace` 漏掉。</p>
 *
 * <p>因此**资源层清单只在本模块出现这一份**（组件里不许再写第二份，理由同 `LAYER_DOMAINS`）。
 * wire 值用大写（`?layer=USER|WORKSPACE|INSTANCE`，design.md 决策 9 / verify V11）；解析时大小写都收
 * —— 手输小写不该 404，但**输出一律大写**，避免同一个 URL 有两种写法。</p>
 */
export type ResourceLayer = "INSTANCE" | "WORKSPACE" | "USER";

/** 显示顺序 = 层进顺序的**反序**（高 → 低）：我的 → 本工作区 → 全平台。 */
export const RESOURCE_LAYERS: readonly ResourceLayer[] = ["USER", "WORKSPACE", "INSTANCE"];

/** 资源面的五个资源（一资源一页 + 层 tab，不是每层一页：design.md 决策 2）。 */
export type ResourceId = "credentials" | "mcp" | "skills" | "agents" | "knowledge";

/**
 * 某一层的进入门槛。**只允许两种来源**，都必须是 CP 自己守卫的原文，不许写角色名特判
 * （工作区硬规则 + design.md 决策 2 的风险判据）：
 * - `capability: "instance:admin"`：CP 控制器上就是
 *   `@PreAuthorize("@requesterAuthority.holdsCapabilityAtom('instance:admin')")`
 *   （`InstanceCredentialController.java:61`），这是**CP 的选择**，不是 UI 抄角色；
 * - `atom`：实例域 action atom（`MANAGE_SKILL_LIBRARY` 等，见 `SkillsPanel.vue:42`）。
 *
 * 缺省（无 `requires`）= 任何已认证调用者都能读该层（CP 这些读面就是 `isAuthenticated()`）。
 */
export type ResourceLayerRequires = { capability: "instance:admin" } | { atom: string };

export interface ResourceLayerRule {
    layer: ResourceLayer;
    requires?: ResourceLayerRequires;
    /** 数据按工作区归属：页面从当前页签上下文取 workspaceId，取不到时给「先选工作区」态。 */
    needsWorkspace?: boolean;
}

export interface ResourceDef {
    id: ResourceId;
    labelKey: string;
    /** 该资源**真实存在**的层（= `spec/resource-layer-matrix.md` 的结论；顺序随 `RESOURCE_LAYERS`）。 */
    layerRules: readonly ResourceLayerRule[];
    /** 打开 `/resources/<id>` 时落在哪一层（该资源最具体、且后端已实现的那层）。 */
    defaultLayer: ResourceLayer;
    /** 后端缺口（无实体）⇒ 不注册真页面，左栏按缺口渲染（D7：留位不隐藏）。 */
    gaps?: BackendGap[];
    gapNoteKey?: string;
}

/**
 * 资源×层矩阵（PLAN-0772 M2 的唯一一份）。逐条依据见
 * `internal/A03-xihe/evidence/2026-11-12-ia-resource-extraction/README.md` §5 与
 * `spec/resource-layer-matrix.md`；**不是** `LAYER_DOMAINS`（资源面不进配置矩阵，D-1006 B6）。
 */
export const RESOURCE_DEFS: readonly ResourceDef[] = [
    {
        id: "credentials",
        labelKey: "settings.ia.resourceCredentials",
        // 三层都是真实体：`owner_type = USER / WORKSPACE / INSTANCE`（D-1007，V63 CHECK）。
        layerRules: [
            { layer: "USER" },
            { layer: "WORKSPACE", needsWorkspace: true },
            { layer: "INSTANCE", requires: { capability: "instance:admin" } },
        ],
        defaultLayer: "USER",
    },
    {
        id: "mcp",
        labelKey: "settings.ia.resourceMcp",
        // 没有个人层：`mcp_remote_servers.workspace_id NOT NULL`（audit §F G1）。
        /**
         * task-447（D-1286）：**实例层读面不挂门槛**。契约原文（`openapi.yaml:5079`）：
         * 「Read face is open to every authenticated caller (this registry shapes routing,
         * not authority); the write face is instance-admin only.」⇒ 写面才是能力位
         * `instance:admin`（`:5102`），由 `InstanceMcpPanel` 自己守；tab 置灰会让非管理员
         * **连读都读不到**，与 skills 实例层同一裁定（见下）。
         *
         * <p>另注：该端点 CP 侧**尚未实现**（`RouteContractParityTest:216-217` 收在 PLANNED_APIS
         * 「PLAN-0771 M3」）⇒ 这是**后端缺口**，不是授权问题：缺口由面板的 `SettingsErrorSurface`
         * 照实显示，**不得**用 403 卡片打扮成「缺权限」（那会同时谎报「不是后端缺口」）。</p>
         */
        layerRules: [{ layer: "WORKSPACE", needsWorkspace: true }, { layer: "INSTANCE" }],
        defaultLayer: "WORKSPACE",
    },
    {
        id: "skills",
        labelKey: "settings.ia.resourceSkills",
        /**
         * 三层：全平台（`GET /skills` 默认 instance）+ 本工作区（`?definitionScope=workspace`，
         * `api.ts:3657`）+ **个人**（`T2b.3`：`?definitionScope=user`，契约 `openapi.yaml:5465`
         * 「takes no id (the caller is the owner)」，CP `SkillLibraryService.list:52-61` 已实现）。
         *
         * <p><b>`USER` 层不给 `requires`</b>（`T2b.2` 交付后改的真话）：读面**不挂任何原子**
         * —— P-189-3 明写撤销 `MANAGE_PERSONAL_SKILLS` 之后**读仍开放**，只有写面 403。
         * ⇒ 把 tab 置灰会让没有该原子的用户**连自己已存的个人技能都看不到**（比"看不到按钮"
         * 严重得多）。该原子只门面板里的「导入技能」按钮，见 `PersonalSkillsPanel`。</p>
         *
         * <p>实例层读面任何已认证调用者都能进（openapi「visible to every authenticated caller」）；
         * 写面原子 `MANAGE_SKILL_LIBRARY` 由面板自己守（不在 tab 上重复挡）。</p>
         */
        layerRules: [
            { layer: "USER" },
            { layer: "WORKSPACE", needsWorkspace: true },
            { layer: "INSTANCE" },
        ],
        defaultLayer: "WORKSPACE",
    },
    {
        id: "agents",
        // 模块级中性名（**不是** `settings.ia.resourceAgents` = 平台智能体）：资源页标题与左栏标签
        // 都要对默认层（USER=个人主体）成立，用层内名会得到「/resources/agents 标题写着平台智能体、
        // 当前层却是我的主体」这种自相矛盾的页面（实测 2026-11-12 探针抓到的）。
        labelKey: "resources.nameAgents",
        /**
         * 三层（task-203，用户 2026-11-12「成员入口的 agent principal 也别漏了」）：
         * - 个人层 = `agent-principals`（`created_by=self` 的个人视图）；
         * - **工作区层 = 成员 / 绑定面**（`WorkspaceAgentsPanel`；读面 `WorkspaceAgentController`
         *   全 `@PreAuthorize("isAuthenticated()")`，写面绑定由 CP 的 `BindingController` /
         *   `BindingAdminService` 守 **`MANAGE_WORKSPACE_AGENTS`**（工作区档原子，`PermissionAtomCatalog.java:125`
         *   与 `PrincipalGrantActionCatalog.java:84` 要求具体 workspace UUID）。⇒ tab 门只需要
         *   「有工作区上下文」，动作原子交给面板与 CP，不在这里重复挡、也不编造原子名）；
         * - 实例层 = 平台智能体（D-1006 B4）。**读面不挂门槛**：CP
         *   `InstanceAgentPrincipalController:75` 是 `@PreAuthorize("isAuthenticated()")`（类头 `:33-36`
         *   明写任何已认证调用者看到同一份列表）；写面才是双门 `INSTANCE_PRINCIPAL_WRITE_GATE`
         *   （`:61-62` = 能力位 `instance:admin` **and** 原子 `MANAGE_AGENT_PRINCIPALS`），由
         *   `InstanceAgentsPanel` 的 `canWrite` 守（A 类双门，防删注释在该面板）。task-447（D-1286）
         *   去掉这里的 `requires`：它比 CP 读面窄，会让非管理员连读都读不到（与 skills 同裁定）。
         */
        layerRules: [
            { layer: "USER" },
            { layer: "WORKSPACE", needsWorkspace: true },
            { layer: "INSTANCE" },
        ],
        defaultLayer: "USER",
    },
    {
        id: "knowledge",
        labelKey: "settings.ia.resourceKnowledge",
        // G3：CP 无库实体（无表、无 CRUD），只有 4 个按 workspace 分区的代理端点 ⇒ 缺口，留位不隐藏。
        layerRules: [],
        defaultLayer: "WORKSPACE",
        gaps: ["G3"],
        gapNoteKey: "settings.ia.gapNoteKnowledge",
    },
];

export function isResourceId(value: unknown): value is ResourceId {
    return (
        typeof value === "string" &&
        (RESOURCE_DEFS as readonly ResourceDef[]).some((d) => d.id === value)
    );
}

export function isResourceLayer(value: unknown): value is ResourceLayer {
    return typeof value === "string" && (RESOURCE_LAYERS as readonly string[]).includes(value);
}

export function resourceDef(id: ResourceId): ResourceDef {
    const def = RESOURCE_DEFS.find((candidate) => candidate.id === id);
    if (!def) throw new Error(`unknown resource id: ${id}`);
    return def;
}

/** 该资源真实存在的层（顺序 = `RESOURCE_LAYERS` 的高 → 低）。 */
export function layersForResource(id: ResourceId): readonly ResourceLayer[] {
    return resourceDef(id).layerRules.map((rule) => rule.layer);
}

export function resourceLayerRule(
    id: ResourceId,
    layer: ResourceLayer,
): ResourceLayerRule | undefined {
    return resourceDef(id).layerRules.find((rule) => rule.layer === layer);
}

/**
 * `?layer=` 的解析：认得（大小写不敏感）就用它，认不得/缺省就落到该资源的默认层。
 *
 * <p>为什么**不**在非法值上 404：层 tab 是本页的主要交互，手输 `?layer=user` 或复制到小写写法
 * 都该落在正确的层，而不是给一张 404。资源 id 非法才 404（路由段不匹配）。</p>
 */
export function resolveResourceLayer(id: ResourceId, raw: unknown): ResourceLayer {
    const def = resourceDef(id);
    if (typeof raw !== "string") return def.defaultLayer;
    const upper = raw.trim().toUpperCase();
    return def.layerRules.some((rule) => rule.layer === upper)
        ? (upper as ResourceLayer)
        : def.defaultLayer;
}

/** 资源页路径（不带层）：`/resources/credentials`。层在 `?layer=`，不进路径段。 */
export function resourcePath(id: ResourceId): string {
    return `/resources/${id}`;
}

/** 资源页 + 具体层的深链：`/resources/credentials?layer=USER`。 */
export function resourceLayerPath(id: ResourceId, layer: ResourceLayer): string {
    return `${resourcePath(id)}?layer=${layer}`;
}

/** 资源模块的默认落点（= 凭据 · 我的层，与 GlobalRail 第三入口同源）。 */
export function defaultResourcePath(): string {
    return resourceLayerPath("credentials", resourceDef("credentials").defaultLayer);
}

export interface SettingsNavItem {
    id: string;
    labelKey: string;
    path: string;
    /** 缺口项：只显示但标「缺口」，不伪装成可用入口（design.md §3.2 / G1/G3）。 */
    gap?: boolean;
}

/**
 * 后端能力缺口代码：**唯一来源**是 `internal/A03-xihe/docs/resource-layer-permission-audit.md` §F
 * （G1–G7，逐条有现状证据）。前端只引用代码与一句话说明，不据此删入口——
 * 用户 2026-11-10 裁定 D7：**留位标缺口，不隐藏**（隐藏会让人以为能力不存在）。
 *
 * <p><b>R20（task-43，2026-11-13）：`G4` 一码两义已拆成 `G4a`/`G4b`</b>，来源见
 * `resource-layer-permission-audit.md:198-201`（该节自己写着「如后续要区分，建议改用 G4a/G4b」）。
 * 拆的理由不是好看：同一个码同时指两件事，下一个人按 §F 对账时必然判 UI 不符。</p>
 *
 * <ul>
 *   <li><b>`G4a` = 工具无注册实体 / 无 CRUD</b> —— <b>仍开</b>。CP 没有 `tools` 表
 *       （迁移里 `CREATE TABLE tools` 0 命中），工具来自 Runtime handler + MCP 发现，
 *       只有分类表 `tool_faces`（`V15__policy_rules_and_tool_faces.sql:42`；
 *       其 scope 也只有 instance/workspace，见同文件 `:53` = 另一条 `G5`）。</li>
 *   <li><b>`G4b` = 智能体无用户级创建入口</b> —— <b>已关闭（2026-11-12，PLAN-0750 M1/M3），
 *       码位保留、不得复用</b>。用户级创建已落地：端点 `AgentPrincipalController.java:122`
 *       （`POST /api/v1/agent-principals`，只要求 `isAuthenticated()`），门是 `CREATE_OWN_AGENT`
 *       （`PermissionAtomCatalog.java:157-160` 明确写「user-level agent-principal creation with
 *       owner = actor and no Workspace binding」），UI 走 `composables/api.ts:3941` 的
 *       `createOwnAgentPrincipal`（显式空白 `X-Workspace-Id` 才落到用户门）+
 *       `AgentPrincipalsPanel.vue:59` 的原子判据。
 *       ⇒ <b>今天再拿 `G4b` 标任何入口，等于说「后端缺」而后端已经有了</b>；它留在联合类型里
 *       只为「这个码曾经指什么、为什么关掉」可查，并防别人把 `G4b` 重新赋给新缺口。</li>
 * </ul>
 *
 * <p>写新的缺口引用时：**禁止**再用不带 `a`/`b` 后缀的裸码（它曾叫 `G4`，一码两义正是 R20 的成因）；用 `G4a`/`G4b` 前先读
 * 上面两条现状，并确认 §F 没有把该条关掉。</p>
 */
export type BackendGap = "G1" | "G2" | "G3" | "G4a" | "G4b";

/**
 * 「资源」组的条目（不是配置域，走 `/settings/<name>` 或缺口说明）。
 *
 * <p>缺口项**没有 path**：点击不跳转、不给 404，弹出说明（与 mock v2 的
 * `blockedNoticeTitle/Body` 同一种做法：说明 + 不跳转 + 可关闭）。</p>
 */
export interface ResourceNavItem {
    id: string;
    labelKey: string;
    /** 该层有后端承载时给真实入口路径。 */
    path?: string;
    /** 缺口代码（空数组 = 通用缺口，audit §F 未单列，说明文字里写清缺什么）。 */
    gaps?: BackendGap[];
    /** 缺口说明 i18n key：一句话说清「缺什么 + 后端现状」。 */
    gapNoteKey?: string;
}

/**
 * PLAN-0772 M2：资源模块的左栏条目（一资源一条目，层由页内 tab 表达）。
 *
 * <p>为什么合并成一份：搬出 /settings 后，实例层与用户层的两组条目不再是「两层各自一组」，
 * 而是**同一资源的两个 tab**（凭据 3 层 / MCP 2 层 / 技能 3 层 / 智能体 2 层）。留着两份分组
 * 会让「凭据」在左栏出现两次（task-88 修掉的重名病会以另一种形式回来）。</p>
 *
 * <p>缺口资源（knowledge）**没有 path**：左栏渲染成「不可点的一行 + 虚线徽标 + title 说明」
 * （D7：留位不隐藏，由 SettingsResourceNav 负责形态）。</p>
 */
export function resourceGroups(): ResourceNavItem[] {
    return RESOURCE_DEFS.map((def) => ({
        id: def.id,
        labelKey: def.labelKey,
        path: def.gaps?.length ? undefined : resourcePath(def.id),
        gaps: def.gaps,
        gapNoteKey: def.gapNoteKey,
    }));
}

export interface SettingsNavGroup {
    id: string;
    labelKey: string;
    items: SettingsNavItem[];
}

/**
 * 实例层运维与安全两组（不属于配置域，路由是 `/settings/<name>`）。
 * 可见性在组件里按 capability/atom 过滤——本函数只给"结构"，不给"权限"。
 */
export function instanceOpsGroups(): SettingsNavGroup[] {
    return [
        {
            id: "ops",
            labelKey: "settings.ia.groupOps",
            items: [
                {
                    id: "monitoring",
                    labelKey: "settings.ia.navMonitoring",
                    path: "/settings/monitoring",
                },
                { id: "data", labelKey: "settings.ia.navData", path: "/settings/data" },
            ],
        },
        {
            id: "security",
            labelKey: "settings.ia.groupSecurity",
            items: [
                {
                    id: "config-locks",
                    labelKey: "settings.ia.navConfigLocks",
                    path: "/settings/config-locks",
                },
                { id: "roles", labelKey: "settings.ia.navRoles", path: "/settings/roles" },
                { id: "audit", labelKey: "settings.ia.navAudit", path: "/settings/audit" },
            ],
        },
    ];
}
