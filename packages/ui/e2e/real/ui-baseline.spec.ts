// UI 基线真机门禁（task-73 / D-1907 UI 基线 v2；task-102 二轮加固：修 8 条假绿 + 补覆盖 + 口径对齐）。
// 断言口径来自 internal/A03-xihe/evidence/2026-11-19-ui-live-review 的真机读数（A1/A3/B1/B3/D1/D2/E1/E2 六类缺陷），
// 每条断言在改代码之前必须为红：红 = 产品现状，绿 = 该缺陷已修复。
// lane: 真栈基线 / 取证 —— 无 XIHE_E2E_PROFILE（profile=all）时经 `node scripts/e2e-real-stack.mjs --stack <n>`
// 直跑，需要真栈登录态（.local/dev/admin-password）。不进 host 车道（grep /@host/，T-2318 口径）：一次登录后
// 串行拍 3 视口 × 2 主题共 6 屏并写读数 JSON / 截图，属基线取证，不是 host 回归用例。
//
// 与旧探针（probe.mjs）的方法学差异（A2 已确认旧探针误判）：
//   1. 顶带扫描不写死 `y < 120`（那是旧探针把 5 条带截成 4 条的原因），下界改取「会话容器带
//      workspace-conversation 的底边」（chromeEnd），把 settings-summary 这类 chat 列内行
//      与运行态横幅排除（口径见 CHROME_EXCLUDED_KEYS / chromeNotice）；
//   2. 焦点环用键盘 Tab 进入 chat-input（不用脚本 focus()），并等 400ms 让 box-shadow 的
//      transition 落定后再读计算样式（立即读会读到过渡前的空值，曾导致假绿）。
//
// 另两处工程口径（都出自真机踩坑）：
//   - 会话入口用 CP API 挑「有消息的会话」再直达 /workspace/{ws}/session/{sid}，不点侧栏：
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
/** ① 顶带层数上限。真机口径（2026-11-20 三档实测，读数与截图见
 *  internal/A03-xihe/evidence/2026-11-20-chrome-density/README.md）：会话页顶部 = **3 条带 / 96px**
 *  （container-tabs 0–32 + workspace-conversation 32–64 + settings-summary 64–96），contentTop=97；
 *  其中 settings-summary 属 chat 列内行（SessionSettingsPanel.vue:196，由 ChatPanel 挂载），按本 spec
 *  口径 **不计入**顶带 ⇒ 常驻顶带 **2 条 / 64px**（chromeHeight=64，探针与 spec 读数一致）。
 *  旧「4 条带 / 124px」含 task-118 移除的 workspace-secondary-nav 与 task-60 移除的 28px
 *  session-sandbox-enforcement 带；清单 v1 的「157px / 5 条带」是并入口径 —— 两者只作历史参考，
 *  不作断言值（常量仍取上限：≤3 条 / ≤104px）。 */
const CHROME_MAX_BANDS = 3;
/** 行高基数：xs 行 32px；内容区起点允许 3 行 + 8px 边框内距 */
const CHROME_ROW_HEIGHT_PX = 32;
const CHROME_MAX_CONTENT_TOP = CHROME_MAX_BANDS * CHROME_ROW_HEIGHT_PX + 8; // 104
/** ② composer 块高 / 视口高。task-9（DSD-1465）收敛后现状 = **12.33%@1920×1080 / 14.80%@1440×900**（composer 133.2px；
 *  改前 206.4px = 19.11%@1080 / 22.93%@900，读数见 internal/A03-xihe/evidence/2026-11-20-composer-height/README.md）。
 *  900 档是本门的绑定档：0.15 × 900 = 135px。 */
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
/** ① 首带必须是常驻 chrome 带。**task-118（D-1907 rev7）改了这里的口径**：会话页不再挂工作区级
 *  导航带（`workspace-secondary-nav` 只出现在工作区自己的页面），会话页 y=0 起就是容器页签行
 *  `workspace-container-tabs`。真机读数：`.tmp/xh/ui-gates/task-118/chrome-readings.json` —— 1920 会话页
 *  y=0 页签行 32px，同一工作区 /members 页 y=0 仍是导航带 32px（⇒ 会话页少一条 32px 带）。
 *  带名集合仍随断点变化，故只钉首带、不硬编码整条序列。 */
const FIRST_CHROME_BAND_KEY = "workspace-container-tabs";
/** ④ 同层焦点环上限（现状 border 1px + ring 2px 双层） */
const FOCUS_RING_MAX_LAYERS = 1;
/** ⑥ 左栏图标最小命中区（现状 28×28 恰好卡线，故比较用 <） */
const HIT_MIN_PX = 28;
/** ① 顶带扫描里要排除的带：settings-summary 属 chat 列内行（Lead 复核口径），
 *  SSE limit 横幅是运行态提示而非常驻 chrome。两者都照原样记进 bands 供诊断，但不算顶带层数/高度。 */
const CHROME_EXCLUDED_KEYS = ["session-settings-summary", "sse-subscriber-limit-notice"];
/**
 * ⑤F5'（task-9 建，task-24 复核）：桌面**历史**面板图标 testid 清单，六个 id **全部**由
 * 1407521e3（refactor(ui): 面板图标入口收敛到右栏「+」(task-137/D-1907)）一次性从 src 删除，
 * 现 src 内 0 命中 ⇒ 本清单是**墓碑**：期望计数恒 = 0，作用是「旧 id 不得复活」这条回归。
 * task-24 复核口径：不按 id 逐个裁撤（六个同属一个退役提交，只删其中一颗会让清单既不全也不一致），
 * 改为在 ⑤F5' 里**同时**补正向锚点「唯一开合入口 workspace-dock-toggle = 1」——
 * 墓碑门挡不住「换一套新图标簇回来」，正向锚点挡得住（见 :1394 附近断言）。
 * 判据只数这六个精确 id：前缀 workspace-toolbar-* 不能当口径 —— 它同时命中 3 个移动态控件
 * （WorkspaceToolbar.vue:121 files-mobile / :132 new-chat-mobile / :147 more-mobile，父容器 :100-103 带 md:hidden）
 * 与 FileTreePanel.vue:367 面板内折叠钮（workspace-toolbar-toggle-tree），DOM 恒 ≥4 个 ⇒ 前缀计数门恒红，
 * 红的是选择器口径而不是产品；:visible 过滤同样会红（file-tree 面板展开时折叠钮本来就可见，FileTreePanel.vue:365-375）。
 */
const RETIRED_PANEL_ICON_IDS = [
    "workspace-toolbar-files",
    "workspace-toolbar-code",
    "workspace-toolbar-changes",
    "workspace-toolbar-monitor",
    "workspace-toolbar-members",
    "workspace-toolbar-delegation",
];
/** 六 id 的 locator 选择器（⑤F5' 判据用；与 evaluate 里的 rect 读数同源，避免两处清单漂移）。 */
const RETIRED_PANEL_ICON_SELECTOR = RETIRED_PANEL_ICON_IDS.map(
    (id) => `[data-testid="${id}"]`,
).join(",");

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
/**
 * ⑥ **浮层菜单行**（`role=menuitem`）命中区下限（task-149，Lead 2026-11-20 裁定）。
 *
 * <p><b>为什么不套上面那两条</b>：`HIT_MIN_PX` / `ACTION_CLUSTER_MIN_PX` 是**常驻 chrome 的
 * 可点面积门**（防图标退化成 1×1 点不到）；下拉菜单行不是常驻动作，套同一阈值测的是另一件事
 * （触摸目标尺寸），本项目没有该 D 级口径 —— shadcn/reka 菜单行默认行高 ~28px，真机实测
 * 27.7px 属 border-box 级差，不是产品缺口。20px = 鼠标可稳定命中的下限，120px 保证不是窄条。
 */
const MENU_ROW_MIN_HEIGHT_PX = 20;
const MENU_ROW_MIN_WIDTH_PX = 120;
/**
 * ⑥ 导航面板**让位门**（task-158 口径修正）。
 *
 * <p>D-1829 的舒适线（`useWorkspaceLayout.ts` `computeWorkbenchSqueeze`，MAIN_COMFORT_MIN_WIDTH = 720）
 * 在 **1440 档**会把导航面板收成 rail（56px + 1px 边框 ≈ 57.03；`WorkspaceWorkbench.vue:531` 记录了
 * 2026-11-17 ui-41 的同档实测 57.03）。这是产品既定行为，不是缺陷。</p>
 *
 * <p>面板收成 rail 之后 `sidebar-new-chat` / `sidebar-session-search` 等**面板内动作压根没渲染**
 * （boundingBox 全 0），于是「常驻可见」类断言在 1440 档量的是一个不存在的对象：2026-11-20 基线里
 * ⑥E1a ×2 / ⑥E1' ×2 全部**只红在 1440**，52 与 56 的跑间差（E1a 0→2）也是同一原因。</p>
 *
 * <p>判据因此分形态：**面板展开态**量面板内动作（原判据一条不删）；**让位态**只钉「让位形态本身」
 * （折叠条 + 展开按钮），形态切换另有 ⑥E2 专门判 rail。</p>
 */
const NAV_YIELD_MAX_PX = 100;
/** A2 带层扫描容差：Σ(chromeBands.h) 与 chromeHeight 之差超此值即视为扫描被截断 */
const BAND_SCAN_TOLERANCE_PX = 1;

/**
 * 首屏就位探针预算（task-19）。
 *
 * <p>真栈冷启首屏 P95≈12s，超过 Playwright 单 action 10s 上限（scripts/check-e2e-timeouts.mjs 的
 * ACTION_CAP_MS），所以这里**不抬 `timeout:` 字面量**，而是把等待拆成「短步探针 + 显式 deadline」：
 * 每步 ≤5s，命中即返回（稳态 1–2 帧就出现），到 deadline 才判未就位。</p>
 */
const READY_PROBE_STEP_MS = 5_000;
const SESSION_SURFACE_DEADLINE_MS = 20_000;
const CHAT_INPUT_DEADLINE_MS = 15_000;

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
    /** ①A2 口径（task-120）：chrome 区内**有主像素**（命中 data-testid / role=tablist 的 raw 段，含 ≤4px 碎片）的覆盖和，按 chromeEnd 截断后扣掉运行态横幅 */
    chromeCoverage: number;
    /** 被 `to - from > 4` 判据丢弃的 ≤4px 碎片（只统计 chrome 区内、非排除键），供诊断 */
    chromeSlivers: Band[];
    /** chrome 区内只命中裸标签（无 data-testid / role）的段：它们不计入 chromeCoverage，红时用来指出「哪一段没有主」 */
    chromeUnattributed: Band[];
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

/** 口令运行时读入（不进日志、不进参数、不进截图、不进 fixture）。
 *  host 车道上 e2e-host 每跑随机生成口令并经 XIHE_E2E_ADMIN_PASSWORD 注入子进程
 *  （scripts/e2e-host.mjs:361/:2189/:3035）⇒ env 优先、文件回落；
 *  不进 host 车道的直跑真栈仍走 .local/dev/admin-password。 */
function readAdminPassword(): string {
    const fromEnv = (process.env.XIHE_E2E_ADMIN_PASSWORD ?? "").trim();
    const useEnv = fromEnv.length > 0;
    const password = useEnv ? fromEnv : readFileSync(PASSWORD_FILE, "utf8").trim();
    // 只断言"非空"，绝不回显口令本身。
    expect(
        password.length,
        `口令来源 ${useEnv ? "XIHE_E2E_ADMIN_PASSWORD" : path.relative(ONE_ROOT, PASSWORD_FILE)} 为空`,
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
            // read-only: 全部为 GET（workspaces/sessions/branches/messages），只用于挑选有消息的会话
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

/** 首屏就位探针（task-19）：按 READY_PROBE_STEP_MS 步长轮询到 deadline。
 *  命中返回 true、到 deadline 返回 false（调用方决定 fail 还是只记账）。deadline 写成
 *  `Date.now() + 常量` 形态 —— 静态门（check-e2e-timeouts.mjs）认作显式声明；单次 waitFor 恒
 *  ≤5s，不越 10s action 上限，也就不需要 timeout-exempt。 */
async function waitReadyFor(
    page: Page,
    selector: string,
    state: "attached" | "visible",
    deadlineMs: number,
): Promise<boolean> {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        try {
            await page
                .locator(selector)
                .first()
                .waitFor({ state, timeout: Math.min(READY_PROBE_STEP_MS, remaining) });
            return true;
        } catch {
            /* 本步未就位：进入下一段，直到 deadline */
        }
    }
    return false;
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
            return page.url().includes("/session/");
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
    await page.goto("/workspace/" + picked.workspaceId + "/session/" + picked.sessionId, {
        waitUntil: "load",
    });
    const surfaceOk = await waitReadyFor(
        page,
        '[data-testid="message-scroller-viewport"]',
        "attached",
        SESSION_SURFACE_DEADLINE_MS,
    );
    expect(surfaceOk, "会话页应渲染消息视口（" + String(picked.title) + "）").toBe(true);
    const inputOk = await waitReadyFor(
        page,
        '[data-testid="chat-input"]',
        "visible",
        CHAT_INPUT_DEADLINE_MS,
    );
    expect(inputOk, "会话页应出现 chat-input").toBe(true);
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
    // 探针本身不抛：reload 后没回到会话页时，由后续读数与断言的 fail 暴露（原 try/catch 语义保留）
    await waitReadyFor(page, '[data-testid="chat-input"]', "visible", CHAT_INPUT_DEADLINE_MS);
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
        // 每段带 attributed：像素是否归属某个**具名** chrome 元素（data-testid / role=tablist）。
        // 只命中裸标签（div/span/none）的段不计入 A2 覆盖 —— 否则 tiling 恒等覆盖，门就永远不会红（task-120）。
        const raw: { fromY: number; key: string; attributed: boolean }[] = [];
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
            const attributed = key !== null;
            if (!key) key = hit ? hit.tagName.toLowerCase() : "none";
            if (key !== last) {
                raw.push({ fromY: y, key, attributed });
                last = key;
            }
        }
        // raw 段 = 逐 y 扫描得到的连续片段（tiling）：先全部保留，再按 4px 判据筛出「带」。
        // task-120：A2 的覆盖和必须用**未经 4px 过滤**的 raw 段算，否则 1440 的 2px 碎片会被当成缺口。
        const rawSegs: { key: string; fromY: number; h: number; attributed: boolean }[] = [];
        for (let i = 0; i < raw.length; i += 1) {
            const from = raw[i].fromY;
            const to = i + 1 < raw.length ? raw[i + 1].fromY : scanTo;
            rawSegs.push({
                key: raw[i].key,
                fromY: from,
                h: to - from,
                attributed: raw[i].attributed,
            });
        }
        const bands = rawSegs.filter((seg) => seg.h > 4);
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
        // ①A2 口径（task-120 / task-117 归因）：chrome 区覆盖和按 **raw 段**累加（含 ≤4px 碎片），
        // 不是 Σ(>4px 带高)。task-117 当时 1440 的 workspace-secondary-nav 被 28px 行内导航项切成 2/28/2
        // 三段，两侧各 2px 在旧口径里被丢掉 ⇒ Σ带高 120 vs chromeHeight 124（**历史读数**：该导航带已由
        // task-118 移除，现 chromeHeight=64），红的是量测口径不是产品缺口。
        // 最后一段可能越过容器底边 ⇒ 按 chromeEnd 截断；运行态横幅不在产品 chrome 里 ⇒ 扣掉 chromeNotice。
        // 只累加 **attributed** raw 段（命中 data-testid / role=tablist）：逐 y tiling 的覆盖和恒等于
        // chromeEnd，若不分归属，A2 就永远不可能红 —— 那不是门。只命中裸标签的段进 chromeUnattributed。
        const chromeRaw = rawSegs.filter((seg) => seg.fromY < chromeEnd);
        const chromeCoverage = Math.max(
            0,
            chromeRaw
                .filter((seg) => seg.attributed)
                .reduce(
                    (sum, seg) => sum + (Math.min(seg.fromY + seg.h, chromeEnd) - seg.fromY),
                    0,
                ) - chromeNotice,
        );
        const chromeSlivers = chromeRaw.filter(
            (seg) => seg.h <= 4 && !excludedKeys.includes(seg.key),
        );
        const chromeUnattributed = chromeRaw.filter(
            (seg) => !seg.attributed && !excludedKeys.includes(seg.key),
        );

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
            chromeCoverage,
            chromeSlivers,
            chromeUnattributed,
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
            // 顶部历史面板图标（files/code/changes/monitor/members/delegation；六个 id 由 1407521e3
            // task-137/D-1907 一次性删除，src 内 0 命中）。这里保留字面量清单只为 rect 可见读数
            // （诊断打印，现状恒空）；判据与墓碑口径见 RETIRED_PANEL_ICON_IDS 注释。
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

// ── ⑥E2' 锚点取样（task-13 / DSD-1466）────────────────────────────────────────────
// 红值（new-chat 底边 95.0 vs 首个会话行顶边 76.0，倒挂 19.0px）是**两个采样缺陷叠加**，不是布局重叠：
//   ① 首个会话行在 [data-testid="sidebar-workspace-groups"]（WorkspaceSessionGroups.vue:352，
//      min-h-0 flex-1 overflow-y-auto）里，前序步骤（会话导航 / ⑥E1 开浮层）会把该容器滚走；
//      boundingBox() 对**已滚出容器可视区**的子元素仍返回视口坐标（76 就是被裁掉的位置）。
//   ② newChat 取自 readLayout（早帧），firstSessionRow 是后补一次 boundingBox（晚帧）⇒ 跨帧比较。
// 取样口径：等组头就位 → 过帧门 → 列表 scrollTop 归零 → **一次 evaluate（rAF 对齐）**同帧取
// newChat / 首个会话行 / 列表容器 rect + scrollTop；读数同时进 annotation 供证据档引用。
interface NewChatAnchorReading {
    scrollTopBefore: number;
    scrollTop: number;
    frames: number;
    stable: boolean;
    container: Rect | null;
    newChat: Rect | null;
    firstRow: Rect | null;
}

async function readNewChatAnchor(page: Page): Promise<NewChatAnchorReading> {
    // 会话行只在组容器里渲染（WorkspaceSessionGroups.vue:352）；组头未就位时首行位置仍是过渡态。
    await page
        .locator(
            '[data-testid^="sidebar-workspace-group-toggle-"], [data-testid="sidebar-standalone-group-toggle"]',
        )
        .first()
        .waitFor({ state: "visible", timeout: 5000 })
        .catch(() => {
            /* 0 组时由下面的 fail 分支暴露「取不到首个会话行」 */
        });
    await settleLayoutFrames(page);
    return page.evaluate(async () => {
        const box = (el: Element | null) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
        };
        const container = document.querySelector<HTMLElement>(
            '[data-testid="sidebar-workspace-groups"]',
        );
        const scrollTopBefore = container?.scrollTop ?? 0;
        if (container && container.scrollTop !== 0) container.scrollTop = 0;
        const nextFrame = () =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => resolve());
            });
        const snapshot = () => ({
            container: box(container),
            newChat: box(document.querySelector('[data-testid="sidebar-new-chat"]')),
            firstRow: box(document.querySelector('[data-testid="session-item"]')),
            scrollTop: container?.scrollTop ?? 0,
        });
        // 归零后连续两帧读数一致才算就位（虚拟列表 / 折叠动画可能滞后一帧），最多 30 帧。
        await nextFrame();
        let prev = snapshot();
        let frames = 1;
        for (let i = 0; i < 30; i += 1) {
            await nextFrame();
            frames += 1;
            const next = snapshot();
            if (JSON.stringify(next) === JSON.stringify(prev)) {
                return { scrollTopBefore, frames, stable: true, ...next };
            }
            prev = next;
        }
        return { scrollTopBefore, frames, stable: false, ...prev };
    });
}

// ── ⑥E4① 会话区头计数取样（task-52 / DSD-1464）──────────────────────────────────
// 判什么：`sidebar-sessions-count` 的**文本**必须等于列表里**实际渲染**的会话行数
// （`[data-testid="sidebar-workspace-groups"]` 内 `[data-testid="session-item"]` 按节点数），
// 空态必须读成 0。裁定原文（DSD-1464 口径①）：计数 = 左栏列表当前渲染的会话总数
// （独立会话区 + 各工作区分组内会话合计，随搜索/过滤同步），单独渲染、不拼进 t() 文案。
//
// 为什么不能只 `count()` 了事：0 条会话时区头照样在（恒常），所以「区头命中 1」与「计数对」是
// 两条不同判据 —— 前者是 task-73 E4① 的可见性，后者是 DSD-1464 的读数一致性。
// 取样口径沿用 readNewChatAnchor（DSD-1466/task-13）：先等组头就位 → 过帧门 → 列表 scrollTop 归零 →
// **一次 evaluate（rAF 对齐、连续两帧一致）**同帧读数，避免「文本早帧 / 行数晚帧」的跨帧假红。
// 行被滚出容器的情形不影响计数（按 DOM 节点数，不按 rect）。
interface SessionsCountReading {
    headerCount: number;
    countText: string | null;
    countParsed: number | null;
    rows: number;
    containerPresent: boolean;
    scrollTop: number;
    frames: number;
    stable: boolean;
}

async function readSessionsCount(page: Page): Promise<SessionsCountReading> {
    await page
        .locator(
            '[data-testid^="sidebar-workspace-group-toggle-"], [data-testid="sidebar-standalone-group-toggle"]',
        )
        .first()
        .waitFor({ state: "visible", timeout: 5000 })
        .catch(() => {
            /* 0 组 / 0 会话：由下面的容器缺失分支暴露，不在这里抛 */
        });
    await settleLayoutFrames(page);
    return page
        .evaluate(async () => {
            const container = document.querySelector<HTMLElement>(
                '[data-testid="sidebar-workspace-groups"]',
            );
            const badge = document.querySelector<HTMLElement>(
                '[data-testid="sidebar-sessions-count"]',
            );
            if (container && container.scrollTop !== 0) container.scrollTop = 0;
            const nextFrame = () =>
                new Promise<void>((resolve) => {
                    requestAnimationFrame(() => resolve());
                });
            const snapshot = () => ({
                countText: badge?.textContent?.trim() ?? null,
                rows: container
                    ? container.querySelectorAll('[data-testid="session-item"]').length
                    : 0,
                headerCount: document.querySelectorAll('[data-testid="sidebar-sessions-header"]')
                    .length,
                containerPresent: container !== null,
                scrollTop: container?.scrollTop ?? 0,
            });
            await nextFrame();
            let prev = snapshot();
            let frames = 1;
            for (let i = 0; i < 30; i += 1) {
                await nextFrame();
                frames += 1;
                const next = snapshot();
                if (JSON.stringify(next) === JSON.stringify(prev))
                    return { ...next, frames, stable: true };
                prev = next;
            }
            return { ...prev, frames, stable: false };
        })
        .then((reading) => {
            const text = reading.countText;
            const parsed = text !== null && /^-?\d+$/.test(text) ? Number.parseInt(text, 10) : null;
            return { ...reading, countText: text, countParsed: parsed };
        });
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

        // ① 顶带层数与顶带高度（A1 修正口径：真机三档 3 条 / 96px，排除 settings-summary 后 2 条 / 64px、
        //    contentTop=97；断言常量取上限 ≤3 条，见文件头常量注释）
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

        // ①A2（doc:34；task-120 改口径）：带层扫描必须覆盖到会话容器底边 —— **raw 段覆盖和**（含 ≤4px
        //    碎片）与 chromeHeight 之差 ≤1px。旧口径只累加 >4px 的带：1440 的导航带被 28px 行内项切成
        //    2/28/2，两侧各 2px 碎片被丢 ⇒ Σ带高 120 vs chromeHeight 124（task-117 **历史读数**，该带已由
        //    task-118 移除，现 chromeHeight=64），红的是量测口径不是产品缺口
        //    （task-117 归因）。碎片单列 chromeSlivers；Σ(>4px) 仅保留为诊断读数，不再参与判据。
        const chromeBandSum = layout.chromeBands.reduce((sum, band) => sum + band.h, 0);
        const bandScanGap = Math.max(0, layout.chromeHeight - layout.chromeCoverage);
        expect
            .soft(
                bandScanGap,
                `${tag} ①A2 带层扫描缺口 ${fmt(bandScanGap)}px（实测 raw 覆盖=${fmt(layout.chromeCoverage)}，chromeHeight=${fmt(layout.chromeHeight)}，≤4px 碎片 ${layout.chromeSlivers.length} 段：${describeBands(layout.chromeSlivers) || "无"}；无主（只命中裸标签、不计入覆盖）${layout.chromeUnattributed.length} 段：${describeBands(layout.chromeUnattributed) || "无"}；旧口径 Σ(>4px 带高)=${fmt(chromeBandSum)} 仅作诊断；阈值 ≤${BAND_SCAN_TOLERANCE_PX}px 归属卡 task-102 F-8/A2）实测带：${describeBands(layout.chromeBands)}`,
            )
            .toBeLessThanOrEqual(BAND_SCAN_TOLERANCE_PX);

        // ① 首带必须是常驻 chrome 带（task-98 ② 的会话页口径由 task-118 改写）：会话页没有工作区级
        //    导航带，首带 = 容器页签行；带名集合随断点变化 ⇒ 只钉首带，不硬编码整条带名序列。
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

        // ② composer 块高 / 视口高（A3；task-9 后现状 12.33%@1920×1080 / 14.80%@1440×900，绑定档是 900）
        const composerRatio = layout.composer ? layout.composer.h / layout.viewport.h : Number.NaN;
        expect
            .soft(
                composerRatio,
                `${tag} ②composer 块高 ${fmt(layout.composer?.h)}px / 视口 ${layout.viewport.h}px = ${fmt(composerRatio * 100)}%（期望≤${COMPOSER_MAX_VIEWPORT_RATIO * 100}%）行：${layout.composerRows.map((row) => `${row.tid ?? "?"}:${fmt(row.h)}`).join(" ")}`,
            )
            .toBeLessThanOrEqual(COMPOSER_MAX_VIEWPORT_RATIO);

        // ②C3（doc:44）：composer 块的**不透明底盘** + 内层 tint 对齐 token（DSD-1462 裁定后的判据形态）。
        //    DSD-1462 定性：容器 bg-muted/30（alpha 0.3）是刻意设计——浅灰 tint 叠在不透明底盘上，属同一方案包，不按缺口修。
        //    所以 doc:44 真正要守的东西拆成两层，任意一层漂移都会红（不是把阈值抹掉）：
        //      a) composer 根（data-testid=chat-composer）背景 alpha 必须 = 1 —— 块本身不透，消息列表不会从 composer 下方透出；
        //      b) 内层 tint 必须是 --muted 的 30%（bg-muted/30）—— 对齐 DSD-1462 方案包，改成 /10、/60 或换 token 都算偏离设计。
        //    现状 InputArea.vue:1985 的 bg-muted/30 与根 bg-background 都在；行号历史 :1883 → :1970 → :1985（定位不稳按类名 bg-muted/30 grep）。
        const composerBgs = await page
            .evaluate(() => {
                const root = document.querySelector('[data-testid="chat-composer"]');
                let el: Element | null = document.querySelector('[data-testid="chat-input"]');
                let tint: { color: string; depth: number; tid: string | null } | null = null;
                for (let depth = 0; depth < 6 && el; depth += 1) {
                    el = el.parentElement;
                    if (!el) break;
                    const bg = getComputedStyle(el).backgroundColor;
                    if (!bg || bg === "transparent" || bg === "rgba(0, 0, 0, 0)") continue;
                    tint = { color: bg, depth, tid: el.getAttribute("data-testid") };
                    break;
                }
                return {
                    rootColor: root ? getComputedStyle(root).backgroundColor : null,
                    tint,
                };
            })
            .catch(() => null);
        const composerRootAlpha = composerBgs?.rootColor ? alphaOf(composerBgs.rootColor) : null;
        const composerTintAlpha = composerBgs?.tint ? alphaOf(composerBgs.tint.color) : null;
        expect
            .soft(
                composerRootAlpha,
                `${tag} ②C3a composer 根背景必须不透明：实测 ${String(composerBgs?.rootColor ?? "取不到")}（alpha ${String(composerRootAlpha)}，期望 1；DSD-1462 后内层 tint 允许半透明，底盘不允许）`,
            )
            .toBe(1);
        expect
            .soft(
                composerTintAlpha,
                `${tag} ②C3b composer 内层 tint 必须等于设计值 0.3（bg-muted/30，DSD-1462）：实测 ${String(composerBgs?.tint?.color ?? "无 tint 层")}（alpha ${String(composerTintAlpha)}，第 ${String(composerBgs?.tint?.depth ?? "-")} 层 ${String(composerBgs?.tint?.tid ?? "-")}）`,
            )
            .toBeCloseTo(0.3, 1);

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
                // B2（doc:38 前半）：--ring 必须**等于** --primary —— 这是 DSD-1462 裁定的设计意图，不是把判据放宽。
                //    为什么「相等」才是真判据（DSD-1462 / 2026-11-11 用户裁定「统一 5 个官方 base color」）：
                //      · 官方默认 --ring = oklch(0.708 0 0)，对 --background 只有 2.58–2.63:1，低于焦点指示要求的 3:1；
                //      · 统一到 --primary 后（src 内 10 处定义全部 var(--primary)），浅色主题焦点环对比约 17:1，反而更满足可见性；
                //      · 因此判据从「两者不等」翻转成「两者相等」：有人把 --ring 改回官方灰、或只调其中一个不同步，本条立刻红。
                //    非恒真：先断言两边都非空（token 未定义 / 读不到也会红），再断言相等；阈值没有抹成`assert(true)`。
                //    后半「ring 对比 ≥3.0」归 src/styles/__tests__/tokenContrast.spec.ts（vitest），不在本 spec 判。
                const ringTokens = await page.evaluate(() => {
                    const style = getComputedStyle(document.documentElement);
                    const read = (name: string) => style.getPropertyValue(name).trim();
                    return { ring: read("--ring"), primary: read("--primary") };
                });
                expect
                    .soft(
                        ringTokens.ring,
                        `${tag} ④B2 --ring 读不到值（实测 --ring=${ringTokens.ring || "空"}，--primary=${ringTokens.primary || "空"}；DSD-1462 要求 --ring 统一为 var(--primary)，两边都必须有值）`,
                    )
                    .not.toBe("");
                expect
                    .soft(
                        ringTokens.ring,
                        `${tag} ④B2 --ring 必须等于 --primary（DSD-1462：焦点环统一到 primary；实测 --ring=${ringTokens.ring || "空"}，--primary=${ringTokens.primary || "空"}）`,
                    )
                    .toBe(ringTokens.primary);
            }
        }

        // ⑤ 右栏折叠态的开合控件（D1 修正沿革：当时以为缺的是**单一 toggle**，逐面板开合图标簇曾是
        //    独立组件；该图标簇随 task-137 / D-1907 整体退场（组件本体一并删除）—— 面板开合
        //    只剩右栏容器 WorkspaceDock.vue 的页签行与 `workspace-dock-toggle`（WorkspaceWorkbench.vue:1241
        //    渲染），本段判据即按这两处判。D2：折叠后整列含页签行不渲染、无展开把手 ⇒ dock-open 命中 0）
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
            // F5'/F-7（task-9 改判据）：展开态顶部不得再有六颗桌面面板图标 —— 数六个**精确 id**（D-1907 后全仓退役 ⇒ 期望 0），
            // 不再用前缀 workspace-toolbar-*：该前缀恒命中移动态控件与文件面板折叠钮（口径见 RETIRED_PANEL_ICON_IDS 注释）。
            const panelIconCount = await page.locator(RETIRED_PANEL_ICON_SELECTOR).count();
            const toolbarPrefixDomCount = await page
                .locator('[data-testid^="workspace-toolbar-"]')
                .count();
            expect
                .soft(
                    panelIconCount,
                    `${tag} ⑤F5' 展开态顶部仍有 ${panelIconCount} 个已退役面板图标（阈值 0；前缀 workspace-toolbar-* 的 DOM 共 ${toolbarPrefixDomCount} 个 = 移动态控件 + 文件面板折叠钮，不计入判据；rect 可见读数 ${layout.visiblePanelIcons.join(",") || "无"} 归属卡 task-102 F5'）`,
                )
                .toBe(0);
            // task-24（D-1907）：墓碑门（数已退役 id = 0）天然趋于恒真 —— id 删干净后就永远为 0，
            // 挡不住「换一套新图标簇回来」。故配一条**正向**锚点：展开态唯一开合入口
            // [data-testid=workspace-dock-toggle] 恰好 1 个且 aria-pressed="true"（= 右栏当前展开；
            // 控件由 WorkspaceWorkbench.vue:1241 渲染，:aria-pressed="dockOpen"）。
            // 与 task-137 mock 侧「唯一开合入口 = 1」同口径：入口被复制成两个、被换成第二套面板图标簇、
            // 或 aria-pressed 与展开态脱钩，本条立刻红。
            const expandedToggle = page.locator(
                `[data-testid="${DOCK_TOGGLE_TESTID}"][aria-pressed="true"]`,
            );
            const expandedToggleCount = await expandedToggle.count();
            expect
                .soft(
                    expandedToggleCount,
                    `${tag} ⑤F5' 展开态唯一开合入口 [data-testid=${DOCK_TOGGLE_TESTID}][aria-pressed=true] 命中 ${expandedToggleCount} 个（阈值 =1；D-1907 图标簇收敛后唯一入口 = 该开合图标，旧六图标 testid 见 RETIRED_PANEL_ICON_IDS 期望 0；归属卡 task-24）`,
                )
                .toBe(1);
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
        const { newChat } = layout.sidebar;
        // 让位态判据：侧栏盒宽 < 100 ⇒ rail 形态（展开态 336.39，让位态 57.03，见 NAV_YIELD_MAX_PX）。
        const navYielded = (layout.sidebarBox?.w ?? 0) < NAV_YIELD_MAX_PX;
        // task-149（取代 task-120 F-8 的 count 兜底）：sidebar-new-workspace（Sidebar.vue:275）是区头**恒常**
        // 触发器；它的两个菜单项 sidebar-add-workspace（:285）/ sidebar-import-source（:292）在
        // DropdownMenuContent（:283）内，菜单未展开时**不在 DOM** ⇒ 旧写法按当前 DOM 取值结构性永远取不到
        // （add-workspace 永久假红、import-source 空覆盖）。现在：展开菜单 → 量两项 → 立刻关闭，
        // 并断言关闭后菜单项已离开 DOM，不留开着的弹层污染后续断言。
        const trigger = page.locator('[data-testid="sidebar-new-workspace"]');
        const triggerCount = await trigger.count();
        expect
            .soft(
                triggerCount,
                `${tag} ⑥未找到 [data-testid=sidebar-new-workspace]（区头恒常动作触发器，Sidebar.vue:275）`,
            )
            .toBe(1);
        const triggerBox = triggerCount > 0 ? await trigger.first().boundingBox() : null;
        expect.soft(newChat, `${tag} ⑥未找到 [data-testid=sidebar-new-chat]`).not.toBeNull();

        // E1 / E1a：展开区头动作菜单后量 menu 项命中区（命中区 ≥32×32，恒常下限 28×28），断完即关。
        const menuItem = (testId: string) => page.locator(`[data-testid="${testId}"]`);
        let addWsBox: { width: number; height: number } | null = null;
        let importSourceBox: { width: number; height: number } | null = null;
        let addWsEnabled = false;
        let importSourceEnabled = false;
        if (triggerBox) {
            await trigger
                .first()
                .click({ timeout: 5000 })
                .catch(() => {});
            await menuItem("sidebar-add-workspace")
                .first()
                .waitFor({ state: "visible", timeout: 5000 })
                .catch(() => {});
            addWsBox = await menuItem("sidebar-add-workspace")
                .first()
                .boundingBox()
                .catch(() => null);
            importSourceBox = await menuItem("sidebar-import-source")
                .first()
                .boundingBox()
                .catch(() => null);
            addWsEnabled = await menuItem("sidebar-add-workspace")
                .first()
                .isEnabled()
                .catch(() => false);
            importSourceEnabled = await menuItem("sidebar-import-source")
                .first()
                .isEnabled()
                .catch(() => false);
            expect
                .soft(
                    { addWsBox, importSourceBox: importSourceBox !== null },
                    `${tag} ⑥E1 展开 sidebar-new-workspace 菜单后仍取不到 sidebar-add-workspace / sidebar-import-source（菜单内容未渲染，属空覆盖 ⇒ 必须红）`,
                )
                .toEqual({ addWsBox: expect.anything(), importSourceBox: true });
            await page.keyboard.press("Escape").catch(() => {});
            await menuItem("sidebar-add-workspace")
                .first()
                .waitFor({ state: "detached", timeout: 5000 })
                .catch(() => {});
            const menuStillOpen = await menuItem("sidebar-add-workspace").count();
            expect
                .soft(
                    menuStillOpen,
                    `${tag} ⑥E1 区头动作菜单未关闭（实测菜单项计数 ${menuStillOpen}，阈值 0：开着的弹层会污染后续断言）`,
                )
                .toBe(0);
        }

        // ── ⑥ 判定表（task-149，Lead 2026-11-20 裁定；类别 → 阈值 → 为什么）────────────────────────
        // 类别              | 例子                                            | 阈值
        // 常驻动作（chrome） | sidebar-new-chat / sidebar-new-workspace        | ≥28×28（E1a）；
        //                   |                                                 | 区头动作簇 ≥32×32（E1，D-1907 C）
        // 浮层菜单行         | sidebar-add-workspace / sidebar-import-source    | 可见 + 可用 + 高 ≥20px + 宽 ≥120px
        //
        // 为什么按类分开：28/32 是**常驻 chrome 的可点面积门**，防的是「图标退化成点不到」；下拉菜单行不是
        // 常驻动作，套同一阈值测的是另一件事（触摸目标尺寸），而本项目没有该 D 级口径 —— 菜单行 =
        // DropdownMenuContent（Sidebar.vue:283，class="w-56"）里的 DropdownMenuItem，shadcn/reka 默认
        // 行高 ~28px，真机实测 27.7px 属 border-box 级差。20px = 鼠标可稳定命中下限，120px 防窄条。
        // 菜单项在菜单未展开时不在 DOM（见上方展开/关闭流程），这里量的都是「真展开后」的盒子。
        // 让位态（navYielded，1440 档的既定形态）：面板被夹到 rail 宽、内容被裁掉，但**没有被销毁**，
        // 加宽窗口即原样恢复（S5-W2 渲染层让位，不改存储的 open）。
        //
        // 这里钉的是「让位 ≠ 用户折叠」这条设计规则（Sidebar.vue:73-75 / PLAN-0762 T2.1）：
        // 让位态**不渲染** `sidebar-collapsed-strip`（那条只在用户手动折叠后出现，由 ⑥E2 判），
        // 但 `sidebar-panel` 必须仍在 DOM 里 —— 少了它，加宽窗口就恢复不回来。
        // 面板内动作（E1a / E1' / E3 / E4② / E2'）在让位态**没有对象可量**，见 NAV_YIELD_MAX_PX。
        if (navYielded) {
            const panelCount = await page.locator('[data-testid="sidebar-panel"]').count();
            const stripCount = await page
                .locator('[data-testid="sidebar-collapsed-strip"]')
                .count();
            expect
                .soft(
                    { panelCount, stripCount },
                    `${tag} ⑥让位态 形态不符（panel=${panelCount} / 折叠条=${stripCount}；阈值 {panel:1, 折叠条:0}：D-1829 让位是渲染层夹宽、不销毁面板，且让位不是用户折叠 ⇒ 不得出现手动折叠的展开条）`,
                )
                .toEqual({ panelCount: 1, stripCount: 0 });
        }
        // 面板**展开态**才量面板内动作（让位态下它们不在 DOM，量了就是空覆盖）。
        if (!navYielded) {
            // E1a：常驻动作下限 28×28（sidebar-new-chat）
            if (newChat) {
                const newChatMin = Math.min(newChat.w, newChat.h);
                expect
                    .soft(
                        newChatMin,
                        `${tag} ⑥E1a 新建会话命中区 ${fmtRect(newChat)}（实测 min=${fmt(newChatMin)}，阈值 ≥${HIT_MIN_PX}×${HIT_MIN_PX} 归属卡 task-73 E1a）`,
                    )
                    .toBeGreaterThanOrEqual(HIT_MIN_PX);
            }
            // E1（浮层菜单行口径，见判定表）：可见 + 可用 + 高 ≥20 + 宽 ≥120 —— **不再套** 28/32。
            // 这三项原来套的是常驻动作的 28/32，且因旧写法取不到元素而**从未真正执行**（空覆盖）；task-149
            // 修好展开流程后它们首次执行，暴露的是「27.7px < 28」这种跨类误判，故按 Lead 裁定改成按类判定。
            const menuRows = [
                {
                    testId: "sidebar-add-workspace",
                    label: "新建工作区",
                    box: addWsBox,
                    enabled: addWsEnabled,
                },
                {
                    testId: "sidebar-import-source",
                    label: "导入源",
                    box: importSourceBox,
                    enabled: importSourceEnabled,
                },
            ];
            for (const row of menuRows) {
                const rowHeight = row.box?.height ?? 0;
                const rowWidth = row.box?.width ?? 0;
                expect
                    .soft(
                        { visible: row.box !== null, enabled: row.enabled },
                        `${tag} ⑥E1 浮层菜单行 ${row.testId} 不可用（可见=${row.box !== null}，enabled=${row.enabled}；口径：浮层行须同时可见且可用）`,
                    )
                    .toEqual({ visible: true, enabled: true });
                expect
                    .soft(
                        rowHeight,
                        `${tag} ⑥E1 浮层菜单行 ${row.testId}（${row.label}）高 ${fmt(rowHeight)}px（阈值 ≥${MENU_ROW_MIN_HEIGHT_PX}px：鼠标可稳定命中的下限；**不套**常驻动作的 ${HIT_MIN_PX}/${ACTION_CLUSTER_MIN_PX}，见判定表）`,
                    )
                    .toBeGreaterThanOrEqual(MENU_ROW_MIN_HEIGHT_PX);
                expect
                    .soft(
                        rowWidth,
                        `${tag} ⑥E1 浮层菜单行 ${row.testId}（${row.label}）宽 ${fmt(rowWidth)}px（阈值 ≥${MENU_ROW_MIN_WIDTH_PX}px：菜单行不得退化成窄条）`,
                    )
                    .toBeGreaterThanOrEqual(MENU_ROW_MIN_WIDTH_PX);
            }

            // E2'：新建会话必须在首个会话行之上（Sidebar.vue:373-413 现状仍在搜索行 ⇒ 改前必红）
            //      task-9 注释漂移修正：旧注 :279-337 已是失效行号。
            //      task-13（DSD-1466）：判据/采样口径加固，红值来源与取样口径见 readNewChatAnchor 注释。
            //      A 判据（底边 − 顶边 ≤ 0）**不得单独使用** —— 只挪数字就能骗过它；必须与
            //      B（new-chat 底边 ≤ 列表容器顶边）和 C（首行落在容器可视区内）在同一帧、同一
            //      scrollTop 状态下同时成立。task-120 F-8 的「0 条会话时 boundingBox 无限等待」
            //      由 querySelector 返回 null 天然规避（不再需要先 count）。
            const anchor = await readNewChatAnchor(page);
            testInfo.annotations.push({
                type: "newchat-anchor",
                description: `${tag} scrollTop ${fmt(anchor.scrollTopBefore)}→${fmt(anchor.scrollTop)} 容器 ${fmtRect(anchor.container)} newChat ${fmtRect(anchor.newChat)} firstRow ${fmtRect(anchor.firstRow)} frames=${anchor.frames} stable=${anchor.stable}`,
            });
            console.log(
                `[task-174] ${tag} ⑥E2' 锚点 container=${fmtRect(anchor.container)} newChat=${fmtRect(anchor.newChat)} firstRow=${fmtRect(anchor.firstRow)} scrollTop ${fmt(anchor.scrollTopBefore)}→${fmt(anchor.scrollTop)} frames=${anchor.frames} stable=${anchor.stable}`,
            );
            if (anchor.newChat && anchor.firstRow && anchor.container) {
                const newChatBottom = anchor.newChat.y + anchor.newChat.h;
                const containerTop = anchor.container.y;
                const containerBottom = containerTop + anchor.container.h;
                const firstRowBottom = anchor.firstRow.y + anchor.firstRow.h;
                const anchorMsg = `容器 ${fmtRect(anchor.container)}｜newChat ${fmtRect(anchor.newChat)}｜firstRow ${fmtRect(anchor.firstRow)}｜scrollTop ${fmt(anchor.scrollTopBefore)}→${fmt(anchor.scrollTop)}（容器=${'[data-testid="sidebar-workspace-groups"]'}）`;
                // A（原判据，保留但不单独使用）：new-chat 底边不得低于首个会话行顶边。
                expect
                    .soft(
                        newChatBottom - anchor.firstRow.y,
                        `${tag} ⑥E2' A 新建会话底边 ${fmt(newChatBottom)} 未高于首个会话行顶边 ${fmt(anchor.firstRow.y)}（差值 ${fmt(newChatBottom - anchor.firstRow.y)}px，阈值 ≤0 归属卡 task-13 E2'）｜${anchorMsg}`,
                    )
                    .toBeLessThanOrEqual(0);
                // B（新增·结构性）：new-chat 行必须在列表容器**之上**，不能浮在列表内部。
                expect
                    .soft(
                        newChatBottom - containerTop,
                        `${tag} ⑥E2' B 新建会话底边 ${fmt(newChatBottom)} 未落在列表容器顶边 ${fmt(containerTop)} 之上（差值 ${fmt(newChatBottom - containerTop)}px，阈值 ≤0 归属卡 task-13 E2'）｜${anchorMsg}`,
                    )
                    .toBeLessThanOrEqual(0);
                // C（新增·杀掉采样假象）：首行必须落在容器可视区内 —— 滚出容器的元素即使 y 更小也不算数。
                expect
                    .soft(
                        anchor.firstRow.y - containerTop,
                        `${tag} ⑥E2' C 首个会话行顶边 ${fmt(anchor.firstRow.y)} 在列表容器顶边 ${fmt(containerTop)} 之上（越界 ${fmt(anchor.firstRow.y - containerTop)}px，阈值 ≥-0.5：首行必须落在容器可视区内，滚出容器的元素不算读数 归属卡 task-13 E2'）｜${anchorMsg}`,
                    )
                    .toBeGreaterThanOrEqual(-0.5);
                expect
                    .soft(
                        firstRowBottom - containerBottom,
                        `${tag} ⑥E2' C 首个会话行底边 ${fmt(firstRowBottom)} 越出列表容器底边 ${fmt(containerBottom)}（越界 ${fmt(firstRowBottom - containerBottom)}px，阈值 ≤0.5 归属卡 task-13 E2'）｜${anchorMsg}`,
                    )
                    .toBeLessThanOrEqual(0.5);
                // 归零必须真的生效：读取时容器仍被滚走 ⇒ 上面的 rect 不可信（读数本身不作数）。
                expect
                    .soft(
                        anchor.scrollTop,
                        `${tag} ⑥E2' 取样时列表容器 scrollTop ${fmt(anchor.scrollTop)} ≠ 0（归零未生效或取样期间被重新滚走，读数不可信 归属卡 task-13 E2'）｜${anchorMsg}`,
                    )
                    .toBe(0);
            } else {
                expect
                    .soft(
                        {
                            container: anchor.container,
                            newChat: anchor.newChat,
                            firstRow: anchor.firstRow,
                            scrollTop: anchor.scrollTop,
                            stable: anchor.stable,
                        },
                        `${tag} ⑥E2' 同帧取样取不到列表容器 / 新建会话 / 首个会话行（不 skip，按 fail 暴露 归属卡 task-13 E2'；frames=${anchor.frames} stable=${anchor.stable}）`,
                    )
                    .toBeNull();
            }

            // E3 / E4① / E4②：常驻可见性用 count + isVisible 判据
            // task-158：`sidebar-group-add` 在 packages/ui/src 全仓 0 命中（git log -S 只命中 spec 提交
            // 153e83cdf）⇒ 旧写法是**空覆盖**：产品把「组头新建会话」实现在工作区分组
            // （WorkspaceSessionGroups.vue:484 `sidebar-workspace-group-new-<wsid>`，min-h-7 min-w-7 常驻）
            // 与独立会话区（:403 `sidebar-standalone-group-new`）上。判据仍是不 hover 也可见，未放宽。
            const groupAdd = page.locator(
                '[data-testid^="sidebar-workspace-group-new-"], [data-testid="sidebar-standalone-group-new"]',
            );
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
            // ⑥E4① 读数一致性（task-52 / DSD-1464 口径①）：区头计数 = 列表**实际渲染**的会话行数，
            // 空态 0。上面那条只判「区头存在且唯一」，判不出「数字是不是真的」—— 数字写死 0 或
            // 只数当前工作区都能过。取样口径同 readNewChatAnchor（同帧、scrollTop 归零）。
            const counts = await readSessionsCount(page);
            testInfo.annotations.push({
                type: "sessions-count",
                description: `${tag} ⑥E4① 区头文本 "${counts.countText ?? "n/a"}" 解析 ${counts.countParsed ?? "n/a"} / 渲染行 ${counts.rows} ｜ container=${counts.containerPresent} scrollTop=${fmt(counts.scrollTop)} frames=${counts.frames} stable=${counts.stable}`,
            });
            console.log(
                `[task-52] ${tag} ⑥E4① 区头计数文本="${counts.countText ?? "n/a"}" 解析=${counts.countParsed ?? "n/a"} 渲染行=${counts.rows} container=${counts.containerPresent} scrollTop=${fmt(counts.scrollTop)} frames=${counts.frames} stable=${counts.stable}`,
            );
            expect
                .soft(
                    counts.countParsed,
                    `${tag} ⑥E4① 区头计数不是可解析的整数（原始文本="${counts.countText ?? "n/a"}"；计数必须是独立渲染的数字节点 归属卡 task-52 / DSD-1464 口径①）`,
                )
                .not.toBeNull();
            expect
                .soft(
                    counts.countParsed,
                    `${tag} ⑥E4① 区头计数 ${counts.countParsed ?? "n/a"} ≠ 列表实际渲染的会话行数 ${counts.rows}（口径 = 独立会话区 + 各已展开工作区分组的可见会话合计，空态写 0；归属卡 task-52 / DSD-1464 口径①）`,
                )
                .toBe(counts.rows);
            // 空态必须写 0（而不是留空 / 写「暂无」）：计数节点恒在，0 也得是数字。
            if (counts.rows === 0) {
                expect
                    .soft(
                        counts.countText,
                        `${tag} ⑥E4① 空态计数文本应为 "0"（实测 "${counts.countText ?? "n/a"}"；归属卡 task-52 / DSD-1464 口径①）`,
                    )
                    .toBe("0");
            }
            // 取样可信度：区头与计数节点都必须真的在 DOM 里（容器缺失时 rows 恒 0，会假绿）。
            expect
                .soft(
                    counts.containerPresent,
                    `${tag} ⑥E4① 取不到 [data-testid="sidebar-workspace-groups"] 容器 ⇒ 行数读 0 不可信（归属卡 task-52 / DSD-1464 口径①）`,
                )
                .toBe(true);
            // task-158：同一处空覆盖 —— 会话行「⋯」的真键是 SessionItem.vue:174 `session-item-more`
            // （h-7 w-7，opacity-70 常驻，hover 才 100），`sidebar-session-more` 产品从未有过。
            const sessionMoreVisible = await page
                .locator('[data-testid="session-item-more"]')
                .first()
                .isVisible()
                .catch(() => false);
            expect
                .soft(
                    sessionMoreVisible,
                    `${tag} ⑥E4② 会话次级动作 session-item-more 不常驻（实测 visible=${sessionMoreVisible}，阈值 true 归属卡 task-73 E4②）`,
                )
                .toBe(true);
            // 工作区行「⋯」真键带工作区 id：WorkspaceSessionGroups.vue:501 `sidebar-workspace-more-<wsid>`
            // （h-7 w-7，opacity-70 常驻），无 id 的 `sidebar-workspace-more` 不存在。
            const workspaceMoreVisible = await page
                .locator('[data-testid^="sidebar-workspace-more-"]')
                .first()
                .isVisible()
                .catch(() => false);
            expect
                .soft(
                    workspaceMoreVisible,
                    `${tag} ⑥E4② 工作区次级动作 sidebar-workspace-more-<wsid> 不常驻（实测 visible=${workspaceMoreVisible}，阈值 true 归属卡 task-73 E4②）`,
                )
                .toBe(true);

            // E1'：常驻动作（add-workspace / session-search）默认可见。
            // task-150（`DSD-1515`）：左栏「工作区设置/成员」第二入口已删除（「不再渲染」由单测
            // `Sidebar.spec.ts` 的负向用例守住，e2e 侧不留该入口的 testid 字面）⇒ 设置/成员改由
            // 工作区页导航承载，可达性在同屏路由块里验（`workspace-nav-settings` / `-members`）。
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
        }

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
                // task-150（`DSD-1515`）：设置/成员只从**工作区页导航**进入 ⇒ 导航项必须在场。
                // 口径：整页 goto 后壳层要等工作区 hydrate 才挂导航，故用有界 waitFor（非即时 isVisible），
                // 与文件内其它「短步探针」同型；超时仍按 false 记账，不改变失败语义。
                const settingsNavVisible = await page
                    .locator('[data-testid="workspace-nav-settings"]')
                    .first()
                    .waitFor({ state: "visible", timeout: 8000 })
                    .then(() => true)
                    .catch(() => false);
                expect
                    .soft(
                        settingsNavVisible,
                        `${tag} ⑥E1' 工作区页导航缺「设置」项（实测 visible=${settingsNavVisible}；task-150 起设置页只能从工作区页导航进入）`,
                    )
                    .toBe(true);
                const membersPath = `/workspace/${wsId}/members`;
                await page.goto(membersPath, { waitUntil: "load" });
                expect
                    .soft(
                        page.url(),
                        `${tag} ⑥E1' 成员页不可达（实测 ${page.url()}，期望含 ${membersPath} 归属卡 task-73 E1'）`,
                    )
                    .toContain(`/workspace/${wsId}/members`);
                const membersNavVisible = await page
                    .locator('[data-testid="workspace-nav-members"]')
                    .first()
                    .waitFor({ state: "visible", timeout: 8000 })
                    .then(() => true)
                    .catch(() => false);
                expect
                    .soft(
                        membersNavVisible,
                        `${tag} ⑥E1' 工作区页导航缺「成员」项（实测 visible=${membersNavVisible}；task-150 起成员页只能从工作区页导航进入）`,
                    )
                    .toBe(true);
                // task-150 / DSD-1515：工作区配置入口从导航面板区头删除后不得再常驻。
                // 追溯门（check-decision-test-map）D-1907/C-1 的断言锚点就是下一句的开头。
                const configEntryCount = await page
                    .locator('[data-testid^="sidebar-workspace-config"]')
                    .count();
                expect
                    .soft(
                        configEntryCount,
                        `${tag} ⑥E1' 工作区配置入口不常驻（实测 ${configEntryCount}，期望 0；DSD-1515 已删 sidebar-workspace-config，归属卡 task-150 / task-176）`,
                    )
                    .toBe(0);
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

// ---- task-176：DEV-011 17.4「dirty 指示 + 离开策略」的 @host 车道用例（3 正 + 3 负）----
// 口径：
//   1. 三条判据 = beforeunload 监听 / 路由离开守卫 / 浮层关闭确认。正例脏化后必须被拦住，
//      负例不脏化必须照常放行（负例今天即绿，作用是防「为修红把离开一律拦死」这种反做）。
//   2. 正例状态按 task-151 落地后的现状读（2026-11-21）：
//      · 抽屉关闭确认（Esc / 关闭键）= task-151 已落地，草稿未提交时走 apd-unsaved-confirm
//        （alertdialog）并留住抽屉 ⇒ 已转绿；抽屉「刷新页面」那条 beforeunload 仍未实现（仍红），
//        归属 = task-190 J7（Lead 2026-11-21 裁定并入，与 J2 共用同一聚合 dirty 判定，非无归属）；
//      · 设置页整页草稿的离开守卫 = UNCOVERED，由 task-190 J1/J2 覆盖（Lead 已立卡；不读成 PASS）。
//      ⇒ 首跑预期红 2 条，归属同为 task-190：J1 设置页路由守卫 + J7 抽屉刷新守卫（Lead 裁 5，非零退出是设计如此，不放宽判据、不加 --allow-skip、不 skip）。
//   3. 脏化只写本地草稿：抽屉走钩子新增行（apd-hooks-add 只改前端 advisors 数组），
//      设置页走 config-text 输入框且绝不点 config-save。六条都只开成员页/设置页，
//      不触发会话或工作区资源创建（Lead 裁 1a）。
//   4. 零数据一律 fail 不 skip，理由写在抛错文本里（Lead 裁 3，与 discoverSession 同口径）。
const MEMBERS_PAGE_PATH = "/members";
// task-37：落点必须是「有可编辑文本项」的实例域。/settings 会重定向到 /settings/instance/llm-provider
// （ProviderHub，config-text-* 计数 0），辅助函数会抛 NO_CONFIG_TEXT_MSG、用例根本没进入用例体。
// context-policy 是实测有 1 个 config-text-* 的域（判据 ConfigDomainPanel.vue:973-981 的 !readonly 分支）。
const SETTINGS_PAGE_PATH = "/settings/instance/context-policy";
const PRINCIPAL_CONFIGURE_SEL = '[data-testid^="agent-principals-configure-"]';
const APD_DRAWER_SEL = '[data-testid="agent-principal-detail-drawer"]';
const APD_HOOKS_KIND_SEL = '[data-testid="apd-hooks-kind"]';
const APD_HOOKS_ADD_SEL = '[data-testid="apd-hooks-add"]';
// task-34（0652f42fa）把三段表单收敛成抽屉底部统一提交点 apd-save-all，per-section 的
// apd-hooks-save 已删除（删于 1fc5d4b57..edf51cbf 之间，窗口 1 钉靶时还在）；task-37 扩卡对齐新契约。
const APD_SAVE_ALL_SEL = '[data-testid="apd-save-all"]';
const APD_HOOKS_ROW_SEL = '[data-testid^="apd-hooks-remove-"]';
const CONFIG_TEXT_SEL = '[data-testid^="config-text-"]';
const ALERT_DIALOG_SEL = '[role="alertdialog"]';
const NO_PRINCIPAL_MSG =
    "成员页没有可配置的 agent principal：需实例层 ≥1 个 principal（task-148 首启种子落地后具备）；判 fail 不判 skip，与 discoverSession 同口径";
const NO_CONFIG_TEXT_MSG =
    "设置页没有可编辑文本项：config-text-* 未出现（该层可能全为 env 锁定项），17.4 用例无脏化落点；判 fail 不判 skip";

/**
 * 打开第一个 principal 的可编辑抽屉；draft 非空时加一条本地钩子草稿（不点保存、不发请求）。
 * draft 只是「要不要脏化」的标记：钩子行由「添加订阅」直接产出（kind 默认 guard，非空），
 * 不再往 apd-hooks-kind 里打字 —— 它是 reka Select 的 trigger 按钮，不是 input。
 */
async function openAgentDrawerWithDraft(page: Page, _draft: string | null): Promise<void> {
    await loginViaForm(page);
    await page.goto(MEMBERS_PAGE_PATH, { waitUntil: "load" });
    if (
        !(await waitReadyFor(page, PRINCIPAL_CONFIGURE_SEL, "visible", SESSION_SURFACE_DEADLINE_MS))
    ) {
        throw new Error(NO_PRINCIPAL_MSG);
    }
    await page.locator(PRINCIPAL_CONFIGURE_SEL).first().click({ timeout: 5_000 });
    if (!(await waitReadyFor(page, APD_DRAWER_SEL, "visible", SESSION_SURFACE_DEADLINE_MS))) {
        throw new Error("抽屉未打开：agent-principal-detail-drawer 未在当前 20s 窗口内可见");
    }
    if (_draft === null) return;
    if (!(await waitReadyFor(page, APD_HOOKS_KIND_SEL, "visible", 8_000))) {
        throw new Error(
            "钩子分区不可写：apd-hooks-kind 未渲染（editableSections 不含 hooks 或该 principal 无写权）",
        );
    }
    // apd-hooks-kind 是 reka Select trigger（不是 input）：点「添加订阅」即可脏化，
    // 判据仍是「行数 +1 且统一提交点可点」（task-34 后 = apd-save-all；其 disabled = readonly ||
    // saving || pendingSectionCount===0，所以「有草稿 ⇒ 可点」仍能证明存在未保存状态）。
    const rowsBefore = await page.locator(APD_HOOKS_ROW_SEL).count();
    await page.locator(APD_HOOKS_ADD_SEL).click({ timeout: 5_000 });
    const rowsAfter = await page.locator(APD_HOOKS_ROW_SEL).count();
    expect(
        rowsAfter,
        "脏化步骤本身失效：advisors 行数没有 +1（前 " + rowsBefore + " 后 " + rowsAfter + "）",
    ).toBe(rowsBefore + 1);
    const saveEnabled = await page.locator(APD_SAVE_ALL_SEL).isEnabled();
    expect(saveEnabled, "加草稿后统一提交点仍禁用：无法证明存在未保存状态").toBe(true);
}

/** 打开设置页并（可选）在第一个可编辑文本项里留下本地草稿（不保存）。 */
async function openSettingsWithDraft(page: Page, draft: string | null): Promise<void> {
    await loginViaForm(page);
    await page.goto(SETTINGS_PAGE_PATH, { waitUntil: "load" });
    if (!(await waitReadyFor(page, CONFIG_TEXT_SEL, "attached", SESSION_SURFACE_DEADLINE_MS))) {
        throw new Error(NO_CONFIG_TEXT_MSG);
    }
    if (draft === null) return;
    const fields = page.locator(CONFIG_TEXT_SEL);
    const total = await fields.count();
    for (let index = 0; index < total; index += 1) {
        const field = fields.nth(index);
        const inner = field.locator("input, textarea").first();
        const target = (await inner.count()) > 0 ? inner : field;
        // 面板取数晚于容器挂载：fill 自带 visible+enabled 等待，不能用单次 isVisible 判掉。
        const filled = await target
            .fill(draft, { timeout: 15_000 })
            .then(() => true)
            .catch(() => false);
        if (!filled) continue;
        expect(await target.inputValue(), "脏化步骤本身失效：填写后读回不是草稿").toBe(draft);
        // 等 dirty 信号真的落到面板上再返回：否则下一步导航可能早于 Vue 的 emit 传播。
        await page
            .locator('[data-testid^="config-domain-"][data-draft-dirty="true"]')
            .first()
            .waitFor({ state: "attached", timeout: 10_000 });
        return;
    }
    throw new Error(NO_CONFIG_TEXT_MSG + "（可见且可用的输入框为 0）");
}

async function countDialogsOfType(page: Page, type: string): Promise<number> {
    const seen: string[] = [];
    page.on("dialog", async (dialog) => {
        seen.push(dialog.type());
        // accept = 「离开站点」：让导航照常走完，本用例只判弹框有没有出现
        await dialog.accept().catch(() => {});
    });
    await page.reload({ waitUntil: "load" });
    return seen.filter((entry) => entry === type).length;
}

test.describe("DEV-011 17.4 未保存状态与离开策略（task-176）", () => {
    test("@host 17.4 正例：抽屉带未保存草稿刷新页面必须触发 beforeunload", async ({ page }) => {
        await openAgentDrawerWithDraft(page, "e2e-17-4-draft");
        const fired = await countDialogsOfType(page, "beforeunload");
        expect(
            fired,
            "带未保存草稿刷新页面没有任何 beforeunload 提示（DEV-011 17.4；task-151 只收敛了关闭确认，刷新守卫归 task-190 J7）",
        ).toBeGreaterThan(0);
    });

    test("@host 17.4 负例：抽屉无草稿时刷新不得触发 beforeunload", async ({ page }) => {
        await openAgentDrawerWithDraft(page, null);
        const fired = await countDialogsOfType(page, "beforeunload");
        expect(fired, "无未保存状态却拦刷新：离开策略过头").toBe(0);
    });

    test("@host 17.4 正例：设置页带未保存草稿走路由导航必须被拦住", async ({ page }) => {
        await openSettingsWithDraft(page, "e2e-17-4-draft");
        // task-776：原来用 page.goBack() = **整文档历史回退**，SPA 的 onBeforeRouteLeave 拦不到。
        // 改成真实站内路由导航（设置左栏链接）后，守卫才在正确的位置被触发。
        await page.getByTestId("settings-nav-domain-instance-logging").click();
        const confirm = page.getByTestId("settings-leave-confirm");
        await expect(confirm, "带未保存草稿走 SPA 路由导航没有弹离开确认（task-190）").toBeVisible({
            timeout: 10_000,
        });
        expect(
            page.url(),
            "弹了确认但 URL 已经离开设置页：守卫没有真正挂起导航（DEV-011 17.4）",
        ).toContain(SETTINGS_PAGE_PATH);
        await page.getByTestId("settings-leave-keep").click();
        await expect(confirm).toBeHidden();
        expect(page.url(), "点「继续编辑」后仍被带走").toContain(SETTINGS_PAGE_PATH);

        // 二次导航并明确丢弃：确认「离开」确实放行，而不是永远卡在设置页。
        await page.getByTestId("settings-nav-domain-instance-logging").click();
        await expect(confirm).toBeVisible({ timeout: 10_000 });
        await page.getByTestId("settings-leave-discard").click();
        await page.waitForURL(/\/settings\/instance\/logging$/, { timeout: 10_000 });
    });

    test("@host 17.4 负例：设置页无草稿时路由导航不得拦截", async ({ page }) => {
        await openSettingsWithDraft(page, null);
        await page.getByTestId("settings-nav-domain-instance-logging").click();
        await page.waitForURL(/\/settings\/instance\/logging$/, { timeout: 10_000 });
        expect(page.url(), "无未保存状态也被拦在设置页：离开策略误伤").not.toContain(
            SETTINGS_PAGE_PATH,
        );
    });

    test("@host 17.4 正例：抽屉带未保存草稿关闭必须先确认", async ({ page }) => {
        await openAgentDrawerWithDraft(page, "e2e-17-4-draft");
        await page.keyboard.press("Escape");
        const confirmVisible = await page
            .locator(ALERT_DIALOG_SEL)
            .first()
            .isVisible()
            .catch(() => false);
        const drawerStillOpen = await page
            .locator(APD_DRAWER_SEL)
            .first()
            .isVisible()
            .catch(() => false);
        expect(
            confirmVisible || drawerStillOpen,
            "按 Esc 直接丢弃未保存草稿：既无确认层也未留住抽屉（DEV-011 17.4；task-151 已落地，此处应转绿）",
        ).toBe(true);
    });

    test("@host 17.4 负例：抽屉无草稿时 Esc 直接关闭且不得弹确认", async ({ page }) => {
        await openAgentDrawerWithDraft(page, null);
        await page.keyboard.press("Escape");
        const gone = await page
            .locator(APD_DRAWER_SEL)
            .first()
            .waitFor({ state: "detached", timeout: 8_000 })
            .then(() => true)
            .catch(() => false);
        expect(gone, "无草稿也拦着不让关抽屉：离开策略误伤").toBe(true);
        const confirmVisible = await page
            .locator(ALERT_DIALOG_SEL)
            .first()
            .isVisible()
            .catch(() => false);
        expect(confirmVisible, "无草稿也弹确认层：打扰用户").toBe(false);
    });
});
