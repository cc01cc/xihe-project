import { beforeEach, describe, expect, it, vi } from "vitest";

import { useInstanceWriteGate } from "../useInstanceWriteGate";

/**
 * task-420（D-1254）：实例写门**三态**（外加 allowed）的判据。
 *
 * <p>缺陷复现口径与真栈探针一致（`internal/A03-xihe/evidence/2026-11-14-instance-flow-audit/`
 * 图 16-19）：投影 `GET /me/permissions` 延迟 ⇒ 加载中；abort ⇒ 读取失败。
 * 二态实现把两者都判成「缺原子」，本组用例钉住「未判定 ≠ 拒绝」。</p>
 *
 * <p>替身用 `reactive` 而不是普通对象：门是 `computed`，普通对象改了字段不会触发重算，
 * 那样「状态推进」这条判据会被静默跳过（测的是快照不是派生）。</p>
 */
interface AuthStub {
    isAuthenticated: boolean;
    hasInstanceAdminCapability: boolean;
    selfPermissionsStatus: "idle" | "loading" | "ready" | "error";
    atoms: Set<string>;
    ensureSelfPermissions: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
    hasInstanceAtom: (atom: string) => boolean;
}

const holder = vi.hoisted(() => ({ store: null as unknown as AuthStub }));

vi.mock("../../stores/auth", async () => {
    const { reactive } = await import("vue");
    const store = reactive({
        isAuthenticated: true,
        hasInstanceAdminCapability: true,
        selfPermissionsStatus: "idle",
        atoms: new Set<string>(),
        ensureSelfPermissions: vi.fn<() => Promise<boolean>>(async () => true),
        hasInstanceAtom(atom: string): boolean {
            return (this as unknown as AuthStub).atoms.has(atom);
        },
    }) as unknown as AuthStub;
    holder.store = store;
    return { useAuthStore: () => store };
});

const ATOM = "MANAGE_AGENT_PRINCIPALS";

function stub(): AuthStub {
    return holder.store;
}

describe("useInstanceWriteGate", () => {
    beforeEach(() => {
        const s = stub();
        s.isAuthenticated = true;
        s.hasInstanceAdminCapability = true;
        s.selfPermissionsStatus = "idle";
        s.atoms = new Set([ATOM]);
        s.ensureSelfPermissions.mockClear();
    });

    it("idle（投影还没开始读）⇒ loading，不是 denied", () => {
        const gate = useInstanceWriteGate(ATOM);
        expect(gate.state.value).toBe("loading");
        expect(gate.canWrite.value).toBe(false);
    });

    it("loading（投影在途）⇒ loading，不是 denied", () => {
        stub().selfPermissionsStatus = "loading";
        const gate = useInstanceWriteGate(ATOM);
        expect(gate.state.value).toBe("loading");
        expect(gate.canWrite.value).toBe(false);
    });

    it("error（投影读取失败）⇒ error，与 denied 分开（失败态要有重试出口）", () => {
        stub().selfPermissionsStatus = "error";
        const gate = useInstanceWriteGate(ATOM);
        expect(gate.state.value).toBe("error");
        expect(gate.canWrite.value).toBe(false);
    });

    it("ready 且含原子 ⇒ allowed（真管理员的正常路径）", () => {
        stub().selfPermissionsStatus = "ready";
        const gate = useInstanceWriteGate(ATOM);
        expect(gate.state.value).toBe("allowed");
        expect(gate.canWrite.value).toBe(true);
    });

    it("ready 但确实缺原子 ⇒ denied（只有这一态可以点名原子）", () => {
        stub().selfPermissionsStatus = "ready";
        stub().atoms = new Set<string>();
        const gate = useInstanceWriteGate(ATOM);
        expect(gate.state.value).toBe("denied");
        expect(gate.canWrite.value).toBe(false);
    });

    it("能力位缺失 ⇒ denied（CP 双门前半段，与投影状态无关）", () => {
        stub().hasInstanceAdminCapability = false;
        stub().selfPermissionsStatus = "ready";
        const gate = useInstanceWriteGate(ATOM);
        expect(gate.state.value).toBe("denied");
    });

    it("未登录 ⇒ loading（不冒充拒绝）", () => {
        stub().isAuthenticated = false;
        stub().selfPermissionsStatus = "ready";
        expect(useInstanceWriteGate(ATOM).state.value).toBe("loading");
    });

    it("状态推进是响应式的：error → ready+原子 ⇒ allowed（无需重建门）", async () => {
        stub().selfPermissionsStatus = "error";
        const gate = useInstanceWriteGate(ATOM);
        expect(gate.state.value).toBe("error");
        stub().selfPermissionsStatus = "ready";
        await Promise.resolve();
        expect(gate.state.value).toBe("allowed");
        expect(gate.canWrite.value).toBe(true);
    });

    it("retry 走 store 的 ensureSelfPermissions（幂等+单飞在 store，不在门里另取数）", async () => {
        stub().selfPermissionsStatus = "error";
        const gate = useInstanceWriteGate(ATOM);
        await gate.retry();
        expect(stub().ensureSelfPermissions).toHaveBeenCalledTimes(1);
    });

    it("actionAtom 原样回传（denied 文案与 CP 守卫原文对账）", () => {
        expect(useInstanceWriteGate(ATOM).actionAtom).toBe(ATOM);
    });
});
