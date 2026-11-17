/**
 * task-249：preview mock 车道的**权限投影**夹具（`GET /me/permissions` 的响应）。
 *
 * <p>为什么单独成文件：这条投影同时被两类截图依赖 ——</p>
 * <ul>
 *   <li>**正常形态**：资源区凭据页要按真实授权渲染（`credential_manage` 在册 ⇒ 列表、写入口都在）；</li>
 *   <li>**受限形态**：`settings-atom-denied` 403 卡片本身也是**真实形态之一**（CP 侧确实存在"有后端、
 *       只是没授予"的账号），所以不能因为补了原子就把这个形态从预览里删掉 —— 删掉一个真实形态
 *       和当初"造假数据面"是同一类错误。保留方式：页面 URL 带 `?denied=1` 时扣留 `credential_manage`。</li>
 * </ul>
 *
 * <p>切换判据为什么读 `Referer` 而不是页内存储：产品代码里 `/me/permissions` 的请求**不带任何参数**
 * （`api.ts` 的 `ensureSelfPermissions`），mock 层又不许改产品代码；同源 fetch 默认按
 * `strict-origin-when-cross-origin` 带完整路径 ⇒ 中间件从 `Referer` 里读页面 URL 的 `?denied=1`
 * 是唯一"零产品改动 + 用户可手动切换"的通道。另支持 env `XIHE_UI_MOCK_DENIED=1` 给脚本化跑批用。</p>
 */

import type { ApiBindingSet } from "../../../composables/api";
import { MOCK_AGENT_WORKSPACE_ID } from "./workspaceAgents";

export interface PreviewPermissionAtom {
    actionClass: string;
    resource: string;
}

/**
 * 默认（授权）投影 = **CP 固定实例管理员集**（`SystemAccessRoleCatalog.java:141-183` 的
 * `AtomRef.wildcard(...)` 清单）里 UI 真的会判的那几条。原子名全部取自 CP 真实目录，**不许编造**。
 *
 * <p><b>「不许编造」这条自 task-70 起不再是注释自律，而是机器判据</b>：
 * `__tests__/previewPermissions.spec.ts` 的「原子名必须在 CP 真实目录里」用例**读**
 * `packages/control-plane/.../policy/ToolFaceRegistry.java` 的常量声明、并核对它们都在
 * `builtinActionClasses()` 的词汇表里（那是 `GrantIntersectionEvaluator` 的校验集）。
 * 依据：注释写「不许编造」而单测只断言 `resource === "*"` 与「无重复」时，编造不会红 ——
 * 本文件此前就躺着两条 CP 全仓 0 hits 的名字（删除理由见清单下方的「task-70 删掉的两条」），
 * 同族 D-1760（观测采了没判定）。</p>
 */
export const PREVIEW_PERMISSION_ATOMS: readonly PreviewPermissionAtom[] = [
    // `ToolFaceRegistry.java:41` `ACTION_MANAGE_ROLES`（设置区「角色与绑定」面的判据）。
    { actionClass: "MANAGE_ROLES", resource: "*" },
    // PLAN-0772 M2 / 裁定三：实例智能体写面的真原子（不是 `cap:instance:admin` 特判）。
    // `ToolFaceRegistry.java:71`。
    { actionClass: "MANAGE_AGENT_PRINCIPALS", resource: "*" },
    /**
     * task-70：**实例层读面**的真原子。补它之前这条投影缺 `READ_INSTANCE_CONTENT` ⇒
     * `/settings/instance/*` 的 **14 个入口**在预览车道**全部 403`（判据
     * `views/settings/SettingsDomainView.vue:87-93` + `stores/auth.ts:136`）⇒ 这 14 页的截图
     * 自审一直做不了，是审计盲区。
     *
     * <p>依据（三处一致）：`ToolFaceRegistry.java:75` `ACTION_READ_INSTANCE_CONTENT`；
     * `SystemAccessRoleCatalog.java:165-166` 把它放进**固定实例管理员集**
     * （`AtomRef.wildcard(ACTION_READ_INSTANCE_CONTENT)`）；`ConfigController.java:89-90`
     * 的 `canReadInstanceContent()` 就是它。**动作原子，不是能力位** —— 两者互不蕴含
     * （`stores/auth.ts:90-95`）。</p>
     */
    { actionClass: "READ_INSTANCE_CONTENT", resource: "*" },
    /**
     * task-70：**实例层写面**的真原子（`ToolFaceRegistry.java:76`）。它顶替了原先被删掉的编造名
     * `MANAGE_INSTANCE_CONFIG`（删除理由见下方「task-70 删掉的两条」）—— 那条想表达的语义「能写实例配置」
     * 在 CP 侧的真名就是它：`ConfigController.java:384/:392`（PUT/DELETE `/config/instance/{domain}`）、
     * `:592`（`POST /config/import`）。`SystemAccessRoleCatalog.java:167-168` 同样把它放进了
     * 固定实例管理员集 ⇒ **实例管理员形态必须可写**，否则预览演的是「持 READ 不持 WRITE」这种
     * 管理员身上不存在的组合态（同 `?denied=1` 的取证纪律：不造 CP 里没有的形态）。
     */
    { actionClass: "WRITE_INSTANCE_CONTENT", resource: "*" },
    // PLAN-0766（task-160）：写入共享 workspace-default 层的唯一原子。`ToolFaceRegistry.java:93`。
    { actionClass: "MANAGE_WORKSPACE_DEFAULT_CONFIG", resource: "*" },
    // task-167：实例层技能库写入原子（`SkillAccessGuard.canManageInstanceLibrary()` 认的就是它）。
    // `ToolFaceRegistry.java:78`。
    { actionClass: "MANAGE_SKILL_LIBRARY", resource: "*" },
    // task-284：个人技能库写入原子（`ToolFaceRegistry.ACTION_MANAGE_PERSONAL_SKILLS`）。
    // CP 侧**默认授予每个账号**（D-1019：可撤销的能力授予，不是角色判定）⇒ 夹具的"默认授权形态"
    // 必须包含它，否则预览/mock 车道看到的个人层永远是"无权态"，那是**受限形态**不是默认形态。
    { actionClass: "MANAGE_PERSONAL_SKILLS", resource: "*" },
    // task-249：凭据管理原子。登记页 `CredentialsPanel` 用它把 403 语义区分成
    // "授权问题"而不是"功能缺失"（见 `CredentialsPanel.vue` 的 canManage 判定）。
    { actionClass: "credential_manage", resource: "*" },
];

// task-70：**从上面那份清单里删掉的两条编造名**（删掉，而不是留着改注释）。
//
// ① MANAGE_INSTANCE_CONFIG —— `grep packages/control-plane/**` 对它是 **0 hits**；UI 里也**无产品消费点**
//    （`grep src/**` 只有本夹具与单测夹具；`e2e/` 里那几处是同一批夹具的副本）。它想表达的
//    「实例层可写」由上面的 `WRITE_INSTANCE_CONTENT`（CP 真名，`ConfigController.java:384/:392/:592`
//    的守卫原子）表达 —— 不需要第二个别名。
//
// ② VIEW_INSTANCE_AUDIT —— 同样 0 hits。这条更根本的问题**不是名字编错**：审计面两个读端点的守卫
//    都是 `@PreAuthorize("isAuthenticated()")`（`audit/AuditController.java:48` 列表、`:89` 详情），
//    即 **CP 侧根本没有这个门**（UI 文档把 audit / monitoring / knowledge 归为 `no-atom` 页，见
//    `components/settings/SettingsPermissionGate.vue:13-14`）。留着它等于在夹具里**假装存在一个
//    不存在的门**，会让「audit 页为什么不需要原子」这个事实从预览里彻底消失。
//
// 两条都曾出现在 `src/stores/__tests__/authInstanceAtomScope.spec.ts` 的夹具词表里，同批按「CP 真名」
// 同步（那里也删了，理由写在该文件注释里）。机器判据见 `__tests__/previewPermissions.spec.ts`
// 的 task-70 describe：它把「名字必须在 CP 真实目录里」变成会红的断言，并把这两条写成**反例钉子**
// （`expect(DECLARED).not.toContain(...)`），防止有人把「删掉」误读成「漏配」又加回来。

/** 受限模式下被扣留的原子（== `?denied=1` 时页面应看到的 403 形态）。 */
export const DENIED_PERMISSION_ATOMS: readonly string[] = ["credential_manage"];

/**
 * task-449 / D-1287：**工作区档**授予（与上面的实例档 `*` 原子分开，不合并）。
 *
 * <p>为什么必须补：`WorkspaceAgentsPanel` 的写面判据是 `workspaceAtoms.includes('MANAGE_WORKSPACE_AGENTS')`
 * （`:178-181`），而 `workspaceAtoms` 取自本投影的 `workspaces[]`（`:262-267`）。此前 mock 只发实例档 ⇒
 * 该原子永远不在册 ⇒ 「修改上限」按钮恒禁用（`:1558`）⇒ **写回环在浏览器里根本没法验**
 * （449 的 preview e2e 第一轮实测：click 超时，元素 disabled）。这正是 D-1281 说的「空集把缺口藏起来」。</p>
 *
 * <p>原子名取自 CP 真实目录，不编造：`PermissionAtomCatalog.java:125/159`（MANAGE_WORKSPACE_AGENTS）、
 * `:173`（MEMORY_WRITE）。**resource 必须是具体 workspace UUID，禁 `*`**（管理员 Principal 授权页口径，
 * 见 `packages/ui/AGENTS.md`）——所以不能塞进上面那份实例档清单（那份的判据是 resource 全为 `*`）。</p>
 */
export const PREVIEW_WORKSPACE_ATOMS: readonly PreviewPermissionAtom[] = [
    { actionClass: "MANAGE_WORKSPACE_AGENTS", resource: MOCK_AGENT_WORKSPACE_ID },
    { actionClass: "MEMORY_WRITE", resource: MOCK_AGENT_WORKSPACE_ID },
];

/**
 * `?denied=1` 判定：从 `Referer`（页面 URL）里读 `denied`，接受 `1` / `true`。
 *
 * @param referer 请求头 `Referer`（缺失/不可解析 ⇒ 授权模式，即默认形态）
 */
export function isDeniedPreviewMode(referer: string | undefined): boolean {
    if (!referer) return false;
    let page: URL;
    try {
        page = new URL(referer);
    } catch {
        return false;
    }
    const raw = page.searchParams.get("denied");
    return raw === "1" || raw === "true";
}

/**
 * `?nonadmin=1` 判定：演**实例层非管理员**（403 视图 `SettingsForbiddenView` 的真实产品形态）。
 *
 * <p>为什么需要这条通道：该视图只在 `capabilities.isInstanceAdmin === false` 时渲染，而 mock 的
 * 能力位恒为 true ⇒ 它在 mock 车道上**没有任何可达路径**，只能靠单测证明（task-227 ⑨ 类 H-11 的
 * 截图证据就断在这里）。切换通道与 `?denied=1` 同一形状：产品代码不发参数，mock 层从 Referer
 * 读页面 URL 的查询串，零产品改动、用户可手动切换。env `XIHE_UI_MOCK_NONADMIN=1` 供脚本化跑批。</p>
 */
export function isNonAdminPreviewMode(referer: string | undefined): boolean {
    if (!referer) return false;
    let page: URL;
    try {
        page = new URL(referer);
    } catch {
        return false;
    }
    const raw = page.searchParams.get("nonadmin");
    return raw === "1" || raw === "true";
}

/**
 * `/auth/me` 的 capability 投影：非管理员预览下**摘掉 `isInstanceAdmin`**，其余能力位原样保留
 * （演的是"少一个能力位"，不是"把这个账号降成空集"——后者在 CP 里不存在）。
 */
export function mockAuthCapabilities(
    capabilities: Record<string, boolean>,
    nonAdmin: boolean,
): Record<string, boolean> {
    if (!nonAdmin) return capabilities;
    const copy = { ...capabilities };
    delete copy.isInstanceAdmin;
    return copy;
}

/**
 * `/me/permissions` 的响应体（`instanceCapabilities` 由调用方传入 —— capability 位在
 * `api-server.ts` 的 `CAPABILITIES`，避免两处各写一份）。
 */
export function mockPermissionProjection(input: { capabilities: string[]; denied: boolean }): {
    userId: string;
    instanceCapabilities: string[];
    instancePermissions: PreviewPermissionAtom[];
    /**
     * CP `CapabilityProjectionService.WorkspacePermissions`（`:77-78`）四字段原样：
     * workspaceId / workspaceRole（canonicalName）/ workspaceAdmin / permissions。
     * 角色名取自 `SystemAccessRoleCatalog.WS_OWNER`（`:52`），不自造别名。
     */
    workspaces: Array<{
        workspaceId: string;
        workspaceRole: string;
        workspaceAdmin: boolean;
        permissions: PreviewPermissionAtom[];
    }>;
} {
    const atoms = input.denied
        ? PREVIEW_PERMISSION_ATOMS.filter(
              (atom) => !DENIED_PERMISSION_ATOMS.includes(atom.actionClass),
          )
        : [...PREVIEW_PERMISSION_ATOMS];
    return {
        userId: "mock-user",
        instanceCapabilities: input.capabilities,
        instancePermissions: atoms,
        // 工作区档不受 `?denied=1` 影响：受限形态演的是**凭据** 403（DENIED_PERMISSION_ATOMS），
        // 不顺手把智能体写面也扣掉 —— 那会造出一个 CP 里不存在的组合态。
        workspaces: [
            {
                workspaceId: MOCK_AGENT_WORKSPACE_ID,
                workspaceRole: "WS_OWNER",
                workspaceAdmin: true,
                permissions: [...PREVIEW_WORKSPACE_ATOMS],
            },
        ],
    };
}

/**
 * task-54（D-1444）：`GET /bindings?scopeType=instance` 的夹具 —— 组织成员**详情抽屉段②**
 * （访问角色绑定）读的就是这条面。
 *
 * <p><b>为什么必须有</b>：在补它之前这条面**完全没有 mock** ⇒ 抽屉的 `loadAccessRoles()`
 * 拿到 `404 MOCK_ENDPOINT_MISSING` ⇒ `accessState = "error"`（`OrgMemberDetailSheet.vue:155-160`），
 * 于是卡面判据「两段角色」的段②在图上只是一段错误文案。</p>
 *
 * <p><b>为什么是两行、而且必须属于不同 subject</b>：抽屉按
 * `row.subjectId === member.memberId` 过滤（`:153`）。只有一行时「过滤生效」与「过滤失效」
 * 拍出来是同一张图 —— 夹具必须让**失效看得出来**（这也是 task-64 那条 catch-all 200 {} 的反面：
 * 那种兜底会让缺失渲染成合法空态，图被当成证据交出去）。</p>
 *
 * <p>角色名与 id **照 CP 真实种子**（`V87__dynamic_access_roles.sql:122-134`）：
 * `USER` = 实例层注册最小集（`…0003`）、`ADMIN` = 实例管理员（`…0002`），不自造别名。
 * 主体：`mock-user`（张安，当前登录账号）与 `u-lina`（有账号但**不是**本工作区成员 ⇒
 * 她的实例绑定不该出现在张安的详情里）。</p>
 */
export const MOCK_INSTANCE_BINDINGS: ApiBindingSet = {
    scopeType: "instance",
    scopeId: null,
    bindings: [
        {
            id: "rb-mock-user-user",
            subjectType: "user",
            subjectId: "mock-user",
            roleId: "00000000-0000-4000-8000-000000000003",
            roleName: "USER",
            grantedBy: null,
            grantedAt: "2026-01-01T00:00:00Z",
        },
        {
            id: "rb-u-lina-admin",
            subjectType: "user",
            subjectId: "u-lina",
            roleId: "00000000-0000-4000-8000-000000000002",
            roleName: "ADMIN",
            grantedBy: null,
            grantedAt: "2026-01-02T00:00:00Z",
        },
    ],
};
