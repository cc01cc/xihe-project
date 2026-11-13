import type { ApiOrgUnitMember, ApiOrgUnitNode } from "../../../composables/api";

/**
 * PLAN-0773 M3（task-240）：组织单元 mock 夹具（真页面 + mock 数据预览用）。
 *
 * <p>这里同时钉住三件在真契约里容易造错的事（卡面 ⑥ 的反例守卫）：</p>
 * ① `orgUnitId` 是**成员实际所在单元**，不是父单元 —— 三个成员分别落在三个不同单元，
 *    任何"照抄父单元 id"的填法都会让页面显示错名字（单测 `OrgMembersView.spec` 同款断言）；
 * ② `hasChildren` 与真实子集一致（有子级才是 true），懒加载据此决定要不要发请求；
 * ③ 成员视图**不带角色/权限**（契约 :6129）—— 夹具不造 role 字段，页面也就不该有角色列。
 */
export const MOCK_ORG_UNITS: ApiOrgUnitNode[] = [
    { id: "ou-rd", name: "研发部", parentId: null, depth: 0, hasChildren: true },
    { id: "ou-platform", name: "平台组", parentId: "ou-rd", depth: 1, hasChildren: true },
    { id: "ou-storage", name: "存储组", parentId: "ou-platform", depth: 2, hasChildren: false },
    { id: "ou-frontend", name: "前端组", parentId: "ou-rd", depth: 1, hasChildren: false },
    { id: "ou-data", name: "数据部", parentId: null, depth: 0, hasChildren: true },
    { id: "ou-analytics", name: "分析组", parentId: "ou-data", depth: 1, hasChildren: false },
];

export const MOCK_ORG_UNIT_MEMBERS: ApiOrgUnitMember[] = [
    { memberKind: "human", memberId: "mock-user", orgUnitId: "ou-rd", displayName: "张安" },
    { memberKind: "human", memberId: "u-lifeng", orgUnitId: "ou-storage", displayName: "李风" },
    { memberKind: "human", memberId: "u-wangqi", orgUnitId: "ou-platform", displayName: "王琦" },
    {
        memberKind: "agent_principal",
        memberId: "ap-codebot",
        orgUnitId: "ou-platform",
        displayName: "代码智能体",
    },
    {
        memberKind: "agent_principal",
        memberId: "ap-analyst",
        orgUnitId: "ou-analytics",
        displayName: "分析智能体",
    },
];

/** 该单元在树里的全部后代 id（`includeDescendants=true` 用它过滤；Mock 无 DB，纯函数足够）。 */
export function mockOrgUnitDescendants(unitId: string): string[] {
    const out: string[] = [unitId];
    let frontier = [unitId];
    while (frontier.length > 0) {
        const next: string[] = [];
        for (const parentId of frontier) {
            for (const unit of MOCK_ORG_UNITS) {
                if (unit.parentId === parentId) next.push(unit.id);
            }
        }
        out.push(...next);
        frontier = next;
    }
    return out;
}

/** mock 侧名搜：与契约同义 —— 只按名字匹配（服务端忽略 parentId）。 */
export function mockOrgUnitSearch(q: string): ApiOrgUnitNode[] {
    const needle = q.trim();
    return needle ? MOCK_ORG_UNITS.filter((unit) => unit.name.includes(needle)) : MOCK_ORG_UNITS;
}
