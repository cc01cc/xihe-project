/**
 * task-83 · 实例层 Skills 页的 mock 夹具（mock lane 专用，**不进产品代码**）。
 *
 * <p>形状严格跟 openapi `SkillView` 对齐：`required` 13 个字段一个不少，正文只在
 * `?includeBody=true` 时出现（列表接口本来就不返回 body）。这样页面在 mock lane 与真壳上的
 * 解析路径完全一致 —— 如果夹具多给一个字段、页面偷懒用了它，换真栈就会空。</p>
 *
 * <p>刻意覆盖四种展示面：①普通定义 ②`oversize` 标记（D28-15：只标记不拒绝）③`trusted`
 * 受信来源 ④带附件 + 超长正文（用来验「正文别铺满」的 `max-h` 滚动）。</p>
 */

export interface MockSkillView {
    skillId: string;
    name: string;
    /** PLAN-0772 M2：夹具要能表达**工作区层**，所以 scope 不写死成 instance。 */
    definitionScope: { type: "instance" | "workspace" | "user"; workspaceId?: string | null };
    description: string;
    bodyTokensEst: number;
    oversize: boolean;
    trusted: boolean;
    sourcePath: string;
    contentHash: string;
    version: number;
    attachments: Array<{ path: string; sizeBytes: number; sha256: string; kind: string }>;
    createdAt: string;
    updatedAt: string;
    body?: string;
}

/** 64 位 hex（openapi 用 `^[0-9a-f]{64}$` 校验，夹具不许糊弄成短串）。 */
const HASH = "a3f1c9d2b47e8065b0c4e7f2139d5a86".repeat(2);

const LONG_BODY = Array.from(
    { length: 60 },
    (_, i) =>
        `## 第 ${i + 1} 节\n\n这一节用来把正文撑长，验证展开后的容器是**限高 + 滚动**而不是把整页顶开。` +
        `每节都写两句，避免被当成占位符糊过去：技能正文是最大的列，页面上必须给它一个自己的滚动区。\n`,
).join("\n");

const BASE: ReadonlyArray<MockSkillView> = [
    {
        skillId: "skill-0001-instance-commit-msg",
        name: "commit-msg-review",
        definitionScope: { type: "instance", workspaceId: null },
        description:
            "按仓库提交规范检查 commit message：type/scope 白名单、CJK 显示宽度、必填 PLAN 引用。",
        bodyTokensEst: 412,
        oversize: false,
        trusted: false,
        sourcePath: "skills/commit-msg-review/SKILL.md",
        contentHash: HASH,
        version: 3,
        attachments: [
            {
                path: "references/types.md",
                sizeBytes: 2048,
                sha256: HASH,
                kind: "reference",
            },
        ],
        createdAt: "2026-10-28T09:12:00Z",
        updatedAt: "2026-11-12T07:41:00Z",
    },
    {
        skillId: "skill-0002-instance-ui-review",
        name: "ui-review",
        definitionScope: { type: "instance", workspaceId: null },
        description: "UI 截图审阅六维判据与 P0/P1/P2 分级；含字体、图标、对比度与半径口径。",
        bodyTokensEst: 5210,
        oversize: true,
        trusted: true,
        sourcePath: "skills/ui-review/SKILL.md",
        contentHash: HASH,
        version: 12,
        attachments: [
            { path: "references/dimensions.md", sizeBytes: 8192, sha256: HASH, kind: "reference" },
            {
                path: "references/type-scale-and-contrast.md",
                sizeBytes: 12288,
                sha256: HASH,
                kind: "reference",
            },
            {
                path: "references/component-patterns.md",
                sizeBytes: 6144,
                sha256: HASH,
                kind: "reference",
            },
        ],
        createdAt: "2026-09-30T03:00:00Z",
        updatedAt: "2026-11-12T06:05:00Z",
    },
    {
        skillId: "skill-0003-instance-fact-verification",
        name: "fact-verification",
        definitionScope: { type: "instance", workspaceId: null },
        description: "断言纪律：具体数值必须给证据等级与出处，推导值不得凭印象给出。",
        bodyTokensEst: 1870,
        oversize: false,
        trusted: true,
        sourcePath: "skills/fact-verification/SKILL.md",
        contentHash: HASH,
        version: 5,
        attachments: [],
        createdAt: "2026-08-14T10:20:00Z",
        updatedAt: "2026-11-08T12:30:00Z",
    },
    {
        skillId: "skill-0004-instance-long-body",
        name: "long-body-fixture",
        definitionScope: { type: "instance", workspaceId: null },
        description: "故意超长正文的夹具：验展开区限高滚动，也验 oversize 徽标与正文读数并存。",
        bodyTokensEst: 6400,
        oversize: true,
        trusted: false,
        sourcePath: "skills/long-body-fixture/SKILL.md",
        contentHash: HASH,
        version: 1,
        attachments: [],
        createdAt: "2026-11-11T02:00:00Z",
        updatedAt: "2026-11-11T02:00:00Z",
    },
];

/** 列表面：**不返回 body**（与 openapi `listSkills` 一致；BASE 里没有任何一条带 body）。 */
/**
 * PLAN-0772 M2：**本工作区**层的夹具（`GET /skills?definitionScope=workspace&workspaceId=`）。
 *
 * <p>为什么必须单独一组：mock 早先对 workspace 查询也回实例定义（`BASE`），页面上于是出现
 * 「4 个本工作区技能」而它们的 `skillId` 是 `skill-000N-instance-*` —— 拿实例层的数据冒充本层，
 * 正是 V11 禁的那种假象。夹具按 scope 分开回，页面才可能验到「本层只显示本层的行」。</p>
 */
const WORKSPACE_BASE: ReadonlyArray<MockSkillView> = [
    {
        skillId: "skill-ws01-repo-conventions",
        name: "repo-conventions",
        definitionScope: { type: "workspace", workspaceId: "workspace-1" },
        description: "本工作区的仓库约定：目录布局、命名与 PR 模板都在这份技能里，改约定只动它。",
        bodyTokensEst: 288,
        oversize: false,
        trusted: true,
        sourcePath: "skills/repo-conventions/SKILL.md",
        contentHash: HASH,
        version: 2,
        attachments: [],
        createdAt: "2026-11-02T03:20:00Z",
        updatedAt: "2026-11-11T08:05:00Z",
    },
    {
        skillId: "skill-ws02-release-checklist",
        name: "release-checklist",
        definitionScope: { type: "workspace", workspaceId: "workspace-1" },
        description: "本工作区的发版清单：谁批、什么顺序、失败了怎么回滚。",
        bodyTokensEst: 176,
        oversize: false,
        trusted: false,
        sourcePath: "skills/release-checklist/SKILL.md",
        contentHash: HASH,
        version: 1,
        attachments: [],
        createdAt: "2026-11-05T06:40:00Z",
        updatedAt: "2026-11-09T11:15:00Z",
    },
];

export function mockSkillDefinitions(): { items: MockSkillView[] } {
    return { items: BASE.map((skill) => ({ ...skill })) };
}

/** 本工作区层的列表面（PLAN-0772 M2：按 scope 分开回，绝不拿实例定义冒充）。 */
export function mockWorkspaceSkillDefinitions(workspaceId: string | null): {
    items: Array<Omit<MockSkillView, "body">>;
} {
    // 别的 workspace id 一律回空：本层的数据按工作区归属，夹具不跨工作区借数据。
    if (workspaceId && workspaceId !== "workspace-1") return { items: [] };
    return { items: WORKSPACE_BASE.map((skill) => ({ ...skill })) };
}

/** 详情面：`includeBody=true` 才带正文；未知 id 由调用处回 404。 */
export function mockSkillDefinition(skillId: string, includeBody: boolean): MockSkillView | null {
    const found = BASE.find((s) => s.skillId === skillId);
    if (!found) return null;
    if (!includeBody) return found;
    const body =
        found.skillId === "skill-0004-instance-long-body"
            ? LONG_BODY
            : `# ${found.name}\n\n${found.description}\n\n（夹具正文：真栈正文来自 ` +
              `POST /api/v1/skills/import 的 body 字段。）\n`;
    return { ...found, body };
}
