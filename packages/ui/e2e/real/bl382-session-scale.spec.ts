/**
 * PLAN-0682 (BL-382) —— 会话规模测量 spec（真栈 · T1.1 采样夹具 + T1.2 双口径骨架）。
 *
 * 定位（design §3 D2 + 决策 #1/#4）：
 * - **通道，不是门**：只如实采样并写 JSON，**不写阈值断言**——判据宁可不写也不要假红
 *   （bl329 方法学教训）。唯一例外是结构门（元素可见 / 计数稳定）。
 * - 数据只用真链路：隔离 e2e-host 栈 + `run-baseline.mjs seed-runs --apply` 直灌 PG
 *   （决策 #1 否决 mock 灌数——mock 绕过真实分页，store 驻留失真；禁用于 store 驻留类指标）。
 * - CDP 协议自带实现（`scripts/l2/heap-sample.mjs` 不在 develop），对齐
 *   `e2e/mock/bl348-heap-sample.spec.ts` 的 PROTOCOL：`HeapProfiler.collectGarbage` ×2 →
 *   等 rAF → 连采 5 次（间隔 100ms）→ 取中位 + min/max。bl348 的 `settleBeforeSampleMs`
 *   在这里升级为「消息条数连续稳定」轮询（readiness-by-polling，禁固定 sleep 等就绪）。
 *
 * 操作员协议（T1.3 route A：spec 自建 session 后用 seed-runs 直接回灌）：
 *   1. 隔离栈 boot（Lead 窗口通知后）；CP build verdict 须 fresh（钉靶 SHA 口径，验证期禁合入）。
 *   2. 设 `XIHE_BL382_TIER`（1k|5k|20k）与 `XIHE_BL382_SELF_SEED=1`：spec 用真实 API 建号/工作区/
 *      session（连带 root branch），再以 `run-baseline.mjs seed-runs --apply` 往自己的 session
 *      直灌 PG；不再依赖另一用户预置 fixture session（跨用户 403）。
 *   3. 路线 B（`XIHE_BL382_SESSION` 测既有预置会话）保留兼容，但不得与 `XIHE_BL382_SELF_SEED=1`
 *      同时使用；可选 `XIHE_BL382_OUT` 覆盖落盘路径。
 *
 * 证据口径：JSON 的 `seededSession` / `selfSeeded` / `seed` 字段必须能区分「本身份自建回灌」与
 * 「外部预置会话」，否则测量对象归属不可复核。
 *
 * T1.2（骨架先行，实跑待窗口）：同一会话内继续滚动回填口径——循环「滚顶（真实 wheel
 * 意图）→ load-older 点击」直至 olderExhausted（入口消失）或增长信号连续 2 轮不动
 * （store cap / 加载停止），终态采样 ×5；回填窗口 longtask、逐页耗时与 renderedRows
 * 旁证（虚拟化失效信号）只登记不断言。两口径各写一份 JSON。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { CDPSession, Page, Response } from "@playwright/test";
import { agentName } from "./helpers/agent-name";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { ensureFakeUserProvider } from "./helpers/fake-provider";
import { registerJourneyUser, seedPage, waitForControlPlaneAgentReady } from "./helpers/journey";
import { workspaceChatPath } from "../../src/lib/routes";

const TIERS = { "1k": 1_000, "5k": 5_000, "20k": 20_000 } as const;
type Tier = keyof typeof TIERS;

const PROTOCOL = (() => {
    try {
        const raw = process.env.BL382_PROTOCOL;
        if (raw)
            return JSON.parse(raw) as {
                gcRounds: number;
                samples: number;
                sampleIntervalMs: number;
            };
    } catch {
        // 忽略：回落到默认协议
    }
    return { gcRounds: 2, samples: 5, sampleIntervalMs: 100 };
})();

/**
 * Lead ruling 4: raw measurement JSON belongs to the PLAN package, not to the
 * gitignored `one/.local` tree. The spec runs from the A03 lane's `packages/ui`,
 * so walk up to the one workspace instead of assuming a fixed depth — the lane
 * can be either the main checkout or a `.worktrees` slot. Missing PLAN evidence
 * is a hard error: silently falling back to `.local` would strand the result
 * outside the reviewable package.
 *
 * The one-root marker mirrors `findOneRoot()` in measure-session-scale.mjs:
 * only the workspace root contains A03-xihe/scripts/perf/run-baseline.mjs.
 */
function resolveOneRoot(): string {
    const hostRoot = process.env.XIHE_WORKSPACE_HOST_ROOT;
    const start = hostRoot ? path.resolve(hostRoot, "../../..") : process.cwd();
    let dir = path.resolve(start);
    for (;;) {
        if (existsSync(path.join(dir, "A03-xihe", "scripts", "perf", "run-baseline.mjs"))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    throw new Error(
        `[BL-382] cannot find the one workspace from ${start}; expected ` +
            "A03-xihe/scripts/perf/run-baseline.mjs (one root marker)",
    );
}

function resolveEvidenceDir(): string {
    const oneRoot = resolveOneRoot();
    const planEvidence = path.join(
        oneRoot,
        "plans",
        "PLAN-0682-XH-bl382-session-scale-measure",
        "evidence",
    );
    if (!existsSync(planEvidence)) {
        throw new Error(
            `[BL-382] one workspace at ${oneRoot} has no ` +
                "plans/PLAN-0682-XH-bl382-session-scale-measure/evidence/; " +
                "raw JSON must land in the PLAN",
        );
    }
    return path.join(planEvidence, "raw");
}

type RawSample = {
    renderedRows: number;
    storeMessages: number | null; // B-05：只读探针拿不到记 null，不 fake
    domNodes: number;
    jsEventListeners: number;
    documents: number;
    heapMb: number;
};

type Summary = { median: number; min: number; max: number };

type BackfillPage = {
    round: number;
    ms: number; // load-older 点击 → 增长信号变化 的墙钟耗时
    networkPageRequests: number;
    store: number | null;
    renderedRows: number;
};

/** 回填循环护栏：每轮一页（50 条），20k 档 400 轮内耗尽；兜底防 runaway。 */
const MAX_BACKFILL_ROUNDS = 500;
const BACKFILL_STALL_ROUNDS = 2;

type MessagePageSample = {
    at: string;
    ms: number | null;
    count: number | null; // envelope messages 条数；非 JSON 响应记 null
    nextCursor: string | null;
    truncated: boolean | null;
};

type PiniaChatState = { chat?: { messages?: Record<string, readonly unknown[]> } };
type VueAppLike = {
    config: { globalProperties: { $pinia?: { state: { value: PiniaChatState } } } };
};

/** 只读探针：`chat` store 的 `messages[sessionId].length`（store 定义 chat.ts:45-49）。 */
async function storeMessagesProbe(page: Page, sessionId: string): Promise<number | null> {
    try {
        return await page.evaluate((sid: string) => {
            const app = (window as unknown as { __vue_app__?: VueAppLike }).__vue_app__;
            const messages = app?.config.globalProperties.$pinia?.state.value.chat?.messages?.[sid];
            return Array.isArray(messages) ? messages.length : null;
        }, sessionId);
    } catch (error) {
        // B-05 null 纪律：探针失败一律记 null 并附因，绝不 fake 数值。
        console.warn(
            `[BL-382] store probe unavailable: ${error instanceof Error ? error.message : error}`,
        );
        return null;
    }
}

/** bl348 同款采样：GC×2 → 双 rAF → CDP 堆/DOM 计数 + 渲染行 + store 条数。 */
async function sampleOnce(page: Page, cdp: CDPSession, sessionId: string): Promise<RawSample> {
    for (let round = 0; round < PROTOCOL.gcRounds; round += 1) {
        await cdp.send("HeapProfiler.collectGarbage");
    }
    await page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
    );
    const used = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
    const counters = (await cdp.send("Memory.getDOMCounters")) as {
        documents: number;
        nodes: number;
        jsEventListeners: number;
    };
    const renderedRows = await page.evaluate(
        () => document.querySelectorAll('[data-testid="message-item"]').length,
    );
    return {
        renderedRows,
        storeMessages: await storeMessagesProbe(page, sessionId),
        domNodes: counters.nodes,
        jsEventListeners: counters.jsEventListeners,
        documents: counters.documents,
        heapMb: Math.round((used.usedSize / 1024 / 1024) * 10) / 10,
    };
}

function summarize(values: number[]): Summary {
    const sorted = [...values].sort((left, right) => left - right);
    return {
        median: sorted[Math.floor(sorted.length / 2)] ?? 0,
        min: sorted[0] ?? 0,
        max: sorted[sorted.length - 1] ?? 0,
    };
}

/** 全 null（B-05 通道不可用）时整体记 null，不产 0 中位假数据。 */
function summarizeNullable(values: Array<number | null>): Summary | null {
    const usable = values.filter((value): value is number => value !== null);
    return usable.length > 0 ? summarize(usable) : null;
}

function metricsOf(raw: RawSample[]): {
    renderedRows: Summary;
    storeMessages: Summary | null;
    domNodes: Summary;
    jsHeapMb: Summary;
    jsEventListeners: Summary;
    documents: Summary;
} {
    return {
        renderedRows: summarize(raw.map((item) => item.renderedRows)),
        storeMessages: summarizeNullable(raw.map((item) => item.storeMessages)),
        domNodes: summarize(raw.map((item) => item.domNodes)),
        jsHeapMb: summarize(raw.map((item) => item.heapMb)),
        jsEventListeners: summarize(raw.map((item) => item.jsEventListeners)),
        documents: summarize(raw.map((item) => item.documents)),
    };
}

/** PROTOCOL.samples 次 sampleOnce；间隔为测量协议 pacing（bl348 同款），非就绪等待。 */
async function sampleSeries(page: Page, cdp: CDPSession, sessionId: string): Promise<RawSample[]> {
    const raw: RawSample[] = [];
    for (let index = 0; index < PROTOCOL.samples; index += 1) {
        raw.push(await sampleOnce(page, cdp, sessionId));
        await page.waitForTimeout(PROTOCOL.sampleIntervalMs);
    }
    return raw;
}

/** 消息条数连续 stablePolls 轮不变才算稳定（readiness-by-polling，替代固定 sleep）。 */
async function waitForMessageCountStable(
    page: Page,
    stablePolls = 3,
    timeout = 60_000,
): Promise<number> {
    let previous = -1;
    let stable = 0;
    await expect
        .poll(
            async () => {
                const count = await page.locator('[data-testid="message-item"]').count();
                stable = count === previous ? stable + 1 : 1;
                previous = count;
                return stable;
            },
            { timeout, intervals: [500, 1000] },
        )
        .toBeGreaterThan(stablePolls - 1);
    return previous;
}

/** longtask 观察器（语义对齐 bl329 `longTasksPer4s`；buffered 兜住导航期，只采不断言）。 */
async function installLongTaskObserver(page: Page): Promise<void> {
    await page.evaluate(() => {
        const w = window as typeof window & { __bl382LongTasks?: number[] };
        if (w.__bl382LongTasks) return;
        w.__bl382LongTasks = [];
        new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) w.__bl382LongTasks?.push(entry.duration);
        }).observe({ type: "longtask", buffered: true });
    });
}

async function drainLongTasks(page: Page): Promise<number[]> {
    return page.evaluate(() => {
        const w = window as typeof window & { __bl382LongTasks?: number[] };
        const drained = w.__bl382LongTasks ?? [];
        w.__bl382LongTasks = [];
        return drained;
    });
}

/** 网络侧：消息列表 GET（路径形如 /api/v1/sessions/{id}/messages）的 envelope 条数 / nextCursor / truncated / 耗时。 */
function trackMessagePages(page: Page): { samples: MessagePageSample[]; stop: () => void } {
    const samples: MessagePageSample[] = [];
    const listener = (response: Response): void => {
        if (response.request().method() !== "GET") return;
        if (!/\/api\/v1\/sessions\/[^/]+\/messages/.test(new URL(response.url()).pathname)) return;
        // Playwright Request.timing()：responseEnd 相对 startTime（毫秒），-1 不可用。
        // T1.3 试跑校对绝对/相对口径后再固化。
        const timing = response.request().timing();
        const entry: MessagePageSample = {
            at: new Date().toISOString(),
            ms: timing.responseEnd >= 0 ? Math.round(timing.responseEnd) : null,
            count: null,
            nextCursor: null,
            truncated: null,
        };
        samples.push(entry);
        void response.json().then(
            (body) => {
                const envelope = body as {
                    messages?: unknown[];
                    nextCursor?: string | null;
                    truncated?: boolean;
                };
                entry.count = Array.isArray(envelope.messages) ? envelope.messages.length : null;
                entry.nextCursor = envelope.nextCursor ?? null;
                entry.truncated = envelope.truncated ?? null;
            },
            () => {
                // 非 JSON 响应：条数保持 null（不 fake）。
            },
        );
    };
    page.on("response", listener);
    return { samples, stop: () => page.off("response", listener) };
}

/** A03 仓库根：Playwright 从 packages/ui 启动（见 e2e-host.mjs 的 uiDir）。 */
function repoRoot(): string {
    return path.resolve(process.cwd(), "..", "..");
}

type SeedRunsResult = {
    phase: string;
    tier: string;
    seeded: number;
    runs: number;
    sessionId: string;
};

/**
 * T1.3 route A：在 journey 自建 session 的 root branch 上直灌 tier 条 run-linked messages。
 * 只调用已提交的 facility（seed-runs），不经过 API，不碰任何非 XIHE_E2E_PG_* 指向的隔离库；
 * facility 自己会在同一事务里断言行数，失败即 throw，绝不让测量在空/半灌数据上继续。
 */
function seedOwnSession(
    sessionId: string,
    tier: Tier,
    container: string,
    db: string,
): SeedRunsResult {
    // 与 measure 脚本同一隔离判据：只允许 per-run PG 容器与 xihe_e2e_* 库，绝不落到
    // 固定 stack-1/stack-2 或共享库上（seed-runs --apply 会真实写库）。
    if (
        !container.endsWith("-postgres-1") ||
        /a03-xihe-postgres|stack-1|stack-2/i.test(container)
    ) {
        throw new Error(`[BL-382] refusing non-isolated PG container: ${container}`);
    }
    if (!/^xihe_e2e_[a-z0-9_]+$/i.test(db)) {
        throw new Error(`[BL-382] refusing non-isolated database: ${db}`);
    }
    const script = path.join(repoRoot(), "scripts", "perf", "run-baseline.mjs");
    const stdout = execFileSync(
        process.execPath,
        [
            script,
            "seed-runs",
            "--apply",
            "--tier",
            tier,
            "--container",
            container,
            "--db",
            db,
            "--session",
            sessionId,
        ],
        {
            cwd: repoRoot(),
            encoding: "utf8",
            // stderr 必须保留给失败诊断，但绝不打印环境里的 token/密码；facility 只输出计数 JSON。
            stdio: ["ignore", "pipe", "pipe"],
        },
    ).trim();
    const lastLine = stdout.split(/\r?\n/).at(-1) ?? "";
    let parsed: SeedRunsResult;
    try {
        parsed = JSON.parse(lastLine) as SeedRunsResult;
    } catch (error) {
        throw new Error(
            `[BL-382] seed-runs returned non-JSON output: ${lastLine.slice(0, 300)} ` +
                `(${error instanceof Error ? error.message : String(error)})`,
        );
    }
    if (
        parsed.phase !== "seed-runs" ||
        parsed.sessionId !== sessionId ||
        parsed.tier !== tier ||
        parsed.seeded !== TIERS[tier] ||
        parsed.runs !== TIERS[tier] / 2
    ) {
        throw new Error(
            `[BL-382] seed-runs result mismatch: expected tier=${tier} seeded=${TIERS[tier]} ` +
                `runs=${TIERS[tier] / 2} session=${sessionId}; got ${JSON.stringify(parsed)}`,
        );
    }
    console.log(`[BL-382 SEED] ${JSON.stringify(parsed)}`);
    return parsed;
}

/** 口径字段：被测栈对应的 A03 worktree commit / dirty（读不到记 null 并附因）。 */
function worktreeCaliber(): { commit: string | null; dirty: boolean | null } {
    try {
        const root = repoRoot(); // packages/ui → A03 根
        const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
            encoding: "utf8",
        }).trim();
        const status = execFileSync("git", ["-C", root, "status", "--porcelain"], {
            encoding: "utf8",
        });
        return { commit, dirty: status.length > 0 };
    } catch (error) {
        console.warn(
            `[BL-382] git caliber unavailable: ${error instanceof Error ? error.message : error}`,
        );
        return { commit: null, dirty: null };
    }
}

test.describe("PLAN-0682 会话规模测量（BL-382 · 真栈）", () => {
    test.describe.configure({ mode: "serial", retries: 0 });

    test("双口径：初始窗口 + 滚动回填（CDP 采样两轮并写 JSON） @host", async ({ page, request }) => {
        const tierName = process.env.XIHE_BL382_TIER;
        const tier = tierName && tierName in TIERS ? (tierName as Tier) : null;
        const envSessionId = process.env.XIHE_BL382_SESSION;
        const selfSeed = process.env.XIHE_BL382_SELF_SEED === "1";
        test.skip(
            !process.env.XIHE_E2E_PG_CONTAINER || !tier || (!selfSeed && !envSessionId),
            "requires the isolated e2e-host stack + XIHE_BL382_TIER (1k|5k|20k) and a session route: " +
                "XIHE_BL382_SELF_SEED=1 (route A) or XIHE_BL382_SESSION=<uuid> (route B)",
        );
        if (!tier) throw new Error("unreachable: test.skip handled missing XIHE_BL382_TIER");
        // 回填轮次随档位增长（20k≈400 页），实跑预算 T1.3 试跑后再收敛。
        test.setTimeout(1_200_000);
        const evidenceDir = resolveEvidenceDir();
        mkdirSync(evidenceDir, { recursive: true });
        const caliber = worktreeCaliber();

        // 真链路序（design §3 D2 前置，同 plan0670-m2d-smoke 组织）：建号 → direct_attach
        // workspace → fake provider → principal → 路径形式建 session。
        const ctx = await registerJourneyUser(request, "bl382-measure");
        const wsId = ctx.workspaceId;
        const headers = { ...ctx.headers, "X-Workspace-Id": wsId };
        await waitForControlPlaneAgentReady(request, headers);
        const auth = { accessToken: ctx.authToken, workspaceId: wsId };
        await ensureFakeUserProvider(request, auth);
        const principalId = await provisionWorkspaceAgentPrincipal(request, auth, {
            name: agentName("Bl382Measure", Date.now()),
            actions: ["read"],
            systemPrompt: "Reply briefly.",
        });
        const ownSessionId = await createSessionWithPrincipal(request, auth, {
            principalId,
            title: "BL-382 scale measurement",
            workspaceId: wsId,
        });
        let seedResult: SeedRunsResult | null = null;
        if (selfSeed) {
            if (envSessionId) {
                throw new Error(
                    "XIHE_BL382_SELF_SEED=1 cannot be combined with XIHE_BL382_SESSION; " +
                        "route A seeds the journey-created session, route B measures an existing one",
                );
            }
            const container = process.env.XIHE_E2E_PG_CONTAINER;
            const db = process.env.XIHE_E2E_PG_DATABASE;
            if (!container || !db) {
                throw new Error(
                    "XIHE_BL382_SELF_SEED=1 requires XIHE_E2E_PG_CONTAINER and XIHE_E2E_PG_DATABASE " +
                        "from the isolated e2e-host runner",
                );
            }
            // 必须在打开 ChatPanel 之前完成直灌，避免 UI 先读到空会话再靠重载补救。
            seedResult = seedOwnSession(ownSessionId, tier, container, db);
        }
        const targetSessionId = envSessionId ?? ownSessionId;
        const seededSession = selfSeed || Boolean(envSessionId);

        const pages = trackMessagePages(page);
        try {
            await seedPage(page, ctx);
            await page.goto(workspaceChatPath(wsId, targetSessionId));
            await expect(page.getByTestId("message-list")).toBeVisible({ timeout: 60_000 });
            const initialRows = await waitForMessageCountStable(page);
            await installLongTaskObserver(page);
            const initialTasks = await drainLongTasks(page);

            const cdp = await page.context().newCDPSession(page);
            await cdp.send("HeapProfiler.enable");
            await cdp.send("Runtime.enable");
            const raw = await sampleSeries(page, cdp, targetSessionId);

            const metrics = metricsOf(raw);
            const chromium = await page.evaluate(() => navigator.userAgent);
            const viewport = page.viewportSize() ?? { width: 0, height: 0 };
            const dpr = await page.evaluate(() => window.devicePixelRatio);
            const caliberFields = { ...caliber, chromium, viewport, dpr };
            const payload = {
                generatedAt: new Date().toISOString(),
                plan: "PLAN-0682",
                task: "T1.1 initial-window sample",
                tier,
                seededSession,
                selfSeeded: selfSeed,
                seed: seedResult
                    ? {
                          phase: seedResult.phase,
                          tier: seedResult.tier,
                          seeded: seedResult.seeded,
                          runs: seedResult.runs,
                      }
                    : null,
                sessionId: targetSessionId,
                initialRows,
                protocol: PROTOCOL,
                longTasksDuringInitialWindow: initialTasks,
                network: pages.samples,
                raw,
                metrics,
                caliber: caliberFields,
            };
            const outPath =
                process.env.XIHE_BL382_OUT ??
                path.join(evidenceDir, `bl382-${tier}-initial-window.json`);
            writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
            console.log(`[BL-382 SAMPLE] ${JSON.stringify(metrics)}`);
            console.log(`[BL-382 SAMPLE] evidence: ${outPath}`);

            // ── T1.2 回填口径（骨架先行，实跑待窗口）：循环滚顶 → load-older 直至耗尽/不再增长 ──
            const viewportEl = page.getByTestId("message-scroller-viewport");
            // 增长信号：store 条数优先；B-05 探针不可用时回落网络页请求数（选一次，整轮粘住）。
            const storeWorks = (await storeMessagesProbe(page, targetSessionId)) !== null;
            const growth = async (): Promise<number> =>
                storeWorks
                    ? ((await storeMessagesProbe(page, targetSessionId)) ?? 0)
                    : pages.samples.length;
            const backfillPages: BackfillPage[] = [];
            let exhaustedAtRound: number | null = null;
            let stallTerminated = false;
            let previousGrowth = await growth();
            let stallRounds = 0;
            for (let round = 1; round <= MAX_BACKFILL_ROUNDS; round += 1) {
                await viewportEl.hover();
                // 真实 wheel 意图（userScrollIntent）→ 滚到顶 → load-older 入口出现
                // （plan0670-m2d-smoke.spec.ts:148-161 同款入口链）。
                await page.mouse.wheel(0, -100_000);
                await expect
                    .poll(async () => await viewportEl.evaluate((el) => el.scrollTop), {
                        timeout: 30_000,
                        intervals: [200, 500, 1000],
                    })
                    .toBe(0);
                const loadOlder = page.getByTestId("load-older-messages");
                if (!(await loadOlder.isVisible().catch(() => false))) {
                    exhaustedAtRound = round; // olderExhausted：入口不再出现
                    break;
                }
                const samplesBefore = pages.samples.length;
                const startedAt = Date.now();
                await loadOlder.click();
                let grew = true;
                try {
                    await expect
                        .poll(growth, { timeout: 45_000, intervals: [500, 1000] })
                        .toBeGreaterThan(previousGrowth);
                } catch {
                    // cap/加载停止是**终态信号**不是失败：登记后按 stall 收敛（决策 #4）。
                    grew = false;
                }
                if (!grew) {
                    stallRounds += 1;
                    if (stallRounds >= BACKFILL_STALL_ROUNDS) {
                        stallTerminated = true;
                        break;
                    }
                } else {
                    stallRounds = 0;
                    previousGrowth = await growth();
                }
                backfillPages.push({
                    round,
                    ms: Date.now() - startedAt,
                    networkPageRequests: pages.samples.length - samplesBefore,
                    store: await storeMessagesProbe(page, targetSessionId),
                    renderedRows: await page.locator('[data-testid="message-item"]').count(),
                });
            }
            const backfillTasks = await drainLongTasks(page);
            const finalRaw = await sampleSeries(page, cdp, targetSessionId);
            const finalMetrics = metricsOf(finalRaw);
            const backfillPayload = {
                generatedAt: new Date().toISOString(),
                plan: "PLAN-0682",
                task: "T1.2 backfill caliber (skeleton; live run pending stack window)",
                tier,
                seededSession,
                selfSeeded: selfSeed,
                seed: seedResult
                    ? {
                          phase: seedResult.phase,
                          tier: seedResult.tier,
                          seeded: seedResult.seeded,
                          runs: seedResult.runs,
                      }
                    : null,
                sessionId: targetSessionId,
                backfill: {
                    rounds: backfillPages.length,
                    maxRounds: MAX_BACKFILL_ROUNDS,
                    exhaustedAtRound,
                    stallTerminated,
                    pages: backfillPages,
                },
                longTasksDuringBackfill: backfillTasks,
                final: { raw: finalRaw, metrics: finalMetrics },
                caliber: caliberFields,
            };
            const backfillPath = path.join(evidenceDir, `bl382-${tier}-backfill.json`);
            writeFileSync(backfillPath, `${JSON.stringify(backfillPayload, null, 2)}\n`, "utf8");
            console.log(
                `[BL-382 BACKFILL] rounds=${backfillPages.length} exhausted=${exhaustedAtRound} stall=${stallTerminated}`,
            );
            console.log(`[BL-382 BACKFILL] final=${JSON.stringify(finalMetrics)}`);
            console.log(`[BL-382 BACKFILL] evidence: ${backfillPath}`);
            // 通道不做阈值断言（决策 #4）；上面各结构门（可见/稳定/增长等待）已足够判定采样成立。
        } finally {
            pages.stop();
        }
    });
});
