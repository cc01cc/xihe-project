// UI 基线真机门禁（task-73 / D-1907 UI 基线 v2；task-102 二轮加固：修 8 条假绿 + 补覆盖 + 口径对齐）。
// 断言口径来自 internal/A03-xihe/evidence/2026-11-19-ui-live-review 的真机读数（A1/A3/B1/B3/D1/D2/E1/E2 六类缺陷），
// 每条断言在改代码之前必须为红：红 = 产品现状，绿 = 该缺陷已修复。
//
// 与旧探针（probe.mjs）的方法学差异（A2 已确认旧探针误判）：
//   1. 顶带扫描不写死 `y < 120`（那是旧探针把 5 条带截成 4 条的原因），下界改取「会话容器带
//      workspace-conversation 的底边」（chromeEnd），把 settings-summary 这类 chat 列内行
//      与运行态横幅排除（口径见 CHROME_EXCLUDED_KEYS / chromeNotice）；
//   2. 焦点环用键盘 Tab 进入 chat-input（不用脚本 focus()），并等 400ms 让 box-shadow 的
//      transition 落定后再读计算样式（立即读会读到过渡前的空值，曾导致假绿）。
//
// 另两处工程口径（都出自真机踩坑）：
//   - 会话入口用 CP API 挑「有消息的会话」再直达 /workspace/{ws}/chat/{sid}，不点侧栏：
//     点侧栏会为每条会话开一个容器页签，多页签会触发 SSE 订阅上限横幅，污染顶带读数。
//     空会话不挂 MessageScrollerViewport，所以「有消息」是能读到 transcript 的前提。
//   - 页面若仍带着该横幅（测试产物，非产品 chrome），读数里 chromeNotice 显式记账，
//     断言用 chromeEnd - chromeNotice，不把横幅算进产品顶带。
//   - 每次读数前过「帧门」（settleLayoutFrames，task-93 ③）：不可见窗口里 rAF 不推进，
//     reka Splitter 的 flex-grow 过渡会冻结在起始帧，sidebar 读成 1585px、main/composer 读成 0；
//     8s 不收敛就用 a.finish() 强制定格并把「已强制定格」写进读数与注解，宽度仍取不到则 fail（不 skip）。
//   - 每视口新开一个 page（同一 context 复用登录态，旧 page 先关）：多页签/多次重载会累积 SSE 订阅，
//     把 37px 的 sse-subscriber-limit-notice 横幅顶出来；同一时刻只留一个页面是「零横幅」基线可复现的前提。
//     横幅仍可能偶发，出现时只记账（chromeNotice）不判红，但断言它不裁切 composer 可视高度。
//
// ③a 改前基线（2026-11-19 真机，帧门 settled=true，light/dark 两主题读数一致）：
//   1920×1080 = 130.8px / 1440×900 = 70.3px / 1600×900 = 150.6px（判据 ≤2px，改后应向 0 收敛）。
//   帧门接入前曾读到 1440=0.0、1600=16.7 —— 那是 Splitter flex-grow 首帧的假读数，不得引用。
//
// timeout-exempt: 一次登录后串行测 3 视口 × 2 主题（6 屏）逐屏读数，需跨多次页面装载
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// 本 spec 不用 helpers/chat 的 ensureWorkspaceChat：它在「栈里无会话且 agent-principals 为空」时
// 会去点「新建会话」并等 composer，而该栈新建会话需要已绑定 principal（GET /api/v1/agent-principals = 0 条），
// 只会 10s 超时。这里改为直接开已有会话（真机基线测的是布局，不是会话创建链路）。

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** packages/ui/e2e/real → A03-xihe */
const PROJECT_ROOT = path.resolve(HERE, "../../../..");
/** A03-xihe → one */
const ONE_ROOT = path.resolve(PROJECT_ROOT, "..");

const PASSWORD_FILE = path.join(PROJECT_ROOT, ".local", "dev", "admin-password");
const ADMIN_IDENTIFIER = process.env.XIHE_E2E_ADMIN_IDENTIFIER ?? "admin@xihe.local";
const OUT_FILE =
    process.env.UI_BASELINE_OUT ?? path.join(ONE_ROOT, ".tmp", "xh", "ui-gates", "red-before.json");
const SHOT_DIR = path.join(ONE_ROOT, ".tmp", "xh", "ui-gates", "shots");

// ── 判据常量（括号内为 2026-11-19 真机现状，改前应红） ────────────────────────────
/** ① 顶带层数上限。修正口径（Lead 2026-11-19 复核）：会话页顶部 = 4 条带、合计 124px
 *  （secondary-nav 32 + container-tabs 32 + WorkspaceView.vue:563-575 ~28 + 会话头 h-8 32）；
 *  settings-summary 属 chat 列内行（SessionSettingsPanel.vue:196，由 ChatPanel 挂载），**不计入**顶带。
 *  清单 v1 的「157px / 5 条带」是并入口径，只作参考、不作断言值。 */
const CHROME_MAX_BANDS = 3;
/** 行高基数：xs 行 32px；内容区起点允许 3 行 + 8px 边框内距 */
const CHROME_ROW_HEIGHT_PX = 32;
const CHROME_MAX_CONTENT_TOP = CHROME_MAX_BANDS * CHROME_ROW_HEIGHT_PX + 8; // 104
/** ② composer 块高 / 视口高（现状 16.1%@1920、22.7%@1366、12.1%@2560） */
const COMPOSER_MAX_VIEWPORT_RATIO = 0.15;
/**
 * ③ composer 居中容差（**task-67 r5 口径**，Lead 2026-11-20 00:46 裁定；取代 rev0 的
 * `COMPOSER_MAX_RIGHT_DEAD_ZONE_PX = 40`）。
 *
 * <p><b>为什么废掉「右死区 ≤40px」</b>：那条门在 896 定宽下**数学不可达** —— 内盒
 * `InputArea.vue:1481` 是 `w-full max-w-4xl`（896），1920 展开态主列 1157.61 ⇒ 居中后最小死区恒
 * (1157.61 − 896) / 2 = **130.81**（task-67 实测 130.81 / 70.31 / 150.64，三个视口是「完全居中」的
 * 对称余量，不是偏左）。一条永远过不了的门只会逼下一个人去改设计宽度。</p>
 *
 * <p><b>现行两条判据（都只判「偏差」，不判绝对值）</b>：
 * ① ③a 居中：内盒中心 vs `workspace-main` 中心偏差 ≤ 2px；
 * ② ③b 死区平衡：右死区 vs (主列宽 − 内盒宽) / 2 偏差 ≤ 2px（左右余量相等）。
 * 两条都是「钉算法不钉结果」：`max-w-4xl` 或列宽变了，判据不用跟着改。</p>
 *
 * <p>「内盒 / 主列宽占比」仍不设断言：它的绝对值由 max-w-4xl 与列宽决定，真正表达「偏左」的
 * 是上面两条。</p>
 */
const COMPOSER_CENTER_TOLERANCE_PX = 2;
/** ⑤ D-1907 **rev5**（2026-11-19 Lead 改判，取代 rev3 的「唯一 + 可见 + 可开」三条）：
 *  - rev3：旧口径「折叠态留 40±2px rail 把手」作废，判据 = 开合图标唯一 + 折叠态可见 + 点已激活页签不关整列
 *    + 顶部不再有六面板图标；
 *  - rev4 更正：E2 不以「与搜索框重叠」立论，rail 内只剩 28px 展开按钮；
 *  - rev5：开合图标必须在**顶栏右侧常驻区**、**不得**放右栏内部 ⇒ 本文件额外判
 *    「dock-open 不落在 [data-container=right] 子树内」与「dock-open 垂直中心在顶带内」。
 *  故本文件不再有任何 rail 宽度常量。 */
/** ③a 改前基线（帧门后真机读数，见文件头注释；仅用于失败消息里的改前/改后对比） */
const COMPOSER_CENTER_BASELINE: Record<string, number> = {
    "1920x1080": 130.8,
    "1440x900": 70.3,
    "1600x900": 150.6,
};
/** ① 首带必须常驻顶部导航（带名集合随断点变化，故只钉首带，不硬编码整条带名序列） */
const FIRST_CHROME_BAND_KEY = "workspace-secondary-nav";
/** ④ 同层焦点环上限（现状 border 1px + ring 2px 双层） */
const FOCUS_RING_MAX_LAYERS = 1;
/** ⑥ 左栏图标最小命中区（现状 28×28 恰好卡线，故比较用 <） */
const HIT_MIN_PX = 28;
/** ① 顶带扫描里要排除的带：settings-summary 属 chat 列内行（Lead 复核口径），
 *  SSE limit 横幅是运行态提示而非常驻 chrome。两者都照原样记进 bands 供诊断，但不算顶带层数/高度。 */
const CHROME_EXCLUDED_KEYS = ["session-settings-summary", "sse-subscriber-limit-notice"];

const VIEWPORTS = [
    { name: "1920x1080", width: 1920, height: 1080 },
    { name: "1440x900", width: 1440, height: 900 },
    { name: "1600x900", width: 1600, height: 900 },
] as const;

/** 宽屏可选档（UI_BASELINE_WIDE=1 才注册）：2560 只验同一套 6 类断言，不进 D-1907 的 3 档默认门 */
const WIDE_VIEWPORTS = [{ name: "2560x1440", width: 2560, height: 1440 }] as const;

/** D1/D2 统一口径 testid（D-1907 rev3 目标态；task-101 的 S1 落地前产品侧不存在 ⇒ 断言应红）。
 *  旧键 dock-open 本轮**不得删**：它是现状读数来源，删掉会同时失去改前/改后对比。 */
const DOCK_TOGGLE_TESTID = "workspace-dock-toggle";
const DOCK_TOGGLE_LEGACY_TESTID = "dock-open";
/** E1 区头动作簇最小命中区（D-1907 C：动作簇 ≥32×32；恒常动作下限仍是 HIT_MIN_PX = 28） */
const ACTION_CLUSTER_MIN_PX = 32;
/** A2 带层扫描容差：Σ(chromeBands.h) 与 chromeHeight 之差超此值即视为扫描被截断 */
const BAND_SCAN_TOLERANCE_PX = 1;

const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

/**
 * 把 computed backgroundColor 解析成 alpha。
 * 兼容四种真实取值：`rgb(…)`（α=1）、`rgba(r,g,b,a)`、`oklab(… / 0.3)` / `oklch(… / 0.3)`（斜杠后是 α）、
 * `transparent`（α=0）。Tailwind 的 `bg-muted/30` 编译成 oklab 斜杠形态，只认 rgb 会读成 null；
 * 解析失败一律返回 null（断言侧按「读不到 α」处理，不当作 1）。
 */
function alphaOf(color: string | null): number | null {
    if (!color) return null;
    if (color === "transparent") return 0;
    const open = color.indexOf("(");
    const close = color.lastIndexOf(")");
    if (open < 0 || close <= open) return null;
    const body = color.slice(open + 1, close);
    const slash = body.indexOf("/");
    if (slash >= 0) {
        const alpha = Number.parseFloat(body.slice(slash + 1));
        return Number.isFinite(alpha) ? alpha : null;
    }
    const parts = body
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    if (parts.length === 0) return null;
    if (parts.length < 4) return 1;
    const alpha = Number.parseFloat(parts[3]);
    return Number.isFinite(alpha) ? alpha : null;
}

interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

interface Band {
    key: string;
    fromY: number;
    h: number;
}

interface ComposerRow {
    tid: string | null;
    h: number;
    w: number;
}

interface LayoutReading {
    viewport: { w: number; h: number };
    theme: string;
    themeStorage: string | null;
    contentTop: number | null;
    content: Rect | null;
    bands: Band[];
    /** 顶带（已排除 chat 列内行与运行态横幅） */
    chromeBands: Band[];
    chromeEnd: number;
    chromeHeight: number;
    chromeNotice: number;
    composer: Rect | null;
    /** composer 与视口求交后的可见高度：「横幅不得压缩 composer 可视高度」的观测值 */
    composerVisibleH: number | null;
    /** 内层内容盒（max-w-4xl = 896）：外框是主列全宽，居中/死区只能用这一层算（B3） */
    composerInner: Rect | null;
    composerRows: ComposerRow[];
    column: Rect | null;
    /** 主列（workspace-main）：B3 居中断言的参照（audit-1 采样有 0 值异常，用前必须校验 w>0） */
    main: Rect | null;
    input: Rect | null;
    dockOpen: number;
    /** 首个 dock-open 的矩形（rev5：要在顶栏右侧常驻区） */
    dockOpenRect: Rect | null;
    /** 首个 dock-open 是否落在右栏 DOM 子树内（rev5 要求 false；无控件时为 null） */
    dockOpenInRightPanel: boolean | null;
    rightTabs: number;
    /** 展开态判据之二：页面上 aria-pressed=true 的控件数（D-1907 rev3 的唯一开合图标） */
    ariaPressedTrue: number;
    /** 顶部仍可见的六面板图标 testid（D-1907 rev3 要求为 0） */
    visiblePanelIcons: string[];
    sidebarBox: Rect | null;
    sidebar: { newChat: Rect | null; search: Rect | null; addWs: Rect | null };
    /** 帧门结果：settled=false 表示 8s 未收敛、已强制定格（读数必须标注） */
    frameGate: { settled: boolean; forcedShots: number; finishedByForce: number };
}

/** ⑤ 读数的落盘形态（record 与断言共用，加字段只改这一处） */
interface DockReading {
    collapsed: boolean;
    openControlHit: number;
    opened: boolean;
    inRightPanel?: boolean | null;
    inTopBar?: boolean | null;
    toggleCount?: number;
    togglePressedCount?: number;
    pressedBefore?: string | null;
    pressedAfter?: string | null;
    railCount?: number;
    panelIconCount?: number;
    staysOpen?: boolean;
}

interface FocusLayer {
    tid: string | null;
    tag: string;
    borderTop: string;
    borderWidthPx: number;
    outline: string;
    focusWithin: boolean;
    boxShadow: string;
    ringLayers: number;
}

interface FocusReading {
    presses: number;
    activeTid: string | null;
    activeTag: string | null;
    chain: (FocusLayer | null)[];
}

function unique(values: string[]): string[] {
    return Array.from(new Set(values));
}

function fmt(value: number | null | undefined, digits = 1): string {
    if (value === null || value === undefined) return "n/a";
    return value.toFixed(digits);
}

function fmtRect(rect: Rect | null): string {
    if (!rect) return "n/a";
    return `${fmt(rect.w)}×${fmt(rect.h)} @(${fmt(rect.x)},${fmt(rect.y)})`;
}

function describeBands(bands: Band[]): string {
    return bands.map((band) => `${band.key}@${band.fromY}+${band.h}`).join(" / ");
}

/** 按主题累积写盘：light 与 dark 分两条 test 跑，后跑的不能覆盖先跑的读数。 */
function persist(theme: Theme, records: unknown[]): void {
    mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    let existing: { generatedAt?: string; themes?: Record<string, unknown[]> } = {};
    try {
        existing = JSON.parse(readFileSync(OUT_FILE, "utf8")) as typeof existing;
    } catch {
        /* 首次运行或旧格式：重建 */
    }
    const themes = { ...(existing.themes ?? {}), [theme]: records };
    writeFileSync(
        OUT_FILE,
        `${JSON.stringify({ generatedAt: new Date().toISOString(), themes }, null, 2)}\n`,
        "utf8",
    );
}

/** 口令运行时从文件读入（不进日志、不进参数、不进截图、不进 fixture）。 */
function readAdminPassword(): string {
    const password = readFileSync(PASSWORD_FILE, "utf8").trim();
    // 只断言"非空"，绝不回显口令本身。
    expect(
        password.length,
        `口令文件 ${path.relative(ONE_ROOT, PASSWORD_FILE)} 为空`,
    ).toBeGreaterThan(0);
    return password;
}

async function loginViaForm(page: Page): Promise<void> {
    const password = readAdminPassword();
    await page.goto("/login", { waitUntil: "load" });
    await page.locator("#identifier").fill(ADMIN_IDENTIFIER);
    await page.locator("#password").fill(password);
    const [response] = await Promise.all([
        page.waitForResponse(
            (res) =>
                new URL(res.url()).pathname === "/api/v1/auth/login" &&
                res.request().method() === "POST",
        ),
        page.locator('button[type="submit"]').first().click(),
    ]);
    expect(response.status(), "登录接口应 200").toBe(200);
    await expect
        .poll(() => page.evaluate(() => Boolean(localStorage.getItem("xihe-token"))), {
            timeout: 10_000,
        })
        .toBe(true);
}

/** 走 CP 只读 API 挑「有消息」的会话（GET /api/v1/workspaces + sessions + branches + messages?limit=1）。
 *  瞬态 `Failed to fetch`（导航/上下文切换打断 evaluate）重试 3 次，每次重新装载 /workspace。 */
async function discoverSession(
    page: Page,
): Promise<{ workspaceId: string; sessionId: string; title: string | null }> {
    let lastError = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            const picked = (await page.evaluate(async () => {
                const token = localStorage.getItem("xihe-token") ?? "";
                const H: Record<string, string> = { authorization: "Bearer " + token };
                const diag: string[] = [];
                const wsRes = await fetch("/api/v1/workspaces", { headers: H });
                diag.push("workspaces:" + wsRes.status + ":token=" + (token ? token.length : 0));
                if (!wsRes.ok) return { error: "workspaces " + wsRes.status, diag };
                const wsBody = (await wsRes.json()) as
                    | { id: string; name?: string }[]
                    | { workspaces?: { id: string; name?: string }[] };
                const workspaces = Array.isArray(wsBody) ? wsBody : (wsBody.workspaces ?? []);
                for (const workspace of workspaces) {
                    const sRes = await fetch("/api/v1/sessions", {
                        headers: { ...H, "X-Workspace-Id": workspace.id },
                    });
                    diag.push("sessions:" + sRes.status + ":" + workspace.id.slice(0, 8));
                    if (!sRes.ok) continue;
                    const sessions =
                        ((await sRes.json()) as { sessions?: { id: string; title?: string }[] })
                            .sessions ?? [];
                    diag.push("count:" + sessions.length);
                    for (const session of sessions.slice(0, 40)) {
                        const brRes = await fetch("/api/v1/sessions/" + session.id + "/branches", {
                            headers: H,
                        });
                        if (!brRes.ok) {
                            diag.push("branches:" + brRes.status);
                            continue;
                        }
                        const branchId = (
                            (await brRes.json()) as { items?: { branchId?: string }[] }
                        ).items?.[0]?.branchId;
                        if (!branchId) continue;
                        const mRes = await fetch(
                            "/api/v1/sessions/" +
                                session.id +
                                "/messages?branchId=" +
                                branchId +
                                "&limit=1",
                            { headers: H },
                        );
                        if (!mRes.ok) {
                            diag.push("messages:" + mRes.status);
                            continue;
                        }
                        const body = (await mRes.json()) as unknown;
                        const messages = Array.isArray(body)
                            ? body
                            : ((body as { messages?: unknown[] }).messages ?? []);
                        if (messages.length > 0) {
                            return {
                                workspaceId: workspace.id,
                                sessionId: session.id,
                                title: session.title ?? null,
                            };
                        }
                    }
                }
                return { error: "no session with messages", diag: diag.slice(0, 12) };
            })) as
                | { workspaceId: string; sessionId: string; title: string | null }
                | { error: string; diag?: string[] };
            if ("sessionId" in picked && picked.sessionId) return picked;
            lastError = JSON.stringify(picked);
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        if (attempt < 3) await page.goto("/workspace", { waitUntil: "load" });
    }
    throw new Error("会话发现失败（重试 3 次）：" + lastError);
}

/** 打开一个已有消息的会话页并返回其 URL：已知 URL 就直达，未知才走 API 发现。
 *  不点侧栏 —— 点侧栏会开出多个容器页签，多页签 SSE 订阅会弹订阅上限横幅并污染顶带读数。 */
async function openChatSurface(page: Page, target: string | null): Promise<string> {
    const surfaceReady = async (timeoutMs: number): Promise<boolean> => {
        try {
            await page
                .locator('[data-testid="message-scroller-viewport"]')
                .first()
                .waitFor({ state: "attached", timeout: timeoutMs });
            await page
                .locator('[data-testid="chat-input"]')
                .waitFor({ state: "visible", timeout: Math.min(timeoutMs, 15_000) });
            return page.url().includes("/chat/");
        } catch {
            return false;
        }
    };
    // 已知会话 URL 就直达：少一次 /workspace 装载 = 少一个 SSE 订阅，零横幅基线更稳
    if (target) {
        await page.goto(target, { waitUntil: "load" });
        if (await surfaceReady(15_000)) return page.url();
    }
    await page.goto("/workspace", { waitUntil: "load" });
    const picked = await discoverSession(page);
    await page.goto("/workspace/" + picked.workspaceId + "/chat/" + picked.sessionId, {
        waitUntil: "load",
    });
    await expect(
        page.locator('[data-testid="message-scroller-viewport"]').first(),
        "会话页应渲染消息视口（" + String(picked.title) + "）",
    ).toBeAttached({ timeout: 20_000 });
    await expect(page.locator('[data-testid="chat-input"]'), "会话页应出现 chat-input").toBeVisible(
        {
            timeout: 15_000,
        },
    );
    return page.url();
}

/** 零横幅基线（task-98 ①）：运行态 SSE 订阅上限横幅是测试产物，出现即污染顶带读数。
 *  先等它自行消失（旧 page 已关，服务端订阅数应回落），还不行就 reload 一次再等；
 *  仍未消失则由读数记账（chromeNotice），不判红。 */
async function waitForNoticeGone(page: Page, waitMs: number): Promise<boolean> {
    const notice = page.locator('[data-testid="sse-subscriber-limit-notice"]');
    if ((await notice.count()) === 0) return true;
    try {
        await notice.first().waitFor({ state: "detached", timeout: waitMs });
        return true;
    } catch {
        return false;
    }
}

async function ensureZeroNotice(page: Page): Promise<{ cleared: boolean; reloaded: boolean }> {
    if (await waitForNoticeGone(page, 4_000)) return { cleared: true, reloaded: false };
    await page.reload({ waitUntil: "load" });
    try {
        await page
            .locator('[data-testid="chat-input"]')
            .waitFor({ state: "visible", timeout: 15_000 });
    } catch {
        /* reload 后没回到会话页时，由后续读数与断言的 fail 暴露 */
    }
    // 残留订阅要等服务端心跳超时才回收（实测 reload 后 8s 仍可能挂着）⇒ 放宽到 20s 再判
    return { cleared: await waitForNoticeGone(page, 20_000), reloaded: true };
}

// ── 帧门（task-93 ③ / task-82 定因）────────────────────────────────────────────
// 任何「读布局宽度」的断言之前都必须先过这道门。背景（实测）：后台标签页或不可见窗口里 rAF 不推进，
// reka Splitter 面板的 flex-grow 过渡（px 336 → % 21.1）会冻结在起始帧，于是 sidebar 读成 1585px、
// workspace-main / chat-composer 读成 0；直接读数的结果在 0 / 中间态 / 稳态之间随机。
// 复用片段：one/.tmp/xh/ui-gates/splitter-transition/frame-gate.mjs（此处内联，保持 spec 不依赖未跟踪的临时目录）。
async function settleLayoutFrames(
    page: Page,
    timeoutMs = 8000,
    pollMs = 50,
): Promise<{ settled: boolean; forcedShots: number; finishedByForce: number }> {
    const deadline = Date.now() + timeoutMs;
    let forcedShots = 0;
    while (Date.now() < deadline) {
        const running = await page.evaluate(
            () => document.getAnimations().filter((a) => a.playState === "running").length,
        );
        if (running === 0) return { settled: true, forcedShots, finishedByForce: 0 };
        if (forcedShots < 3) {
            // 强制一帧：不可见窗口里只有截图/录屏会推进合成
            await page.screenshot();
            forcedShots += 1;
        }
        await page.waitForTimeout(pollMs);
    }
    const finishedByForce = await page.evaluate(() => {
        const anims = document.getAnimations().filter((a) => a.playState === "running");
        anims.forEach((a) => a.finish());
        return anims.length;
    });
    return { settled: false, forcedShots, finishedByForce };
}

async function readLayout(page: Page): Promise<LayoutReading> {
    const frameGate = await settleLayoutFrames(page);
    const reading = await page.evaluate((excludedKeys: string[]) => {
        const rect = (sel: string): { x: number; y: number; w: number; h: number } | null => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
        };

        const viewport = { w: window.innerWidth, h: window.innerHeight };
        const content = rect('[data-testid="message-scroller-viewport"]');
        const contentTop = content ? content.y : null;

        // 顶带扫描：上限取内容区起点（旧探针写死 120 导致 5 条带被截断成 4 条，A2）
        const scanTo = Math.max(1, Math.round(contentTop ?? Math.min(240, viewport.h / 2)));
        const contentX = Math.round(viewport.w * 0.55);
        const raw: { fromY: number; key: string }[] = [];
        let last: string | null = null;
        for (let y = 0; y < scanTo; y += 1) {
            const hit = document.elementFromPoint(contentX, y);
            let key: string | null = null;
            let node: Element | null = hit;
            while (node && node !== document.body) {
                const tid = node.getAttribute("data-testid");
                if (tid) {
                    key = tid;
                    break;
                }
                if (node.getAttribute("role") === "tablist") {
                    key = "role=tablist";
                    break;
                }
                node = node.parentElement;
            }
            if (!key) key = hit ? hit.tagName.toLowerCase() : "none";
            if (key !== last) {
                raw.push({ fromY: y, key });
                last = key;
            }
        }
        const bands: { key: string; fromY: number; h: number }[] = [];
        for (let i = 0; i < raw.length; i += 1) {
            const from = raw[i].fromY;
            const to = i + 1 < raw.length ? raw[i + 1].fromY : scanTo;
            if (to - from > 4) bands.push({ key: raw[i].key, fromY: from, h: to - from });
        }
        // 顶带 = 常驻 chrome；排除 chat 列内行与运行态横幅（口径见 CHROME_EXCLUDED_KEYS）
        // 下界取「会话区容器带」的底边（workspace-conversation）：其下是 chat 列内行（settings-summary 等），
        // 不是顶带 —— 按带数累加会把它们算进来（1440/1600 实测会出现 5~6 条假带）。
        const conversationBand = bands.find((band) => band.key === "workspace-conversation");
        const chromeEnd = conversationBand ? conversationBand.fromY + conversationBand.h : scanTo;
        const chromeBands = bands.filter(
            (band) => band.fromY < chromeEnd && !excludedKeys.includes(band.key),
        );
        // 运行期横幅（SSE 订阅上限提示）不是产品顶带，但会把整体下推；单独记账并从高度里扣掉
        const notice = rect('[data-testid="sse-subscriber-limit-notice"]');
        const chromeNotice = notice ? notice.h : 0;
        const chromeHeight = chromeEnd - chromeNotice;

        const composerRect = rect('[data-testid="chat-composer"]');
        // 「横幅/顶带不得压缩 composer 可视高度」的观测值：composer 与视口的交集高度
        const composerVisibleH = composerRect
            ? Math.max(
                  0,
                  Math.min(composerRect.y + composerRect.h, viewport.h) -
                      Math.max(0, composerRect.y),
              )
            : null;

        const composerRows: { tid: string | null; h: number; w: number }[] = [];
        const composerEl = document.querySelector('[data-testid="chat-composer"]');
        const inner = composerEl?.firstElementChild ?? null;
        if (inner) {
            for (const child of Array.from(inner.children)) {
                const r = child.getBoundingClientRect();
                composerRows.push({
                    tid: child.getAttribute("data-testid"),
                    h: r.height,
                    w: r.width,
                });
            }
        }

        // D-1907 rev5：开合图标必须在顶栏右侧常驻区、**不得**落在右栏 DOM 子树内
        const dockOpenEls = Array.from(document.querySelectorAll('[data-testid="dock-open"]'));
        const dockOpenEl = dockOpenEls[0] ?? null;
        const dockOpenRect = dockOpenEl
            ? (() => {
                  const r = dockOpenEl.getBoundingClientRect();
                  return { x: r.x, y: r.y, w: r.width, h: r.height };
              })()
            : null;
        const dockOpenInRightPanel = dockOpenEl
            ? dockOpenEl.closest('[data-container="right"]') !== null
            : null;

        return {
            viewport,
            theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
            themeStorage: localStorage.getItem("xihe-theme"),
            contentTop,
            content,
            bands,
            chromeBands,
            chromeEnd,
            chromeHeight,
            chromeNotice,
            composer: composerRect,
            composerVisibleH,
            composerInner: inner
                ? (() => {
                      const r = inner.getBoundingClientRect();
                      return { x: r.x, y: r.y, w: r.width, h: r.height };
                  })()
                : null,
            composerRows,
            column: rect('[data-testid="workspace-conversation"]'),
            main: rect('[data-testid="workspace-main"]'),
            input: rect('[data-testid="chat-input"]'),
            dockOpen: dockOpenEls.length,
            dockOpenRect,
            dockOpenInRightPanel,
            rightTabs: document.querySelectorAll(
                '[data-testid="workspace-container-tabs"][data-container="right"]',
            ).length,
            // 右栏展开态的第二个判据：D-1907 rev3 要求开合由「唯一 aria-pressed 图标」表达（现状是六面板图标）
            ariaPressedTrue: document.querySelectorAll('[aria-pressed="true"]').length,
            // 顶部六面板图标（WorkspacePanelActions.vue:49-116 的 files/code/changes/monitor/members/delegation）
            visiblePanelIcons: [
                "workspace-toolbar-files",
                "workspace-toolbar-code",
                "workspace-toolbar-changes",
                "workspace-toolbar-monitor",
                "workspace-toolbar-members",
                "workspace-toolbar-delegation",
            ].filter((id) => {
                const el = document.querySelector(`[data-testid="${id}"]`);
                if (!el) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            }),
            sidebarBox: rect('[data-testid="sidebar"]'),
            sidebar: {
                newChat: rect('[data-testid="sidebar-new-chat"]'),
                search: rect('[data-testid="sidebar-session-search"]'),
                addWs: rect('[data-testid="sidebar-add-workspace"]'),
            },
        };
    }, CHROME_EXCLUDED_KEYS);
    return { ...(reading as Omit<LayoutReading, "frameGate">), frameGate };
}

/** 只用键盘 Tab 站到 chat-input，避免脚本 focus() 造出产品里不存在的焦点态。 */
async function tabToChatInput(page: Page, maxPresses = 400): Promise<number> {
    for (let i = 1; i <= maxPresses; i += 1) {
        await page.keyboard.press("Tab");
        const tid = await page.evaluate(
            () => document.activeElement?.getAttribute("data-testid") ?? null,
        );
        if (tid === "chat-input") return i;
    }
    return -1;
}

async function readFocusChain(page: Page): Promise<Omit<FocusReading, "presses">> {
    const reading = await page.evaluate(() => {
        // 环层 = box-shadow 里非透明、非 elevation 的层（旧探针 classifyRing 的简化版）
        const ringLayers = (shadow: string): number => {
            if (!shadow || shadow === "none") return 0;
            return shadow
                .split(/,(?![^(]*\))/)
                .map((part) => part.trim())
                .filter((part) => part.length > 0)
                .filter((part) => !/\btransparent\b/i.test(part))
                .filter((part) => {
                    // 颜色可能在前也可能在后：先判 alpha=0（rgba 第四参 / oklab|color 的 / a）
                    const rgba = part.match(/rgba?\(([^)]*)\)/i);
                    if (rgba) {
                        const args = rgba[1].split(",").map((v) => v.trim());
                        if (args.length === 4 && Number.parseFloat(args[3]) === 0) return false;
                    }
                    const slashAlpha = part.match(/\/\s*([\d.]+)\s*\)/);
                    if (slashAlpha && Number.parseFloat(slashAlpha[1]) === 0) return false;
                    // 再判「零偏移 + 零 blur + 零 spread」的空层（Chrome 计算值会带 4 个 0px）
                    const lengths = (part.match(/-?\d*\.?\d+px/g) ?? []).map(
                        (v) => Number.parseFloat(v) || 0,
                    );
                    if (lengths.length > 0 && lengths.every((v) => v === 0)) return false;
                    return true;
                }).length;
        };
        const layer = (el: Element) => {
            const cs = getComputedStyle(el);
            const widths = [
                cs.borderTopWidth,
                cs.borderRightWidth,
                cs.borderBottomWidth,
                cs.borderLeftWidth,
            ].map((w) => Number.parseFloat(w) || 0);
            return {
                tid: el.getAttribute("data-testid"),
                tag: el.tagName.toLowerCase(),
                borderTop: cs.borderTopWidth,
                borderWidthPx: Math.max(...widths),
                outline: cs.outlineWidth + " " + cs.outlineStyle + " " + cs.outlineColor,
                focusWithin: el.matches(":focus-within"),
                boxShadow: cs.boxShadow,
                ringLayers: ringLayers(cs.boxShadow),
            };
        };
        const chain: (ReturnType<typeof layer> | null)[] = [];
        let node: Element | null = document.activeElement;
        for (let i = 0; i < 4 && node; i += 1) {
            chain.push(layer(node));
            node = node.parentElement;
        }
        return {
            activeTid: document.activeElement?.getAttribute("data-testid") ?? null,
            activeTag: document.activeElement?.tagName.toLowerCase() ?? null,
            chain,
        };
    });
    return reading as Omit<FocusReading, "presses">;
}

async function captureShot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
    mkdirSync(SHOT_DIR, { recursive: true });
    const file = path.join(SHOT_DIR, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    await testInfo.attach(name, { path: file, contentType: "image/png" });
}

/** 一屏一 page：跑完一个视口的全部断言后关掉该 page，保证同一时刻只有一个页面订阅 SSE。 */
async function runMatrix(
    rootPage: Page,
    theme: Theme,
    testInfo: TestInfo,
    viewports: readonly { name: string; width: number; height: number }[],
): Promise<void> {
    const records: {
        viewport: string;
        theme: Theme;
        layout: LayoutReading;
        focus: FocusReading | null;
        dock: DockReading | null;
    }[] = [];

    await loginViaForm(rootPage);
    // 主题落盘形态是裸值（stores/settings.ts:52-58），不走 JSON 引号形态；
    // 挂在 context 上而不是 page 上，后开的每视口 page 才会自动继承主题初始化脚本。
    await rootPage.context().addInitScript((value: string) => {
        try {
            window.localStorage.setItem("xihe-theme", value);
        } catch {
            /* 隐私模式下 localStorage 不可写时忽略，断言会以主题不符暴露 */
        }
    }, theme);

    let chatUrl: string | null = null;
    for (const [index, vp] of viewports.entries()) {
        // 每视口新开 page（同 context 复用登录态）：旧 page 先关，避免多页签累积 SSE 订阅把 37px 横幅顶出来
        const page = index === 0 ? rootPage : await rootPage.context().newPage();
        await page.setViewportSize({ width: vp.width, height: vp.height });
        const tag = `${vp.name}-threed${theme}`;
        chatUrl = await openChatSurface(page, chatUrl);
        // 零横幅（task-98 ①）：先让运行态 SSE 横幅退场再读数；仍未退场则按 chromeNotice 记账，不判红
        const noticeState = await ensureZeroNotice(page);
        if (!noticeState.cleared) {
            console.log(
                `[ui-baseline] ${tag} 横幅 reload=${noticeState.reloaded} 后仍在，按记账口径处理`,
            );
        }
        const layout = await readLayout(page);
        // 先落盘再断言：软断言失败 / 后续视口中断都不会丢已测读数
        const record = {
            viewport: vp.name,
            theme,
            layout,
            focus: null as FocusReading | null,
            dock: null as DockReading | null,
        };
        records.push(record);
        persist(theme, records);

        // 帧门结果先入账：8s 未收敛（a.finish() 强制定格）必须留痕，否则读数会被当成自然稳态
        if (!layout.frameGate.settled) {
            testInfo.annotations.push({
                type: "frame-gate",
                description: `${tag} 布局动画 8s 未收敛，已强制定格 ${layout.frameGate.finishedByForce} 个动画（读数标记为「已强制定格」）`,
            });
        }
        // 宽度取不到必须 fail（不 skip）：B3 的三条断言全部依赖这些宽度，0 值读数会让断言变成假绿
        const gateWidths = {
            sidebar: layout.sidebarBox?.w ?? null,
            main: layout.main?.w ?? null,
            composer: layout.composer?.w ?? null,
            composerInner: layout.composerInner?.w ?? null,
        };
        const missingWidths = Object.entries(gateWidths)
            .filter(([, w]) => w === null || w <= 0)
            .map(([key]) => key);
        expect
            .soft(
                missingWidths,
                `${tag} 帧门后仍有宽度取不到：${missingWidths.join(",") || "无"}（宽度 ${JSON.stringify(gateWidths)}，gate=${JSON.stringify(layout.frameGate)}）`,
            )
            .toHaveLength(0);

        expect
            .soft(
                layout.theme,
                `${tag} 主题未按预期生效（html.dark / xihe-theme=${String(layout.themeStorage)}）`,
            )
            .toBe(theme);

        // ① 顶带层数与顶带高度（A1 修正口径：现状 4 条带 / 合计 124px）
        expect
            .soft(
                layout.chromeBands.length,
                `${tag} ①顶带层数=${layout.chromeBands.length}（期望≤${CHROME_MAX_BANDS}）实测：${describeBands(layout.chromeBands)}（全量含 chat 列内行：${describeBands(layout.bands)}）`,
            )
            .toBeLessThanOrEqual(CHROME_MAX_BANDS);
        expect
            .soft(
                layout.chromeHeight,
                `${tag} ①顶带高度=${fmt(layout.chromeHeight)}px（期望≤${CHROME_MAX_CONTENT_TOP}px = ${CHROME_MAX_BANDS}×${CHROME_ROW_HEIGHT_PX}+8；消息视口起点 y=${fmt(layout.contentTop)}px）`,
            )
            .toBeLessThanOrEqual(CHROME_MAX_CONTENT_TOP);

        // ①A2（doc:34）：带层扫描必须覆盖到会话容器底边 —— Σ(带高) 与 chromeHeight 之差 ≤1px，
        //    否则「4 带 124px」可能只是扫描被截断（旧探针 y<120 正是这样把 124 读成 120）。
        const chromeBandSum = layout.chromeBands.reduce((sum, band) => sum + band.h, 0);
        const bandScanGap = Math.abs(chromeBandSum - layout.chromeHeight);
        expect
            .soft(
                bandScanGap,
                `${tag} ①A2 带层扫描缺口 ${fmt(bandScanGap)}px（实测 Σ带高=${fmt(chromeBandSum)}，chromeHeight=${fmt(layout.chromeHeight)}；阈值 ≤${BAND_SCAN_TOLERANCE_PX}px 归属卡 task-102 F-8/A2）实测带：${describeBands(layout.chromeBands)}`,
            )
            .toBeLessThanOrEqual(BAND_SCAN_TOLERANCE_PX);

        // ① 首带必须是常驻顶部导航（task-98 ②）：窄断点会把 secondary-nav 换行成 workspace-nav-* 条目，
        //    带名集合随断点变化 ⇒ 只钉首带，不硬编码整条带名序列。
        expect
            .soft(
                layout.chromeBands[0]?.key,
                `${tag} ①首带=${String(layout.chromeBands[0]?.key)}（期望 ${FIRST_CHROME_BAND_KEY}）实测：${describeBands(layout.chromeBands)}`,
            )
            .toBe(FIRST_CHROME_BAND_KEY);

        // ① 运行态横幅只记账、不判红，但不得压缩 composer 可视高度（task-98 ①）
        if (layout.chromeNotice > 0) {
            testInfo.annotations.push({
                type: "sse-notice",
                description: `${tag} 出现 ${fmt(layout.chromeNotice)}px 的 sse-subscriber-limit-notice（测试产物，已从 chromeHeight 扣除，不判红）`,
            });
            console.log(`[ui-baseline] ${tag} 横幅 ${fmt(layout.chromeNotice)}px 已记账`);
        }
        const composerClippedPx =
            layout.composer && layout.composerVisibleH !== null
                ? layout.composer.h - layout.composerVisibleH
                : 0;
        expect
            .soft(
                composerClippedPx,
                `${tag} ①composer 被裁掉 ${fmt(composerClippedPx)}px（横幅/顶带不得压缩 composer 可视高度：composer ${fmtRect(layout.composer)} 可见 ${fmt(layout.composerVisibleH)}px，视口 ${layout.viewport.h}px）`,
            )
            .toBeLessThanOrEqual(0.5);

        // ② composer 块高 / 视口高（A3；现状 16.1%@1920、22.7%@1366）
        const composerRatio = layout.composer ? layout.composer.h / layout.viewport.h : Number.NaN;
        expect
            .soft(
                composerRatio,
                `${tag} ②composer 块高 ${fmt(layout.composer?.h)}px / 视口 ${layout.viewport.h}px = ${fmt(composerRatio * 100)}%（期望≤${COMPOSER_MAX_VIEWPORT_RATIO * 100}%）行：${layout.composerRows.map((row) => `${row.tid ?? "?"}:${fmt(row.h)}`).join(" ")}`,
            )
            .toBeLessThanOrEqual(COMPOSER_MAX_VIEWPORT_RATIO);

        // ②C3（doc:44）：composer 容器背景必须不透明 —— 计算值 alpha = 1。
        //    现状 InputArea.vue:1883 用 bg-muted/30（半透明）⇒ 改前必红。测试位置就在本 spec。
        const composerBg = await page
            .evaluate(() => {
                let el: Element | null = document.querySelector('[data-testid="chat-input"]');
                for (let depth = 0; depth < 6 && el; depth += 1) {
                    el = el.parentElement;
                    if (!el) break;
                    const bg = getComputedStyle(el).backgroundColor;
                    if (!bg || bg === "transparent" || bg === "rgba(0, 0, 0, 0)") continue;
                    return { color: bg, depth, tid: el.getAttribute("data-testid") };
                }
                return null;
            })
            .catch(() => null);
        const composerBgAlpha = composerBg ? alphaOf(composerBg.color) : null;
        expect
            .soft(
                composerBgAlpha,
                `${tag} ②C3 composer 容器背景不透明度 ${String(composerBgAlpha)}（实测 ${String(composerBg?.color ?? "无背景层")}，第 ${String(composerBg?.depth ?? "-")} 层 ${String(composerBg?.tid ?? "-")}；阈值 alpha=1 归属卡 task-73 C3）`,
            )
            .toBe(1);

        // ③a composer 在主列内水平居中（B3-①，Lead 修订：全视口判内盒中心 vs workspace-main 中心）。
        //     外框是主列全宽，必须用内层 max-w-4xl 盒算；主列 rect 取不到/宽 0 时 fail 并写清原因（不 skip）。
        const main = layout.main;
        const mainUsable = main !== null && main.w > 0;
        if (layout.composerInner && mainUsable) {
            const box = layout.composerInner;
            const boxCenter = box.x + box.w / 2;
            const mainCenter = main.x + main.w / 2;
            const centerDeviation = Math.abs(boxCenter - mainCenter);
            expect
                .soft(
                    centerDeviation,
                    `${tag} ③a composer 中心偏离主列中心 ${fmt(centerDeviation)}px（期望≤${COMPOSER_CENTER_TOLERANCE_PX}；改前基线 ${fmt(COMPOSER_CENTER_BASELINE[vp.name])}px，本屏偏离基线 ${fmt(centerDeviation - (COMPOSER_CENTER_BASELINE[vp.name] ?? 0))}px）内盒 ${fmtRect(box)} 中心 ${fmt(boxCenter)}，主列 ${fmtRect(main)} 中心 ${fmt(mainCenter)}`,
                )
                .toBeLessThanOrEqual(COMPOSER_CENTER_TOLERANCE_PX);
        } else {
            // 明确 fail（旧写法 `expect(对象).not.toBeNull()` 恒真 = 假绿，已修）
            expect
                .soft(
                    {
                        composerInner: layout.composerInner,
                        main,
                        frameGate: layout.frameGate,
                    },
                    `${tag} ③a 取不到 composer 内盒或 workspace-main 主列（rect.w>0 校验失败；audit-1 报过主列 0 宽采样异常，task-82 定因为 Splitter 过渡帧，现已在读数前过帧门）`,
                )
                .toBeNull();
        }

        // ③b 死区平衡（B3-②，**task-67 r5 口径**，Lead 2026-11-20 00:46 裁定）：
        // 旧口径「1920 展开态右死区 ≤40px」在 896 定宽下数学不可达（最小 130.81），已废；
        // 现在只判「右死区 ≈ (主列宽 − 内盒宽) / 2」⇒ 左右余量相等。居中本身由 ③a 判，
        // 这条判的是「余量没有全堆在右边 / 没有贴左」。三档视口都判，不再依赖「1920 必须展开右栏」。
        if (layout.composerInner && mainUsable) {
            const box = layout.composerInner;
            const rightDeadZone = main.x + main.w - (box.x + box.w);
            const balancedDeadZone = (main.w - box.w) / 2;
            const deadZoneDeviation = Math.abs(rightDeadZone - balancedDeadZone);
            expect
                .soft(
                    deadZoneDeviation,
                    `${tag} ③b 右死区 ${fmt(rightDeadZone)}px 对等分余量 ${fmt(balancedDeadZone)}px（= (${fmt(main.w)} − ${fmt(box.w)}) / 2）偏差 ${fmt(deadZoneDeviation)}px，期望≤${COMPOSER_CENTER_TOLERANCE_PX}（task-67 r5：不判绝对上限；内盒 ${fmtRect(box)}，主列 ${fmtRect(main)}）`,
                )
                .toBeLessThanOrEqual(COMPOSER_CENTER_TOLERANCE_PX);
        } else {
            // 取不到内盒/主列时明确 fail（不 skip），与 ③a 同口径
            expect
                .soft(
                    { composerInner: layout.composerInner, main },
                    `${tag} ③b 取不到 composer 内盒或 workspace-main 主列（rect.w>0 校验失败）`,
                )
                .toBeNull();
        }

        // ④ 焦点环层数（B1；只用键盘进入，现状 border 1px + ring 2px 双层）
        let focus: FocusReading | null = null;
        if (vp.name === "1920x1080") {
            await page.locator('[data-testid="chat-input"]').click();
            await page.locator("body").click({ position: { x: 2, y: 2 } });
            const presses = await tabToChatInput(page);
            // task-102 F-1：旧写法把「未到达」写成 presses >= 0，而 tabToChatInput 未到达时返回 -1
            // ⇒ 旧分支恒真（假绿），现在无条件判「至少 1 次 Tab 就到得了 chat-input」。
            expect
                .soft(
                    presses,
                    `${tag} ④键盘 Tab 到达 chat-input 用了 ${presses} 次（实测 ${presses}，阈值 ≥1；-1 表示未到达 归属卡 task-102 F-1）`,
                )
                .toBeGreaterThanOrEqual(1);
            if (presses < 0) {
                // 不用 test.fixme(true)：运行期调用会立刻终止本条 test，读数落盘全丢；只记注解
                testInfo.annotations.push({
                    type: "fixme",
                    description:
                        "待用户确认：键盘 Tab 站点顺序里未到达 chat-input，焦点环断言未覆盖",
                });
            } else {
                // 环有 transition；等 400ms 让 box-shadow/outline 稳定后再读，否则读到过渡前的空值
                await page.waitForTimeout(400);
                const chain = await readFocusChain(page);
                focus = { presses, ...chain };
                // task-102 F-2：旧写法在链为空时 maxRingLayers 恒为 0 ⇒ 环层数断言恒绿（假绿）。
                // 先判「链里至少有一层」，再判层数上限。
                const nonEmptyLayers = chain.chain.filter((layer) => layer !== null);
                expect
                    .soft(
                        nonEmptyLayers.length,
                        `${tag} ④焦点链为空（active=${String(chain.activeTid)}，层数 ${nonEmptyLayers.length}；阈值 >0 归属卡 task-102 F-2）`,
                    )
                    .toBeGreaterThan(0);
                // 焦点指示必须可见：要么有 alpha>0 的环层，要么有生效的 outline（style 非 none 且宽度>0）
                const hasRing = chain.chain.some((layer) => layer !== null && layer.ringLayers > 0);
                const hasOutline = chain.chain.some((layer) => {
                    if (!layer) return false;
                    const width = Number.parseFloat(layer.outline) || 0;
                    return width > 0 && !/\bnone\b/.test(layer.outline);
                });
                expect
                    .soft(
                        hasRing || hasOutline,
                        `${tag} ④焦点指示不可见（ring 层=0 且 outline 未生效）链：${chain.chain.map((l) => (l ? `${l.tid ?? l.tag}[${l.outline}]` : "null")).join(" ← ")}`,
                    )
                    .toBe(true);
                const ringer = chain.chain.find((layer) => layer && layer.ringLayers > 0) ?? null;
                const maxRingLayers = Math.max(
                    0,
                    ...chain.chain.map((layer) => layer?.ringLayers ?? 0),
                );
                expect
                    .soft(
                        maxRingLayers,
                        `${tag} ④焦点环层数=${maxRingLayers}（期望≤${FOCUS_RING_MAX_LAYERS}）active=${String(chain.activeTid)} 链：${chain.chain
                            .map((layer) =>
                                layer
                                    ? `${layer.tid ?? layer.tag}[border ${layer.borderTop}, ring ${layer.ringLayers}]`
                                    : "null",
                            )
                            .join(" ← ")}`,
                    )
                    .toBeLessThanOrEqual(FOCUS_RING_MAX_LAYERS);
                expect
                    .soft(
                        ringer ? ringer.borderWidthPx : 0,
                        `${tag} ④焦点环容器同时带边框（border ${ringer?.borderTop ?? "n/a"}，shadow ${ringer?.boxShadow ?? "n/a"}）`,
                    )
                    .toBe(0);
                // B2（doc:38 前半）：--ring 不得直接等于 --primary，否则焦点环与选中态同色。
                // 后半「ring 对比 ≥3.0」归 src/styles/__tests__/tokenContrast.spec.ts（vitest），不在本 spec 判。
                const ringTokens = await page.evaluate(() => {
                    const style = getComputedStyle(document.documentElement);
                    const read = (name: string) => style.getPropertyValue(name).trim();
                    return { ring: read("--ring"), primary: read("--primary") };
                });
                expect
                    .soft(
                        ringTokens.ring,
                        `${tag} ④B2 --ring 与 --primary 同值（实测 --ring=${ringTokens.ring || "空"}，--primary=${ringTokens.primary || "空"}；阈值 两者不等 归属卡 task-73 B2）`,
                    )
                    .not.toBe(ringTokens.primary);
            }
        }

        // ⑤ 右栏折叠态的开合控件（D1 修正：有六键工具栏 WorkspaceToolbar.vue:70-75 → WorkspacePanelActions，
        //    能逐个开合面板，缺的是**单一 toggle**；D2：折叠后整列含页签行不渲染、无展开把手 ⇒ dock-open 命中 0）
        // D-1907 rev5 判据（取代 rev3 的「唯一 + 可见 + 可开」三项，rev4 更正 rail 内只剩 28px 展开按钮）：
        // 折叠态 ⇒ 开合图标唯一、可见、可点开，且**必须位于顶栏右侧常驻区、不得落在右栏 DOM 子树内**；
        // 展开态 ⇒ 顶部六面板图标退场，且点已激活页签不关整列。
        // ⑤ 右栏单一开合图标（D1/D2/D4；D-1907 rev3 B + rev5 位置口径；task-102 二轮：
        //    F-3 展开态也要判位置、F-4 不再用「页面上任意 aria-pressed」判展开、
        //    F5'/F-7 六面板图标改**计数**判据（不按 rect 猜可见性）、D1 判 aria-pressed 翻转。
        //    现状产品侧没有 workspace-dock-toggle / dock-rail ⇒ 折叠态那一串断言改前必红。）
        let dock: DockReading | null = null;
        const collapsed = layout.rightTabs === 0;
        const dockToggle = page.locator(`[data-testid="${DOCK_TOGGLE_TESTID}"]`);
        const dockTogglePressed = page.locator(
            `[data-testid="${DOCK_TOGGLE_TESTID}"][aria-pressed]`,
        );
        const toggleCount = await dockToggle.count();
        const togglePressedCount = await dockTogglePressed.count();
        const legacyToggleCount = await page
            .locator(`[data-testid="${DOCK_TOGGLE_LEGACY_TESTID}"]`)
            .count();
        const railCount = await page.locator('[data-testid="dock-rail"]').count();
        const toggleBox = toggleCount > 0 ? await dockToggle.first().boundingBox() : null;
        const toggleInRightPanel =
            toggleCount > 0
                ? await dockToggle
                      .first()
                      .evaluate((el) => el.closest('[data-container="right"]') !== null)
                : null;
        // D1：开合图标唯一且带 aria-pressed（旧键 dock-open 的命中数只作诊断打印）
        expect
            .soft(
                togglePressedCount,
                `${tag} ⑤D1 单一开合图标 [data-testid=${DOCK_TOGGLE_TESTID}][aria-pressed] 命中 ${togglePressedCount} 个（实测 ${togglePressedCount}，阈值 =1；旧键 ${DOCK_TOGGLE_LEGACY_TESTID} 命中 ${legacyToggleCount} 归属卡 task-102 D1）`,
            )
            .toBe(1);
        // D2：不得出现 rail 竖条（D-1907 rev3 已作废「折叠态留 40±2px 把手」）
        expect
            .soft(
                railCount,
                `${tag} ⑤D2 出现 dock-rail 竖条 ${railCount} 个（实测 ${railCount}，阈值 0 归属卡 task-73 D2）`,
            )
            .toBe(0);
        // rev5 / F-3：图标必须在顶栏常驻区、不得落在右栏 DOM 子树内 —— 折叠与展开两态同判
        expect
            .soft(
                toggleInRightPanel,
                `${tag} ⑤rev5 开合图标落在右栏 DOM 子树内（实测 ${String(toggleInRightPanel)}，阈值 false；无图标时为 null 归属卡 task-102 F-3）`,
            )
            .toBe(false);
        let opened = false;
        if (collapsed) {
            const toggleVisible = toggleCount > 0 ? await dockToggle.first().isVisible() : false;
            expect
                .soft(
                    toggleVisible,
                    `${tag} ⑤D2 折叠态开合图标不可见（实测 visible=${toggleVisible}，阈值 true 归属卡 task-73 D2）`,
                )
                .toBe(true);
            const toggleMin = Math.min(toggleBox?.width ?? 0, toggleBox?.height ?? 0);
            expect
                .soft(
                    toggleMin,
                    `${tag} ⑤D2 折叠态开合图标命中区 ${toggleBox ? `${fmt(toggleBox.width)}×${fmt(toggleBox.height)}` : "无"}（实测 min=${fmt(toggleMin)}，阈值 ≥${HIT_MIN_PX}×${HIT_MIN_PX} 归属卡 task-73 D2）`,
                )
                .toBeGreaterThanOrEqual(HIT_MIN_PX);
            const inTopBar =
                toggleBox !== null && toggleBox.y + toggleBox.height / 2 <= CHROME_MAX_CONTENT_TOP;
            expect
                .soft(
                    inTopBar,
                    `${tag} ⑤rev5 折叠态开合图标不在顶栏常驻区（中心 y=${fmt(toggleBox ? toggleBox.y + toggleBox.height / 2 : null)}，上限 ${CHROME_MAX_CONTENT_TOP}px，rect=${toggleBox ? `${fmt(toggleBox.width)}×${fmt(toggleBox.height)}@(${fmt(toggleBox.x)},${fmt(toggleBox.y)})` : "无"} 归属卡 task-102 F-3）`,
                )
                .toBe(true);
            let pressedBefore: string | null = null;
            let pressedAfter: string | null = null;
            if (togglePressedCount > 0) {
                pressedBefore = await dockTogglePressed.first().getAttribute("aria-pressed");
                await dockTogglePressed.first().click();
                await page.waitForTimeout(200);
                pressedAfter = await dockTogglePressed
                    .first()
                    .getAttribute("aria-pressed")
                    .catch(() => null);
                opened =
                    (await page
                        .locator('[data-testid="workspace-container-tabs"][data-container="right"]')
                        .count()) > 0;
            }
            // D1：点击必须翻转 aria-pressed（与 F-1 同型 —— 不翻转等于没有开关）
            expect
                .soft(
                    pressedBefore !== pressedAfter,
                    `${tag} ⑤D1 点击开合图标后 aria-pressed 未翻转（实测 before=${String(pressedBefore)} after=${String(pressedAfter)}，阈值 翻转 归属卡 task-102 D1）`,
                )
                .toBe(true);
            expect
                .soft(
                    opened,
                    `${tag} ⑤D2 点击开合图标后右侧容器页签未出现（实测 opened=${opened}，阈值 true 归属卡 task-73 D2）`,
                )
                .toBe(true);
            dock = {
                collapsed,
                openControlHit: toggleCount,
                opened,
                inRightPanel: toggleInRightPanel,
                inTopBar,
                toggleCount,
                togglePressedCount,
                pressedBefore,
                pressedAfter,
                railCount,
            };
        } else {
            // F5'/F-7：展开态顶部不得再有六面板图标 —— 用计数判据（旧版按 rect 判可见会漏）
            const panelIconCount = await page
                .locator('[data-testid^="workspace-toolbar-"]')
                .count();
            expect
                .soft(
                    panelIconCount,
                    `${tag} ⑤F5' 展开态顶部仍有 ${panelIconCount} 个 workspace-toolbar-* 图标（实测 ${panelIconCount}，阈值 0；rect 可见读数 ${layout.visiblePanelIcons.join(",") || "无"} 归属卡 task-102 F5'）`,
                )
                .toBe(0);
            // D4：点已激活的 right 页签不得关整列
            const activeTab = page.locator('[data-testid^="dock-tab-"][aria-selected="true"]');
            const activeTabHit = await activeTab.count();
            expect
                .soft(
                    activeTabHit,
                    `${tag} ⑤D4 找不到已激活的右侧页签（dock-tab-*[aria-selected=true]）实测 ${activeTabHit}，阈值 ≥1 归属卡 task-88 D4`,
                )
                .toBeGreaterThanOrEqual(1);
            let staysOpen = false;
            if (activeTabHit > 0) {
                await activeTab.first().click();
                staysOpen =
                    (await page
                        .locator('[data-testid="workspace-container-tabs"][data-container="right"]')
                        .count()) > 0;
            }
            expect
                .soft(
                    staysOpen,
                    `${tag} ⑤D4 点击已激活页签后整列被关闭（实测 staysOpen=${staysOpen}，阈值 true 归属卡 task-88 D4）`,
                )
                .toBe(true);
            dock = {
                collapsed,
                openControlHit: toggleCount,
                opened: staysOpen,
                inRightPanel: toggleInRightPanel,
                inTopBar: null,
                toggleCount,
                togglePressedCount,
                railCount,
                panelIconCount,
                staysOpen,
            };
        }

        // ⑥ 左栏（task-102 二轮）：E1/E1a 命中区、E1' 三常驻动作、E2' new-chat 位置、E3 组头「+」、
        //    E4① 会话区头、E4② 会话/工作区次级动作常驻入口。
        //    F-6：旧「新建会话与搜索框纵向不重叠」立论已撤（D-1236/task-373 起该键就是两项菜单触发器），删除。
        //    可见性一律用 count/isVisible 判（F-7：不按 rect 猜）。
        const { newChat, addWs } = layout.sidebar;
        const importSourceBox = await page
            .locator('[data-testid="sidebar-import-source"]')
            .boundingBox()
            .catch(() => null);
        expect.soft(newChat, `${tag} ⑥未找到 [data-testid=sidebar-new-chat]`).not.toBeNull();
        expect.soft(addWs, `${tag} ⑥未找到 [data-testid=sidebar-add-workspace]`).not.toBeNull();

        // E1a：恒常动作下限 28×28（sidebar-new-chat / sidebar-import-source）
        if (newChat) {
            const newChatMin = Math.min(newChat.w, newChat.h);
            expect
                .soft(
                    newChatMin,
                    `${tag} ⑥E1a 新建会话命中区 ${fmtRect(newChat)}（实测 min=${fmt(newChatMin)}，阈值 ≥${HIT_MIN_PX}×${HIT_MIN_PX} 归属卡 task-73 E1a）`,
                )
                .toBeGreaterThanOrEqual(HIT_MIN_PX);
        }
        if (importSourceBox) {
            const importMin = Math.min(importSourceBox.width, importSourceBox.height);
            expect
                .soft(
                    importMin,
                    `${tag} ⑥E1a 导入源命中区 ${fmt(importSourceBox.width)}×${fmt(importSourceBox.height)}（实测 min=${fmt(importMin)}，阈值 ≥${HIT_MIN_PX}×${HIT_MIN_PX} 归属卡 task-73 E1a）`,
                )
                .toBeGreaterThanOrEqual(HIT_MIN_PX);
            // E1：区头动作簇 ≥32×32（D-1907 C）
            expect
                .soft(
                    importMin,
                    `${tag} ⑥E1 导入源命中区 ${fmt(importSourceBox.width)}×${fmt(importSourceBox.height)}（实测 min=${fmt(importMin)}，阈值 ≥${ACTION_CLUSTER_MIN_PX}×${ACTION_CLUSTER_MIN_PX}，恒常下限 ${HIT_MIN_PX} 归属卡 task-73 E1）`,
                )
                .toBeGreaterThanOrEqual(ACTION_CLUSTER_MIN_PX);
        }
        if (addWs) {
            const addWsMin = Math.min(addWs.w, addWs.h);
            expect
                .soft(
                    addWsMin,
                    `${tag} ⑥E1 新建工作区命中区 ${fmtRect(addWs)}（实测 min=${fmt(addWsMin)}，阈值 ≥${ACTION_CLUSTER_MIN_PX}×${ACTION_CLUSTER_MIN_PX}，恒常下限 ${HIT_MIN_PX} 归属卡 task-73 E1）`,
                )
                .toBeGreaterThanOrEqual(ACTION_CLUSTER_MIN_PX);
        }

        // E2'：新建会话必须在首个会话行之上（Sidebar.vue:279-337 现状仍在搜索行 ⇒ 改前必红）
        const firstSessionRow = await page
            .locator('[data-testid="session-item"]')
            .first()
            .boundingBox()
            .catch(() => null);
        if (newChat && firstSessionRow) {
            const newChatBottom = newChat.y + newChat.h;
            expect
                .soft(
                    newChatBottom - firstSessionRow.y,
                    `${tag} ⑥E2' 新建会话底边 ${fmt(newChatBottom)} 未高于首个会话行顶边 ${fmt(firstSessionRow.y)}（差值 ${fmt(newChatBottom - firstSessionRow.y)}px，阈值 ≤0 归属卡 task-73 E2'）`,
                )
                .toBeLessThanOrEqual(0);
        } else {
            expect
                .soft(
                    { newChat, firstSessionRow },
                    `${tag} ⑥E2' 取不到新建会话或首个会话行（不 skip，按 fail 暴露 归属卡 task-73 E2'）`,
                )
                .toBeNull();
        }

        // E3 / E4① / E4②：常驻可见性用 count + isVisible 判据
        const groupAdd = page.locator('[data-testid="sidebar-group-add"]');
        const groupAddCount = await groupAdd.count();
        const groupAddVisible = groupAddCount > 0 ? await groupAdd.first().isVisible() : false;
        expect
            .soft(
                groupAddVisible,
                `${tag} ⑥E3 会话组头「+」不 hover 即不可见（实测 count=${groupAddCount} visible=${groupAddVisible}，阈值 可见=true 归属卡 task-73 E3）`,
            )
            .toBe(true);
        const sessionsHeaderCount = await page
            .locator('[data-testid="sidebar-sessions-header"]')
            .count();
        expect
            .soft(
                sessionsHeaderCount,
                `${tag} ⑥E4① 会话区头计数 ${sessionsHeaderCount}（实测 ${sessionsHeaderCount}，阈值 =1 归属卡 task-73 E4①）`,
            )
            .toBe(1);
        const sessionMoreVisible = await page
            .locator('[data-testid="sidebar-session-more"]')
            .first()
            .isVisible()
            .catch(() => false);
        expect
            .soft(
                sessionMoreVisible,
                `${tag} ⑥E4② 会话次级动作 sidebar-session-more 不常驻（实测 visible=${sessionMoreVisible}，阈值 true 归属卡 task-73 E4②）`,
            )
            .toBe(true);
        const workspaceMoreVisible = await page
            .locator('[data-testid="sidebar-workspace-more"]')
            .first()
            .isVisible()
            .catch(() => false);
        expect
            .soft(
                workspaceMoreVisible,
                `${tag} ⑥E4② 工作区次级动作 sidebar-workspace-more 不常驻（实测 visible=${workspaceMoreVisible}，阈值 true 归属卡 task-73 E4②）`,
            )
            .toBe(true);

        // E1'：三常驻动作（add-workspace / session-search / workspace-config）默认可见
        const sessionSearchVisible = await page
            .locator('[data-testid="sidebar-session-search"]')
            .first()
            .isVisible()
            .catch(() => false);
        expect
            .soft(
                sessionSearchVisible,
                `${tag} ⑥E1' 会话检索入口不常驻（实测 visible=${sessionSearchVisible}，阈值 true 归属卡 task-73 E1'）`,
            )
            .toBe(true);
        const configEntry = page.locator('[data-testid="sidebar-workspace-config"]');
        const configEntryCount = await configEntry.count();
        const configEntryVisible =
            configEntryCount > 0 ? await configEntry.first().isVisible() : false;
        expect
            .soft(
                configEntryVisible,
                `${tag} ⑥E1' 工作区配置入口不常驻（实测 count=${configEntryCount} visible=${configEntryVisible}，阈值 可见=true 归属卡 task-73 E1'）`,
            )
            .toBe(true);

        // E2：rail（折叠）态仍要有检索入口（现状 rail 只剩 28×28 展开按钮 ⇒ 改前必红）。
        //     这一步会改左栏形态，所以放在 ⑥ 最末，并在末尾点展开按钮复原。
        const collapseBtn = page.locator('[data-testid="sidebar-collapse"]');
        const collapseHit = await collapseBtn.count();
        if (collapseHit > 0)
            await collapseBtn
                .first()
                .click({ timeout: 5000 })
                .catch(() => {});
        const railReached =
            (await page.locator('[data-testid="sidebar-collapsed-strip"]').count()) > 0;
        expect
            .soft(
                railReached,
                `${tag} ⑥E2 左栏未进入 rail 折叠态（collapse 命中 ${collapseHit}，sidebar-collapsed-strip 未出现）⇒ 检索断言无法验证（不 skip，按 fail 暴露 归属卡 task-73 E2）`,
            )
            .toBe(true);
        if (railReached) {
            const railSearchCount = await page
                .locator('[data-testid="sidebar-session-search"]')
                .count();
            expect
                .soft(
                    railSearchCount,
                    `${tag} ⑥E2 rail 态检索入口命中 ${railSearchCount} 个（实测 ${railSearchCount}，阈值 ≥1；rail 内只剩展开按钮 = 缺陷 归属卡 task-73 E2）`,
                )
                .toBeGreaterThanOrEqual(1);
            const expandVisible = await page
                .locator('[data-testid="sidebar-expand"]')
                .first()
                .isVisible()
                .catch(() => false);
            expect
                .soft(
                    expandVisible,
                    `${tag} ⑥E2 rail 态展开按钮不可见（实测 visible=${expandVisible}，阈值 true 归属卡 task-73 E2）`,
                )
                .toBe(true);
            await page
                .locator('[data-testid="sidebar-expand"]')
                .first()
                .click({ timeout: 5000 })
                .catch(() => {});
        }

        record.focus = focus;
        record.dock = dock;
        persist(theme, records);
        console.log(`[ui-baseline] ${tag} 完成`);
        if (vp.name === "1920x1080") {
            await captureShot(page, testInfo, `ui-baseline-${theme}-1920x1080`);
        }
        // ⑥E1'（路由可达性）：只在 1920 屏、且**截图之后**做 —— page.goto 会毁掉页面状态，
        // 放在截图前会把 1920 基线图拍成设置页。只验 router 已注册的两条目标路由能打开。
        if (vp.name === "1920x1080") {
            const wsMatch = /\/workspace\/([^/?#]+)/.exec(page.url());
            const wsId = wsMatch?.[1] ?? null;
            if (wsId) {
                const settingsPath = `/workspace/${wsId}/settings?tab=config`;
                await page.goto(settingsPath, { waitUntil: "load" });
                expect
                    .soft(
                        page.url(),
                        `${tag} ⑥E1' 配置工作区页不可达（实测 ${page.url()}，期望含 ${settingsPath} 归属卡 task-73 E1'）`,
                    )
                    .toContain(`/workspace/${wsId}/settings`);
                const membersPath = `/workspace/${wsId}/members`;
                await page.goto(membersPath, { waitUntil: "load" });
                expect
                    .soft(
                        page.url(),
                        `${tag} ⑥E1' 成员页不可达（实测 ${page.url()}，期望含 ${membersPath} 归属卡 task-73 E1'）`,
                    )
                    .toContain(`/workspace/${wsId}/members`);
            }
        }

        // 下一屏由 openChatSurface 重新装载同一会话 URL，上一屏的交互（如打开右栏）随之复位
        // 本视口读数已落盘/截图完毕，立刻关掉临时 page：零横幅基线要求同一时刻只有一个 SSE 订阅者
        if (page !== rootPage) await page.close();
    }

    persist(theme, records);
    await testInfo.attach(`ui-baseline-${theme}-readings`, {
        body: JSON.stringify(records, null, 2),
        contentType: "application/json",
    });
    console.log(`[ui-baseline] ${theme} 读数已写入 ${OUT_FILE}`);
    console.log(
        unique(
            records.map(
                (record) =>
                    `${record.viewport}: bands=${record.layout.bands.length} notice=${fmt(record.layout.chromeNotice)} top=${fmt(record.layout.contentTop)} composerH=${fmt(record.layout.composer?.h)} ratio=${fmt(((record.layout.composer?.h ?? 0) / record.layout.viewport.h) * 100)}% dockOpen=${record.layout.dockOpen} rightTabs=${record.layout.rightTabs}`,
            ),
        ).join("\n"),
    );
}

for (const theme of THEMES) {
    test(`UI 基线 · ${theme} · 3 视口 × 6 类断言`, async ({ page }, testInfo) => {
        test.slow();
        await runMatrix(page, theme, testInfo, VIEWPORTS);
    });
}

// 宽屏档（2560×1440）默认不注册：D-1907 的 3 档门不变，默认门仍是 2 failed / 1 skipped。
// 需要时 `UI_BASELINE_WIDE=1 pnpm exec playwright test …` 临时把这些用例带进来，读数写同一份 red-before.json。
if (process.env.UI_BASELINE_WIDE === "1") {
    test.describe("UI 基线 · 宽屏档 2560（UI_BASELINE_WIDE=1）", () => {
        for (const theme of THEMES) {
            test(`UI 基线 · ${theme} · 2560 宽屏 × 6 类断言`, async ({ page }, testInfo) => {
                test.slow();
                await runMatrix(page, theme, testInfo, WIDE_VIEWPORTS);
            });
        }
    });
}

// 待用户确认：F1「容器 tab 出现在设置页」已派 task-78 真机取证，取回前不写断言；A4 已并入 A1（同一条 settings-summary 带），不再单列。
test("设置页顶带（A4/F1）待 task-78 取证", async () => {
    // 文件级 test.fixme(true, …) 会把整份 spec 全标 skipped（实测），所以 fixme 放进测试体内：
    // 声明照常收集（--list 3 条），运行时跳过并带理由，等 task-78 取回读数再落断言。
    test.fixme(
        true,
        "A4/F1 设置页顶带口径待 task-78 真机取证（D-1907 F1 未定）：取回读数前禁止在此写断言，见 task-102 F-5",
    );
});
