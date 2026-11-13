import { computed, type ComputedRef } from "vue";

import { useAuthStore } from "../stores/auth";

/**
 * task-420（D-1254）：实例写面的**三态门**（原先是二态）。
 *
 * <p>缺陷形态（因果探针实测，证据 `internal/A03-xihe/evidence/2026-11-14-instance-flow-audit/`
 * 图 16-19）：写面只看 `hasInstanceAtom(atom)`，而原子投影 `GET /me/permissions` 是**异步**的。
 * 于是「还没读到」与「读失败」都被渲染成「当前账号缺动作原子 X」——
 * 真管理员（`instanceCapabilities` 含 `instance:admin`、投影里确有该原子）在加载中看到确定性拒绝，
 * 读取失败时更是**永久**禁用且原因与事实矛盾、没有重试出口。加载态 P1（自愈但误导），失败态 P0。</p>
 *
 * <p>判据分工：本 composable 只**派生状态**，不自己取数、不复制授权逻辑 ——
 * 取数与单飞仍由 `auth.ensureSelfPermissions()` 负责（CP 始终是权威）。
 * 四态里 `denied` 才是「已读到且确实缺」，只有它可以点名原子。</p>
 *
 * <p>为什么能力位 false 直接判 `denied`：`hasInstanceAdminCapability` 来自 `/auth/me` 投影，
 * 登录时即随 user 缓存落地（`stores/auth.ts` 的 `capabilities`），不是这条异步链上的一环；
 * 且消费面都在 `auth.isAuthenticated` 之后渲染。未登录一律 `loading`，不冒充拒绝。</p>
 */
export type InstanceWriteGateState = "loading" | "error" | "denied" | "allowed";

export interface InstanceWriteGate {
    /** 写门状态；只有 `allowed` 可写，只有 `denied` 可以点名缺失原子。 */
    state: ComputedRef<InstanceWriteGateState>;
    /** 等价于 `state === "allowed"`，供 `:disabled="!canWrite"` 直接使用。 */
    canWrite: ComputedRef<boolean>;
    /** 传入的动作原子名（`denied` 文案与 CP 守卫原文对账用）。 */
    actionAtom: string;
    /** 重新取投影（失败态的重试出口）；store 侧幂等 + 单飞。 */
    retry: () => Promise<boolean>;
}

export function useInstanceWriteGate(actionAtom: string): InstanceWriteGate {
    const auth = useAuthStore();

    const state = computed<InstanceWriteGateState>(() => {
        if (!auth.isAuthenticated) return "loading";
        if (!auth.hasInstanceAdminCapability) return "denied";
        const status = auth.selfPermissionsStatus;
        if (status === "ready") return auth.hasInstanceAtom(actionAtom) ? "allowed" : "denied";
        if (status === "error") return "error";
        // idle / loading：投影还没落地 —— 不是拒绝。
        return "loading";
    });

    return {
        state,
        canWrite: computed(() => state.value === "allowed"),
        actionAtom,
        retry: () => auth.ensureSelfPermissions(),
    };
}
