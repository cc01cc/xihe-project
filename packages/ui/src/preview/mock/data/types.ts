/**
 * 域内容区数据契约（task-77，Lead 定义；三方共写，字段名不得自创）。
 *
 * 硬要求（逐条对应卡 + 2026-11-11 裁定）：
 * 1. `key` 必须是真实配置键 —— 取自
 *    `packages/control-plane/src/main/resources/config-schemas/<domain>.json` 的 `properties`；
 *    后端无此键时写 `state: "gap"` 并在 `help` 里写明「后端无此键」。
 * 2. `writableAt` 由 `writableAtOf()` **推导**，作者不许手填（裁定 C：产品按层查看，
 *    单值表达不了「实例层与用户层都能改」这种两处都可写的情况）。
 * 3. `help` 回答「改这个会怎样」，不写同义反复。
 * 4. `label`/`help` 的结论性表述标来源：[裁定 …] / [文档] / [引用 …] / [推导] / [实测]。
 * 5. 字段数以**真实键数**为准，左栏 badge 由数据派生（裁定 B：不再从产品截图抄数字）。
 *
 * **规则（2026-11-11 升级）：顶层键数 ≠ 字段数，要数到叶子。**
 * 反例：`context-policy.json` 顶层只有 `defaults` 一个键，叶子却有 13 个
 * （`defaults.fingerprintEnabled` / `softThresholdPct` / … / `summaryTimeoutMs`）。
 * 反方向也有：`agent-runtime.json` 顶层 30 个键，其中一个是嵌套对象。
 * ⇒ 数键时必须展开到**叶子**，并且 `key` 写**全路径**（`defaults.xxx`），否则回不到 schema 逐字核对。
 * 下一个数键的人一定还会犯 —— 这条是给他们的。
 */

/** 字段可在哪些层写；自上而下的可写层清单。 */
export type MockLayer = "instance" | "workspace" | "user";

export interface MockField {
    /** 真实配置键，如 `chunkSize`。 */
    key: string;
    label: string;
    /** 一行说明：改这个会怎样。 */
    help?: string;
    control: "text" | "number" | "select" | "switch" | "textarea" | "secret";
    value: string | number | boolean;
    options?: string[];
    /** 由 `writableAtOf()` 推导，不手填。 */
    writableAt: MockLayer[];
    /** 仅当后端不存在该键（gap）或该层 0 项配置（unconfigured）时填。 */
    state?: "gap" | "unconfigured";
}

export interface MockGroup {
    label: string;
    fields: MockField[];
}

export interface MockPanelColumn {
    key: string;
    label: string;
}

export interface MockPanelRow {
    id: string;
    cells: Record<string, string>;
    state?: "gap" | "unconfigured";
}

/** [裁定] 专用面板域的主行动：两种形状不同，骨架必须显式区分，不能只换文案。 */
export type MockPrimaryAction = "add" | "pick";

export interface MockDomain {
    id: string;
    label: string;
    summary: string;
    /**
     * 该域的层可写性是否**只有 Set 推导、没有解析链出处**（裁定 ④ 改动 2）。
     * true ⇒ 屏上必须在域标题旁显示可见的 `[推导]` 徽标，且**不显示「继承自上层」标记**
     *（继承关系本身是猜的）。**不确定就在屏幕上说不确定，不要用排版假装确定。**
     */
    layerDerivedOnly?: boolean;
    /** [裁定 E] 专用面板域（整块编辑：列表/卡片），非表单域。 */
    layout?: "form" | "panel";
    groups: MockGroup[];
    /**
     * [裁定 E] 专用面板域的两个状态：列表态 + 详情态。
     * **只画列表态等于没画重点** —— 产品的关键恰恰是「点进去能改什么」。
     */
    panel?: {
        columns: MockPanelColumn[];
        rows: MockPanelRow[];
        /**
         * 主行动形状（默认 `add`）：
         * - `add` = 列表页右上「新增 X」，行不可选中（如 llm-provider 的提供商）
         * - `pick` = **没有新建动作**，本面板只「从候选里挑一条 + 保存/清除继承」
         *   （[源码] `embeddingProfile.ts:53-65`、`ConfigLayerPanels.vue:503`：embedding 在实例层根本不存在）
         * 形状差异还包括：行可选中态、空态文案、按钮位置。
         */
        primaryAction?: MockPrimaryAction;
        /** 列表页徽标单位（「个连接」），**数字留在外面**（[裁定 ④] 数字是派生值，不许去掉）。 */
        unit?: string;
        /**
         * 详情态动作（[裁定 ⑥]）：「保存本层」+「清除/删除」；文案按 resolveChain 分三类，
         * **explicit-only 域必须叫「删除本层副本」**（没有下一层可继承，叫「清除」会让用户以为能回退）。
         */
        actions?:
            | { save?: { label: string }; clear?: { label: string; hint: string } }
            | {
                  label: string;
                  variant?: "default" | "outline" | "ghost" | "destructive";
                  hint?: string;
              }[];
        addLabel: string;
        detail: { groups: MockGroup[]; note?: string };
    };
}

/** 域集合，逐字取自 `ConfigService.java:76-101`（[源码] 2026-11-11 核对）。 */
const EXPLICIT_ONLY_DOMAINS = new Set([
    "agent-templates",
    "context-templates",
    "api-request-templates",
]);
const WORKSPACE_WRITABLE_DOMAINS = new Set([
    "llm-provider",
    "context-policy",
    "embedding",
    "rag",
    "agent-runtime",
    "approval-policy",
    "agent-templates",
    "context-templates",
    "job-policy",
]);
const USER_WRITABLE_DOMAINS = new Set([
    "llm-provider",
    "context-policy",
    "embedding",
    "rag",
    "agent-runtime",
    "agent-profile",
    "user-preference",
    "agent-templates",
    "context-templates",
]);

/**
 * 域级解析链覆盖（2026-11-11 裁定 ④）。
 *
 * **`source` 必填、不给默认值**：可选字段等于允许留空，而留空的覆盖表和没有覆盖表一样危险，
 * 却看起来更权威。改成必填后，「没有出处」在类型层就编不过。
 */
export interface DomainResolveOverride {
    chain: MockLayer[];
    /** 文件:行 —— 不许写「看代码」「同上」「推导」。 */
    source: string;
}

/**
 * 唯一已核实的覆盖：
 * [源码] `EmbeddingProfileService.java:97-104` ——「workspace wins whole, else user; no merge」
 * ⇒ 解析链 **不读 instance**，而 embedding 同在 USER/WORKSPACE 两个 Set 里 ⇒ Set 推导会多算一层。
 */
export const RESOLVE_OVERRIDES: Record<string, DomainResolveOverride> = {
    embedding: {
        chain: ["workspace", "user"],
        source: "packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/config/EmbeddingProfileService.java:97-104",
    },
    "llm-provider": {
        chain: ["workspace", "user", "instance"],
        source: "packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/config/ConfigService.java:1152-1174",
    },
};

/** 键级例外：命中的键只能在实例层改（`INSTANCE_ONLY_KEYS`），无条件覆盖域集合。 */
const INSTANCE_ONLY_KEYS: Record<string, string[]> = {
    /**
     * [源码 ConfigService.java:99-118] 12 个键，逐字对齐 CP 的 INSTANCE_ONLY_KEYS。
     * 非实例层写入抛 ConfigAccessException（ConfigService.java:963-974）。
     *
     * **2026-11-11 修正**：这里原先只有 `instructions` 一个键，另外 11 个天花板/闸门键在屏上
     * 会显示成「三层可写」，与 CP 行为**相反**。发现者是 agent-runtime 数据的 subagent
     * （他按纪律没有手填 writableAt、也没有自建覆盖表，而是把缺陷报上来 —— 做法正确）。
     *
     * 注意：本表仍是**手抄镜像**，与 `STORES` 那三张域集合表同病。真正的解法是让层可写性
     * 由契约声明（OpenAPI 域枚举 + 层矩阵），见 Q-1111-22 的设计建议；本文件只是过渡。
     */
    "agent-runtime": [
        "instructions",
        "runMaxTurnsCeiling",
        "runMaxElapsedSecondsCeiling",
        "runMaxTokensCeiling",
        "loopRepeatEscalateCeiling",
        "loopErrorRunEscalateCeiling",
        "loopStaleResultEscalateCeiling",
        "loopWindowSizeCeiling",
        "wakeChainMaxDepth",
        "maxConcurrentRunsPerSession",
        "delegationMaxCountCeiling",
        "delegationMaxDepthCeiling",
    ],
};

/**
 * `writableAt` 的**唯一推导入口**：三方都不许手填，一律调它。
 *
 * 顺序：键级例外 → 域级 resolveChain 覆盖（**只许收紧**）→ Set 推导。
 * 覆盖表若比 Set 宽 ⇒ **直接抛错**：那意味着 CP 的 Set 漏了，是 CP 的缺陷，得报，不许 mock 悄悄修正。
 */
export function writableAtOf(domain: string, key: string): MockLayer[] {
    if (INSTANCE_ONLY_KEYS[domain]?.includes(key)) return ["instance"];
    const override = RESOLVE_OVERRIDES[domain];
    if (override) {
        const bySet = setWritableAtOf(domain);
        const wider = override.chain.filter((item) => !bySet.includes(item));
        if (wider.length > 0) {
            throw new Error(
                `[契约] ${domain} 的 resolveChain 比可写集合更宽（${wider.join(",")}）：Set 漏了层，属 CP 缺陷，不许 mock 修正（${override.source}）`,
            );
        }
        return override.chain;
    }
    return setWritableAtOf(domain);
}

/** 纯 Set 推导（不读覆盖表）——用于校验覆盖表是否「只收紧」。 */
export function setWritableAtOf(domain: string): MockLayer[] {
    // explicit-only 域：每层各存一份，不继承 —— 三层都"可写"，但没有合并语义。
    if (EXPLICIT_ONLY_DOMAINS.has(domain)) return ["instance", "workspace", "user"];
    const layers: MockLayer[] = ["instance"];
    if (WORKSPACE_WRITABLE_DOMAINS.has(domain)) layers.push("workspace");
    if (USER_WRITABLE_DOMAINS.has(domain)) layers.push("user");
    return layers;
}
