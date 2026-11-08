// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
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
 *      同时使用；可选 `XIHE_BL382_OUT=<某文件>.json` 把**两份**口径 JSON 一起挪到该目录（同前缀，
 *      见 `evidencePaths()`）—— 只有一份吃这个 env 时，同一轮测量的两口径会分落两处、事后对不上。
 *
 * 证据口径：JSON 的 `seededSession` / `selfSeeded` / `seed` 字段必须能区分「本身份自建回灌」与
 * 「外部预置会话」，否则测量对象归属不可复核。
 *
 * T1.2 回填口径（PLAN-0682 task-51 修探针与收敛判据）：同一会话内继续滚动回填——循环
 * 「滚顶（真实 wheel 意图）→ load-older 点击」，每轮先读**页面侧事实**再判定收敛：
 * ① 页响应 `count=0`；② `nextCursor` 连续两次相同（并计重复请求数）；③ 入口消失；
 * ④ 入口在场但点击 0 页请求且 store 已到 500 上限（`hasOlder=false` 时入口只因折叠计数
 * 在场）；⑤ CP 声明 `truncated=false`/`nextCursor=null`。**⑥ 不是终态**：store 到
 * `MAX_LOADED_MESSAGES`(500) 后每轮只换页不驻留（cap 生效），只记 `storeCapAtRound` /
 * 每轮 `storeCapped`，回填继续到页面侧终态 —— 否则 20k 档会在第 10 轮被 cap 提前截断。
 * 命中哪条终态信号写进 `backfill.exhaustedBy`；
 * `stallTerminated`（增长连续 2 轮不动）与 `exhaustedAtRound` **分开记**，超时绝不冒充
 * 耗尽。终态采样 ×5；回填窗口 longtask 与逐页耗时只登记不断言。
 *
 * **`renderedRows` 的语义（task-51 归因）**：它是**窗口内渲染的消息行数**，不是已加载
 * 条数。渲染行变少有两个成因：①窗口化 —— `MessageList.vue:340-369` 在
 * `rows.length > DEFAULT_VIRTUAL_MIN_ROWS(=150)` 时启用（`virtualWindow.ts:42`），只渲染
 * `virtualWindow` 内的行；②run 组折叠 —— `MessageList.vue:280-281` 对 `collapsed` 组
 * `continue`，折叠组只剩组头、消息行不渲染。所以初始 50 → 终态 8 是**渲染侧减少**，不是
 * 丢行；已加载条数看 `storeMessages`/`foldedOlder`，二分成因看 `virtualization.active` +
 * `runHeaders`（组头数），活动 DOM 看 `liveDomNodes`（`Memory.getDOMCounters.nodes` 是
 * inspector 侧计数，含已卸载但尚未回收的节点，大换手后不能当活动 DOM 读）。
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
import { ACTION_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

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

/**
 * T1.2 双口径两份 JSON 的落盘路径（①初始窗口 / ②滚动回填）。
 *
 * `XIHE_BL382_OUT` 覆盖时**两份一起挪**（同目录 + 同前缀）：只有初始窗口吃这个 env 的旧写法，
 * 会让同一轮测量的两口径分落两处，事后无法判定它们是否同一会话同一构建。
 */
function evidencePaths(evidenceDir: string, tier: Tier): { initial: string; backfill: string } {
    const override = process.env.XIHE_BL382_OUT;
    if (override) {
        const resolved = path.resolve(override);
        const stem = path
            .basename(resolved)
            .replace(/\.json$/i, "")
            .replace(/-initial-window$/, "");
        return {
            initial: path.join(path.dirname(resolved), `${stem}-initial-window.json`),
            backfill: path.join(path.dirname(resolved), `${stem}-backfill.json`),
        };
    }
    return {
        initial: path.join(evidenceDir, `bl382-${tier}-initial-window.json`),
        backfill: path.join(evidenceDir, `bl382-${tier}-backfill.json`),
    };
}

type VirtualizationSample = {
    /** 窗口化是否真正生效（两个 spacer 同时在场即生效，见 MessageList.vue:483/556）。 */
    active: boolean;
    topSpacerPx: number | null;
    bottomSpacerPx: number | null;
};

type RawSample = {
    /** 窗口内渲染的消息行数（≠ 已加载条数，见文件头 task-51 归因）。 */
    renderedRows: number;
    /** 只读探针读到的 store 条数；task-51 起**取不到即抛错**，不再记 null。 */
    storeMessages: number;
    /** store 500 上限折叠掉的更旧条数（读入口文案"更早的 N 条…已折叠"）；入口不在场记 null。 */
    foldedOlder: number | null;
    /** 活动 DOM：`document.querySelectorAll("*").length`（与 inspector 侧 `domNodes` 对照）。 */
    liveDomNodes: number;
    /**
     * DOM 里的 run 组头数（`[data-run-block]`）。渲染行变少有两个成因：窗口化切片
     * （`MessageList.vue:366-369`）与 run 组折叠（`MessageList.vue:280-281` 的
     * `if (header.collapsed) continue`）—— 记下组头数，实跑时才能二分是哪一个。
     */
    runHeaders: number;
    virtualization: VirtualizationSample;
    /** 本次探针命中的根/路径，落 JSON 供复核。 */
    probeSource: string;
    domNodes: number;
    jsEventListeners: number;
    documents: number;
    heapMb: number;
};

type Summary = { median: number; min: number; max: number };

/** 回填终态信号：命中哪条就按哪条收敛，`null` = 未命中（继续回填）。 */
type BackfillSignal =
    | "entry-gone" // 更旧入口不再渲染
    | "entry-inert" // 入口在场但点击 0 页请求（hasOlder=false，入口只因折叠计数在场）
    | "empty-page" // 页响应 count=0
    | "cursor-repeat" // nextCursor 连续两次相同（CP 游标没前进）
    | "page-end"; // CP 声明 truncated=false / nextCursor=null

type BackfillPage = {
    round: number;
    ms: number; // load-older 点击 → 本轮判定结束 的墙钟耗时
    networkPageRequests: number;
    store: number; // 硬探针，不再 null
    foldedOlder: number | null;
    storeDelta: number; // 相对上一轮 store 条数变化
    renderedRows: number;
    /** DOM 里的 run 组头数（区分"窗口化切片"与"run 组折叠"两种渲染行变少）。 */
    runHeaders: number;
    virtualized: boolean;
    /** 本轮 store 是否已在 500 上限（只换页不驻留）；**不是**耗尽信号，回填继续。 */
    storeCapped: boolean;
    page: { count: number | null; nextCursor: string | null; truncated: boolean | null } | null;
    cursorRepeated: boolean;
    signal: BackfillSignal | null;
};

/** 回填循环护栏：每轮一页（50 条），20k 档 400 轮内耗尽；兜底防 runaway。 */
const MAX_BACKFILL_ROUNDS = 500;
const BACKFILL_STALL_ROUNDS = 2;

/**
 * `ChatPanel.vue:237` 的 `MAX_LOADED_MESSAGES`：store 只保留最新 500 条，更旧的进
 * `foldedMessageCount`。回填到 500 后每页都被 `trimMessages` 掉 ⇒ store 条数不再增长；
 * 这是**设计上限**，必须与"耗尽"分开记，否则 20k 档会一直等到超时。
 */
const MAX_LOADED_MESSAGES = 500;

/**
 * 探针事实（写进 JSON，供复核"数值是从哪条路径读到的"）。
 *
 * task-51：旧探针读 `window.__vue_app__`，而 `@vue/runtime-dom` 只把 app 挂在**根容器
 * 元素**上（本项目 `index.html:36 <div id="app">` + `main.ts:32 app.mount("#app")`），
 * window 上永远没有 ⇒ 恒 null，再被 try/catch 静默吞掉，T1.2 的判据数值从未真正测到。
 */
const PROBE_CALIBER = {
    mount: 'index.html:36 `<div id="app">` + main.ts:32 `app.mount("#app")`',
    appInstance: "根容器元素.__vue_app__（@vue/runtime-dom 写入；不在 window 上）",
    storePath: "config.globalProperties.$pinia.state.chat.messages[sessionId].length",
    unavailability: "缺失即 throw，无 null 回落（不允许用网络页计数冒充 store 驻留）",
    renderedRowsSemantics:
        "窗口内渲染行数 ≠ 已加载条数；渲染行变少有两个成因：①窗口化切片" +
        "（rows.length > DEFAULT_VIRTUAL_MIN_ROWS(150) ⇒ MessageList.vue:340-369 / " +
        "virtualWindow.ts:42，spacer 在场即 active）②run 组折叠" +
        "（MessageList.vue:280-281 跳过 collapsed 组的消息行）。已加载条数看 " +
        "storeMessages/foldedOlder；二分成因看 virtualization.active + runHeaders",
} as const;

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

type StoreProbe = {
    storeMessages: number;
    foldedOlder: number | null;
    liveDomNodes: number;
    messageRows: number;
    runHeaders: number;
    virtualization: VirtualizationSample;
    source: string;
};

/**
 * 只读探针：`chat` store 的 `messages[sessionId].length`（store 定义 chat.ts:45-49）。
 *
 * **取不到就抛错**（task-51）：这里没有任何 catch 把失败降级成 null ——
 * `page.evaluate` 抛出的异常会直接让本 spec 失败。"探针坏了"必须表现为红，而不是让
 * 判据数值悄悄退化成网络页计数。
 */
async function storeProbe(page: Page, sessionId: string): Promise<StoreProbe> {
    return page.evaluate((sid: string) => {
        const probeError = (reason: string, detail: Record<string, unknown>): Error =>
            new Error(`[BL-382] store probe unavailable: ${reason} ${JSON.stringify(detail)}`);
        // ① 真实渲染根：#app（main.ts 的 mount 点）；body 直接子节点兜底 —— Vue 只把
        //    `__vue_app__` 挂在根容器元素上，window 上恒无（旧探针的根因）。
        const direct = document.getElementById("app");
        const candidates: Array<[string, Element | null]> = [
            ["#app", direct],
            ...[...document.body.children].map((element, index): [string, Element | null] => [
                `body>${element.tagName.toLowerCase()}:${index}`,
                element,
            ]),
        ];
        let rootSelector = "";
        let app: VueAppLike | undefined;
        for (const [selector, element] of candidates) {
            const instance = (element as unknown as { __vue_app__?: VueAppLike } | null)
                ?.__vue_app__;
            if (instance) {
                rootSelector = selector;
                app = instance;
                break;
            }
        }
        if (!app) {
            throw probeError("no element carries __vue_app__", {
                hasAppElement: Boolean(direct),
                bodyChildren: document.body.children.length,
                tried: candidates.map(([selector]) => selector),
            });
        }
        const pinia = app.config.globalProperties.$pinia;
        if (!pinia) {
            throw probeError("app.config.globalProperties.$pinia missing", { rootSelector });
        }
        const state = pinia.state.value;
        const chat = state.chat;
        if (!chat) {
            throw probeError("pinia has no `chat` store", { stores: Object.keys(state) });
        }
        const messages = chat.messages?.[sid];
        if (!Array.isArray(messages)) {
            throw probeError("chat.messages[sessionId] is not an array", {
                rootSelector,
                knownSessions: Object.keys(chat.messages ?? {}).length,
                sessionId: sid,
            });
        }
        // ② 折叠计数：只有折叠入口在场时才读文案（`chat.foldedOlder` = "更早的 N 条…已折叠"，
        //    i18n/index.ts:869）；常规"加载更早"文案没有数字 ⇒ null。
        const foldedMatch = document
            .querySelector('[data-testid="load-older-messages"]')
            ?.textContent?.match(/(\d+)/);
        const topSpacer = document.querySelector('[data-testid="virtual-top-spacer"]');
        const bottomSpacer = document.querySelector('[data-testid="virtual-bottom-spacer"]');
        const heightOf = (element: Element | null): number | null =>
            element instanceof HTMLElement
                ? Math.round(element.getBoundingClientRect().height)
                : null;
        return {
            storeMessages: messages.length,
            foldedOlder: foldedMatch ? Number(foldedMatch[1]) : null,
            liveDomNodes: document.querySelectorAll("*").length,
            messageRows: document.querySelectorAll('[data-testid="message-item"]').length,
            runHeaders: document.querySelectorAll("[data-run-block]").length,
            virtualization: {
                active: Boolean(topSpacer && bottomSpacer),
                topSpacerPx: heightOf(topSpacer),
                bottomSpacerPx: heightOf(bottomSpacer),
            },
            source: `root=${rootSelector}.__vue_app__ → $pinia.state.chat.messages[${sid}]`,
        };
    }, sessionId);
}

/** bl348 同款采样：GC×2 → 双 rAF → CDP 堆/DOM 计数 + 探针（store/窗口化/活动 DOM）。 */
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
    // 探针取不到就抛错（task-51）：采样失败即本 spec 失败，不留 null 假数据。
    const probe = await storeProbe(page, sessionId);
    return {
        renderedRows: probe.messageRows,
        storeMessages: probe.storeMessages,
        foldedOlder: probe.foldedOlder,
        liveDomNodes: probe.liveDomNodes,
        runHeaders: probe.runHeaders,
        virtualization: probe.virtualization,
        probeSource: probe.source,
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

/** 全 null（入口不在场）时整体记 null，不产 0 中位假数据。 */
function summarizeNullable(values: Array<number | null>): Summary | null {
    const usable = values.filter((value): value is number => value !== null);
    return usable.length > 0 ? summarize(usable) : null;
}

function metricsOf(raw: RawSample[]): {
    renderedRows: Summary;
    storeMessages: Summary;
    foldedOlder: Summary | null;
    liveDomNodes: Summary;
    runHeaders: Summary;
    domNodes: Summary;
    jsHeapMb: Summary;
    jsEventListeners: Summary;
    documents: Summary;
    virtualizationActiveSamples: number;
} {
    return {
        renderedRows: summarize(raw.map((item) => item.renderedRows)),
        storeMessages: summarize(raw.map((item) => item.storeMessages)),
        foldedOlder: summarizeNullable(raw.map((item) => item.foldedOlder)),
        liveDomNodes: summarize(raw.map((item) => item.liveDomNodes)),
        runHeaders: summarize(raw.map((item) => item.runHeaders)),
        domNodes: summarize(raw.map((item) => item.domNodes)),
        jsHeapMb: summarize(raw.map((item) => item.heapMb)),
        jsEventListeners: summarize(raw.map((item) => item.jsEventListeners)),
        documents: summarize(raw.map((item) => item.documents)),
        virtualizationActiveSamples: raw.filter((item) => item.virtualization.active).length,
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

    test("双口径：初始窗口 + 滚动回填（CDP 采样两轮并写 JSON） @host", async ({
        page,
        request,
    }) => {
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
        const evidenceDir = resolveEvidenceDir();
        mkdirSync(evidenceDir, { recursive: true });
        const caliber = worktreeCaliber();
        /** 双口径两份 JSON 的落点（同一覆盖规则，见 evidencePaths）。 */
        const paths = evidencePaths(evidenceDir, tier);

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
            await expect(page.getByTestId("message-list")).toBeVisible({
                timeout: LONG_TIMEOUT_MS,
            });
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
                task: "T1.2 dual-caliber #1: initial-window sample (store expected ≈50 = MESSAGE_PAGE_SIZE)",
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
                probe: PROBE_CALIBER,
                protocol: PROTOCOL,
                longTasksDuringInitialWindow: initialTasks,
                network: pages.samples,
                raw,
                metrics,
                caliber: caliberFields,
            };
            writeFileSync(paths.initial, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
            console.log(`[BL-382 SAMPLE] ${JSON.stringify(metrics)}`);
            console.log(`[BL-382 SAMPLE] evidence: ${paths.initial}`);

            // ── T1.2 回填口径（task-51：页面侧事实 + store 硬探针，超时不得冒充耗尽）─────
            const viewportEl = page.getByTestId("message-scroller-viewport");
            /**
             * 增长/驻留信号**只**取 store 硬探针（取不到即红）；不再回落网络页计数 ——
             * 网络计数是"请求发生了"不是"消息驻留了"，拿它冒充会把 500 条 cap 读成"还在长"。
             */
            const storeCount = async (): Promise<number> =>
                (await storeProbe(page, targetSessionId)).storeMessages;
            const backfillPages: BackfillPage[] = [];
            let exhaustedAtRound: number | null = null;
            let exhaustedBy: BackfillSignal | null = null;
            let stallTerminated = false;
            let duplicateCursorRequests = 0;
            /** 双口径 #1 的终值快照：回填起点的 store/渲染事实，随回填 JSON 一起落盘。 */
            const probeAtInitial = await storeProbe(page, targetSessionId);
            let previousGrowth = probeAtInitial.storeMessages;
            let previousCursor = pages.samples.at(-1)?.nextCursor ?? null;
            let stallRounds = 0;
            /** store 首次到 500 上限的轮次（cap 只登记、不终止回填，见文件头 ⑥）。 */
            let storeCapAtRound: number | null = null;
            for (let round = 1; round <= MAX_BACKFILL_ROUNDS; round += 1) {
                await viewportEl.hover();
                // 真实 wheel 意图（userScrollIntent）→ 滚到顶 → load-older 入口出现
                // （plan0670-m2d-smoke.spec.ts:148-161 同款入口链）。
                await page.mouse.wheel(0, -100_000);
                await expect
                    .poll(async () => await viewportEl.evaluate((el) => el.scrollTop), {
                        timeout: LONG_TIMEOUT_MS,
                        intervals: [200, 500, 1000],
                    })
                    .toBe(0);
                const loadOlder = page.getByTestId("load-older-messages");
                // 不用 catch 包 isVisible：locator 无匹配只会返回 false；抛错 = 页面/上下文
                // 真出问题，必须红，不能记成"入口消失 ⇒ 已耗尽"。
                if (!(await loadOlder.isVisible())) {
                    exhaustedBy = "entry-gone"; // 信号 ③：入口不再渲染
                    exhaustedAtRound = round;
                    break;
                }
                const samplesBefore = pages.samples.length;
                const startedAt = Date.now();
                await loadOlder.click();
                // 信号 ④：先有界等"点击真的发出了页请求"。0 页请求 = hasOlder=false，
                // 入口只因 foldedCount>0 还在场（MessageList.vue:453 的 v-if）——旧实现
                // 在这里空等 45s 增长，把"已耗尽"记成了"停滞"。
                let issued = samplesBefore;
                try {
                    await expect
                        .poll(() => pages.samples.length, {
                            timeout: ACTION_TIMEOUT_MS,
                            intervals: [100, 250],
                        })
                        .toBeGreaterThan(samplesBefore);
                    issued = pages.samples.length;
                } catch {
                    // 保持 issued = samplesBefore：下面把它判成 entry-inert，不猜成增长。
                }
                const pageSample = issued > samplesBefore ? pages.samples[issued - 1] : null;
                // envelope 的 count/nextCursor/truncated 由 response.json() 异步补齐：有界等待；
                // 仍读不到就保留 null —— 读不到的数**绝不**用来宣称耗尽（不 fake）。
                if (pageSample) {
                    try {
                        await expect
                            .poll(
                                () => pageSample.count !== null || pageSample.truncated !== null,
                                {
                                    timeout: ACTION_TIMEOUT_MS,
                                    intervals: [100, 250],
                                },
                            )
                            .toBe(true);
                    } catch {
                        // 非 JSON 响应：count/nextCursor/truncated 保持 null。
                    }
                }
                const pageMeta = pageSample
                    ? {
                          count: pageSample.count,
                          nextCursor: pageSample.nextCursor,
                          truncated: pageSample.truncated,
                      }
                    : null;
                const counted = pageMeta?.count ?? null;
                const nextCursor = pageMeta?.nextCursor ?? null;
                const truncated = pageMeta?.truncated ?? null;
                const cursorRepeated = Boolean(
                    pageMeta &&
                    nextCursor !== null &&
                    previousCursor !== null &&
                    nextCursor === previousCursor,
                );
                if (cursorRepeated) duplicateCursorRequests += 1;
                // 到 cap 后 store 条数不再增长（trimMessages 丢掉的正是刚前插的更旧页），
                // 此时"增长"不再是进度信号 —— 用页面侧进度（拿到非空页）判定回填是否仍在推进，
                // 否则 20k 档会在第 10 轮被两次"没增长"误判成停滞。
                const atCap = previousGrowth >= MAX_LOADED_MESSAGES;
                let grew = false;
                if (!atCap) {
                    try {
                        await expect
                            .poll(storeCount, { timeout: LONG_TIMEOUT_MS, intervals: [500, 1000] })
                            .toBeGreaterThan(previousGrowth);
                        grew = true;
                    } catch {
                        // 增长没发生：**先确认探针仍可用**（探针坏了必须红，不能被"没增长"吞掉）。
                        await storeProbe(page, targetSessionId);
                    }
                }
                // 本轮结束时的探针事实（store 条数 / 折叠计数 / 窗口化 / 渲染行）。
                const probeAfter = await storeProbe(page, targetSessionId);
                const storeDelta = probeAfter.storeMessages - previousGrowth;
                const pageProgressed = Boolean(pageSample && (counted ?? 0) > 0);
                if (storeCapAtRound === null && probeAfter.storeMessages >= MAX_LOADED_MESSAGES) {
                    storeCapAtRound = round;
                }
                // 终态信号顺序：空页 → CP 声明到底 → 游标重复两次 → 无请求(cap)。
                let signal: BackfillSignal | null = null;
                if (pageSample && counted === 0) {
                    signal = "empty-page"; // 信号 ①
                } else if (pageSample && (truncated === false || nextCursor === null)) {
                    // 信号 ⑤：ChatPanel.vue:460 的 hasOlder = truncated && nextCursor，此处已假。
                    if (truncated !== null || counted !== null) signal = "page-end";
                } else if (cursorRepeated && duplicateCursorRequests >= 2) {
                    signal = "cursor-repeat"; // 信号 ②：连续两页游标没前进
                } else if (!pageSample && probeAfter.storeMessages >= MAX_LOADED_MESSAGES) {
                    // 信号 ④：入口只因折叠计数在场（hasOlder=false ⇒ 点击是 no-op），且 store 已到
                    // 500 上限 —— 这才叫"没有更旧的了"。store 未到上限却点不动说明是别的状态
                    // （例如 loading 卡住），记 null 交给 stall，不冒充耗尽。
                    signal = "entry-inert";
                }
                backfillPages.push({
                    round,
                    ms: Date.now() - startedAt,
                    networkPageRequests: pages.samples.length - samplesBefore,
                    store: probeAfter.storeMessages,
                    foldedOlder: probeAfter.foldedOlder,
                    storeDelta,
                    renderedRows: probeAfter.messageRows,
                    runHeaders: probeAfter.runHeaders,
                    virtualized: probeAfter.virtualization.active,
                    storeCapped: probeAfter.storeMessages >= MAX_LOADED_MESSAGES,
                    page: pageMeta,
                    cursorRepeated,
                    signal,
                });
                if (signal) {
                    exhaustedBy = signal;
                    exhaustedAtRound = round;
                    break;
                }
                // 进度 = store 长了 或 拿到了非空页（cap 后只剩后者可用）。
                if (grew || pageProgressed) {
                    stallRounds = 0;
                } else {
                    stallRounds += 1;
                }
                if (grew) previousGrowth = probeAfter.storeMessages;
                if (stallRounds >= BACKFILL_STALL_ROUNDS) {
                    stallTerminated = true;
                    break;
                }
                if (nextCursor !== null) previousCursor = nextCursor;
            }
            const backfillTasks = await drainLongTasks(page);
            const finalRaw = await sampleSeries(page, cdp, targetSessionId);
            const finalMetrics = metricsOf(finalRaw);
            const finalProbe = await storeProbe(page, targetSessionId);
            const backfillPayload = {
                generatedAt: new Date().toISOString(),
                plan: "PLAN-0682",
                task: "T1.2 dual-caliber #2: rolling backfill (exhaustion/abort signals recorded, no threshold assertions)",
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
                probe: PROBE_CALIBER,
                /** 双口径 #1（回填起点）事实：两口径对照要在同一份文件里可读，不必再 join 两份 JSON。 */
                initial: {
                    storeMessages: probeAtInitial.storeMessages,
                    renderedRows: probeAtInitial.messageRows,
                    renderedRowsAtStability: initialRows,
                    foldedOlder: probeAtInitial.foldedOlder,
                    runHeaders: probeAtInitial.runHeaders,
                    virtualizationActive: probeAtInitial.virtualization.active,
                    probeSource: probeAtInitial.source,
                },
                backfill: {
                    rounds: backfillPages.length,
                    maxRounds: MAX_BACKFILL_ROUNDS,
                    /** 命中的终态信号（null = 跑满上限/被 stall 打断）；超时不算耗尽。 */
                    exhaustedBy,
                    exhaustedAtRound,
                    /** 增长连续 2 轮不动（**独立**于耗尽：命中它时 exhaustedBy 必为 null）。 */
                    stallTerminated,
                    duplicateCursorRequests,
                    storeCap: MAX_LOADED_MESSAGES,
                    /** store 首次到 500 上限的轮次（cap 是设计上限，不是耗尽 ⇒ 回填继续）。 */
                    storeCapAtRound,
                    loadedMessages: finalProbe.storeMessages,
                    /** 回填前后 store 条数差（cap 生效时它是 0/负，不能当"没加载"读）。 */
                    loadedMessagesDelta: finalProbe.storeMessages - probeAtInitial.storeMessages,
                    foldedOlder: finalProbe.foldedOlder,
                    virtualizationActive: finalProbe.virtualization.active,
                    pages: backfillPages,
                },
                longTasksDuringBackfill: backfillTasks,
                final: { raw: finalRaw, metrics: finalMetrics },
                caliber: caliberFields,
            };
            writeFileSync(paths.backfill, `${JSON.stringify(backfillPayload, null, 2)}\n`, "utf8");
            console.log(
                `[BL-382 BACKFILL] rounds=${backfillPages.length} exhaustedBy=${exhaustedBy} ` +
                    `atRound=${exhaustedAtRound} stall=${stallTerminated} ` +
                    `duplicateCursorRequests=${duplicateCursorRequests}`,
            );
            console.log(`[BL-382 BACKFILL] final=${JSON.stringify(finalMetrics)}`);
            console.log(`[BL-382 BACKFILL] evidence: ${paths.backfill}`);
            // 通道不做阈值断言（决策 #4）；上面各结构门（可见/稳定/增长等待）已足够判定采样成立。
        } finally {
            pages.stop();
        }
    });
});
