import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { Router } from "vue-router";
import { LAST_LOCATION_KEY, readLastLocation } from "../../lib/lastLocation";
import { WORKSPACE_PICKER_PATH } from "../../lib/routes";
import { clearTabWorkspace } from "../../lib/workspaceContext";

/**
 * task-111（H1 / H2 / H4-c）+ task-145（① / ②）的**真路由**读数。
 *
 * 驱动 `router/index.ts` 真模块（守卫 + 模块级 afterEach 都是真实现），不替身：
 *  - H1 两侧：sessionStorage 有 tab 上下文时必须回本 tab 落点（即使上一跳是别处）；
 *    无 tab 上下文时上一跳必须真的生效（证明读数不是「两边都不恢复」的假绿）。
 *  - H2 两侧：被守卫 redirect 的深链（非 UUID workspaceId ⇒ 弹 workspace-home）不得写入；
 *    真正落地的会话页必须写入（证明写点本身活着）。
 *  - H4-c 两侧：**冷启显式**进 picker（`/workspace` → redirect → `workspace-home`）不得恢复；
 *    冷启 `/workbench`（无 `redirectedFrom`）必须仍恢复 —— 这是 ①② 都不许废掉的真控制。
 *  - task-145 ①：站内到达 `workspace-home` 一律不恢复（删工作区/无权/上下文冲突的回弹）。
 *  - task-145 ②：站内从死工作区回弹时，指向它的上一跳被忘掉 ⇒ 下一次冷启不落在死工作区。
 *
 * **每个用例一个全新 router**（`vi.resetModules()` + 重新 import）：恢复只在冷启发生，而
 * 「冷启」的判据是 `from = START_LOCATION`（`matched.length === 0`）——只有全新实例的
 * 第一次导航才是它。共用单例时从第二个用例起全部变成站内导航，冷启判据就再也测不到。
 *
 * 变异判据（若实现回退即红）：
 *  - H1：若守卫先读上一跳再读 tab 上下文 ⇒ H1-A 落在 WS_LAST/chat 而非 WS_TAB ⇒ 红。
 *  - H2：若写点挪进 beforeEach ⇒ H2-A 会写下 {workspaceId:"not-a-uuid"} ⇒ 红。
 *  - H4-c：若删掉「冷启 + 显式 picker」判据 ⇒ A/A2 落在 WS_LAST/chat ⇒ 红。
 *  - ①：若删掉冷启判据 ⇒ ① 用例被恢复送回 WS_LAST/chat ⇒ 红。
 *  - ②：若删掉 `forgetLastLocationForWorkspace` ⇒ ② 用例的键仍在、下一次冷启又回死工作区 ⇒ 红。
 */

const WS_TAB = "11111111-1111-4111-8111-111111111111",
    WS_LAST = "22222222-2222-4222-8222-222222222222",
    WS_DEAD = "44444444-4444-4444-8444-444444444444",
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

/** 造一个全新 router 实例（= 一次冷启：当前路由回到 START_LOCATION）。 */
async function freshRouter(): Promise<Router> {
    vi.resetModules();
    setActivePinia(createPinia());
    router = (await import("../index")).default;
    localStorage.setItem("xihe-token", "token");
    return router;
}

beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await freshRouter();
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

    it("B 面（反面读数）：冷启无 tab 上下文时上一跳真的生效", async () => {
        // sessionStorage 空 = 另一个 tab / 冷启场景；上一跳必须被读到，否则 A 面是假绿。
        seedLastLocation("workspace", WS_LAST, SESS_LAST);
        await navigate("/workbench");
        const landed = window.location.pathname;
        process.stdout.write(`[H1-B] last=${WS_LAST}/${SESS_LAST} landed=${landed}\n`);
        expect(landed).toBe(`/workspace/${WS_LAST}/session/${SESS_LAST}`);
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
        await navigate("/workspace/not-a-uuid/session/sess-1");
        const landed = window.location.pathname + window.location.search,
            written = localStorage.getItem(LAST_LOCATION_KEY);
        process.stdout.write(
            `[H2-A] deep-link=/workspace/not-a-uuid/session/sess-1 landed=${landed} written=${written}\n`,
        );
        expect(written).toBeNull();
        expect(landed.startsWith("/workbench")).toBe(true);
    });

    it("B 面（正读数）：真正落地的会话页/裸工作区/独立会话都写入", async () => {
        await navigate(`/workspace/${WS_LAST}/session/${SESS_LAST}`);
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

describe("H4-c：冷启显式进 picker 不恢复（冷启 /workbench 仍恢复 = 真控制）", () => {
    it("A 面：冷启直接打开 /workspace ⇒ 落在 workspace-home（不恢复），且上一跳不被改写", async () => {
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
        expect(landed, "冷启显式进 picker 不得被上一跳拖走").toBe("/workbench");
        expect(router.currentRoute.value.name).toBe("workspace-home");
        // 机制读数（判据的**输入面**）：这条导航确实是 redirect 来的，来源正是 picker 入口
        // —— 不是「恢复恰好没跑」的巧合。冷启判据（①）在这里放行，唯一拦住恢复的是本判据。
        expect(router.currentRoute.value.redirectedFrom?.path).toBe(WORKSPACE_PICKER_PATH);
        // picker 不是可恢复页面（`lastLocationForRoute` 对它返回 null）⇒ 上一跳原样留着：
        // 既没被清（H1 的读法仍在），也没被改写成别的落点。
        expect(localStorage.getItem(LAST_LOCATION_KEY)).toBe(seeded);
    });

    it("A2 面：冷启带 query 的显式入口同样不恢复，query 原样透传给 picker", async () => {
        seedLastLocation("workspace", WS_LAST, SESS_LAST);
        await navigate(WORKSPACE_PICKER_PATH + "?invalidWorkspace=1");
        const landed = window.location.pathname + window.location.search;
        process.stdout.write("[H4-c/A2] explicit=?invalidWorkspace=1 landed=" + landed + "\n");
        expect(landed).toBe("/workbench?invalidWorkspace=1");
        expect(router.currentRoute.value.name).toBe("workspace-home");
    });

    it("B 面（真控制）：冷启 /workbench 无 tab 上下文 ⇒ 仍恢复", async () => {
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
            `/workspace/${WS_LAST}/session/${SESS_LAST}`,
        );
        // 机制读数：恢复发生后才有的这层 redirect，来源是 `/workbench`（不是 picker 入口）。
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

describe("task-145 ①：站内到达 workspace-home 一律不恢复", () => {
    it("删工作区/无权的回弹：清 tab 上下文后回 picker ⇒ 落在 picker，不被上一跳送回原工作区", async () => {
        // 真实链路起手：冷启先落在该工作区的会话页（= 恢复落点，或用户直接打开深链）。
        await navigate(`/workspace/${WS_LAST}/session/${SESS_LAST}`);
        expect(localStorage.getItem(LAST_LOCATION_KEY), "前置：上一跳必须已写入").not.toBeNull();
        // 页面发现该工作区不可用（WORKSPACE_FORBIDDEN / NOT_FOUND / 已被删除）：
        // 三处真实调用点同形 —— WorkspaceView.vue:368、WorkspaceSettingsView.vue:322、:231
        // ⇒ 先 clearTabWorkspace() 再回 picker。
        clearTabWorkspace();
        await router.push({ name: "workspace-home" });
        await flushRouter();
        const landed = window.location.pathname;
        process.stdout.write(
            "[①] in-app→workspace-home landed=" +
                landed +
                " route=" +
                String(router.currentRoute.value.name) +
                "\n",
        );
        // 变异判据：删掉「非冷启一律不恢复」⇒ 落在 /workspace/WS/session/SESS（被劫持）⇒ 红。
        expect(landed, "站内到 picker 不得被上一跳送回原工作区").toBe("/workbench");
        expect(router.currentRoute.value.name).toBe("workspace-home");
    });
});

describe("task-145 ②：指向死工作区的上一跳被忘掉（下一次冷启不落在死工作区）", () => {
    it("恢复落在死工作区 → 回弹时清键 → 下一次冷启落在 picker", async () => {
        seedLastLocation("workspace", WS_DEAD, null);
        // 冷启 ⇒ 被恢复到那个（已删除/无权的）工作区：读点没错，错在键没被清。
        await navigate("/workbench");
        expect(window.location.pathname, "前置：冷启必须真的恢复到该工作区").toBe(
            `/workspace/${WS_DEAD}`,
        );
        // 页面判定它不可用：清 tab 上下文 + 回 picker（WorkspaceSettingsView.vue:322-326 同形）。
        clearTabWorkspace();
        await router.push({ name: "workspace-home" });
        await flushRouter();
        const afterBounce = window.location.pathname,
            keyAfterBounce = readLastLocation();
        process.stdout.write(
            "[②] afterBounce=" +
                afterBounce +
                " lastLocationAfterBounce=" +
                JSON.stringify(keyAfterBounce) +
                "\n",
        );
        // ② 的判据（独立于 ① 的落地判据）：指向死工作区的键必须消失。
        // 变异判据：删掉 forgetLastLocationForWorkspace ⇒ 键仍在 ⇒ 红。
        expect(afterBounce, "前置：① 生效后回弹应落在 picker").toBe("/workbench");
        expect(keyAfterBounce, "指向死工作区的上一跳必须被清").toBeNull();
        // 判据的下半句（卡面原文「下一次冷启也不落在死工作区」）：冷启一次新实例。
        await freshRouter();
        await navigate("/workbench");
        process.stdout.write("[②-cold] next cold start landed=" + window.location.pathname + "\n");
        // 变异判据：② 未做 ⇒ 冷启又被恢复回 /workspace/WS_DEAD ⇒ 红。
        expect(window.location.pathname, "下一次冷启不得落在死工作区").toBe("/workbench");
    });
});
