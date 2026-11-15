/**
 * task-149 B：chat run 的**登记表**（`GET /api/v1/chat/runs/{runId}` 与 `POST …/cancel` 的桩数据源）。
 *
 * <p>**为什么不能写一个「任何 runId 都返回同一个 run」的通用桩**：`api.ts:5259-5265` 对响应做硬校验
 * （缺 `sessionId` / `origin` 直接抛），而 run 是**每条用例自己造出来的** —— 通用桩只能编一个现实中
 * 不存在的 run，于是「查到了」和「查到了一个假的」在断言上长得一模一样（`D-1500` 那类空转绿）。</p>
 *
 * <p>**为什么是登记表而不是第二份清单**：run 记录**只从 `POST /api/v1/chat` 的 202 响应产生** —— 也就是
 * 产品真实拿到 runId 的那唯一一条路径（`helpers/auth.ts` 的 chat 桩）。登记时 `sessionId` 直接取请求体里
 * 的值，所以它**天然与那一次会话投影一致**，不存在「两份清单各记一份、漂移后红在别处」。
 * 未登记的 runId 一律 404 —— 与真实 CP 对未知 run 的行为一致。</p>
 *
 * <p>**形状来源**：`src/composables/api.ts:5249-5290`（`getChatRun` 返回的字段清单）与
 * `:5243-5246`（cancel 返回 `{status, runId}`）。</p>
 */

/** 一条 run 的 wire 记录（字段 = `api.ts:5249-5290` 读的那些）。 */
export interface MockRunRecord {
    runId: string;
    sessionId: string;
    origin: "user_submission" | "spawn";
    status: string;
    terminalOutcome: string | null;
    errorCode: string | null;
    leaseExpired: boolean;
    pendingApprovals: unknown[];
}

export interface MockRunRegistry {
    /** 登记一条 run（调用方 = `POST /api/v1/chat` 的 202 桩，唯一生产者）。 */
    record(input: {
        runId: string;
        sessionId: string;
        origin?: "user_submission" | "spawn";
    }): MockRunRecord;
    get(runId: string): MockRunRecord | undefined;
    /** 取消：把状态推到 `cancelled`；未登记返回 `undefined`（调用方回 404）。 */
    cancel(runId: string): MockRunRecord | undefined;
    readonly size: number;
}

export function createMockRunRegistry(): MockRunRegistry {
    const runs = new Map<string, MockRunRecord>();
    return {
        record(input) {
            const record: MockRunRecord = {
                runId: input.runId,
                sessionId: input.sessionId,
                origin: input.origin ?? "user_submission",
                status: "running",
                terminalOutcome: null,
                errorCode: null,
                leaseExpired: false,
                pendingApprovals: [],
            };
            runs.set(record.runId, record);
            return record;
        },
        get(runId) {
            return runs.get(runId);
        },
        cancel(runId) {
            const record = runs.get(runId);
            if (!record) return undefined;
            const cancelled: MockRunRecord = {
                ...record,
                status: "cancelled",
                terminalOutcome: "cancelled",
            };
            runs.set(runId, cancelled);
            return cancelled;
        },
        get size() {
            return runs.size;
        },
    };
}

/** `GET /api/v1/chat/runs/{runId}` 的响应体（`api.ts:5249-5290` 读的全部字段）。 */
export function chatRunProjection(record: MockRunRecord): Record<string, unknown> {
    return {
        runId: record.runId,
        sessionId: record.sessionId,
        origin: record.origin,
        status: record.status,
        terminalOutcome: record.terminalOutcome,
        errorCode: record.errorCode,
        leaseExpired: record.leaseExpired,
        pendingApprovals: record.pendingApprovals,
    };
}

/** `POST …/cancel` 的响应体（`api.ts:5243-5246` `Promise<{status, runId}>`）。 */
export function chatRunCancelProjection(record: MockRunRecord): { status: string; runId: string } {
    return { status: record.status, runId: record.runId };
}

/**
 * 解析 run 子资源路径：只认 `/api/v1/chat/runs/{runId}` 与 `…/{runId}/cancel`
 * （`/attempts`、`/trace`、`/guidance` 等子资源有各自的桩，这里返回 `null` 让它们继续走原路）。
 */
export function parseChatRunPath(
    pathname: string,
): { runId: string; action: "get" | "cancel" } | null {
    const matched = /^\/api\/v1\/chat\/runs\/([^/]+)(\/cancel)?$/.exec(pathname);
    if (!matched) return null;
    return { runId: matched[1], action: matched[2] ? "cancel" : "get" };
}

/** 未登记 runId 的 404（与真实 CP 对未知 run 的行为一致；带 problem code 便于排查）。 */
export const CHAT_RUN_NOT_FOUND = {
    type: "about:blank",
    title: "Not Found",
    status: 404,
    code: "CHAT_RUN_NOT_FOUND",
} as const;

/**
 * 每页一张登记表（`WeakMap` 按 `Page` 身份隔离 ⇒ 不跨用例泄漏，也不需要模块级全局态）。
 *
 * <p>**为什么必须共享**：`POST /api/v1/chat` 有两个生产者 —— `setupMockAuth` 的默认桩，以及
 * `helpers/sendable.ts` 为「走完整发送路径」准备的桩。若各自建一张表，后者产生的 run 在
 * `GET /chat/runs/{id}` 上就是 404（假失败），而那正是一种「两份清单漂移」。
 * ⇒ 两个生产者都从这里取表。</p>
 */
export function mockRunsFor(page: object): MockRunRegistry {
    const existing = registryByPage.get(page);
    if (existing) return existing;
    const created = createMockRunRegistry();
    registryByPage.set(page, created);
    return created;
}

const registryByPage = new WeakMap<object, MockRunRegistry>();

/**
 * task-162：登记表的**第二个生产者** —— 网络层观察 `POST /api/v1/chat` 的 202 响应。
 *
 * <p>**为什么需要**：有些 spec 自己注册 api/v1/chat 的 202 桩（glob 后注册优先，盖住本 helper 的那条），
 * runId 在那条桩里产生 ⇒ 登记表看不到 ⇒ 后续 GET api/v1/chat/runs/{id} 回 404。实测
 * follow-up-queue.spec.ts:214（失败块里 failedResponses: 404 …/chat/runs/33333333-…）。</p>
 *
 * <p>**为什么这不算第二份清单**：观察点仍是"产品真拿到 runId 的那条路径"（202 响应体），只是从
 * "在我们的桩里登记"换成"在网络上看到同一次成功"。202 体里没有 `runId` 的（非本平台的 202）不登记，
 * 让 404 继续暴露「没桩」。</p>
 */
export function installRunRegistryObservers(
    page: { on: Function },
    registry: MockRunRegistry,
): void {
    page.on("response", (response: any) => {
        const request = response.request();
        if (request.method() !== "POST") return;
        if (new URL(response.url()).pathname !== "/api/v1/chat") return;
        if (response.status() !== 202) return;
        void (async () => {
            try {
                const body = (await response.json()) as { runId?: unknown; sessionId?: unknown };
                if (typeof body?.runId !== "string") return;
                if (registry.get(body.runId)) return;
                registry.record({
                    runId: body.runId,
                    sessionId: typeof body.sessionId === "string" ? body.sessionId : "",
                });
            } catch {
                // 202 不是 JSON（或正文已被消费）：不登记。真实 CP 的 202 一定是 JSON ⇒ 这里是防御。
            }
        })();
    });
}

/**
 * task-162：显式登记一条 run（**SSE 里出现过的 runId** 走这条）。
 *
 * <p>审批/运行事件是 spec 在**页面内**推的，网络层看不到 ⇒ 这类 run 只能由"谁推谁登记"声明，
 * 与 `approval-registry.ts` 的 `pushMockApproval` 同一取舍：登记点必须紧贴产生点。</p>
 */
export function registerMockRun(
    page: object,
    input: { runId: string; sessionId: string; origin?: "user_submission" | "spawn" },
): MockRunRecord {
    const registry = mockRunsFor(page);
    return registry.get(input.runId) ?? registry.record(input);
}
