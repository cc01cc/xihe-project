import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

/**
 * task-224 复现脚本：并发 401 下的登录重定向递归。
 *
 * 复现的必要条件（task-223 已定位，不重新论证）：
 *  (a) 存在**被当作已登录**的 token（不校验有效性，只要 localStorage 里有）；
 *  (b) 同屏**并发多个 401** ⇒ 每个 401 各调一次 `forceLogout()`（无去重）。
 *
 * 用真模块复现，不做手工模拟：
 *  - 真 `composables/api` 的 `checkedFetch` 401 分支 + `ensureRefreshed` 单飞；
 *  - 真 `stores/auth` 注册的 `forceLogout` 实现（`auth.ts:519-525` 的 `router.push`）；
 *  - 真 `router`（`router/index.ts`）—— 它才是把 push 落进 `window.location` 的那层，
 *    而自增行读的正是 `window.location.pathname + window.search`。
 *
 * 两个测量对应两条不同的修复目标：
 *  - **跳转次数**：12 个 401 同一帧完成 ⇒ 数 `router.push` 调用次数（档 2 单飞的目标）；
 *  - **嵌套层数**：10 个 401 的响应依次到达（真浏览器就是这样：每个 401 的
 *    `ensureRefreshed` 失败时刻不同）⇒ 数最终 URL 里 `/login` 的层数（档 1 的目标）。
 *
 * 「层数」定义：最终 URL **完全解码后**里 `/login` 的出现次数（嵌套 `redirect=` 每外层各编码一次）。
 *
 * 读数（改前 / 改后见 receipt）：
 *  改前：并发 12 个 401 ⇒ 12 次跳转；交错 10 个 401 ⇒ 11 层嵌套。
 *  改后：并发 12 个 401 ⇒ 1 次跳转；交错 10 个 401 ⇒ 1 层（每次登出的目标都是 /workspace）。
 */

function fullyDecoded(raw: string): string {
    let current = raw;
    for (let i = 0; i < 20; i++) {
        const next = decodeURIComponent(current);
        if (next === current) return current;
        current = next;
    }
    return current;
}

function loginLayers(url = window.location.pathname + window.location.search): number {
    return fullyDecoded(url).split("/login").length - 1;
}

/** 排空 router 导航（push 内部要跑守卫，需要若干宏任务）。 */
async function flushRouter(): Promise<void> {
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function unauthorizedResponse(): Response {
    return new Response(
        JSON.stringify({
            type: "about:blank",
            title: "Unauthorized",
            status: 401,
            code: "AUTHORIZATION_REQUIRED",
        }),
        { status: 401, headers: { "Content-Type": "application/problem+json" } },
    );
}

interface Harness {
    pushCount: () => number;
    /** 真正被 401 打回的次数（断言"401 数不变"用：修复不该减少请求，只该减少跳转）。 */
    unauthorizedCount: () => number;
    /** 让浏览器里重新"看起来已登录"（模拟每个请求发出时的状态）。 */
    seedStaleToken: () => void;
    /** 发一个注定 401 的请求并等它走完 logout 分支。 */
    triggerUnauthorized: () => Promise<unknown>;
}

async function buildHarness(startPath: string): Promise<Harness> {
    setActivePinia(createPinia());
    const { default: router } = await import("../../router");
    const { useAuthStore } = await import("../auth");
    const { api } = await import("../../composables/api");
    useAuthStore(); // 注册真 forceLogout 实现

    // 启动 router（未启动的 router 会把 push 排在初始导航后面，URL 不落地）
    window.history.replaceState({}, "", startPath);
    await router.push(startPath);
    await flushRouter();

    const pushes: string[] = [];
    let unauthorizedCount = 0;
    const originalPush = router.push.bind(router);
    vi.spyOn(router, "push").mockImplementation((to: never) => {
        pushes.push(JSON.stringify(to));
        return originalPush(to);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(unauthorizedResponse()));

    return {
        pushCount: () => pushes.length,
        unauthorizedCount: () => unauthorizedCount,
        seedStaleToken: () => {
            localStorage.setItem("xihe-token", "stale-token");
            localStorage.setItem("xihe-refresh-token", "stale-refresh-token");
            localStorage.setItem(
                "xihe-user",
                JSON.stringify({ id: "u1", email: "e@x.test", name: "U" }),
            );
        },
        triggerUnauthorized: () =>
            api.listWorkspaces().catch(() => {
                unauthorizedCount += 1;
                return undefined;
            }),
    };
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
});

describe("task-224 复现：并发 401 下的登录重定向递归", () => {
    it("交错 10 个 401 ⇒ redirect 嵌套层数（档 1 的目标）", async () => {
        const harness = await buildHarness("/workspace/ws-1");
        for (let i = 0; i < 10; i++) {
            harness.seedStaleToken();
            await harness.triggerUnauthorized();
            await flushRouter();
        }
        const layers = loginLayers();
        console.log(
            "MEASURE layers " +
                JSON.stringify({
                    requests: 10,
                    pushCount: harness.pushCount(),
                    layers,
                    finalUrl: window.location.pathname + window.location.search,
                }),
        );
        // 档 1 的判据：层数不再增长（改前 11 层），且 redirect 里不许再出现 login。
        expect(layers).toBe(1);
        expect(window.location.search).not.toContain("login");
        // 这里 10 次跳转是**故意**的：本用例每轮都重新塞 token，模拟的是 10 次独立登出
        // （例如 10 个标签页各自过期）；档 2 的单飞管的是同一批 401，见下一条用例。
        expect(harness.pushCount()).toBe(10);
    }, 30000);

    it("并发 12 个 401 ⇒ 跳转次数（档 2 的目标）", async () => {
        const harness = await buildHarness("/workspace/ws-2");
        harness.seedStaleToken();
        const before = harness.pushCount();
        await Promise.allSettled(Array.from({ length: 12 }, () => harness.triggerUnauthorized()));
        await flushRouter();
        const pushes = harness.pushCount() - before;
        console.log(
            "MEASURE concurrent " +
                JSON.stringify({
                    requests: 12,
                    unauthorized: harness.unauthorizedCount(),
                    pushCount: pushes,
                }),
        );
        // 档 2 的判据：401 一个都没少（语义不动），但一批只发生一次登出跳转。
        expect(harness.unauthorizedCount()).toBe(12);
        expect(pushes).toBe(1);
    }, 30000);
});
