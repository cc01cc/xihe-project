/**
 * task-191 · mock lane 的**个人主体列表**（`GET /api/v1/agent-principals`，个人视图）。
 *
 * <p>为什么不再回空集：`{principals:[]}` 让用户层主体面板在 mock 车道**没有行可渲染** ⇒
 * 本卡新增的行内「配置」入口、以及详情抽屉的四个写分区，在浏览器车道一个都点不到（D-1281：
 * 空集不是「没有缺口」，是**看不见**缺口）。夹具按 `AgentPrincipalView` 的形状给，包含：
 * </p>
 * <ul>
 *   <li>完整文档行（hooks / contextPolicy / delegationPolicy / allowedModels 都有值）—— 抽屉里
 *       四个分区都应显示**真值**而不是占位；</li>
 *   <li>空白行（文档全 null、未禁用）—— 抽屉应显示「未设置/无订阅」，写面按钮初始 disabled；</li>
 *   <li>禁用行 —— 徽标与危险区不可再用（危险区只在未禁用时渲染）。</li>
 * </ul>
 *
 * <p>注意：`listMyAgentPrincipals` 解析器对缺席字段 fail-closed ⇒ 这里给的是**完整**形状，
 * 不要靠「省略键」表达空值（那会让 mock 掩盖真实线形的差异）。</p>
 */
export interface MockPersonalPrincipal {
    principalId: string;
    name: string;
    templateId: string | null;
    templateName: string | null;
    createdAt: string;
    /** 契约 `AgentPrincipalView.disabledAt`：**时间戳或 null，没有布尔 disabled**（panel 解析器按它推导徽标）。 */
    disabledAt: string | null;
    /** 契约字段；PLAN-0750 用户层行恒为 null（创建不写 owner_user_id），照实给。 */
    ownerUserId: string | null;
    ownership: "USER" | "INSTANCE";
    defaultModelProvider: string | null;
    defaultModelName: string | null;
    allowedModels: Array<{ provider: string; model: string }> | null;
    hooks: Record<string, unknown> | null;
    contextPolicy: Record<string, unknown> | null;
    delegationPolicy: Record<string, unknown> | null;
}

const PRINCIPALS: MockPersonalPrincipal[] = [
    {
        principalId: "9b1f5a10-0000-4000-8000-000000000101",
        name: "ResearchAgent",
        templateId: "tpl-research",
        templateName: "Researcher",
        createdAt: "2026-11-02T02:10:00Z",
        disabledAt: null,
        ownerUserId: null,
        ownership: "USER",
        defaultModelProvider: "anthropic",
        defaultModelName: "claude-sonnet-4-5",
        allowedModels: [
            { provider: "anthropic", model: "claude-sonnet-4-5" },
            { provider: "openai", model: "gpt-5.1" },
        ],
        hooks: { advisors: [{ kind: "guard", on: ["approval.ask"] }] },
        contextPolicy: { memory: { enabled: true, writeMode: "append", types: ["fact"] } },
        delegationPolicy: { maxCount: 8, maxDepth: 3 },
    },
    {
        principalId: "9b1f5a10-0000-4000-8000-000000000102",
        name: "BlankAgent",
        templateId: null,
        templateName: null,
        createdAt: "2026-11-05T09:30:00Z",
        disabledAt: null,
        ownerUserId: null,
        ownership: "USER",
        defaultModelProvider: null,
        defaultModelName: null,
        allowedModels: null,
        hooks: null,
        contextPolicy: null,
        delegationPolicy: null,
    },
    {
        principalId: "9b1f5a10-0000-4000-8000-000000000103",
        name: "RetiredAgent",
        templateId: "tpl-ops",
        templateName: "Operator",
        createdAt: "2026-10-21T03:22:00Z",
        // 已禁用行的唯一表达方式：disabledAt 有值（写布尔 disabled 是**线形错误**，
        // 契约里没有这个字段 —— 早先夹具写成 disabled:true 导致图 15 少了「已禁用」徽标）。
        disabledAt: "2026-11-10T00:00:00Z",
        ownerUserId: null,
        ownership: "USER",
        defaultModelProvider: null,
        defaultModelName: null,
        allowedModels: null,
        hooks: null,
        contextPolicy: null,
        delegationPolicy: null,
    },
];

export function mockPersonalAgentPrincipals(): MockPersonalPrincipal[] {
    return PRINCIPALS.map((row) => ({ ...row }));
}
