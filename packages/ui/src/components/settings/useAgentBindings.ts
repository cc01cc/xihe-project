import { computed, ref } from "vue";
import { api, ApiError, type AgentRoleBinding, type ApiWorkspace } from "../../composables/api";

/**
 * task-153 S1：agent 主体 × 工作区绑定的读面与写面（从 `AgentPrincipalsPanel.vue` 搬出来）。
 *
 * <p>搬的是**判据**不是样式 —— 下面三条都是既有面的既有结论，本文件不重写规则：</p>
 *
 * <ul>
 *   <li><b>能不能管</b>：实例级持 {@link MANAGE_AGENTS_ATOM} ⇒ 每个工作区都能管；否则只看该工作区那一行。
 *       这是照抄 CP `holdsActionAtom(atom, workspaceId)` 的「实例行 ∪ 该工作区行」，不引入第二套规则。</li>
 *   <li><b>读不到 ≠ 没绑</b>：某个工作区的 `GET /agents` 失败时，那一行的 {@link WorkspaceBindingView.bound}
 *       是 `null`（不知道），不是 `false`。旧面在 catch 里什么都不做，宁可少显示也不编造。</li>
 *   <li><b>写后重取</b>：旧面绑定成功后往本地 `bindings` 里 push 名字（乐观更新）；本文件不沿用 ——
 *       J5 要求一律重取读面，标记与 `capSource` 只认 CP 回包。</li>
 * </ul>
 */

/** CP 授权原子名（判据是原子，不是角色名）。 */
export const MANAGE_AGENTS_ATOM = "MANAGE_WORKSPACE_AGENTS";

/** `loading` = 能力投影还没回来 ⇒ 调用方必须禁用入口，但**不许**说"你没权限"。 */
export type AgentBindingsCapabilityState = "loading" | "ready" | "failed";
export type AgentBindingsReadState = "idle" | "loading" | "ready";
/**
 * 工作区清单读面状态（task-41）。与能力投影分开记：清单读失败**不许**降级成「空清单」——
 * 空清单在界面上等于「没有可管理工作区」，而读失败只说明「这次没读成」。
 */
export type AgentBindingsWorkspacesState = "loading" | "ready" | "failed";

/**
 * 一行「该主体 × 一个可管理工作区」。
 *
 * <p>`bound`：`true` = CP 列表里出现了这个主体（行存在即属于该工作区 —— 工作区级角色绑定也能让
 * 未绑 cap 的行可见，与旧面口径一致）；`false` = 列表读到了但没有这一行；`null` = 这次读失败，
 * **不许降级成 false**。</p>
 */
export interface WorkspaceBindingView {
    workspaceId: string;
    workspaceName: string;
    bound: boolean | null;
    isDefault: boolean;
    capSource: "baseline" | "explicit" | null;
}

/**
 * 角色读面状态。
 *
 * <p><b>四态必须分明</b>（Lead 2026-11-21 10:55 与 task-219 同口径）：`ready` + 空数组 = 真的没有角色；
 * `not-found` = 404 读不到（`AGENT_PRINCIPAL_NOT_FOUND`，code 要透出）；`failed` = 网络/5xx 等
 * 读失败。**三者不许画成同一个空态** —— 抽屉侧 `apd-roles-none`/`apd-roles-empty` 被拆开也是
 * 这同一条判据，面板侧不得再造一个合并灰态。</p>
 */
export type AgentRolesReadState = "idle" | "loading" | "ready" | "not-found" | "failed";

/**
 * 一个工作区里该主体绑定的角色（`GET /agent-principals/{pid}/roles?workspaceId=`）。
 *
 * <p>只对已绑行读；读失败保留原始 `cause`，由调用方交给 `presentCauseError` 转成文案 ——
 * 404 `AGENT_PRINCIPAL_NOT_FOUND` 必须显示 code 原文，不能写成「没有角色」。</p>
 */
export interface WorkspaceRolesView {
    workspaceId: string;
    state: AgentRolesReadState;
    roles: AgentRoleBinding[];
    cause: unknown;
}

export interface UseAgentBindingsOptions {
    /** 当前展示绑定的主体 id；返回 null = 还没选中主体。 */
    principalId: () => string | null;
}

interface BindingRow {
    bound: boolean | null;
    isDefault: boolean;
    capSource: "baseline" | "explicit" | null;
}

export function useAgentBindings(options: UseAgentBindingsOptions) {
    const capabilityState = ref<AgentBindingsCapabilityState>("loading");
    const instanceAtoms = ref<string[]>([]);
    const workspaceAtoms = ref<Record<string, string[]>>({});
    const workspaces = ref<ApiWorkspace[]>([]);
    /** 清单读面状态与原始 cause：`failed` 时面板要说「读不到」并给重试，不能说「没权限」。 */
    const workspacesState = ref<AgentBindingsWorkspacesState>("loading");
    const workspacesCause = ref<unknown>(null);
    const readState = ref<AgentBindingsReadState>("idle");
    const rows = ref<Record<string, BindingRow>>({});
    /** 这次读失败的可管理工作区（`bound` 为 null 的那些）。 */
    const unreadableWorkspaces = ref<string[]>([]);
    const busyWorkspaces = ref<string[]>([]);
    /** 每工作区角色读面（S2）；键只在已绑行出现，其余走 `idle` 默认值。 */
    const roleRows = ref<Record<string, WorkspaceRolesView>>({});
    /** 写面失败的原始 cause —— 由调用方用 `presentCauseError` 转文案，本文件不拼错误串。 */
    const lastCause = ref<unknown>(null);

    function canManageAgentsIn(workspaceId: string): boolean {
        if (instanceAtoms.value.includes(MANAGE_AGENTS_ATOM)) return true;
        return (workspaceAtoms.value[workspaceId] ?? []).includes(MANAGE_AGENTS_ATOM);
    }

    const manageableWorkspaces = computed<ApiWorkspace[]>(() =>
        workspaces.value.filter((workspace) => canManageAgentsIn(workspace.id)),
    );

    /**
     * `null` = 判据还没齐（能力投影未回，**或**工作区清单未回/读失败）⇒ 调用方禁用但不说"你没权限"。
     *
     * <p>清单未回也算 `null`：`manageableWorkspaces` 依赖 `workspaces`，清单 pending 时它是空数组，
     * 此时若返回 `false`，界面就把「还不知道」画成「没有可管理的工作区」（task-41 的竞态根因）。</p>
     */
    const canManage = computed<boolean | null>(() => {
        if (capabilityState.value !== "ready") return null;
        if (workspacesState.value !== "ready") return null;
        return manageableWorkspaces.value.length > 0;
    });

    const bindingViews = computed<WorkspaceBindingView[]>(() =>
        manageableWorkspaces.value.map((workspace) => {
            const row = rows.value[workspace.id];
            return {
                workspaceId: workspace.id,
                workspaceName: workspace.name || workspace.id,
                // null ≠ 未绑定，见 task-153 裁定：注意不能写 `row?.bound ?? false` ——
                // 读面失败那一行 `bound` 就是 null，`??` 会把它翻成 false（"不知道"被说成"没绑"），
                // 这条被单测 `useAgentBindings.spec.ts` 的「单工作区 403 ⇒ bound null」用例照出来过。
                bound: row ? row.bound : false,
                isDefault: row?.isDefault ?? false,
                capSource: row?.capSource ?? null,
            };
        }),
    );

    function isBusy(workspaceId: string): boolean {
        return busyWorkspaces.value.includes(workspaceId);
    }

    function clearCause() {
        lastCause.value = null;
    }

    /**
     * 能力投影 + 工作区清单（fail-closed）。
     *
     * <p>原子读失败 ⇒ `failed` 并 return：不显示写入口，也不断言"你没权限"（读失败证明不了权限）。
     * 清单读失败 ⇒ `workspacesState = "failed"` 并保留原始 cause（面板据此显示「读不到」+ 重试）——
     * **不再**把清单置空：空清单会把读失败画成「没有可管理的工作区」，正是 task-41 的第二处缺口。</p>
     *
     * <p>顺序约束：`capabilityState` 只在**清单也回来之后**才置 `ready`。提前置 ready 会让
     * `canManage` 在清单 pending 期间算出 `false`（而不是 `null`），面板就会在清单回来前先落「没权限」空态。</p>
     */
    async function loadCapability(): Promise<void> {
        capabilityState.value = "loading";
        workspacesState.value = "loading";
        workspacesCause.value = null;
        try {
            const self = await api.getSelfPermissions();
            instanceAtoms.value = (self.instancePermissions ?? []).map((atom) => atom.actionClass);
            const atomsByWorkspace: Record<string, string[]> = {};
            for (const workspace of self.workspaces ?? []) {
                atomsByWorkspace[workspace.workspaceId] = (workspace.permissions ?? []).map(
                    (atom) => atom.actionClass,
                );
            }
            workspaceAtoms.value = atomsByWorkspace;
            // 投影读到了，但**这里先不置 ready**（Lead 2026-11-21 裁定 A：先取数、后置 ready）。
        } catch {
            capabilityState.value = "failed";
            return;
        }
        try {
            workspaces.value = await api.listWorkspaces();
            workspacesState.value = "ready";
        } catch (cause) {
            workspacesCause.value = cause;
            workspacesState.value = "failed";
        }
        // 两轴都取完才置 ready。清单失败也从这里走：投影本身是读到了的，
        // 失败记在 workspacesState 上（界面据此显示「读不到清单」+ 重试，而不是永远 loading）。
        capabilityState.value = "ready";
    }

    /**
     * 逐工作区读「这个主体在不在」。
     *
     * <p>用 `Promise.all` 而不是串行：可管理工作区通常个位数，串行会让首屏按工作区数线性变慢。
     * 单点失败只把那一行标成 `null`（{@link unreadableWorkspaces}），不影响其它行。</p>
     */
    async function loadBindings(): Promise<void> {
        const principalId = options.principalId();
        readState.value = "loading";
        const nextRows: Record<string, BindingRow> = {};
        const failed: string[] = [];
        if (principalId) {
            await Promise.all(
                manageableWorkspaces.value.map(async (workspace) => {
                    try {
                        const list = await api.getWorkspaceAgents(workspace.id);
                        const row = list.find((candidate) => candidate.principalId === principalId);
                        nextRows[workspace.id] = row
                            ? {
                                  bound: true,
                                  isDefault: row.isDefault === true,
                                  capSource: row.capSource ?? null,
                              }
                            : { bound: false, isDefault: false, capSource: null };
                    } catch {
                        failed.push(workspace.id);
                        nextRows[workspace.id] = { bound: null, isDefault: false, capSource: null };
                    }
                }),
            );
        }
        rows.value = nextRows;
        // 主体或读面可能已变：先清掉上一次的角色记录，避免旧主体的角色挂在同名工作区上。
        roleRows.value = {};
        // S2：角色只跟已绑行走（`bound: null` 是读失败、`false` 是未绑，两者都不发角色请求）。
        await Promise.all(
            Object.entries(nextRows)
                .filter(([, row]) => row.bound === true)
                .map(([workspaceId]) => loadRoles(workspaceId)),
        );
        unreadableWorkspaces.value = failed;
        readState.value = "ready";
    }

    /** 一个工作区的角色读面；没有记录 = `idle`（未发起 / 未绑行）。 */
    function rolesFor(workspaceId: string): WorkspaceRolesView {
        return (
            roleRows.value[workspaceId] ?? {
                workspaceId,
                state: "idle",
                roles: [],
                cause: null,
            }
        );
    }

    /**
     * 读一个工作区里该主体的角色（S2）。
     *
     * <p>失败保留原始 cause 而不是折叠成空数组：空数组在界面上等于「没有角色」，
     * 而 404 `AGENT_PRINCIPAL_NOT_FOUND` 表示**读不到**，两者不能混（卡面 S2 反）。</p>
     */
    async function loadRoles(workspaceId: string): Promise<void> {
        const principalId = options.principalId();
        if (!principalId) return;
        roleRows.value = {
            ...roleRows.value,
            [workspaceId]: { workspaceId, state: "loading", roles: [], cause: null },
        };
        try {
            const roles = await api.getAgentRoles(workspaceId, principalId);
            roleRows.value = {
                ...roleRows.value,
                [workspaceId]: { workspaceId, state: "ready", roles, cause: null },
            };
        } catch (cause) {
            // 404 与 5xx/网络分开：前者是「这个工作区下读不到这个主体」，后者是「这次没读成」。
            const notFound =
                cause instanceof ApiError &&
                (cause.problem.status === 404 ||
                    cause.problem.code === "AGENT_PRINCIPAL_NOT_FOUND");
            roleRows.value = {
                ...roleRows.value,
                [workspaceId]: {
                    workspaceId,
                    state: notFound ? "not-found" : "failed",
                    roles: [],
                    cause,
                },
            };
        }
    }

    /**
     * 设为 / 取消工作区默认智能体（`PUT|DELETE /workspaces/{ws}/agents/{pid}/default`，S2）。
     *
     * <p>只对已绑行可点：未绑行设默认没有语义（CP 会 404），前端不发注定失败的请求。
     * 成功后同样重取读面 —— 默认标记只认 CP 回包，不本地改 `isDefault`。</p>
     */
    async function setDefault(workspaceId: string, makeDefault: boolean): Promise<boolean> {
        const principalId = options.principalId();
        if (!principalId) return false;
        if (!canManageAgentsIn(workspaceId)) return false;
        if (rows.value[workspaceId]?.bound !== true) return false;
        if (isBusy(workspaceId)) return false;
        busyWorkspaces.value = [...busyWorkspaces.value, workspaceId];
        lastCause.value = null;
        try {
            if (makeDefault) {
                await api.setWorkspaceAgentDefault(workspaceId, principalId);
            } else {
                await api.clearWorkspaceAgentDefault(workspaceId, principalId);
            }
            await loadBindings();
            return true;
        } catch (cause) {
            lastCause.value = cause;
            return false;
        } finally {
            busyWorkspaces.value = busyWorkspaces.value.filter((id) => id !== workspaceId);
        }
    }

    /** 首次进入：能力 → 清单 → 绑定。三步串行是有意的（后者依赖前者的可管理集）。 */
    async function load(): Promise<void> {
        await loadCapability();
        // 判据没齐就不读绑定：清单读失败时读绑定等于拿空候选集发请求，而 `readState = ready`
        // 会让面板把「没读成」看成「读完了、什么都没有」（task-41）。
        if (capabilityState.value !== "ready" || workspacesState.value !== "ready") return;
        await loadBindings();
    }

    /**
     * 绑定 / 解绑一个工作区。
     *
     * <p>绑定沿用既有面的写入形态：`PUT /workspaces/{ws}/agents/{pid}` 带**显式零 cap**（`[]`）——
     * 绑定只表示"这个主体属于该工作区"，提权仍在主体权限面里做，本入口不代劳。</p>
     */
    async function setBound(workspaceId: string, bound: boolean): Promise<boolean> {
        const principalId = options.principalId();
        if (!principalId) return false;
        // 前端不复制授权判据，但也不发一条注定 403 的请求（候选集外的行本来就不该出现）。
        if (!canManageAgentsIn(workspaceId)) return false;
        if (isBusy(workspaceId)) return false;
        busyWorkspaces.value = [...busyWorkspaces.value, workspaceId];
        lastCause.value = null;
        try {
            if (bound) {
                await api.updateWorkspaceAgentCap(workspaceId, principalId, []);
            } else {
                await api.deleteWorkspaceAgent(workspaceId, principalId);
            }
            await loadBindings();
            return true;
        } catch (cause) {
            lastCause.value = cause;
            return false;
        } finally {
            busyWorkspaces.value = busyWorkspaces.value.filter((id) => id !== workspaceId);
        }
    }

    return {
        capabilityState,
        workspacesState,
        workspacesCause,
        readState,
        workspaces,
        manageableWorkspaces,
        canManage,
        canManageAgentsIn,
        bindingViews,
        unreadableWorkspaces,
        lastCause,
        clearCause,
        isBusy,
        rolesFor,
        loadRoles,
        setDefault,
        load,
        loadBindings,
        setBound,
    };
}
