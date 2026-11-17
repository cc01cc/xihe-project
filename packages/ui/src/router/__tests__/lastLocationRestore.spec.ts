import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { Router } from "vue-router";
import { LAST_LOCATION_KEY, clearLastLocation, readLastLocation } from "../../lib/lastLocation";
import { WORKSPACE_PICKER_PATH } from "../../lib/routes";

/**
 * task-111：H1（tab 上下文优先）与 H2（写点 = afterEach）的**真路由**读数。
 *
 * 驱动 `router/index.ts` 真模块（守卫 + 模块级 afterEach 都是真实现），不替身：
 *  - H1 两侧：sessionStorage 有 tab 上下文时必须回本 tab 落点（即使上一跳是别处）；
 *    无 tab 上下文时上一跳必须真的生效（证明读数不是「两边都不恢复」的假绿）。
 *  - H2 两侧：被守卫 redirect 的深链（非 UUID workspaceId ⇒ 弹 workspace-home）不得写入；
 *    真正落地的会话页必须写入（证明写点本身活着）。
 *  - H4-c 两侧：**显式**进 picker（`/workspace` → redirect → `workspace-home`）不得恢复；
 *    `/workbench` 冷启（无 `redirectedFrom`）必须仍恢复 —— 两条都要能红，只测一侧等于
 *    「把恢复整个关掉」也能过。哨兵 `e2e/real/plan-0608-browser.spec.ts` test 3 第二 tab
 *    `goto("/workspace")` 必须出 picker（该文件只读，不许编辑）。
 *
 * 变异判据（若实现回退即红）：
 *  - H1：若守卫先读上一跳再读 tab 上下文 ⇒ H1-A 落在 WS_LAST/chat 而非 WS_TAB ⇒ 红。
 *  - H2：若写点挪进 beforeEach ⇒ H2-A 会写下 {workspaceId:"not-a-uuid"} ⇒ 红。
 */

const WS_TAB = "11111111-1111-4111-8111-111111111111",
    WS_LAST = "22222222-2222-4222-8222-222222222222",
    SESS_LAST = "33333333-3333-4333-8333-333333333333";

let router: Router;

function seedLastLocation(
    kind: string,
    workspaceId: string | null,
    sessionId: string | null,
): void {
    localStorage.setItem(
        LAST_LOCATION_KEY,
        JSON.stringify({ kind, workspaceId, sessionId, at: new Date().toISOString() }),
    );
}

/** 排空 router 导航（守卫 + redirect 递归需要若干宏任务；与 authRedirectRecursion 同形）。 */
async function flushRouter(): Promise<void> {
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function navigate(path: string): Promise<void> {
    window.history.replaceState({}, "", path);
    await router.push(path);
    await flushRouter();
}

beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    setActivePinia(createPinia());
    if (!router) {
        router = (await import("../index")).default;
    }
    localStorage.setItem("xihe-token", "token");
});

describe("H1：tab 上下文（sessionStorage）优先于上一跳（localStorage）", () => {
    it("A 面：两 tab 各停一处，本 tab 重载回本 tab 落点", async () => {
        sessionStorage.setItem("xihe-workspace", JSON.stringify({ id: WS_TAB }));
        seedLastLocation("workspace", WS_LAST, SESS_LAST);
        await navigate("/workbench");
        const landed = window.location.pathname;
        process.stdout.write(
            `[H1-A] tab=${WS_TAB} last=${WS_LAST}/${SESS_LAST} landed=${landed}\n`,
        );
        expect(landed).toBe(`/workspace/${WS_TAB}`);
    });

    it("B 面（反面读数）：无 tab 上下文时上一跳真的生效", async () => {
        // sessionStorage 空 = 另一个 tab / 冷启场景；上一跳必须被读到，否则 A 面是假绿。
        seedLastLocation("workspace", WS_LAST, SESS_LAST);
        await navigate("/workbench");
        const landed = window.location.pathname;
        process.stdout.write(`[H1-B] last=${WS_LAST}/${SESS_LAST} landed=${landed}\n`);
        expect(landed).toBe(`/workspace/${WS_LAST}/chat/${SESS_LAST}`);
    });

    it("standalone 上一跳恢复到 /chat/<sid>", async () => {
        seedLastLocation("standalone", null, SESS_LAST);
        await navigate("/workbench");
        const landed = window.location.pathname;
        process.stdout.write(`[H1-C] standalone last=${SESS_LAST} landed=${landed}\n`);
        expect(landed).toBe(`/chat/${SESS_LAST}`);
    });
});

describe("H2：写点必须是 afterEach —— redirect 目标不得写入上一跳", () => {
    it("A 面：指向非 UUID 工作区的深链被守卫弹走，不写上一跳", async () => {
        await navigate("/workspace/not-a-uuid/chat/sess-1");
        const landed = window.location.pathname + window.location.search,
            written = localStorage.getItem(LAST_LOCATION_KEY);
        process.stdout.write(
            `[H2-A] deep-link=/workspace/not-a-uuid/chat/sess-1 landed=${landed} written=${written}\n`,
        );
        expect(written).toBeNull();
        expect(landed.startsWith("/workbench")).toBe(true);
    });

    it("B 面（正读数）：真正落地的会话页/裸工作区/独立会话都写入", async () => {
        await navigate(`/workspace/${WS_LAST}/chat/${SESS_LAST}`);
        let written = readLastLocation();
        process.stdout.write(
            `[H2-B1] landed=${window.location.pathname} written=${JSON.stringify(written)}\n`,
        );
        expect(written).toMatchObject({
            kind: "workspace",
            workspaceId: WS_LAST,
            sessionId: SESS_LAST,
        });

        await navigate(`/workspace/${WS_LAST}`);
        written = readLastLocation();
        process.stdout.write(
            `[H2-B2] landed=${window.location.pathname} written=${JSON.stringify(written)}\n`,
        );
        expect(written).toMatchObject({ kind: "workspace", workspaceId: WS_LAST, sessionId: null });

        await navigate(`/chat/${SESS_LAST}`);
        written = readLastLocation();
        process.stdout.write(
            `[H2-B3] landed=${window.location.pathname} written=${JSON.stringify(written)}\n`,
        );
        expect(written).toMatchObject({
            kind: "standalone",
            workspaceId: null,
            sessionId: SESS_LAST,
        });
    });
});

describe("H4-c：显式进 picker 不恢复（冷启 /workbench 仍恢复）", () => {
    /**
     * 把当前路由挪到与后续断言无关的落点。
     *
     * <p>必要性：vue-router 把「push 到与当前完全相同的 location」判成 duplicated failure
     * ⇒ **守卫根本不会再跑**，读数就成了「上一次导航的残留」（假绿/假红都从这里来）。
     * 落点取独立会话页：它既不是 picker 也不是工作台入口，本身不依赖 tab 上下文。</p>
     */
    async function parkOnStandaloneChat(): Promise<void> {
        await navigate("/chat/" + SESS_LAST);
        // 只清「上一跳」与 tab 上下文：**不能** localStorage.clear()，那会连 xihe-token
        // （守卫的登录态）一起清掉 ⇒ 后续导航全被弹到 /login，读数与判据完全无关。
        clearLastLocation();
        sessionStorage.clear();
    }

    it("A 面：显式进 picker ⇒ 落在 workspace-home（不恢复），且上一跳不被改写", async () => {
        await parkOnStandaloneChat();
        seedLastLocation("workspace", WS_LAST, SESS_LAST);
        const seeded = localStorage.getItem(LAST_LOCATION_KEY);
        await navigate(WORKSPACE_PICKER_PATH);
        const landed = window.location.pathname + window.location.search;
        process.stdout.write(
            "[H4-c/A] explicit=" +
                WORKSPACE_PICKER_PATH +
                " last=" +
                WS_LAST +
                "/" +
                SESS_LAST +
                " landed=" +
                landed +
                " route=" +
                String(router.currentRoute.value.name) +
                "\n",
        );
        // workspace-home = picker 的路由（无 tab 上下文时渲染 WorkspacePicker，见
        // router/index.ts 的 `workspace` 记录 + components/__tests__/WorkspacePicker.spec）。
        expect(landed, "显式进 picker 不得被上一跳拖走").toBe("/workbench");
        expect(router.currentRoute.value.name).toBe("workspace-home");
        // 机制读数（判据的**输入面**）：这条导航确实是 redirect 来的，来源正是 picker 入口
        // —— 不是「恢复恰好没跑」的巧合。
        expect(router.currentRoute.value.redirectedFrom?.path).toBe(WORKSPACE_PICKER_PATH);
        // picker 不是可恢复页面（`lastLocationForRoute` 对它返回 null）⇒ 上一跳原样留着：
        // 既没被清（H1 的读法仍在），也没被改写成别的落点。
        expect(localStorage.getItem(LAST_LOCATION_KEY)).toBe(seeded);
    });

    it("A2 面：带 query 的显式入口同样不恢复，query 原样透传给 picker", async () => {
        await parkOnStandaloneChat();
        seedLastLocation("workspace", WS_LAST, SESS_LAST);
        await navigate(WORKSPACE_PICKER_PATH + "?invalidWorkspace=1");
        const landed = window.location.pathname + window.location.search;
        process.stdout.write("[H4-c/A2] explicit=?invalidWorkspace=1 landed=" + landed + "\n");
        expect(landed).toBe("/workbench?invalidWorkspace=1");
        expect(router.currentRoute.value.name).toBe("workspace-home");
    });

    it("B 面（控制读数）：/workbench 冷启无 tab 上下文 ⇒ 仍恢复（判据不是「整体关掉恢复」）", async () => {
        await parkOnStandaloneChat();
        seedLastLocation("workspace", WS_LAST, SESS_LAST);
        await navigate("/workbench");
        const landed = window.location.pathname;
        process.stdout.write(
            "[H4-c/B] cold-start=/workbench last=" +
                WS_LAST +
                "/" +
                SESS_LAST +
                " landed=" +
                landed +
                "\n",
        );
        expect(landed, "冷启 /workbench 的原语义不许跟着废掉").toBe(
            "/workspace/" + WS_LAST + "/chat/" + SESS_LAST,
        );
        // 机制读数：恢复发生后才有的这层 redirect，来源是 `/workbench`（不是 picker 入口）
        // ⇒ 中间那次导航没有 `redirectedFrom` ⇒ 判据为 false ⇒ 恢复生效。两句一起钉住
        // 「判据不是对所有 redirect 一律放行」。
        expect(router.currentRoute.value.redirectedFrom?.path).toBe("/workbench");
    });

    it("判据锚点与路由表同源：WORKSPACE_PICKER_PATH 仍是 redirect 到 /workbench 的那条记录", () => {
        const record = router
            .getRoutes()
            .find((candidate) => candidate.path === WORKSPACE_PICKER_PATH);
        expect(record, "路由表里必须有 picker 入口 " + WORKSPACE_PICKER_PATH).toBeDefined();
        expect(typeof record?.redirect, "picker 入口必须是 redirect 记录（落地 /workbench）").toBe(
            "function",
        );
        expect(router.getRoutes().find((candidate) => candidate.path === "/workbench")?.name).toBe(
            "workspace-home",
        );
    });
});
