import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../composables/api";
import {
    ensureProviderBinding,
    type EnsureProviderBindingDeps,
} from "../composables/ensureProviderBinding";

/**
 * C1（2026-11-04 用户裁定）：发送前 provider 绑定守卫的单元契约。
 *
 * 覆盖四条：已绑定零开销放行；未绑定自动补绑（成功 → 放行 + 回调）；
 * `PROVIDER_REQUIRED`/`LLM_PROFILE_CONFLICT` → 引导（**不发消息**，不静默失败）；
 * 其它错误 fail-closed 拦下。守卫是纯函数 + 注入依赖，不碰 store/router。
 */
function problem(code: string, status = 400): ApiError {
    return new ApiError({ status, code, detail: `${code} detail`, requestId: "req-1" });
}

function deps(overrides: Partial<EnsureProviderBindingDeps> = {}): EnsureProviderBindingDeps {
    return {
        hasBinding: false,
        bindDefaults: vi.fn<EnsureProviderBindingDeps["bindDefaults"]>(async () => ({
            id: "session-1",
            title: "T",
            modelProvider: "deepseek",
            modelName: "deepseek-flash",
            providerConnectionId: "conn-1",
            connectionRevision: 2,
        })),
        onAutoBound: vi.fn<EnsureProviderBindingDeps["onAutoBound"]>(),
        onGuide: vi.fn<EnsureProviderBindingDeps["onGuide"]>(),
        onBlocked: vi.fn<EnsureProviderBindingDeps["onBlocked"]>(),
        ...overrides,
    };
}

describe("ensureProviderBinding", () => {
    it("passes a bound session through without calling the endpoint", async () => {
        const d = deps({ hasBinding: true });

        await expect(ensureProviderBinding(d)).resolves.toBe(true);

        expect(d.bindDefaults).not.toHaveBeenCalled();
        expect(d.onAutoBound).not.toHaveBeenCalled();
        expect(d.onGuide).not.toHaveBeenCalled();
    });

    it("auto-binds an unbound session and lets the send continue", async () => {
        const d = deps();

        await expect(ensureProviderBinding(d)).resolves.toBe(true);

        expect(d.bindDefaults).toHaveBeenCalledTimes(1);
        expect(d.onAutoBound).toHaveBeenCalledWith(
            expect.objectContaining({ providerConnectionId: "conn-1" }),
        );
        expect(d.onGuide).not.toHaveBeenCalled();
    });

    it("opens the guide instead of sending when CP has no default to bind", async () => {
        const d = deps({
            bindDefaults: vi.fn<EnsureProviderBindingDeps["bindDefaults"]>(async () => {
                throw problem("PROVIDER_REQUIRED");
            }),
        });

        await expect(ensureProviderBinding(d)).resolves.toBe(false);

        expect(d.onGuide).toHaveBeenCalledWith("provider_required", "PROVIDER_REQUIRED detail");
        expect(d.onAutoBound).not.toHaveBeenCalled();
        expect(d.onBlocked).not.toHaveBeenCalled();
    });

    it("maps an ambiguous connection set to the same guidance", async () => {
        const d = deps({
            bindDefaults: vi.fn<EnsureProviderBindingDeps["bindDefaults"]>(async () => {
                throw problem("PROVIDER_CONNECTION_AMBIGUOUS");
            }),
        });

        await expect(ensureProviderBinding(d)).resolves.toBe(false);
        expect(d.onGuide).toHaveBeenCalledWith(
            "provider_required",
            "PROVIDER_CONNECTION_AMBIGUOUS detail",
        );
    });

    it("distinguishes a profile conflict from a missing default", async () => {
        const d = deps({
            bindDefaults: vi.fn<EnsureProviderBindingDeps["bindDefaults"]>(async () => {
                throw problem("LLM_PROFILE_CONFLICT", 409);
            }),
        });

        await expect(ensureProviderBinding(d)).resolves.toBe(false);
        expect(d.onGuide).toHaveBeenCalledWith("profile_conflict", "LLM_PROFILE_CONFLICT detail");
    });

    it("treats a 200 without a connection as a contract break, not a silent pass", async () => {
        const d = deps({
            bindDefaults: vi.fn<EnsureProviderBindingDeps["bindDefaults"]>(async () => ({
                id: "session-1",
                title: "T",
            })),
        });

        await expect(ensureProviderBinding(d)).resolves.toBe(false);
        expect(d.onGuide).toHaveBeenCalledWith("provider_required");
        expect(d.onAutoBound).not.toHaveBeenCalled();
    });

    it("fails closed on unexpected errors so the message never hits a 409", async () => {
        const d = deps({
            bindDefaults: vi.fn<EnsureProviderBindingDeps["bindDefaults"]>(async () => {
                throw problem("WORKSPACE_READ_ONLY", 403);
            }),
        });

        await expect(ensureProviderBinding(d)).resolves.toBe(false);
        expect(d.onBlocked).toHaveBeenCalledWith(
            "WORKSPACE_READ_ONLY",
            "WORKSPACE_READ_ONLY detail",
        );
        expect(d.onAutoBound).not.toHaveBeenCalled();
        expect(d.onGuide).not.toHaveBeenCalled();
    });
});
