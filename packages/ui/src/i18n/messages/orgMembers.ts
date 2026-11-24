export const messages = {
    "zh-CN": {
        orgMembers: {
            // PLAN-0773 M3（task-240）：全局模块「组织成员」读面。404 与 403 是**两个语义**：
            // 404 ORG_UNIT_NOT_FOUND = 非成员/不存在（不许说「没权限」）；403 FORBIDDEN = 缺
            // READ_ORG_UNIT_MEMBERS 原子（权限问题，明写「不是功能没提供」）。写面按钮全禁用。
            // task-509 补提交：403 卡**仍点名缺失原子**（`OrgMembersView.spec.ts` 与
            // `packages/ui/AGENTS.md` 的 atom-denied 口径都要求点名），只把内部术语换成用户话。
            title: "组织成员",
            desc: "按组织架构查看人类成员与智能体。新建、改名、搬移单元，添加或移出成员、修改角色都可以在这里完成；保存失败时会显示原因，并保留你已填写的内容。",
            // task-1010：本页不再自带「智能体主体」列表，只留一个去实例设置「平台智能体」页的入口。
            platformAgentsHint: "平台级智能体在设置里统一创建与维护：",
            searchPlaceholder: "在可见组织树内搜索名称…",
            searchEmpty: "没有命中的组织单元。",
            treeEmpty: "当前账号不在任何组织单元中，或组织树为空。",
            treeLoading: "正在加载组织树…",
            treeError: "组织树加载失败",
            retry: "重试",
            notFoundTitle: "无法查看组织单元",
            notFoundDesc: "该组织单元不存在，或当前账号不是任何单元的成员。",
            atomDeniedTitle: "缺少读取权限",
            atomDeniedDesc:
                "当前身份缺少 READ_ORG_UNIT_MEMBERS 权限原子；这是授权问题，不是功能没提供。",
            membersTitle: "单元成员",
            includeDescendants: "含子单元成员",
            /** 标签的 `title`：把「含子单元成员」扩到人话（嵌套任意层级都会算进来，不只是直接子级）。 */
            includeDescendantsTitle: "包含该单元下所有层级单元的成员",
            colName: "名称",
            colKind: "类型",
            colUnit: "所在单元",
            kindHuman: "人类",
            kindAgent: "智能体",
            selectUnit: "在左栏选择一个组织单元，查看它的成员。",
            expand: "展开下级",
            collapse: "收起下级",
            membersEmpty: "该单元没有成员。",
            membersLoading: "正在加载成员…",
            membersError: "成员列表加载失败",
            writeNewUnit: "新建子单元",
            writeRename: "改名",
            writeMove: "搬移",
            writeAddMember: "加成员",
            writeRemoveMember: "移成员",
            writeChangeRole: "改角色",
            // task-44（D-1440 / A 方案）：智能体的权限 / 技能 / 记忆都在工作区里管理 ⇒ 本页只做深链。
            // 文案纪律（Lead 2026-11-15 裁定）：**不写实现事实** —— 不出现 409、原子名、端点名、
            // 「工作区行 vs 实例行」这类我们内部怎么存的说法；用户要知道的只是"这件事在工作区里做"。
            agentOpenTitle: "在目标工作区打开",
            agentOpenDesc:
                "这个智能体的权限、技能与记忆都在具体工作区里管理；本页只负责把你送到那个工作区，不在这里重复实现。",
            agentOpenPickerLabel: "目标工作区",
            agentOpenButton: "打开智能体面板",
            agentOpenLoading: "正在读取你可以访问的工作区…",
            agentOpenError: "读取工作区列表失败，无法确定打开位置。",
            agentOpenEmpty: "你在任何工作区里都不是成员，暂时没有可打开的位置。",
            agentOpenHint:
                "落地后会自动展开这个智能体；在该工作区没有管理权限时，面板只给只读视图。",
            agentOpenCost: "这里不提供绑定操作：绑定归属取决于你打开的那个工作区。",
            detailTitle: "成员详情",
            detailDesc: "只读视图：工作区成员角色、访问角色绑定、权限可得性与所属单元。",
            detailKindLabel: "类型",
            detailIdLabel: "成员标识",
            detailUnitLabel: "所属单元",
            detailUnitCost:
                "只显示成员直接挂载的单元。往上到根单元要逐级查询（每级 1 次请求），本页不推算链路。",
            detailWorkspaceRoleTitle: "工作区成员角色",
            detailWorkspaceRoleDesc: "逐个查你可见的工作区；这不是「他属于哪些工作区」的全集。",
            detailWorkspaceRoleLoad: "查询工作区角色",
            detailWorkspaceRoleLoading: "正在查询工作区角色…",
            detailWorkspaceRoleCap:
                "已查 {checked} 个工作区（上限 {cap}）。未查的工作区不参与展示，也不代表没有角色。",
            detailWorkspaceRoleEmpty: "在你可见的工作区里没查到该成员的角色。",
            detailWorkspaceRoleError: "工作区清单读取失败，未能查询。",
            detailWorkspaceRoleDenied: "无权查看",
            detailWorkspaceRoleAgent:
                "智能体不是工作区成员，它的工作区绑定在「工作区 → 智能体」里管理。",
            detailWorkspaceRoleEditHint: "改角色在对应工作区的成员页进行；本页只读。",
            detailAccessRoleTitle: "访问角色绑定（实例级）",
            detailAccessRoleDesc: "与上面的工作区成员角色是两条不同的轴，不合并显示。",
            detailAccessRolePending: "正在读取权限投影…",
            detailAccessRoleUnread: "权限投影读取失败；这不等于没有权限，稍后重试。",
            detailAccessRoleGated: "需实例管理员：本段要求 MANAGE_ROLES 权限原子，当前身份没有。",
            detailAccessRoleLoading: "正在读取访问角色绑定…",
            detailAccessRoleEmpty: "该成员没有实例级访问角色绑定。",
            detailAccessRoleError: "访问角色绑定读取失败。",
            detailAccessRoleAgent: "智能体的访问角色绑定在工作区范围内，实例级绑定对它不适用。",
            detailAtomsTitle: "权限原子",
            detailAtomsNotShown: "他人权限不在本页展示。",
            detailAtomsWhy: "后端的权限投影只允许本人读取；本页不根据角色或绑定推断权限。",
            detailAtomsNotNoPermission: "未展示 ≠ 无权限：这里没列出的权限，可能是有的。",
            detailAtomsLink: "查看我自己的权限投影",
            detailActionsTitle: "可执行动作",
            detailActionChangeRole: "改角色",
            detailActionRemove: "移除成员",
            detailActionsBatchReason:
                "改角色与移除成员的入口在页面顶部工具条与成员行内；这里不再重复放按钮。",
            detailActionsAdminReason:
                "即使写面开放，也需在目标工作区具备管理员能力位；实例管理员覆盖全部工作区。",
            // task-136（J1/J2/J3）：写面接真实契约后的文案。服务端原文刻意不改写 ——
            // code/detail/requestId 由组件原样渲染，这里只提供标签。键名不出现在模板注释里（test-utils 裸键护栏）。
            writeHint:
                "在这里新建、改名、搬移单元，或添加、移出成员、修改角色。每次保存成功后，页面都会自动刷新为最新结果。",
            writeNeedsSelection: "先在左栏选择一个组织单元。",
            writeCancel: "取消",
            writeSubmit: "提交",
            writeBusy: "提交中…",
            writeOk: "已保存，页面已刷新。",
            writeNameLabel: "名称",
            writeParentLabel: "父单元",
            writeParentTop: "（顶层单元，没有父单元）",
            writeParentScan:
                "父单元候选只包含左栏树里已经加载过的单元；要找的单元不在列表里，先展开它的上级。",
            writeNewUnitDesc:
                "新单元挂在当前选中的单元下面。同一父单元下不能重名 —— 重名由服务端拒绝，界面不预判。",
            writeRenameDesc: "只改名称，不动成员与下级单元。",
            writeMoveDesc: "搬移会改整个子树的归属。环与越权都交给服务端判定，界面不做本地预检。",
            writeMemberKindLabel: "成员类型",
            writeSubjectLabel: "成员",
            writeSubjectSearch: "按用户名或邮箱搜索",
            writeSubjectSearching: "正在搜索…",
            writeSubjectEmpty: "没有匹配的成员。",
            writeSubjectAgents: "智能体主体列表来自当前可见的主体；看不到的主体不在这里。",
            writeSubjectPick: "请选择一个成员。",
            writeAddMemberDesc:
                "成员会被放到当前选中的单元。服务端算出受影响的工作区后，需要你确认才会真正写入。",
            writeRemoveDesc:
                "把成员从这个单元移出（成员本身不会被删除）。这一步没有反向接口，不可撤销。",
            writeConfirmMoveTitle: "这次移动会影响该成员名下的工作区",
            writeConfirmCount: "服务端原文里的数量：{count} 个工作区",
            writeConfirmCountUnknown: "服务端没有在原文里给出数量。",
            writeConfirmDetailLabel: "服务端原文",
            writeConfirmDerivedTitle: "本地能看到的 OWNER 工作区",
            writeConfirmDerivedPartial:
                "可能不全：服务端把你看不见的工作区也算进去了，这里只列出当前账号可见的那部分。",
            writeConfirmDerivedNone:
                "本地无法列出完整清单：被移动的不是你本人，目前也无法按成员反查其名下的工作区。",
            writeConfirmDerivedEmpty: "在你可见的工作区里，该成员没有任何 OWNER 工作区。",
            writeConfirmSelf:
                "被移动的就是你自己：移出后你会立刻失去这个子树的查看权限；再想搬回原单元会被拒绝（该单元不在你的管理范围内）。",
            writeConfirmMove: "确认移动",
            writeConfirmRemoveTitle: "确认把该成员移出这个单元？",
            writeConfirmRemoveSelf:
                "被移除的是你自己：移除后你会立刻失去这个子树的查看权限，而且目前无法自行恢复。",
            writeConfirmRemove: "确认移出",
            writeConfirmRemoveOther: "移出只影响这个单元的成员列表，不动成员本身的账号或角色绑定。",
            writeProblemTitle: "服务端拒绝了这次写入（原文）",
            writeProblemStatus: "HTTP",
            writeProblemCode: "code",
            writeProblemDetail: "detail",
            writeProblemRequest: "requestId",
            writeProblemNoCode: "服务端没有返回错误码（可能是网络问题或未知错误）。",
            writeRolesBaselineUnknown: "目前无法读取这个单元已绑定的角色，所以这里不显示角色列表。",
            writeRolesBaselineHint:
                "角色写入是整集覆盖：先以空集建立基线，再逐条加上；直接提交会静默清掉既有绑定。",
            writeRolesEstablish: "以空集建立基线",
            writeRolesBaseline: "本地基线：{count} 个角色",
            writeRolesEmpty:
                "角色目录里没有命中治理白名单的角色（服务端只接受 MANAGE_ORG_UNITS / MANAGE_ORG_UNIT_MEMBERS / READ_ORG_UNIT_MEMBERS 三个原子）。这是环境限制，不等于没有权限。",
            writeRolesAdd: "加上",
            writeRolesUnbind: "解绑",
            writeRolesNoCandidates: "没有可加的角色。",
            writeRolesMirror: "白名单是服务端规则的映射副本，判定仍在服务端；越界会原样返回 409。",
            writeRolesNotConfirmed: "基线未知：先按上面说的建立基线，再改角色。",
        },
    },
    "en-US": {
        orgMembers: {
            title: "Org members",
            desc: "Browse humans and agent principals by org structure. Create, rename or move units, add or remove members, and change roles here; if saving fails, the reason is shown and your input is kept.",
            // task-1010: this page no longer embeds the agent-principals list; it only links to settings.
            platformAgentsHint: "Platform-level agents are created and maintained in settings:",
            searchPlaceholder: "Search names in the visible tree…",
            searchEmpty: "No org unit matched.",
            treeEmpty: "This account belongs to no org unit, or the tree is empty.",
            treeLoading: "Loading org tree…",
            treeError: "Failed to load the org tree",
            retry: "Retry",
            notFoundTitle: "Org unit unavailable",
            notFoundDesc: "The unit does not exist, or this account is not a member of any unit.",
            atomDeniedTitle: "Missing read permission",
            atomDeniedDesc:
                "This identity lacks the READ_ORG_UNIT_MEMBERS permission atom — a permission issue, not a missing feature.",
            membersTitle: "Unit members",
            includeDescendants: "Include sub-unit members",
            includeDescendantsTitle: "Includes members of every unit nested under this one",
            colName: "Name",
            colKind: "Type",
            colUnit: "Unit",
            kindHuman: "Human",
            kindAgent: "Agent",
            selectUnit: "Select an org unit in the left column to see its members.",
            expand: "Expand sub-units",
            collapse: "Collapse sub-units",
            membersEmpty: "No members in this unit.",
            membersLoading: "Loading members…",
            membersError: "Failed to load members",
            writeNewUnit: "New sub-unit",
            writeRename: "Rename",
            writeMove: "Move",
            writeAddMember: "Add member",
            writeRemoveMember: "Remove member",
            writeChangeRole: "Change role",
            // task-44 (D-1440 / option A): an agent's permissions, skills and memory are managed
            // inside a workspace, so this page only deep-links. Same copy discipline as zh: no
            // error codes, atom names or endpoints — the user only needs "this happens in a workspace".
            agentOpenTitle: "Open in a workspace",
            agentOpenDesc:
                "This agent's permissions, skills and memory are all managed inside a specific workspace; this page only takes you there and does not duplicate them.",
            agentOpenPickerLabel: "Target workspace",
            agentOpenButton: "Open agent panel",
            agentOpenLoading: "Reading the workspaces you can access…",
            agentOpenError: "Could not list workspaces, so the target cannot be determined.",
            agentOpenEmpty:
                "You are not a member of any workspace, so there is nothing to open yet.",
            agentOpenHint:
                "The panel opens with this agent expanded; without management rights there it stays read-only.",
            agentOpenCost:
                "No binding happens here: which workspace you open decides where a binding would land.",
            detailTitle: "Member detail",
            detailDesc:
                "Read-only: workspace member role, access-role bindings, permission visibility and org unit.",
            detailKindLabel: "Kind",
            detailIdLabel: "Member id",
            detailUnitLabel: "Org unit",
            detailUnitCost:
                "Shows only the unit the member is attached to. Walking up to the root costs one request per level, so this sheet does not derive the chain.",
            detailWorkspaceRoleTitle: "Workspace member role",
            detailWorkspaceRoleDesc:
                "Probes the workspaces you can see; this is not the full set of workspaces the member belongs to.",
            detailWorkspaceRoleLoad: "Probe workspace roles",
            detailWorkspaceRoleLoading: "Probing workspace roles…",
            detailWorkspaceRoleCap:
                "Probed {checked} workspace(s) (cap {cap}). Probed-out workspaces are not shown and do not mean the member has no role there.",
            detailWorkspaceRoleEmpty:
                "No role found for this member in the workspaces you can see.",
            detailWorkspaceRoleError: "Could not read the workspace list, so nothing was probed.",
            detailWorkspaceRoleDenied: "Not permitted",
            detailWorkspaceRoleAgent:
                "An agent principal is not a workspace member; its workspace binding is managed under Workspace → Agents.",
            detailWorkspaceRoleEditHint:
                "Change the role on that workspace's members page; this sheet is read-only.",
            detailAccessRoleTitle: "Access-role bindings (instance scope)",
            detailAccessRoleDesc:
                "A different axis from the workspace member role above; the two are never merged.",
            detailAccessRolePending: "Reading the permission projection…",
            detailAccessRoleUnread:
                "Could not read the permission projection; that is not the same as having no permission. Retry later.",
            detailAccessRoleGated:
                "Requires an instance administrator: this section needs the MANAGE_ROLES permission atom, which this identity lacks.",
            detailAccessRoleLoading: "Reading access-role bindings…",
            detailAccessRoleEmpty: "This member has no instance-scope access-role binding.",
            detailAccessRoleError: "Could not read access-role bindings.",
            detailAccessRoleAgent:
                "An agent principal's access-role bindings live at workspace scope; instance-scope bindings do not apply to it.",
            detailAtomsTitle: "Permission atoms",
            detailAtomsNotShown: "Another person's permissions are not shown on this page.",
            detailAtomsWhy:
                "The backend permission projection is readable only by the subject itself; this page never infers permissions from roles or bindings.",
            detailAtomsNotNoPermission:
                "Not shown is not the same as no permission: a permission missing here may still be held.",
            detailAtomsLink: "View my own permission projection",
            detailActionsTitle: "Available actions",
            detailActionChangeRole: "Change role",
            detailActionRemove: "Remove member",
            detailActionsBatchReason:
                "Role changes and removal live in the page toolbar and on each member row; this sheet does not duplicate them.",
            detailActionsAdminReason:
                "Even once writes open, this needs an administrator capability on the target workspace; an instance administrator covers every workspace.",
            // task-136 (J1/J2/J3): copy for the write surface. The server raw text is never rewritten —
            // code/detail/requestId are rendered verbatim by the component; these are labels only.
            writeHint:
                "Create, rename or move units, add or remove members, change roles. After every successful save the page refreshes to the latest result.",
            writeNeedsSelection: "Select an org unit in the left column first.",
            writeCancel: "Cancel",
            writeSubmit: "Submit",
            writeBusy: "Submitting…",
            writeOk: "Saved; the page has been refreshed.",
            writeNameLabel: "Name",
            writeParentLabel: "Parent unit",
            writeParentTop: "(top level, no parent)",
            writeParentScan:
                "Parent candidates are limited to units already loaded in the left tree; expand a unit to make its children available.",
            writeNewUnitDesc:
                "The new unit goes under the selected unit. Sibling names must be unique — the server rejects duplicates, the UI does not pre-judge.",
            writeRenameDesc: "Renames only; members and sub-units are untouched.",
            writeMoveDesc:
                "A move rewrites the ownership of the whole subtree. Cycles and scope violations are decided by the server, not pre-checked here.",
            writeMemberKindLabel: "Member kind",
            writeSubjectLabel: "Member",
            writeSubjectSearch: "Search by username or email",
            writeSubjectSearching: "Searching…",
            writeSubjectEmpty: "No matching member.",
            writeSubjectAgents:
                "Agent principals come from the list you can currently see; invisible ones are not here.",
            writeSubjectPick: "Pick a member.",
            writeAddMemberDesc:
                "The member is placed into the selected unit. Nothing is written until you confirm the affected workspaces the server reports.",
            writeRemoveDesc:
                "Removes the member from this unit (the member itself is not deleted). There is no inverse endpoint, so this cannot be undone.",
            writeConfirmMoveTitle: "This move affects workspaces owned by the member",
            writeConfirmCount: "Count from the server raw text: {count} workspace(s)",
            writeConfirmCountUnknown: "The server did not state a count.",
            writeConfirmDetailLabel: "Server raw text",
            writeConfirmDerivedTitle: "OWNER workspaces visible locally",
            writeConfirmDerivedPartial:
                "May be incomplete: the server also counts workspaces you cannot see; only the part visible to this account is listed.",
            writeConfirmDerivedNone:
                "A full list isn't available here: the subject is not you, and workspaces cannot be looked up by member yet.",
            writeConfirmDerivedEmpty:
                "Among the workspaces you can see, this member owns no workspaces.",
            writeConfirmSelf:
                "The subject is you: after the move you immediately lose access to this subtree, and moving yourself back will be refused because the unit is outside your management scope.",
            writeConfirmMove: "Confirm move",
            writeConfirmRemoveTitle: "Remove this member from the unit?",
            writeConfirmRemoveSelf:
                "The subject is you: after removal you immediately lose access to this subtree, and you cannot restore it yourself.",
            writeConfirmRemove: "Confirm removal",
            writeConfirmRemoveOther:
                "Removal only changes this unit's member list; the member's account and role bindings are untouched.",
            writeProblemTitle: "The server rejected this write (raw text)",
            writeProblemStatus: "HTTP",
            writeProblemCode: "code",
            writeProblemDetail: "detail",
            writeProblemRequest: "requestId",
            writeProblemNoCode:
                "The server returned no error code (possibly a network problem or an unknown error).",
            writeRolesBaselineUnknown:
                "The roles bound to this unit cannot be read right now, so no role list is shown here.",
            writeRolesBaselineHint:
                "Role writes replace the whole set: establish an empty baseline first, then add one by one; submitting directly silently clears existing bindings.",
            writeRolesEstablish: "Establish empty baseline",
            writeRolesBaseline: "Local baseline: {count} role(s)",
            writeRolesEmpty:
                "No role in the catalog hits the governance whitelist (the server only accepts MANAGE_ORG_UNITS / MANAGE_ORG_UNIT_MEMBERS / READ_ORG_UNIT_MEMBERS). That is an environment limit, not a permission denial.",
            writeRolesAdd: "Add",
            writeRolesUnbind: "Unbind",
            writeRolesNoCandidates: "No role left to add.",
            writeRolesMirror:
                "The whitelist mirrors the server rule; the decision stays server-side and out-of-scope roles still return 409.",
            writeRolesNotConfirmed:
                "Baseline unknown: establish the baseline above before changing roles.",
        },
    },
};
