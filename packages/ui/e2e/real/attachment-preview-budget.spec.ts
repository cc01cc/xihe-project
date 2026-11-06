/**
 * PLAN-0683（BL-381）—— 附件预览三态预算 E5/E6 真栈 spec（**A 路线**：真上传 + fixture-only 换字节）。
 *
 * 定位：只补「真链路证据」，不新增产品能力。断言面严格限定在 PLAN design/verify 的三态口径：
 *   E6 未打开态 —— 不交互就没有附件内容请求；附件位于首屏之外（初始视口上方，见下），
 *      滚动到图片缩略图进入视口后才出现内容请求（该请求在**本栈**上是 401，属已登记独立缺陷
 *      BL-443，不属 0683 判据，见 `BL443_NOTE`）。
 *   E5 预览态 —— 点开附件卡片只发**一次**受预算约束的 Range 请求（≤8 MiB），206 + Content-Range
 *      total 为真实文件长度；截断提示与「继续加载 / 下载原文件」双入口可见；点「继续」才发第二段
 *      Range（`bytes=<budget>-`），两段合并字节数恰好等于真实文件长度。
 *
 * fixture-only（路线 A，Lead 裁定；路线 C「把 multipart 限制注入 CP」被否决——那会改窗口窗口限制
 * 口径、污染证据）：
 *   1) 用**真实 UI 上传**一个 ~10 KiB 的文本附件 + 一个 1×1 PNG（真链路：POST /api/v1/sessions/
 *      {sid}/attachments + POST /api/v1/chat），拿到真实 fileId / messages.attachments。
 *   2) 再用 psql **同一条事务**把磁盘字节换成 12 MiB 样本、`files.size_bytes` 同步为 12582912、
 *      `messages.attachments` 里该附件的 `size` 同步为 12582912，并把该消息 `created_at` 前移
 *      120 分钟（只在它前面插填充消息，不动其它消息的 `chat_runs`/`session_participants` 语义）。
 *   3) 换字节后**三方核对**（磁盘 stat / files.size_bytes / messages.attachments.size）必须全部
 *      等于 12582912；任一不符 ⇒ 夹具失败并终止，绝不在坏夹具上跑 UI 断言。
 *   本文件因此携带 `// fixture-only:` 说明：产品实现与阈值一行未改（8 MiB 预算、CP clamp、
 *   UI 两次显式动作全部是既有实现）。
 *
 * E6 方向说明（Lead 要求写进证据）：会话默认滚动锚是底部（`default-scroll-position="last-anchor"`），
 * 因此「首屏之外」实现为**初始视口上方**；判据用「与初始视口的垂直距离 ≥ 2 × 滚动容器高度」，
 * 而不是「不可见」这种弱断言。方向是实现事实，不是判据放宽。
 *
 * 运行协议（窗口由 Lead 排期后执行；本文件自身不 boot 栈）：
 *   node scripts/e2e-host.mjs --persistent --llm-mode=mock
 *   XIHE_E2E_EXTERNAL_SERVER=1 XIHE_E2E_EXPECT_CP_COMMIT=<branch HEAD> \
 *   XIHE_EVIDENCE_DIR=<PLAN-0683>/evidence pnpm exec playwright test \
 *     --config e2e/playwright.config.ts e2e/real/attachment-preview-budget.spec.ts --expect-tests=2
 *   XIHE_E2E_PG_CONTAINER/DATABASE/USER 来自 e2e-host runner 注入（容器名不许硬编码）。
 *   V5 三连测：同一夹具连跑 3 次，结论一致才算可判定。
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page, Request, Response } from "@playwright/test";
import { captureEvidence } from "../helpers/evidence";
import { ChatPage } from "../page-objects/ChatPage";
import { workspaceChatPath } from "../../src/lib/routes";
import { agentName } from "./helpers/agent-name";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { ensureFakeUserProvider } from "./helpers/fake-provider";
import {
    awaitOperationCompletedForRun,
    registerJourneyUser,
    seedPage,
    sendChat,
    waitForControlPlaneAgentReady,
    type JourneyContext,
} from "./helpers/journey";

// ---------------------------------------------------------------------------
// 常量：预算口径与夹具尺寸
// ---------------------------------------------------------------------------

/** 与 CP `ATTACHMENT_PREVIEW_BUDGET_BYTES` / UI `PREVIEW_BYTE_BUDGET` 同值（8 MiB）。 */
const BUDGET_BYTES = 8 * 1024 * 1024; // 8388608
/** 夹具总字节：预算的 1.5 倍 ⇒ 前缀 8 MiB + 剩余 4 MiB，两段都能非空。 */
const FIXTURE_BYTES = 12 * 1024 * 1024; // 12582912
const REMAINDER_BYTES = FIXTURE_BYTES - BUDGET_BYTES; // 4194304
const ORIGINAL_UPLOAD_TARGET_BYTES = 10 * 1024;
const CSV_NAME = "plan0683-preview-budget.csv";
const PNG_NAME = "plan0683-preview-thumb.png";
const FILLER_MESSAGE_COUNT = 6;
const FIXTURE_MESSAGE_AGE_MINUTES = 120;
const FILLER_AGE_MINUTES = 110;
/** 1×1 PNG（67 B），缩略图走 `<img>` 懒加载，E6 用它观察「滚动才请求」。 */
const PNG_1X1_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** 夹具文件头：换字节后原样保留，用来验算解码后的字符数（头部之后的字节全是 ASCII 换行文本）。 */
const FIXTURE_HEADER_TEXT =
    "// fixture-only: PLAN-0683 A 路线 12 MiB 预览预算夹具（10 KiB 真上传后同事务换字节）\n";
const FIXTURE_HEADER_BYTES = Buffer.byteLength(FIXTURE_HEADER_TEXT, "utf8");
const EXPECTED_PREFIX_CHARS = FIXTURE_HEADER_TEXT.length + (BUDGET_BYTES - FIXTURE_HEADER_BYTES);
const EXPECTED_TOTAL_CHARS = FIXTURE_HEADER_TEXT.length + (FIXTURE_BYTES - FIXTURE_HEADER_BYTES);

/** 已登记独立缺陷：裸 URL 的缩略图/下载在真栈上拿不到 Bearer，CP 返回 401。 */
const BL443_NOTE = "该 401 属已登记独立缺陷 BL-443，不属 0683 判据";

const PG = {
    container: process.env.XIHE_E2E_PG_CONTAINER ?? "",
    database: process.env.XIHE_E2E_PG_DATABASE ?? "",
    user: process.env.XIHE_E2E_PG_USER ?? "",
};
const HAS_STACK = Boolean(PG.container && PG.database && PG.user && process.env.XIHE_FAKE_LLM_PORT);
const SKIP_REASON =
    "需要隔离 host 栈（scripts/e2e-host.mjs --persistent --llm-mode=mock）：" +
    "XIHE_E2E_PG_CONTAINER / XIHE_E2E_PG_DATABASE / XIHE_E2E_PG_USER / XIHE_FAKE_LLM_PORT 缺一不可";
const UI_URL = `http://localhost:${process.env.XIHE_UI_PORT || "12630"}`;

// ---------------------------------------------------------------------------
// 类型：线上记录 / 夹具 / 证据
// ---------------------------------------------------------------------------

interface FileWireRecord {
    url: string;
    method: string;
    headers: Record<string, string>;
    status: number | null;
    responseHeaders: Record<string, string> | null;
}

interface FixtureState {
    workspaceId: string;
    sessionId: string;
    messageId: string;
    branchId: string;
    csvFileId: string;
    pngFileId: string;
    originalUploadBytes: number;
    csvStoragePathFromDb: string;
    transactionSql: string;
    fillerMessageCount: number;
    messageCountAfterFixture: number;
    sizeBytesInFilesTable: number;
    sizeInMessagesJson: number;
    statBytesOnDisk: number;
}

interface E6Record {
    observedAt: string;
    messageCount: number;
    initialScroll: { scrollTop: number; clientHeight: number; scrollHeight: number };
    bottomAnchorGapPx: number;
    fixtureDirection: "above" | "below";
    fixtureDistancePx: number;
    requiredDistancePx: number;
    observationWindowMs: number;
    initialFileRequests: Array<{ url: string; method: string; status: number | null }>;
    csvContentRequestsBeforeScroll: number;
    pngRequestsAfterScroll: Array<{ url: string; status: number | null; range: string | null }>;
    imageResponseStatus: number;
    bl443: string;
}

interface E5Record {
    observedAt: string;
    budgetBytes: number;
    fixtureBytes: number;
    remainderBytes: number;
    initialCsvContentRequests: number;
    requests: Array<{
        method: string;
        range: string | null;
        status: number | null;
        contentRange: string | null;
        contentLength: string | null;
        acceptRanges: string | null;
        contentType: string | null;
    }>;
    prefixBodyBytes: number;
    remainderBodyBytes: number;
    prefixDecodedChars: number;
    totalDecodedChars: number;
    expectedPrefixChars: number;
    expectedTotalChars: number;
    truncatedBannerVisibleFirst: boolean;
    loadRestEntryVisibleFirst: boolean;
    downloadEntryVisibleFirst: boolean;
    truncatedBannerHiddenAfterContinue: boolean;
    footerDownloadEntryVisibleAfterContinue: boolean;
}

interface EvidencePayload {
    plan: string;
    task: string;
    runId: string | null;
    startedAt: string;
    finishedAt: string | null;
    caliber: { commit: string | null; dirty: boolean | null };
    pg: { container: string; database: string; user: string } | null;
    uiUrl: string;
    viewport: { width: number; height: number } | null;
    fixture: FixtureState | null;
    e6: E6Record | null;
    e5: E5Record | null;
    bl443: string;
    notes: string[];
}

const evidence: EvidencePayload = {
    plan: "PLAN-0683 (BL-381)",
    task: "T3.1 E5/E6 真栈证据（A 路线）",
    runId: process.env.XIHE_E2E_RUN_ID ?? null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    caliber: { commit: null, dirty: null },
    pg: null,
    uiUrl: UI_URL,
    viewport: null,
    fixture: null,
    e6: null,
    e5: null,
    bl443: BL443_NOTE,
    notes: [
        "fixture-only: 先真 UI 上传 ~10 KiB 文本附件，再用一条 psql 事务把字节换成 12 MiB 并同步 " +
            "files.size_bytes / messages.attachments.size；产品实现与阈值未改。",
        "E6 方向：会话默认锚定底部（last-anchor），故「首屏之外」= 初始视口上方；判据为垂直距离 " +
            "≥ 2 × message-scroller-viewport 高度。方向是实现事实，非判据放宽。",
        "填充消息只把被侧消息 created_at 前移 120 分钟并插入更晚 10 分钟的文本行，不触碰 " +
            "chat_runs / session_participants 语义。",
    ],
};

let fixture: FixtureState | null = null;
let journeyCtx: JourneyContext | null = null;

// ---------------------------------------------------------------------------
// 小工具：证据落点 / caliber / psql
// ---------------------------------------------------------------------------

/** one 工作区根标记（同 PLAN-0682 bl382 spec 与 scripts/perf/run-baseline.mjs 口径）。 */
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
        `[PLAN-0683] cannot find the one workspace from ${start}; expected ` +
            "A03-xihe/scripts/perf/run-baseline.mjs (one root marker)",
    );
}

const PLAN_EVIDENCE_SUFFIX = path.join(
    "plans",
    "PLAN-0683-XH-bl381-attachment-preview-budget",
    "evidence",
);

function resolveEvidenceDir(): string {
    const oneRoot = resolveOneRoot();
    const directory = path.join(oneRoot, PLAN_EVIDENCE_SUFFIX);
    if (!existsSync(directory)) {
        throw new Error(
            `[PLAN-0683] one workspace at ${oneRoot} has no ${PLAN_EVIDENCE_SUFFIX}/; ` +
                "raw evidence must land in the PLAN",
        );
    }
    return directory;
}

function runIdSlug(): string {
    return (process.env.XIHE_E2E_RUN_ID ?? "no-run-id").replace(/[^A-Za-z0-9._-]+/g, "_");
}

function repoCaliber(): { commit: string | null; dirty: boolean | null } {
    try {
        const root = path.resolve(process.cwd(), "../..");
        const commit = String(
            execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }),
        ).trim();
        const status = String(
            execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }),
        );
        return { commit, dirty: status.trim().length > 0 };
    } catch (error) {
        console.warn(
            `[PLAN-0683] git caliber unavailable: ${error instanceof Error ? error.message : error}`,
        );
        return { commit: null, dirty: null };
    }
}

function sqlLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/** `docker exec psql`：容器/库/用户全部来自 runner 注入的 env，禁止硬编码。 */
function psql(sql: string): string {
    if (!HAS_STACK) throw new Error("[PLAN-0683] psql(): isolated host stack env is missing");
    const output = execFileSync(
        "docker",
        [
            "exec",
            PG.container,
            "psql",
            "-X",
            "-A",
            "-t",
            "-U",
            PG.user,
            "-d",
            PG.database,
            "-c",
            sql,
        ],
        { encoding: "utf8", timeout: 180_000, windowsHide: true },
    );
    return String(output).trim();
}

function psqlScalar(sql: string): string {
    const raw = psql(sql);
    if (raw === "") return "";
    return (raw.split("\n")[0] ?? "").trim();
}

function psqlNumber(sql: string): number {
    const raw = psqlScalar(sql);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        throw new Error(`[PLAN-0683] psql 数值解析失败: ${JSON.stringify(raw)} (${sql})`);
    }
    return parsed;
}

// ---------------------------------------------------------------------------
// 小工具：夹具构造
// ---------------------------------------------------------------------------

/** 真上传用的小样本（~10 KiB ASCII 文本），保证预算远大于它。 */
function buildOriginalCsv(): Buffer {
    const lines = ["id,fixture,note"];
    while (Buffer.byteLength(`${lines.join("\n")}\n`, "utf8") < ORIGINAL_UPLOAD_TARGET_BYTES) {
        lines.push(`${lines.length},plan-0683-fixture-only,original-upload`);
    }
    return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

/**
 * 12 MiB 换字节样本：fixture 头 + 512 字符短行。
 * 用短行而不是一整行超长 token，是为了避免极端换行测量把浏览器渲染拖成病理复杂度；
 * 头之后的字节全部是 ASCII，因此解码字符数可以精确验算。
 */
function buildFixtureBytes(): Buffer {
    const line = `${"0123456789abcdef".repeat(32)}\n`;
    const header = Buffer.from(FIXTURE_HEADER_TEXT, "utf8");
    const bodyBytes = FIXTURE_BYTES - header.byteLength;
    const repeated = Buffer.from(
        line.repeat(Math.ceil(bodyBytes / Buffer.byteLength(line))),
        "utf8",
    );
    const body = repeated.subarray(0, bodyBytes);
    const merged = Buffer.concat([header, body]);
    if (merged.byteLength !== FIXTURE_BYTES) {
        throw new Error(`[PLAN-0683] 夹具字节构造失败: ${merged.byteLength} != ${FIXTURE_BYTES}`);
    }
    return merged;
}

function buildFillerContent(index: number): string {
    const rows: string[] = [];
    for (let line = 0; line < 40; line++) {
        rows.push(`filler ${index + 1}.${line + 1} PLAN-0683 首屏外高度占位文本行`);
    }
    return rows.join("\n");
}

function buildFillerValues(sessionId: string, branchId: string): string {
    const rows: string[] = [];
    for (let index = 0; index < FILLER_MESSAGE_COUNT; index++) {
        rows.push(
            `(${sqlLiteral(randomUUID())}, ${sqlLiteral(sessionId)}, ${sqlLiteral(branchId)}, ` +
                `'USER', ${sqlLiteral(buildFillerContent(index))}, ` +
                `now() - interval '${FILLER_AGE_MINUTES} minutes' + interval '${index} seconds')`,
        );
    }
    return rows.join(",\n");
}

/**
 * CP 在 Windows 上把 `/data/xihe/attachments` 落在「当前盘符根」，DB 里存 `\data\...`（无盘符）。
 * Node 的 `path.resolve` 用本进程当前盘符补全；不一致时下一步 `statSync` 立刻失败（夹具失败退出）。
 */
function resolveStoragePath(storagePath: string): string {
    if (storagePath.length === 0) throw new Error("[PLAN-0683] files.storage_path 为空");
    if (path.isAbsolute(storagePath)) return path.resolve(storagePath);
    return path.resolve(process.cwd(), "../..", storagePath);
}

// ---------------------------------------------------------------------------
// 小工具：网络观测 / 几何 / 等待
// ---------------------------------------------------------------------------

function isAttachmentFileUrl(url: string): boolean {
    try {
        return new URL(url).pathname.startsWith("/api/v1/files/");
    } catch {
        return false;
    }
}

/** 只记录附件内容端点（`/api/v1/files/*`）的请求与响应，别的流量不参与判据。 */
function watchFileRequests(page: Page): FileWireRecord[] {
    const records: FileWireRecord[] = [];
    page.on("request", (request: Request) => {
        if (!isAttachmentFileUrl(request.url())) return;
        records.push({
            url: request.url(),
            method: request.method(),
            headers: request.headers(),
            status: null,
            responseHeaders: null,
        });
    });
    page.on("response", (response: Response) => {
        if (!isAttachmentFileUrl(response.url())) return;
        const url = response.url();
        const record = records.findLast((item) => item.url === url && item.status === null);
        if (!record) return;
        record.status = response.status();
        record.responseHeaders = response.headers();
    });
    return records;
}

function headerOf(record: FileWireRecord, name: string): string | null {
    const value = record.responseHeaders?.[name];
    return value ?? null;
}

/**
 * 负向观测窗口：E6 判据是「不交互就没有附件内容请求」。用显式窗口轮询而不是固定睡眠——
 * 命中请求立即判红，窗口长度写进证据。
 */
async function expectNoFileRequests(
    records: FileWireRecord[],
    matches: (record: FileWireRecord) => boolean,
    windowMs: number,
    label: string,
): Promise<void> {
    const deadline = Date.now() + windowMs;
    for (;;) {
        const hits = records.filter(matches);
        expect(hits, `${label}（观测窗口 ${windowMs}ms，命中 ${hits.length} 次）`).toHaveLength(0);
        if (Date.now() >= deadline) return;
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
}

function requireFixture(): FixtureState {
    if (!fixture) throw new Error("[PLAN-0683] beforeAll 未完成夹具准备（缺少隔离栈环境）");
    return fixture;
}

function requireJourney(): JourneyContext {
    if (!journeyCtx) throw new Error("[PLAN-0683] beforeAll 未完成身份准备");
    return journeyCtx;
}

/** 消息条数稳定（readiness-by-polling，禁固定 sleep）。 */
async function waitForMessageCountStable(page: Page): Promise<number> {
    const bubbles = page.locator('[data-slot="message"]');
    let previous = -1;
    await expect
        .poll(
            async () => {
                const count = await bubbles.count();
                const stable = count > 0 && count === previous;
                previous = count;
                return stable;
            },
            { timeout: 120_000, intervals: [200, 300, 500] },
        )
        .toBe(true);
    return bubbles.count();
}

interface ScrollSnapshot {
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
}

async function scrollSnapshot(page: Page): Promise<ScrollSnapshot> {
    return page.getByTestId("message-scroller-viewport").evaluate((element: HTMLElement) => ({
        scrollTop: element.scrollTop,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
    }));
}

// ---------------------------------------------------------------------------
// 夹具准备（真 UI 上传 → 同事务换字节 → 三方核对）
// ---------------------------------------------------------------------------

async function prepareFixture(request: APIRequestContext, page: Page): Promise<void> {
    // ① 真链路身份：建号 → workspace → CP/Agent 就绪 → fake 用户 provider → principal → session。
    const journey = await registerJourneyUser(request, "plan0683-preview");
    journeyCtx = journey;
    const workspaceId = journey.workspaceId;
    const headers = { ...journey.headers, "X-Workspace-Id": workspaceId };
    await waitForControlPlaneAgentReady(request, headers);
    const auth = { accessToken: journey.authToken, workspaceId };
    await ensureFakeUserProvider(request, auth);
    const principalId = await provisionWorkspaceAgentPrincipal(request, auth, {
        name: agentName("Plan0683Preview", Date.now()),
        actions: ["read"],
        systemPrompt: "Reply briefly.",
    });
    const sessionId = await createSessionWithPrincipal(request, auth, {
        principalId,
        title: "PLAN-0683 attachment preview budget",
        workspaceId,
    });

    // ② 真 UI 上传两个附件并发送，让 CP 自己写 messages.attachments。
    const chat = new ChatPage(page);
    seedPage(page, journey);
    await page.goto(`${UI_URL}${workspaceChatPath(workspaceId, sessionId)}`);
    await expect(page.getByTestId("message-list")).toBeVisible({ timeout: 90_000 });
    await expect(chat.input).toBeVisible({ timeout: 90_000 });

    const csvBuffer = buildOriginalCsv();
    const pngBuffer = Buffer.from(PNG_1X1_BASE64, "base64");
    const uploadPromise = page.waitForResponse(
        (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname === `/api/v1/sessions/${sessionId}/attachments`,
        { timeout: 120_000 },
    );
    const chatPromise = page.waitForResponse(
        (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname === "/api/v1/chat",
        { timeout: 120_000 },
    );
    await chat.attachFiles([
        { name: CSV_NAME, mimeType: "text/csv", buffer: csvBuffer },
        { name: PNG_NAME, mimeType: "image/png", buffer: pngBuffer },
    ]);
    await expect(page.getByTestId("selected-attachment")).toHaveCount(2, { timeout: 30_000 });
    await sendChat(page, "PLAN-0683 fixture-only：附件预览预算夹具");

    const uploadResponse = await uploadPromise;
    const uploadStatusText = uploadResponse.status();
    const uploadBody = await uploadResponse.text();
    if (uploadStatusText !== 200) {
        throw new Error(`[PLAN-0683] 附件上传失败 ${uploadStatusText}: ${uploadBody}`);
    }
    const uploadResult = JSON.parse(uploadBody) as {
        success?: Array<{ id: string; name: string; type: string; size: number; url: string }>;
        failed?: Array<{ fileName: string; reason: string }>;
    };
    const failed = uploadResult.failed ?? [];
    expect(failed, `附件上传 failed 非空: ${JSON.stringify(failed)}`).toEqual([]);
    const uploaded = uploadResult.success ?? [];
    const csvUploaded = uploaded.find((file) => file.name === CSV_NAME);
    const pngUploaded = uploaded.find((file) => file.name === PNG_NAME);
    if (!csvUploaded || !pngUploaded) {
        throw new Error(`[PLAN-0683] 上传响应缺少夹具文件: ${JSON.stringify(uploaded)}`);
    }
    expect(csvUploaded.size, "真上传 CSV 字节数应等于夹具 buffer 长度").toBe(csvBuffer.byteLength);
    expect(pngUploaded.size, "真上传 PNG 字节数应等于夹具 buffer 长度").toBe(pngBuffer.byteLength);

    const chatResponse = await chatPromise;
    const chatStatus = chatResponse.status();
    const chatBody = await chatResponse.text();
    if (chatStatus !== 202) {
        throw new Error(`[PLAN-0683] POST /api/v1/chat 期望 202，实际 ${chatStatus}: ${chatBody}`);
    }
    const runId = (JSON.parse(chatBody) as { runId?: string }).runId;
    if (!runId) throw new Error("[PLAN-0683] POST /api/v1/chat 响应缺少 runId");
    await awaitOperationCompletedForRun(request, headers, runId);

    // ③ 读出真实写入的行（消息 / 分支 / 附件 JSON / 存储路径）。
    const messageId = psqlScalar(
        `select id from messages where session_id = ${sqlLiteral(sessionId)} ` +
            "and role = 'USER' order by created_at desc limit 1",
    );
    if (!messageId) throw new Error("[PLAN-0683] 找不到夹具用户消息");
    const branchId = psqlScalar(
        `select branch_id from messages where id = ${sqlLiteral(messageId)}`,
    );
    if (!branchId) throw new Error("[PLAN-0683] 夹具消息缺少 branch_id");
    const attachmentsJsonBefore = psqlScalar(
        `select attachments from messages where id = ${sqlLiteral(messageId)}`,
    );
    if (!attachmentsJsonBefore) throw new Error("[PLAN-0683] 夹具消息 attachments 为空");
    const csvStoragePath = psqlScalar(
        `select storage_path from files where id = ${sqlLiteral(csvUploaded.id)}`,
    );
    if (!csvStoragePath) throw new Error("[PLAN-0683] 找不到 CSV 附件的 storage_path");

    type MessageAttachmentRef = { fileId: string; name: string; type: string; size: number };
    const refsBefore = JSON.parse(attachmentsJsonBefore) as MessageAttachmentRef[];
    expect(refsBefore.length, "messages.attachments 应含两个附件").toBe(2);
    expect(refsBefore.map((item) => item.name).sort()).toEqual([CSV_NAME, PNG_NAME].sort());
    const csvRefBefore = refsBefore.find((item) => item.name === CSV_NAME);
    expect(csvRefBefore?.size, "messages.attachments 里 CSV size 应等于真上传大小").toBe(
        csvBuffer.byteLength,
    );

    // ④ 先写磁盘字节（Lead 指定顺序：writeFileSync 在前，再进同一事务改两个表）。
    const resolvedStoragePath = resolveStoragePath(csvStoragePath);
    const statBefore = statSync(resolvedStoragePath);
    expect(
        statBefore.size,
        `[PLAN-0683] 上传后磁盘字节与 DB 不一致（path=${resolvedStoragePath}）；` +
            "存储路径解析失效时绝不继续跑 UI 断言",
    ).toBe(csvBuffer.byteLength);
    const fixtureBytes = buildFixtureBytes();
    writeFileSync(resolvedStoragePath, fixtureBytes);

    const refsAfter = refsBefore.map((item) =>
        item.name === CSV_NAME ? { ...item, size: FIXTURE_BYTES } : item,
    );
    const transactionSql = [
        "BEGIN;",
        `update files set size_bytes = ${FIXTURE_BYTES} where id = ${sqlLiteral(csvUploaded.id)};`,
        `update messages set attachments = ${sqlLiteral(JSON.stringify(refsAfter))}, ` +
            `created_at = now() - interval '${FIXTURE_MESSAGE_AGE_MINUTES} minutes' ` +
            `where id = ${sqlLiteral(messageId)};`,
        `insert into messages (id, session_id, branch_id, role, content, created_at) values ${buildFillerValues(
            sessionId,
            branchId,
        )};`,
        "COMMIT;",
    ].join("\n");
    psql(transactionSql);

    // ⑤ 三方核对：磁盘 / files.size_bytes / messages.attachments.size 必须同时等于 12582912。
    const statBytesOnDisk = statSync(resolvedStoragePath).size;
    const sizeBytesInFilesTable = psqlNumber(
        `select size_bytes from files where id = ${sqlLiteral(csvUploaded.id)}`,
    );
    const refsVerified = JSON.parse(
        psqlScalar(`select attachments from messages where id = ${sqlLiteral(messageId)}`),
    ) as MessageAttachmentRef[];
    const sizeInMessagesJson = refsVerified.find((item) => item.name === CSV_NAME)?.size ?? -1;
    const fillerMessageCount = psqlNumber(
        `select count(*) from messages where session_id = ${sqlLiteral(sessionId)} ` +
            `and content like 'filler %'`,
    );
    const messageCountAfterFixture = psqlNumber(
        `select count(*) from messages where session_id = ${sqlLiteral(sessionId)}`,
    );
    expect(
        { statBytesOnDisk, sizeBytesInFilesTable, sizeInMessagesJson },
        "fixture 三处字节数必须一致（磁盘 / files.size_bytes / messages.attachments.size）",
    ).toEqual({
        statBytesOnDisk: FIXTURE_BYTES,
        sizeBytesInFilesTable: FIXTURE_BYTES,
        sizeInMessagesJson: FIXTURE_BYTES,
    });
    expect(fillerMessageCount, "填充消息条数应与夹具设定一致").toBe(FILLER_MESSAGE_COUNT);
    expect(messageCountAfterFixture, "夹具后消息总数至少为填充 + 1").toBeGreaterThan(
        FILLER_MESSAGE_COUNT,
    );

    fixture = {
        workspaceId,
        sessionId,
        messageId,
        branchId,
        csvFileId: csvUploaded.id,
        pngFileId: pngUploaded.id,
        originalUploadBytes: csvBuffer.byteLength,
        csvStoragePathFromDb: csvStoragePath,
        transactionSql,
        fillerMessageCount,
        messageCountAfterFixture,
        sizeBytesInFilesTable,
        sizeInMessagesJson,
        statBytesOnDisk,
    };
    evidence.fixture = fixture;
    evidence.caliber = repoCaliber();
    evidence.pg = { ...PG };
    console.log(
        `[PLAN-0683] fixture ready session=${sessionId} message=${messageId} ` +
            `csv=${uploaded.find((file) => file.name === CSV_NAME)?.id} ` +
            `bytes=${statBytesOnDisk} fillers=${fillerMessageCount} messages=${messageCountAfterFixture}`,
    );
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test.describe("PLAN-0683 附件预览三态预算（真栈 E5/E6）", () => {
    test.describe.configure({ mode: "serial", retries: 0 });

    test.beforeAll(async ({ browser, request }) => {
        test.setTimeout(900_000);
        if (!HAS_STACK) return;
        evidence.startedAt = new Date().toISOString();
        const directory = resolveEvidenceDir();
        if (!process.env.XIHE_EVIDENCE_DIR) {
            process.env.XIHE_EVIDENCE_DIR = directory;
            console.log(`[PLAN-0683] XIHE_EVIDENCE_DIR 未注入，截图落 PLAN evidence: ${directory}`);
        }
        const context = await browser.newContext({
            baseURL: UI_URL,
            viewport: { width: 1920, height: 1080 },
            deviceScaleFactor: 2,
        });
        const page = await context.newPage();
        try {
            await prepareFixture(request, page);
        } finally {
            await context.close().catch(() => undefined);
        }
    });

    test.afterAll(() => {
        if (!HAS_STACK) return;
        try {
            const directory = resolveEvidenceDir();
            mkdirSync(directory, { recursive: true });
            evidence.finishedAt = new Date().toISOString();
            const target = path.join(directory, `t3.1-e5e6-${runIdSlug()}.json`);
            writeFileSync(target, `${JSON.stringify(evidence, null, 4)}\n`, "utf8");
            console.log(`[PLAN-0683] 证据 JSON 已落盘: ${target}`);
        } catch (error) {
            console.error(
                `[PLAN-0683] 证据 JSON 落盘失败: ${error instanceof Error ? error.message : error}`,
            );
        }
    });

    test("E6 @host 未打开态零内容请求：首屏外图片滚动入视口才请求", async ({ page }) => {
        test.skip(!HAS_STACK, SKIP_REASON);
        test.setTimeout(900_000);
        const state = requireFixture();
        const journey = requireJourney();
        const records = watchFileRequests(page);
        const chat = new ChatPage(page);
        seedPage(page, journey);
        await chat.goto(state.sessionId, state.workspaceId);
        await expect(page.getByTestId("message-list")).toBeVisible({ timeout: 90_000 });
        const messageCount = await waitForMessageCountStable(page);

        const csvCard = page.locator('[data-testid="message-attachment"]', { hasText: CSV_NAME });
        const pngCard = page.locator('[data-testid="message-attachment"]', { hasText: PNG_NAME });
        await expect(csvCard).toBeVisible({ timeout: 90_000 });
        await expect(pngCard).toBeVisible({ timeout: 90_000 });

        // 几何：底部锚定 + 夹具在初始视口之外（上方）≥ 2 个滚动容器高度。
        const initialScroll = await scrollSnapshot(page);
        const scrollerBox = await page.getByTestId("message-scroller-viewport").boundingBox();
        const cardBox = await csvCard.boundingBox();
        if (!scrollerBox || !cardBox) {
            throw new Error("[PLAN-0683] E6 取不到滚动容器 / 附件卡片几何");
        }
        const distanceAbove = scrollerBox.y - (cardBox.y + cardBox.height);
        const distanceBelow = cardBox.y - (scrollerBox.y + scrollerBox.height);
        const fixtureDirection: "above" | "below" =
            distanceAbove >= distanceBelow ? "above" : "below";
        const fixtureDistancePx = Math.max(distanceAbove, distanceBelow);
        const requiredDistancePx = 2 * scrollerBox.height;
        const bottomAnchorGapPx =
            initialScroll.scrollTop + initialScroll.clientHeight - initialScroll.scrollHeight;

        expect(
            initialScroll.scrollTop + initialScroll.clientHeight,
            "会话首次进入应锚定底部（last-anchor）",
        ).toBeGreaterThanOrEqual(initialScroll.scrollHeight - 40);
        expect(
            fixtureDistancePx,
            `夹具须在初始视口之外 ≥ 2 个滚动容器高度（方向=${fixtureDirection}，` +
                `实测 ${Math.round(fixtureDistancePx)}px，要求 ${Math.round(requiredDistancePx)}px）`,
        ).toBeGreaterThanOrEqual(requiredDistancePx);
        expect(fixtureDirection, "底部锚定 ⇒ 首屏之外应在上方").toBe("above");
        await expect(csvCard).not.toBeInViewport();
        await expect(pngCard).not.toBeInViewport();

        // 未打开态：观测窗口内 0 次附件内容请求。
        const observationWindowMs = 3_000;
        const initialFileRequests = records.map((record) => ({
            url: record.url,
            method: record.method,
            status: record.status,
        }));
        await expectNoFileRequests(
            records,
            () => true,
            observationWindowMs,
            "未打开态不应有任何附件内容请求",
        );
        expect(
            records.filter((record) => record.url.includes(state.csvFileId)),
            "非图片附件在未打开态必须 0 请求",
        ).toHaveLength(0);
        await captureEvidence(page, "t3.1-e6-initial-zero-load");

        // 滚动到图片卡片进入视口 → 懒加载触发一次内容请求（本栈上是 401，属 BL-443）。
        const pngResponsePromise = page.waitForResponse(
            (response) => response.url().includes(state.pngFileId),
            { timeout: 60_000 },
        );
        await pngCard.scrollIntoViewIfNeeded();
        const pngResponse = await pngResponsePromise;
        const imageResponseStatus = pngResponse.status();
        await expect(pngCard).toBeInViewport();
        const pngRequestsAfterScroll = records
            .filter((record) => record.url.includes(state.pngFileId))
            .map((record) => ({
                url: record.url,
                status: record.status,
                range: record.headers["range"] ?? null,
            }));
        expect(
            pngRequestsAfterScroll.length,
            "滚动到图片后必须产生缩略图内容请求",
        ).toBeGreaterThanOrEqual(1);
        expect(
            records.filter((record) => record.url.includes(state.csvFileId)),
            "E6 中非图片附件必须保持 0 次内容请求",
        ).toHaveLength(0);
        if (imageResponseStatus === 401) console.log(`[PLAN-0683] ${BL443_NOTE}`);
        await captureEvidence(page, "t3.1-e6-scroll-image-request");

        evidence.viewport = page.viewportSize();
        evidence.e6 = {
            observedAt: new Date().toISOString(),
            messageCount,
            initialScroll,
            bottomAnchorGapPx,
            fixtureDirection,
            fixtureDistancePx,
            requiredDistancePx,
            observationWindowMs,
            initialFileRequests,
            csvContentRequestsBeforeScroll: 0,
            pngRequestsAfterScroll,
            imageResponseStatus,
            bl443: BL443_NOTE,
        };
    });

    test("E5 @host 预算内预览 + 显式继续：两段 206 字节精确", async ({ page }) => {
        test.skip(!HAS_STACK, SKIP_REASON);
        test.setTimeout(900_000);
        const state = requireFixture();
        const journey = requireJourney();
        const records = watchFileRequests(page);
        const chat = new ChatPage(page);
        seedPage(page, journey);
        await chat.goto(state.sessionId, state.workspaceId);
        await expect(page.getByTestId("message-list")).toBeVisible({ timeout: 90_000 });
        await waitForMessageCountStable(page);

        const csvCard = page.locator('[data-testid="message-attachment"]', { hasText: CSV_NAME });
        await expect(csvCard).toBeVisible({ timeout: 90_000 });
        const csvMatches = (record: FileWireRecord) => record.url.includes(state.csvFileId);
        const initialCsvContentRequests = records.filter(csvMatches).length;
        await expectNoFileRequests(records, csvMatches, 2_000, "点击前 CSV 附件不应有内容请求");

        // 第一段：一次预算内 Range。
        const trigger = csvCard.getByTestId("message-attachment-preview-trigger");
        const previewResponsePromise = page.waitForResponse(
            (response) => response.url().includes(state.csvFileId),
            { timeout: 120_000 },
        );
        await trigger.click();
        const previewResponse = await previewResponsePromise;
        const previewRequest = previewResponse.request();
        expect(
            previewRequest.headers()["range"],
            "前缀请求必须带预算 Range 头（bytes=0-8388607）",
        ).toBe(`bytes=0-${BUDGET_BYTES - 1}`);
        expect(previewResponse.status(), "预算内前缀必须是 206 而非 200 全文").toBe(206);
        expect(
            headerOf(
                records.find((record) => record.url.includes(state.csvFileId))!,
                "content-range",
            ),
            "Content-Range total 必须是真实文件长度",
        ).toBe(`bytes 0-${BUDGET_BYTES - 1}/${FIXTURE_BYTES}`);
        const previewHeaders = previewResponse.headers();
        expect(previewHeaders["accept-ranges"]).toBe("bytes");
        expect(previewHeaders["content-type"] ?? "").toContain("text/csv");
        expect(previewHeaders["content-length"], "服务端 clamp 后的长度").toBe(
            String(BUDGET_BYTES),
        );
        const previewBody = await previewResponse.body();
        expect(previewBody.length, "前缀 body 字节数").toBe(BUDGET_BYTES);

        // 预览态 UI：截断提示 + 双入口。
        const dialog = page.getByTestId("attachment-preview-dialog");
        await expect(dialog).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId("attachment-preview-error")).toHaveCount(0);
        await expect(page.getByTestId("attachment-preview-truncated")).toBeVisible({
            timeout: 180_000,
        });
        const loadRestEntry = page.getByTestId("attachment-preview-load-rest");
        const downloadEntry = page.getByTestId("attachment-preview-download");
        await expect(loadRestEntry).toBeVisible();
        await expect(downloadEntry).toBeVisible();
        const previewText = page.getByTestId("attachment-preview-text");
        await expect(previewText).toBeVisible();
        const prefixDecodedChars = await previewText.evaluate(
            (element: HTMLElement) => element.textContent?.length ?? 0,
        );
        expect(prefixDecodedChars, "8 MiB 前缀解码后的字符数").toBe(EXPECTED_PREFIX_CHARS);
        await captureEvidence(page, "t3.1-e5-preview-truncated");

        // 第二段：显式「继续加载」才发 Range bytes=<budget>-。
        const remainderResponsePromise = page.waitForResponse(
            (response) => response.url().includes(state.csvFileId),
            { timeout: 180_000 },
        );
        await loadRestEntry.click();
        const remainderResponse = await remainderResponsePromise;
        expect(
            remainderResponse.request().headers()["range"],
            "继续必须是显式开区间 Range（bytes=8388608-）",
        ).toBe(`bytes=${BUDGET_BYTES}-`);
        expect(remainderResponse.status(), "第二段仍必须是 206").toBe(206);
        const remainderHeaders = remainderResponse.headers();
        expect(remainderHeaders["content-range"], "第二段 Content-Range").toBe(
            `bytes ${BUDGET_BYTES}-${FIXTURE_BYTES - 1}/${FIXTURE_BYTES}`,
        );
        expect(remainderHeaders["content-length"]).toBe(String(REMAINDER_BYTES));
        const remainderBody = await remainderResponse.body();
        expect(remainderBody.length, "剩余 body 字节数").toBe(REMAINDER_BYTES);

        await expect(page.getByTestId("attachment-preview-truncated")).toHaveCount(0, {
            timeout: 240_000,
        });
        const footer = dialog.locator('[data-slot="dialog-footer"]');
        await expect(footer).toBeVisible();
        await expect(footer.getByRole("button", { name: /原文件|original/i })).toBeVisible();
        const totalDecodedChars = await previewText.evaluate(
            (element: HTMLElement) => element.textContent?.length ?? 0,
        );
        expect(totalDecodedChars, "前缀 + 剩余合并后必须是完整 12 MiB 文本").toBe(
            EXPECTED_TOTAL_CHARS,
        );
        await captureEvidence(page, "t3.1-e5-after-continue");

        // 线上审计：整场只有两次附件内容请求，且都是 206。
        const csvWire = records.filter(csvMatches);
        expect(csvWire.length, `整个 E5 只应有 2 次 CSV 内容请求，实际 ${csvWire.length} 次`).toBe(
            2,
        );
        expect(
            csvWire.map((record) => record.status),
            "两段都必须是 206，禁止出现 200 全文",
        ).toEqual([206, 206]);

        evidence.viewport = page.viewportSize();
        evidence.e5 = {
            observedAt: new Date().toISOString(),
            budgetBytes: BUDGET_BYTES,
            fixtureBytes: FIXTURE_BYTES,
            remainderBytes: REMAINDER_BYTES,
            initialCsvContentRequests,
            requests: csvWire.map((record) => ({
                method: record.method,
                range: record.headers["range"] ?? null,
                status: record.status,
                contentRange: headerOf(record, "content-range"),
                contentLength: headerOf(record, "content-length"),
                acceptRanges: headerOf(record, "accept-ranges"),
                contentType: headerOf(record, "content-type"),
            })),
            prefixBodyBytes: previewBody.length,
            remainderBodyBytes: remainderBody.length,
            prefixDecodedChars,
            totalDecodedChars,
            expectedPrefixChars: EXPECTED_PREFIX_CHARS,
            expectedTotalChars: EXPECTED_TOTAL_CHARS,
            truncatedBannerVisibleFirst: true,
            loadRestEntryVisibleFirst: true,
            downloadEntryVisibleFirst: true,
            truncatedBannerHiddenAfterContinue: true,
            footerDownloadEntryVisibleAfterContinue: true,
        };
    });
});
