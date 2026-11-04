import { ApiError, type ApiSession } from "../../../../composables/api";

/**
 * C1（2026-11-04 用户裁定）：发送前的 provider 绑定守卫。
 *
 * 用户裁定「会话 UI 不绑定模型，至多绑定默认 agent 主体」，但 CP 对裸会话是
 * fail-closed 的（`POST /chat` → `409 PROVIDER_REQUIRED`，task-24 起裸会话不再允许
 * 创建，但旧会话仍在）。所以发送路径必须在**发送前**检查会话行的绑定：
 *
 * - 已绑定 ⇒ 直接放行（正常路径零开销，不打网络）；
 * - 未绑定 ⇒ 调 CP 的权威补绑端点 `POST /sessions/{id}/bind-defaults`：
 *   - 成功 ⇒ 回调 `onAutoBound`（更新 store + toast「已自动绑定 …」）并放行；
 *   - `PROVIDER_REQUIRED` / `PROVIDER_CONNECTION_AMBIGUOUS`（没有模型身份可解析）或
 *     `LLM_PROFILE_CONFLICT` ⇒ 回调 `onGuide` 打开引导弹窗，**不发消息**（不静默失败）；
 *   - 其它错误 ⇒ 回调 `onBlocked` toast 并拦下（fail-closed：宁可不发，也不发出去撞 409）。
 *
 * 方案 A（Lead 批准）：自动绑只覆盖"有模型身份"的情形；无模型身份 ⇒ 引导去设置。
 * 本文件是纯函数 + 注入依赖，不碰 store / router，便于单测。
 */
export type ProviderBindingGuideReason = "provider_required" | "profile_conflict";

/** CP `Session` returned by `bind-defaults` — enough identity to land it in the store. */
export type AutoBoundSession = Pick<ApiSession, "id" | "title"> & {
    modelProvider?: string;
    modelName?: string;
    providerConnectionId?: string;
    connectionRevision?: number;
};

export interface EnsureProviderBindingDeps {
    /** 会话行是否真的绑了（只认 `providerConnectionId`，与 `modelDisplay` 同口径）。 */
    hasBinding: boolean;
    bindDefaults: () => Promise<AutoBoundSession>;
    onAutoBound: (session: AutoBoundSession) => void;
    onGuide: (reason: ProviderBindingGuideReason, detail?: string) => void;
    onBlocked: (code: string, detail?: string) => void;
}

/** Returns true when the message may be sent. */
export async function ensureProviderBinding(deps: EnsureProviderBindingDeps): Promise<boolean> {
    if (deps.hasBinding) return true;
    try {
        const bound = await deps.bindDefaults();
        if (!bound.providerConnectionId) {
            // 端点 200 却没给连接：契约破坏，走引导而不是把裸会话发出去。
            deps.onGuide("provider_required");
            return false;
        }
        deps.onAutoBound(bound);
        return true;
    } catch (cause) {
        const code = cause instanceof ApiError ? cause.problem.code : undefined;
        const detail =
            cause instanceof ApiError ? (cause.problem.detail ?? cause.message) : String(cause);
        if (code === "PROVIDER_REQUIRED" || code === "PROVIDER_CONNECTION_AMBIGUOUS") {
            deps.onGuide("provider_required", detail);
            return false;
        }
        if (code === "LLM_PROFILE_CONFLICT") {
            deps.onGuide("profile_conflict", detail);
            return false;
        }
        deps.onBlocked(code ?? "BIND_FAILED", detail);
        return false;
    }
}
