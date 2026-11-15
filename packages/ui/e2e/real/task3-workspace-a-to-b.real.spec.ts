// timeout-exempt: 真栈跨上下文观测需要两个工作区与长窗口（LONG_TIMEOUT_MS）
/**
 * task-3（原 task-621）· 工作区 **A → B** 跨上下文 · **真栈态**（task-182 之后新开窗口 2026-11-15）。
 *
 * 与 mock 车道同族但**边界不同**，两份文件**都要留**：
 *  - `e2e/mock/task585-wsless-header-audit.spec.ts`：mock 车道，**无栈也要能跑**；它的
 *    「A→B 真实态」用例保持 `test.skip`（mock 无真 CP，无法复现「CP 按 workspace 相等过滤」的行为）。
 *  - 本文件：**真栈专用**，不桩任何 `/api`，所以它只能在 `XIHE_E2E_EXTERNAL_SERVER=1` 指向真栈时跑。
 *
 * 判据（三条，缺一条读数就不可信）：
 *  ① **边界后**（进入 B 之后发出的）`/api/*` 请求里，带 A 的 `X-Workspace-Id` 头 / `workspaceId` 参数 = **0**；
 *  ② **正面控制**：边界后必须出现带 **B** 头的请求（证明真的在 B 上下文里跑，而不是页面根本没动）；
 *  ③ **仪器自证**：边界后**人为注入**一条带 A 头的页面内 `fetch`，钩子必须抓到它（≥1）
 *     —— 否则「① 为 0」可能只是钩子没工作（D-1516 同族：不可复算的 0 等于没有读数）。
 */
import fs from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { LONG_TIMEOUT_MS } from "../timeouts";
import { registerJourneyUser, seedPage } from "./helpers/journey";
import { createDirectAttachWorkspace } from "./helpers/workspace";

const OUT = process.env.XIHE_AB_REAL_OUT ?? "H:/zeotmp/infra-1/task3/workspace-a-to-b-real.json";

type Row = {
    method: string;
    path: string;
    workspaceHeader: string;
    workspaceParam: string | null;
    atMs: number;
};

/** 记录**所有** `/api/*` 请求的头与显式 workspaceId 参数（与 mock 族同口径）。 */
function recordAll(page: Page): Row[] {
    const rows: Row[] = [];
    const startedAt = Date.now();
    page.on("request", (request) => {
        const url = new URL(request.url());
        if (!url.pathname.startsWith("/api/")) return;
        rows.push({
            method: request.method(),
            path: url.pathname + (url.search || ""),
            workspaceHeader: request.headers()["x-workspace-id"] ?? "",
            workspaceParam: url.searchParams.get("workspaceId"),
            atMs: Date.now() - startedAt,
        });
    });
    return rows;
}

test.describe.configure({ retries: 0 });

test("A→B（真栈 · 同 tab 深链）：边界后带 A 的 workspace 头/参数 = 0", async ({
    page,
    request,
}) => {
    test.setTimeout(LONG_TIMEOUT_MS * 4);
    // A = 注册用户自带工作区；B = 同用户再建一个 direct_attach 工作区（docker 后端冻结）。
    const a = await registerJourneyUser(request, "ab-real");
    const bWorkspaceId = await createDirectAttachWorkspace(request, a.authToken);
    expect(bWorkspaceId, "B 必须是另一个工作区").not.toBe(a.workspaceId);

    // **只在第一个文档播种**（关键，否则仪器自己会制造泄漏）：`seedPage` 用的是
    // `page.addInitScript`，它在**每次导航**都会重放 —— 于是进入 B 的那次也会把 A 的
    // legacy `localStorage["xihe-workspace"]` 重新写回去，而 `migrateLegacyWorkspace()` 会在
    // 首个请求前用它播种 tab 上下文 ⇒ 读数变成「测试自己造的 A 头」（2026-11-15 实测第一轮
    // 就是这么假的：2 条 A 头与 B 头同一毫秒发出）。用一次性旗标把播种限制在首个文档。
    page.addInitScript(
        (input) => {
            if (localStorage.getItem("xihe-ab-seeded")) return;
            localStorage.setItem("xihe-token", input.token);
            localStorage.setItem("xihe-user", JSON.stringify({ workspaceId: input.workspaceId }));
            localStorage.setItem(
                "xihe-workspace",
                JSON.stringify({ id: input.workspaceId, name: "Workspace A" }),
            );
            localStorage.setItem("xihe-ab-seeded", "1");
        },
        { token: a.authToken, workspaceId: a.workspaceId },
    );
    const rows = recordAll(page);
    // 文档级时间线（判「在途 vs 新发」的硬证据）：把**主文档导航提交时刻**放进与请求同一条时间轴。
    // 只看行序是不够的 —— A 文档在导航提交前自己还在发请求，那些包会排在 `boundary` 之后。
    const navs: Array<{ atMs: number; url: string }> = [];
    const navStart = Date.now();
    page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame())
            navs.push({ atMs: Date.now() - navStart, url: frame.url() });
    });

    // ① A 态成立：先看到带 A 头的真实请求，再谈「边界」。
    await page.goto(`/workspace/${a.workspaceId}`);
    await expect
        .poll(() => rows.filter((r) => r.workspaceHeader === a.workspaceId).length, {
            timeout: LONG_TIMEOUT_MS,
        })
        .toBeGreaterThan(0);

    const boundary = rows.length;
    // 边界：同 tab 深链进入 B（产品面同 tab 换工作区唯一路径，守卫在 router 里写 tab 上下文）。
    await page.goto(`/workspace/${bWorkspaceId}`);
    await expect
        .poll(() => rows.slice(boundary).filter((r) => r.workspaceHeader === bWorkspaceId).length, {
            timeout: LONG_TIMEOUT_MS,
        })
        .toBeGreaterThan(0);

    // ② 两次边界必须分开算（否则「在途」会被读成「泄漏」，2026-11-15 实测踩过）：
    //   · `boundary`   = 调用 `page.goto(B)` 之前 → 之后到来的可能仍是 **A 文档自己发的**（导航提交前的在途包）；
    //   · `bStart`     = B 上下文**第一次出现**的那条请求的索引 → 这才是「B 文档已经起来」的硬边界。
    // 判据断言只看 `[bStart, …)`；`[boundary, bStart)` 单独计数并列出样本（不隐藏、也不算违规）。
    const bStartRel = rows.slice(boundary).findIndex((r) => r.workspaceHeader === bWorkspaceId);
    expect(bStartRel, "找不到 B 上下文的第一个请求 ⇒ 边界不成立").toBeGreaterThanOrEqual(0);
    const bStart = boundary + bStartRel;
    const inFlight = rows.slice(boundary, bStart);
    const after = rows.slice(bStart);
    const withAHead = after.filter((r) => r.workspaceHeader === a.workspaceId);
    const withAParam = after.filter((r) => r.workspaceParam === a.workspaceId);
    const withBHead = after.filter((r) => r.workspaceHeader === bWorkspaceId);
    const rowsBeforeProbe = rows.length;

    // ③ 仪器自证：页面内人为注入一条带 A 头的请求，钩子必须抓到。
    const probeStatus = await page.evaluate(async (workspaceId: string) => {
        const response = await fetch(`/api/v1/workspaces/${workspaceId}`, {
            headers: { "X-Workspace-Id": workspaceId },
        });
        return response.status;
    }, a.workspaceId);
    const injected = rows.slice(rowsBeforeProbe).filter((r) => r.workspaceHeader === a.workspaceId);

    const evidence = {
        at: new Date().toISOString(),
        baseURL: page.url(),
        workspaceA: a.workspaceId,
        workspaceB: bWorkspaceId,
        boundaryIndex: boundary,
        bStartIndex: bStart,
        inFlightFromAdoc: inFlight.length,
        inFlightSample: inFlight.slice(0, 15),
        requestsAfterBStart: after.length,
        withAHead: withAHead.length,
        withAParam: withAParam.length,
        withBHead: withBHead.length,
        injectedProbe: { status: probeStatus, caught: injected.length },
        navigations: navs,
        sampleWithAHead: withAHead.slice(0, 10),
        sampleWithBHead: withBHead.slice(0, 10),
    };
    fs.mkdirSync(new URL(".", `file://${OUT}`).pathname.replace(/^\//, ""), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

    // 判据 ③ 先断言：仪器不工作 ⇒ 后面两条读数不作数。
    expect(
        injected.length,
        `仪器自证：注入的 A 头请求必须被抓到（probe status=${probeStatus}）`,
    ).toBeGreaterThan(0);
    expect(withBHead.length, "正面控制：边界后必须出现带 B 头的请求").toBeGreaterThan(0);
    expect(withAHead, "边界后带 A 头的请求").toEqual([]);
    expect(withAParam, "边界后带 A 的 workspaceId 参数的请求").toEqual([]);
});
