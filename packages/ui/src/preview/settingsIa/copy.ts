/**
 * Dev-only copy table for the settings-IA preview screens (task-44).
 *
 * Why a local table instead of product `src/i18n/index.ts`: these strings describe a
 * **proposed** information architecture that does not exist in the product yet. Putting them
 * into the product catalogue would ship preview-only copy to every user (and enlarge the
 * zh/en parity surface). The table is still locale-driven — `usePreviewCopy` resolves the
 * active locale from `useI18n()`, so switching the app language flips the preview too.
 * Promote the keys into `src/i18n/index.ts` when the IA is implemented for real.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";

const zhHans = {
    shell: {
        instanceBlock: "实例配置",
        userBlock: "用户配置",
        domains: "域",
        domainsCount: "12 个域",
        ops: "实例运维",
        opsMonitoring: "监控",
        opsData: "数据",
        security: "安全与权限",
        secLocks: "配置锁定",
        secRoles: "角色与授权",
        secAudit: "审计日志",
        userAgents: "我的智能体",
        userCredentials: "个人凭据",
        userPrefs: "偏好与语言",
        contentTitle: "实例配置 · 域",
        contentSummary: "12 个域 · 3 项被用户覆盖 · 1 项由环境变量锁定",
        openDomain: "打开域",
        coverageNote: "层徽标说明：● 工作区（覆盖）可点；实例只读；环境变量锁定不可改。",
        previewBadge: "真组件 + mock 数据",
        activeDomain: "rag",
        switchLayerHint: "作用层：工作区（本工作区覆盖实例与用户值）",
        keysUnit: "项",
        overriddenUnit: "项被覆盖",
        recentTitle: "最近变更（层归属）",
        recentHint: "每行都写清是谁在哪个层改的——覆盖关系不能只靠徽标推断。",
        recentItem1: "chunkSize 128k ← 工作区（覆盖实例 64k / 用户 96k）",
        recentItem2: "hybridAlpha 0.3 ← 用户（覆盖实例 0.5）",
        recentItem3: "由实例锁定，2 次尝试被拒",
        legendTitle: "层徽标",
        legendWorkspace: "工作区（覆盖）：可点，跳该层同一条",
        legendUser: "用户：为用户层设置，工作区可覆盖",
        legendInstance: "实例（只读）：来源不可改",
        legendEnv: "由环境变量锁定：部署期注入，UI 不可改",
    },
    domain: {
        title: "域：rag",
        summary: "9 项配置 · 3 项被跨层覆盖 · 1 项由实例锁定 · 1 项由环境变量锁定",
        effectiveOf: "生效值",
        chainTitle: "继承链",
        jumpHint: "点击层值可跳到该层同一条并高亮",
        lockedByInstance: "由实例锁定",
        lockedByEnv: "由环境变量锁定",
        readonlyHere: "实例（此处只读）",
        layerWorkspace: "工作区（覆盖）",
        layerUser: "用户",
        layerInstance: "实例（此处只读）",
        resetToInherit: "清除以继承",
        save: "保存域配置",
        located: "已定位：{key} 的{layer}层取值（{value}）",
        shortWorkspace: "工作区",
        shortUser: "用户",
        shortInstance: "实例",
        coverageTitle: "本域覆盖概览",
        coverageHint: "只读项没有保存入口；实例锁与 env 锁走不同通道。",
        coverageWorkspaceLabel: "工作区（覆盖）",
        coverageUserLabel: "用户层设置",
        coverageLockedLabel: "实例只读 / env 锁定",
        chainNote: "生效值取最高层；下层值只作展示与跳转，不因上层存在而丢失。",
        readonlyNote: "只读项没有保存入口：实例锁与 env 锁走不同通道，UI 不提供绕过（PLAN-0556）。",
    },
    agents: {
        title: "工作区设置 · 智能体绑定",
        summary: "6 个可绑定智能体 · 2 个已绑定 · 权限上限决定本工作区可用能力",
        colName: "智能体",
        colSource: "来源",
        colCap: "权限上限",
        colAction: "操作",
        sourceInstance: "来自实例",
        sourceMine: "来自我的凭据",
        bind: "绑定",
        unbind: "解绑",
        capRead: "只读",
        capWrite: "读写",
        capAdmin: "管理",
        bound: "已绑定",
        capHint: "权限上限 ≤ 账号在该智能体上的授权；超出部分不可选。",
        emptyTitle: "你还没有可绑定的智能体",
        emptyBody: "去「用户配置 → 我的智能体」创建一个，再回来绑定到本工作区。",
        emptyCta: "去创建智能体",
        emptyNote:
            "空态不是终点：指引把「谁能出现在这里」讲清楚（用户层创建的智能体 → 本工作区绑定），避免用户以为需要管理员。",
        pendingHint: "解绑不会删除智能体本身，只移除本工作区的绑定。",
        notesTitle: "绑定规则与缺权指引",
        noteSourceTitle: "来源决定可编辑性",
        noteSourceBody:
            "来自实例的智能体由管理员维护，本页只能绑定/解绑；来自我的凭据的智能体可在用户层改模型。",
        noteCapTitle: "权限上限不是新授权",
        noteCapBody: "上限只能收窄账号已有的授权，不能借绑定放大权限；超出部分下拉里直接不出现。",
        noteDeniedTitle: "缺权时给可操作出口",
        noteDeniedBody:
            "看不到某个智能体时，提示去「安全与权限 → 角色与授权」申请，而不是只显示空列表。",
    },
};

const en: PreviewCopy = {
    shell: {
        instanceBlock: "Instance configuration",
        userBlock: "User configuration",
        domains: "Domains",
        domainsCount: "12 domains",
        ops: "Instance operations",
        opsMonitoring: "Monitoring",
        opsData: "Data",
        security: "Security & permissions",
        secLocks: "Config locks",
        secRoles: "Roles & grants",
        secAudit: "Audit log",
        userAgents: "My agents",
        userCredentials: "Personal credentials",
        userPrefs: "Preferences & language",
        contentTitle: "Instance configuration · domains",
        contentSummary: "12 domains · 3 overridden by user · 1 locked by env",
        openDomain: "Open domain",
        coverageNote:
            "Layer badges: ● workspace (override) is clickable; instance is read-only; env-locked cannot change.",
        previewBadge: "real components + mock data",
        activeDomain: "rag",
        switchLayerHint: "Scope: workspace (this workspace overrides instance and user values)",
        keysUnit: "keys",
        overriddenUnit: "overridden",
        recentTitle: "Recent changes (by layer)",
        recentHint:
            "Every row says who changed what at which layer — coverage must not be inferred from badges alone.",
        recentItem1: "chunkSize 128k ← workspace (overrides instance 64k / user 96k)",
        recentItem2: "hybridAlpha 0.3 ← user (overrides instance 0.5)",
        recentItem3: "locked by instance, 2 attempts rejected",
        legendTitle: "Layer badges",
        legendWorkspace: "Workspace (override): clickable, jumps to the same key at that layer",
        legendUser: "User: set at the user layer, overridable by a workspace",
        legendInstance: "Instance (read-only): the source cannot be changed here",
        legendEnv: "Locked by env variable: injected at deploy time, not editable in the UI",
    },
    domain: {
        title: "Domain: rag",
        summary:
            "9 keys · 3 overridden across layers · 1 locked by instance · 1 locked by env variable",
        effectiveOf: "Effective",
        chainTitle: "Inheritance chain",
        jumpHint: "Click a layer value to jump to the same key in that layer and highlight it",
        lockedByInstance: "Locked by instance",
        lockedByEnv: "Locked by env variable",
        readonlyHere: "Instance (read-only here)",
        layerWorkspace: "Workspace (override)",
        layerUser: "User",
        layerInstance: "Instance (read-only here)",
        resetToInherit: "Clear to inherit",
        save: "Save domain config",
        located: "Jumped to {key} at {layer} layer (value {value})",
        shortWorkspace: "workspace",
        shortUser: "user",
        shortInstance: "instance",
        coverageTitle: "Coverage in this domain",
        coverageHint:
            "Read-only rows have no save entry; the instance lock and the env lock use different channels.",
        coverageWorkspaceLabel: "Workspace (override)",
        coverageUserLabel: "Set at user layer",
        coverageLockedLabel: "Instance read-only / env-locked",
        chainNote:
            "The effective value comes from the highest layer; lower values stay visible and jumpable.",
        readonlyNote:
            "Read-only rows have no save entry: the instance lock and the env lock use different channels and the UI offers no bypass (PLAN-0556).",
    },
    agents: {
        title: "Workspace settings · agent bindings",
        summary:
            "6 bindable agents · 2 bound · the permission cap bounds what this workspace can do",
        colName: "Agent",
        colSource: "Source",
        colCap: "Permission cap",
        colAction: "Action",
        sourceInstance: "From instance",
        sourceMine: "From my credentials",
        bind: "Bind",
        unbind: "Unbind",
        capRead: "Read-only",
        capWrite: "Read/write",
        capAdmin: "Manage",
        bound: "Bound",
        capHint: "Permission cap ≤ your grant on that agent; higher values are not selectable.",
        emptyTitle: "You have no bindable agents yet",
        emptyBody:
            "Create one in User configuration → My agents, then come back and bind it to this workspace.",
        emptyCta: "Create an agent",
        emptyNote:
            "The empty state is not a dead end: it explains who can appear here (agents created at the user layer → bound to this workspace) so users do not assume they need an admin.",
        pendingHint: "Unbinding removes this workspace's binding only; the agent itself stays.",
        notesTitle: "Binding rules and the no-permission path",
        noteSourceTitle: "Source decides what you can edit",
        noteSourceBody:
            "Instance agents are maintained by an admin; this page only binds or unbinds them. Agents from my credentials can change their model at the user layer.",
        noteCapTitle: "The cap is not a new grant",
        noteCapBody:
            "The cap can only narrow the grant you already hold; binding never widens it — higher values are absent from the picker.",
        noteDeniedTitle: "A missing agent needs an actionable exit",
        noteDeniedBody:
            "When an agent is not visible, point the user at Security & permissions → Roles & grants instead of showing an empty list.",
    },
};

type PreviewCopy = typeof zhHans;

export function usePreviewCopy() {
    const { locale } = useI18n();
    return computed<PreviewCopy>(() => (locale.value.toLowerCase().startsWith("zh") ? zhHans : en));
}
