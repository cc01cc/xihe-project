import { ref } from "vue";
import { api, ApiError, type ApiOrgUnitMember, type ApiWorkspace } from "../../../composables/api";

/**
 * task-136（用户原话「组织也没法配置」）：组织成员页**写面**状态机。
 *
 * <p>与 {@link useOrgUnitTree} 一样按「能被单测直接驱动」划分：这里不碰 DOM，只把契约的
 * 两条实测性质如实搬上来（G1 真栈取证，
 * `internal/A03-xihe/evidence/2026-11-20-org-members-write/README.md`）：</p>
 * <ol>
 *   <li><b>确认门是「先撞 409 再确认」，不是「先查再发」</b>：`PUT /org-units/{u}/members/{m}`
 *       不带 `confirmAffected` 且这次移动会影响该主体 OWNED 的工作区时，服务端回
 *       `409 ORG_UNIT_MOVE_CONFIRMATION_REQUIRED`，人数只在 `detail` 原文里
 *       （<b>409 响应体没有 `affectedWorkspaceIds`</b>；那个字段只在 200 体里）。所以 UI 想先摆出
 *       受影响清单，唯一诚实的路径是：发一次不带 confirm 的请求 → 把 409 摊开 → 用户确认 →
 *       带 `confirmAffected:true` 原样重发。</li>
 *   <li><b>受影响集合服务端精确、UI 只能少报</b>：G1 实测 200 体给 11 个 id，而 UI 可见工作区只有
 *       5 个（CP `WorkspaceMemberService.java:282-290` 把不可见工作区也计入）。Lead 2026-11-21
 *       裁 C 方案：显示 409 `detail` 原文计数 + 本地派生名称，界面必须标注「可能不全」——
 *       <b>UI 不许假装精确</b>。</li>
 * </ol>
 *
 * <p>另两条已进卡面的实测硬事实：把自己移出当前单元后**立刻**失去该子树读面，再 PUT 回原单元会
 * 403 `org unit is outside the caller's governance scope` ⇒ 确认框必须点名这个后果；角色绑定域
 * **只有 PUT 没有 GET**（`OrgUnitController` 映射）⇒ 基线不可知，面板不许做「勾完整集再保存」
 * 的形态，逐条新增/解绑且每次都以服务端响应为新基线。</p>
 */

/** 移动成员撞到的确认门（CP code 字面量，不改写、不与其它 409 合并）。 */
export const ORG_UNIT_MOVE_CONFIRMATION_CODE = "ORG_UNIT_MOVE_CONFIRMATION_REQUIRED";

/** 治理白名单三原子（CP SSOT = `OrgUnitGovernancePolicy.java:71-72`；此处是镜像副本）。 */
export const ORG_GOVERNANCE_ATOMS: readonly string[] = [
    "MANAGE_ORG_UNITS",
    "MANAGE_ORG_UNIT_MEMBERS",
    "READ_ORG_UNIT_MEMBERS",
];

/**
 * 角色是否落在治理白名单内（原子集合 ⊆ 白名单；**无原子角色也算** —— CP
 * `isGovernanceRole` 空集 ⇒ true，OrgUnitGovernancePolicy.java:111-121）。
 *
 * <p><b>镜像不是权威</b>：判定方是 CP，越界照样 409 `ORG_SCOPE_ROLE_FORBIDDEN`（原文照显）。
 * UI 侧算一次只为少让人撞墙；原子改名会让这里退化（多滤/少滤），但**不会放宽授权**。</p>
 */
export function isOrgGovernanceRole(atoms: ReadonlyArray<{ name: string }>): boolean {
    if (atoms.length === 0) return true;
    return atoms.every((atom) => ORG_GOVERNANCE_ATOMS.includes(atom.name));
}

/** 上屏用的问题详情：`code` + `detail` + `requestId` **原文**（J2：不合并不改写）。 */
export interface OrgWriteProblemView {
    status: number;
    code: string;
    detail: string;
    requestId: string;
}

export function toOrgWriteProblem(cause: unknown): OrgWriteProblemView {
    if (cause instanceof ApiError) {
        return {
            status: cause.problem.status,
            code: cause.problem.code,
            detail: cause.problem.detail ?? cause.message,
            requestId: cause.problem.requestId,
        };
    }
    // 非 ApiError（网络断、解析炸）没有 code/requestId 可给 —— 空串上屏，不编造。
    return { status: 0, code: "", detail: String(cause), requestId: "" };
}

/**
 * 从 409 `detail` 原文取服务端计数。G1 实测句式逐字：
 * `this move affects 11 workspace(s) owned by the subject; resend with confirmAffected=true`。
 * 取不到返回 null —— 界面这时说「服务端没有给出数量」，<b>不许猜一个数</b>。
 */
export function parseAffectedWorkspaceCount(detail: string): number | null {
    const hit = /affects\s+(\d+)\s+workspace/i.exec(detail);
    return hit ? Number(hit[1]) : null;
}

/**
 * 本地派生「受影响工作区」：契约没有「按主体反查工作区」的端点，可见的只有
 * `GET /workspaces` 每行带的**调用者**角色（`ApiWorkspace.workspaceRole`）。
 *
 * <p>所以口径只能是一条：**主体 = 当前登录者**时取自己 OWNER 的可见工作区；主体是别人时
 * 本地无从派生 ⇒ 返回空清单，界面据实说「只有服务端计数，列不出清单」。宁缺勿假。</p>
 */
export function deriveAffectedWorkspaces(
    workspaces: ReadonlyArray<ApiWorkspace>,
    subjectId: string,
    callerId: string | null | undefined,
): Array<{ id: string; name: string }> {
    if (!callerId || subjectId !== callerId) return [];
    return workspaces
        .filter((ws) => ws.workspaceRole === "OWNER")
        .map((ws) => ({ id: ws.id, name: ws.name }));
}

/** 写操作种类：决定成功后重取哪些读面。 */
export type OrgWriteKind =
    | "create-unit"
    | "rename-unit"
    | "move-unit"
    | "place-member"
    | "remove-member"
    | "preset-bindings";

/** 撞开确认门后暂存的移动请求；用户确认即原样带 `confirmAffected:true` 重发。 */
export interface PendingMemberMove {
    unitId: string;
    memberId: string;
    memberKind: ApiOrgUnitMember["memberKind"];
    memberName: string;
    /** 409 `detail` 原文（逐字）。 */
    detail: string;
    /** 服务端计数；null = 原文里没解析出数字。 */
    serverCount: number | null;
    /** 本地派生的 OWNER 工作区清单（可能不全）。 */
    derived: Array<{ id: string; name: string }>;
    /** 清单是否可派生（只有「移的是我自己」这一支可以）。 */
    derivable: boolean;
    /** 移动对象是否当前登录者（决定要不要点名 403 后果）。 */
    isSelf: boolean;
    requestId: string;
}

/** 移除成员的本地确认态（DELETE 上没有 confirmAffected，后果仍不可逆 ⇒ 自己确认）。 */
export interface PendingMemberRemoval {
    unitId: string;
    memberId: string;
    memberKind: ApiOrgUnitMember["memberKind"];
    memberName: string;
    isSelf: boolean;
}

export interface UseOrgUnitWritesOptions {
    /** 写成功后回调（J5：一律重取读面，禁乐观更新）。 */
    onWritten: (kind: OrgWriteKind) => void;
    /** 当前登录者 id：判定「移/删的是不是自己」与能否本地派生。 */
    callerId: () => string | null | undefined;
}

export function useOrgUnitWrites(options: UseOrgUnitWritesOptions) {
    const busy = ref(false),
        problem = ref<OrgWriteProblemView | null>(null),
        pendingMove = ref<PendingMemberMove | null>(null),
        pendingRemoval = ref<PendingMemberRemoval | null>(null);

    /**
     * 公共一段：置忙 → 调用 → 成功回调 onWritten → 失败把问题**原文**留下。
     * 返回 `{ok, value}`：调用方据此决定关不关窗（失败一律不关，错误要留在屏幕上）。
     * `value` 只在 ok 时有意义 —— 204 的合法值就是 undefined ⇒ 用 ok 判成败，不用 value 判。
     */
    async function run<T>(
        kind: OrgWriteKind,
        fn: () => Promise<T>,
    ): Promise<{ ok: boolean; value: T | null }> {
        busy.value = true;
        problem.value = null;
        try {
            const value = await fn();
            // J5：写后重取 —— depth/hasChildren/orgUnitId 都是服务端算的，本地改副本会
            // 与懒加载缓存打架（task-43 已裁：不乐观插入）。
            options.onWritten(kind);
            return { ok: true, value };
        } catch (cause) {
            problem.value = toOrgWriteProblem(cause);
            return { ok: false, value: null };
        } finally {
            busy.value = false;
        }
    }

    function clearProblem(): void {
        problem.value = null;
    }

    function closeMemberMoveConfirmation(): void {
        pendingMove.value = null;
    }

    function closeMemberRemovalConfirmation(): void {
        pendingRemoval.value = null;
    }

    /**
     * J3 第一步：不带 `confirmAffected` 发移动。撞到
     * `409 ORG_UNIT_MOVE_CONFIRMATION_REQUIRED` **不算失败**，而是摊成确认态；
     * 其余错误照旧留原文（J2）。
     */
    async function requestMemberMove(input: {
        unitId: string;
        memberId: string;
        memberKind: ApiOrgUnitMember["memberKind"];
        memberName: string;
    }): Promise<"done" | "needs-confirmation" | "failed"> {
        busy.value = true;
        problem.value = null;
        try {
            await api.placeOrgUnitMember(input.unitId, input.memberId, input.memberKind, {
                confirmAffected: false,
            });
            // 服务端认为没有需要确认的影响面 ⇒ 直接完成（200 体里 affectedWorkspaceIds 为空数组也算答案）。
            options.onWritten("place-member");
            return "done";
        } catch (cause) {
            const view = toOrgWriteProblem(cause);
            if (view.code !== ORG_UNIT_MOVE_CONFIRMATION_CODE) {
                problem.value = view;
                return "failed";
            }
            const callerId = options.callerId();
            const isSelf = !!callerId && callerId === input.memberId;
            let derived: Array<{ id: string; name: string }> = [];
            if (isSelf) {
                try {
                    derived = deriveAffectedWorkspaces(
                        await api.listWorkspaces(),
                        input.memberId,
                        callerId,
                    );
                } catch {
                    // 清单拉不到不是失败：计数仍在 409 原文里，界面标注「可能不全」。
                    derived = [];
                }
            }
            pendingMove.value = {
                unitId: input.unitId,
                memberId: input.memberId,
                memberKind: input.memberKind,
                memberName: input.memberName,
                detail: view.detail,
                serverCount: parseAffectedWorkspaceCount(view.detail),
                derived,
                derivable: isSelf,
                isSelf,
                requestId: view.requestId,
            };
            return "needs-confirmation";
        } finally {
            busy.value = false;
        }
    }

    /** J3 第二步：确认后原样重发（不重新采集输入，避免两次输入不一致）。 */
    async function confirmMemberMove(): Promise<boolean> {
        const pending = pendingMove.value;
        if (!pending) return false;
        const { ok } = await run("place-member", () =>
            api.placeOrgUnitMember(pending.unitId, pending.memberId, pending.memberKind, {
                confirmAffected: true,
            }),
        );
        if (ok) pendingMove.value = null;
        return ok;
    }

    /** 移除成员第一步：只落确认态，不发请求。 */
    function requestMemberRemoval(input: PendingMemberRemoval): void {
        problem.value = null;
        pendingRemoval.value = input;
    }

    /** 移除成员第二步：确认后才发 DELETE。 */
    async function confirmMemberRemoval(): Promise<boolean> {
        const pending = pendingRemoval.value;
        if (!pending) return false;
        const { ok } = await run("remove-member", () =>
            api.removeOrgUnitMember(pending.unitId, pending.memberId, pending.memberKind),
        );
        if (ok) pendingRemoval.value = null;
        return ok;
    }

    return {
        busy,
        problem,
        pendingMove,
        pendingRemoval,
        clearProblem,
        closeMemberMoveConfirmation,
        closeMemberRemovalConfirmation,
        requestMemberMove,
        confirmMemberMove,
        requestMemberRemoval,
        confirmMemberRemoval,
        createUnit: (input: { name: string; parentId: string | null }) =>
            run("create-unit", () => api.createOrgUnit(input)).then((r) => r.ok),
        renameUnit: (unitId: string, name: string) =>
            run("rename-unit", () => api.renameOrgUnit(unitId, name)).then((r) => r.ok),
        moveUnit: (unitId: string, parentId: string | null) =>
            run("move-unit", () => api.moveOrgUnit(unitId, parentId)).then((r) => r.ok),
        /**
         * 治理角色整集替换。**把服务端的 roleIds 当新基线交回调用方**：契约没有 GET 读面
         * （OrgUnitController 只有 PUT），所以这一次响应体就是后续「加上/解绑」唯一起点；
         * 拿不到它就必须退回「基线未知」，不许沿用本地猜测继续叠加。
         */
        replaceRoleBindings: async (unitId: string, roleIds: string[]) => {
            const r = await run("preset-bindings", () =>
                api.replaceOrgUnitRoleBindings(unitId, roleIds),
            );
            return { ok: r.ok, roleIds: r.ok ? (r.value?.roleIds ?? []) : null };
        },
    };
}
