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

export interface PreviewPermissionAtom {
    actionClass: string;
    resource: string;
}

/**
 * 默认（授权）投影。原子名全部取自 CP 真实目录，**不许编造**：
 * - `credential_manage` = `ToolFaceRegistry.ACTION_CREDENTIAL_MANAGE`（task-249 新增，收尾 task-247 边界 ①）；
 * - 其余见 CP `PermissionAtomCatalog` / 各控制器守卫。
 */
export const PREVIEW_PERMISSION_ATOMS: readonly PreviewPermissionAtom[] = [
    { actionClass: "MANAGE_ROLES", resource: "*" },
    // PLAN-0772 M2 / 裁定三：实例智能体写面的真原子（不是 `cap:instance:admin` 特判）。
    { actionClass: "MANAGE_AGENT_PRINCIPALS", resource: "*" },
    { actionClass: "MANAGE_INSTANCE_CONFIG", resource: "*" },
    // PLAN-0766（task-160）：写入共享 workspace-default 层的唯一原子。
    { actionClass: "MANAGE_WORKSPACE_DEFAULT_CONFIG", resource: "*" },
    { actionClass: "VIEW_INSTANCE_AUDIT", resource: "*" },
    // task-167：实例层技能库写入原子（`SkillAccessGuard.canManageInstanceLibrary()` 认的就是它）。
    { actionClass: "MANAGE_SKILL_LIBRARY", resource: "*" },
    // task-284：个人技能库写入原子（`ToolFaceRegistry.ACTION_MANAGE_PERSONAL_SKILLS`）。
    // CP 侧**默认授予每个账号**（D-1019：可撤销的能力授予，不是角色判定）⇒ 夹具的"默认授权形态"
    // 必须包含它，否则预览/mock 车道看到的个人层永远是"无权态"，那是**受限形态**不是默认形态。
    { actionClass: "MANAGE_PERSONAL_SKILLS", resource: "*" },
    // task-249：凭据管理原子。登记页 `CredentialsPanel` 用它把 403 语义区分成
    // "授权问题"而不是"功能缺失"（见 `CredentialsPanel.vue` 的 canManage 判定）。
    { actionClass: "credential_manage", resource: "*" },
];

/** 受限模式下被扣留的原子（== `?denied=1` 时页面应看到的 403 形态）。 */
export const DENIED_PERMISSION_ATOMS: readonly string[] = ["credential_manage"];

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
 * `/me/permissions` 的响应体（`instanceCapabilities` 由调用方传入 —— capability 位在
 * `api-server.ts` 的 `CAPABILITIES`，避免两处各写一份）。
 */
export function mockPermissionProjection(input: { capabilities: string[]; denied: boolean }): {
    userId: string;
    instanceCapabilities: string[];
    instancePermissions: PreviewPermissionAtom[];
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
    };
}
