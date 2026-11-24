/* task-1032：自 composables/api.ts 拆出的 _core 段（逐字节搬运）。 */
import { clearTabWorkspace, readTabWorkspaceId } from "../../lib/workspaceContext";
import type { ProblemDetails } from "./_types";
export const API_BASE = "/api/v1";
export class ApiError extends Error {
    public readonly problem: ProblemDetails;
    public readonly retryAfterSeconds?: number;

    constructor(problem: ProblemDetails, retryAfterSeconds?: number) {
        super(problem.detail || problem.code || `API error ${problem.status}`);
        this.name = "ApiError";
        this.problem = problem;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}
export function endpoint(path: string): string {
    return path.startsWith("/api/v1/") || path.startsWith("/internal/v1/")
        ? path
        : `${API_BASE}${path}`;
}
export function apiAuthHeaders(
    headers?: HeadersInit,
    includeContentType = true,
): Record<string, string> {
    const result: Record<string, string> = {};
    if (headers instanceof Headers)
        headers.forEach((value, key) => {
            result[key] = value;
        });
    else if (Array.isArray(headers))
        headers.forEach(([key, value]) => {
            result[key] = value;
        });
    else Object.assign(result, headers ?? {});
    const token = localStorage.getItem("xihe-token");
    if (token) result.Authorization = `Bearer ${token}`;
    // PLAN-0559: every workspace-scoped request carries the tab workspace. An
    // explicit caller header wins (case-insensitive) over this default.
    const hasWorkspaceHeader = Object.keys(result).some(
        (key) => key.toLowerCase() === "x-workspace-id",
    );
    if (!hasWorkspaceHeader) {
        const workspaceId = readTabWorkspaceId();
        if (workspaceId) result["X-Workspace-Id"] = workspaceId;
    }
    if (includeContentType && !result["Content-Type"]) result["Content-Type"] = "application/json";
    return result;
}
export async function apiErrorFromResponse(res: Response): Promise<never> {
    let problem: Partial<ProblemDetails> = {};
    try {
        problem = (await res.json()) as Partial<ProblemDetails>;
    } catch {
        /* non-JSON upstream error */
    }
    const retryAfterHeader = res.headers?.get?.("Retry-After");
    const retryAfterHeaderSeconds =
        retryAfterHeader && /^[0-9]+$/.test(retryAfterHeader)
            ? Number(retryAfterHeader)
            : undefined;
    // PLAN-0622 D14：`retryAfterSeconds` / `resourceKind` 是 429 契约字段，必须穿过 ApiError
    // 才能到 UI（否则 MessageItem 只能兜底成「资源」，用户不知道是连接不够还是模型不够）。
    // body 优先（header 只有秒数、没有 kind），header 只作为秒数的回退。
    const retryAfterSeconds = problem.retryAfterSeconds ?? retryAfterHeaderSeconds;
    throw new ApiError(
        {
            type: problem.type,
            title: problem.title,
            status: problem.status ?? res.status,
            code: problem.code ?? "API_ERROR",
            detail: problem.detail || `API error ${problem.status ?? res.status}`,
            requestId: problem.requestId || res.headers?.get("X-Request-Id") || "unknown",
            runId: problem.runId,
            provider: problem.provider,
            model: problem.model,
            retryable: problem.retryable,
            outcome: problem.outcome,
            retryAfterSeconds,
            resourceKind: problem.resourceKind,
        },
        retryAfterSeconds,
    );
}
export let refreshInFlight: Promise<boolean> | null = null;
export function ensureRefreshed(): Promise<boolean> {
    if (refreshInFlight) return refreshInFlight;
    const attempt = (async () => {
        try {
            const rt = localStorage.getItem("xihe-refresh-token");
            if (!rt) return false;
            const workspaceId = readTabWorkspaceId();
            const res = await fetch(endpoint("/auth/refresh"), {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(workspaceId ? { "X-Workspace-Id": workspaceId } : {}),
                },
                body: JSON.stringify({ refreshToken: rt }),
            });
            if (!res.ok) return false;
            const data = (await res.json()) as { accessToken?: string; refreshToken?: string };
            if (!data.accessToken || !data.refreshToken) return false;
            localStorage.setItem("xihe-token", data.accessToken);
            localStorage.setItem("xihe-refresh-token", data.refreshToken);
            authSyncCallbacks.forEach((cb) => cb(data.accessToken as string));
            return true;
        } catch {
            return false;
        }
    })();
    // .finally() callback always runs in a microtask (after the assignment above), so the
    // settled promise can never be written back into refreshInFlight.
    refreshInFlight = attempt;
    void attempt.finally(() => {
        refreshInFlight = null;
    });
    return attempt;
}
export const REFRESH_SKEW_SECONDS = 30;
export function accessTokenExpiresSoon(token: string | null): boolean {
    if (!token) return false;
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    try {
        const payload = JSON.parse(
            atob((parts[1] as string).replace(/-/g, "+").replace(/_/g, "/")),
        ) as { exp?: number };
        if (typeof payload.exp !== "number") return false;
        return payload.exp - Math.floor(Date.now() / 1000) <= REFRESH_SKEW_SECONDS;
    } catch {
        return false;
    }
}
export const authSyncCallbacks = new Set<(accessToken: string) => void>();
export function onAuthTokensRefreshed(cb: (accessToken: string) => void): void {
    authSyncCallbacks.add(cb);
}
export type ForceLogoutFn = () => void;
export let forceLogoutImpl: ForceLogoutFn | null = null;
export type WorkspaceContextRequiredFn = () => void;
export let workspaceContextRequiredImpl: WorkspaceContextRequiredFn | null = null;
export function registerWorkspaceContextRequired(fn: WorkspaceContextRequiredFn): void {
    workspaceContextRequiredImpl = fn;
}
export async function readProblemCode(res: Response): Promise<string> {
    try {
        const body = (await res.clone().json()) as { code?: unknown };
        return typeof body.code === "string" ? body.code : "";
    } catch {
        return "";
    }
}
export function registerForceLogout(fn: ForceLogoutFn): void {
    forceLogoutImpl = fn;
}
export function forceLogout(): void {
    // 无会话材料 = 已经登出（或从未登录）：再跳一次只会把登录页 URL 再套一层。
    if (!hasSessionMaterial()) return;
    localStorage.removeItem("xihe-token");
    localStorage.removeItem("xihe-refresh-token");
    localStorage.removeItem("xihe-user");
    clearTabWorkspace();
    if (forceLogoutImpl) {
        forceLogoutImpl();
        return;
    }
    // Fallback when the auth store has not registered yet (e.g. tests): keep the old
    // hard-navigation semantics so the session is still visibly terminated.
    if (!["/login", "/register"].includes(window.location.pathname))
        window.location.href = "/login";
}
export function hasSessionMaterial(): boolean {
    return (
        localStorage.getItem("xihe-token") !== null ||
        localStorage.getItem("xihe-refresh-token") !== null ||
        localStorage.getItem("xihe-user") !== null
    );
}
export async function checkedFetch(path: string, options?: RequestInit): Promise<Response> {
    const hasBody = options?.body !== undefined && options.body !== null,
        includeContentType = hasBody && !(options?.body instanceof FormData),
        isAuthEndpoint =
            path === "/auth/login" ||
            path === "/auth/register" ||
            path === "/auth/bootstrap-status" ||
            path === "/bootstrap/first-run-account" ||
            path === "/bootstrap/first-run-account/rewrite",
        // PLAN-0498 T3.1: a wrong reveal step-up password is a 401 domain outcome,
        // not session expiry — it must stay inline in the reveal dialog.
        isStepUpEndpoint = /^\/credentials\/[^/]+\/reveal$/.test(path);
    // task-427：预刷新。失败不在这里登出 —— 让下面的 401 路径按既有语义处理，
    // 免得把「刷新暂时失败」升级成「会话已死」。
    if (
        !isAuthEndpoint &&
        !isStepUpEndpoint &&
        localStorage.getItem("xihe-refresh-token") !== null &&
        accessTokenExpiresSoon(localStorage.getItem("xihe-token"))
    ) {
        await ensureRefreshed();
    }
    const res = await fetch(endpoint(path), {
        ...options,
        headers: apiAuthHeaders(options?.headers, includeContentType),
    });
    if (res.status === 401 && !isAuthEndpoint && !isStepUpEndpoint) {
        // PLAN-0546: silent refresh with single-flight, then one replay. Logout only when
        // the refresh itself fails or the replayed request is still 401 (no second refresh).
        const refreshed = await ensureRefreshed();
        if (refreshed) {
            const replay = await fetch(endpoint(path), {
                ...options,
                headers: apiAuthHeaders(options?.headers, includeContentType),
            });
            if (replay.status === 401) {
                forceLogout();
                throw new ApiError({
                    status: 401,
                    code: "AUTHORIZATION_REQUIRED",
                    detail: "Session expired",
                    requestId: replay.headers?.get("X-Request-Id") || "unknown",
                });
            }
            if (!replay.ok) return apiErrorFromResponse(replay);
            return replay;
        }
        forceLogout();
        throw new ApiError({
            status: 401,
            code: "AUTHORIZATION_REQUIRED",
            detail: "Session expired",
            requestId: res.headers?.get("X-Request-Id") || "unknown",
        });
    }
    if (res.status === 409 && (await readProblemCode(res)) === "WORKSPACE_CONTEXT_REQUIRED") {
        // BL-181: recoverable — hand off to the picker; never the 401 logout path.
        workspaceContextRequiredImpl?.();
    }
    if (!res.ok) return apiErrorFromResponse(res);
    return res;
}
export async function apiRaw(path: string, options?: RequestInit): Promise<Response> {
    return checkedFetch(path, options);
}
export async function request<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await checkedFetch(path, options);
    if (res.status === 204) return undefined as T;
    return res.json();
}
export async function apiPost<T = unknown>(
    path: string,
    body?: BodyInit | null,
    headers?: Record<string, string>,
): Promise<T> {
    const requestHeaders = apiAuthHeaders(headers);
    if (body instanceof FormData) delete requestHeaders["Content-Type"];
    const res = await checkedFetch(path, {
        method: "POST",
        headers: requestHeaders,
        body,
    });
    if (res.status === 204) return undefined as T;
    return res.json();
}
export async function apiGet<T = unknown>(path: string): Promise<T> {
    const res = await checkedFetch(path, {
        headers: apiAuthHeaders(undefined, false),
    });
    if (res.status === 204) return undefined as T;
    return res.json();
}
export async function apiDelete(path: string): Promise<void> {
    await checkedFetch(path, {
        method: "DELETE",
        headers: apiAuthHeaders(undefined, false),
    });
}
export function workspaceHeaders(workspaceId: string | null | undefined): Record<string, string> {
    if (!workspaceId || workspaceId.trim().length === 0) {
        throw new ApiError({
            status: 400,
            code: "WORKSPACE_CONTEXT_REQUIRED",
            detail: "Workspace context is required",
            requestId: "client",
        });
    }
    return { "X-Workspace-Id": workspaceId };
}
export function runtimeMcpHeaders(workspaceId: string): Record<string, string> {
    return {
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        ...workspaceHeaders(workspaceId),
    };
}
export async function callRuntimeTool<T>(
    tool: string,
    args: Record<string, unknown>,
    workspaceId: string,
): Promise<T> {
    const res = await checkedFetch("/mcp", {
            method: "POST",
            headers: runtimeMcpHeaders(workspaceId),
            body: JSON.stringify({
                jsonrpc: "2.0",
                method: "tools/call",
                id: Date.now(),
                params: { name: tool, arguments: args },
            }),
        }),
        text = await res.text(),
        jsonLine = text.startsWith("data:")
            ? text
                  .split("\n")
                  .find((line) => line.startsWith("data:"))!
                  .slice(5)
                  .trim()
            : text,
        body = JSON.parse(jsonLine);
    if (body.error) {
        throw new ApiError({
            status: 502,
            code: "MCP_TOOL_ERROR",
            detail: body.error.message || "MCP tool call failed",
            requestId: res.headers.get("X-Request-Id") || "unknown",
        });
    }
    const result = body.result;
    if (result?.isError) {
        throw new ApiError({
            status: 502,
            code: "MCP_TOOL_ERROR",
            detail: result.content?.[0]?.text || "MCP tool error",
            requestId: res.headers.get("X-Request-Id") || "unknown",
        });
    }
    if (result?.structuredContent !== undefined) return result.structuredContent as T;
    const textContent = result?.content?.[0]?.text;
    if (typeof textContent === "string") {
        try {
            return JSON.parse(textContent) as T;
        } catch {
            return textContent as T;
        }
    }
    return result as T;
}
