/**
 * task-138 / `D-1907` rev7·rev8·rev10：**容器内页签 id** 的第三形态 `pane:<container>:<view>[:<sid>]`。
 *
 * <p>为什么需要它：`DOCK_TAB_IDS` 是**固定 7 值枚举**（`composables/useWorkspaceLayout.ts:101-110`），
 * 装不下「同一会话的配置页签在两栏各开一份」。而容器归属今天是**由 id 反推**的
 * （`lib/containers.ts` 的 `containerOf`：id ∈ `DOCK_TAB_IDS` ⇒ right，否则 main）——
 * 裸 id 反推不出「这个页签开在哪一栏」，所以容器必须进 id。</p>
 *
 * <p>**为什么是第三形态而不是第三份数组**：页签仍只有一条持久化数组（`xihe-layout-ws:<ws>` 的
 * `dockTabs`），本文件只负责「怎么把 id 写出来 / 怎么读回来」。多一份数组就是多一个 writer、
 * 多一处可能不同步的真源。</p>
 *
 * <p>**为什么前缀是 `pane:` 而不是 `panel:`**：`lib/workTabs.ts`（task-69）
 * 已占用 `panel:<view>` 表示「与会话无关的工作区视图」，且它的 `parseWorkTab` 对
 * `panel:` 前缀只认三个 view（`workTabs.ts:80-83`）⇒ `panel:right:code` 会被它判非法。
 * 两个域用**不相交的前缀**，谁的载荷都不会被对方吃掉；本文件与 `workTabs.ts` 各有一条
 * 互斥守卫单测（`parseWorkTab("pane:right:code") === null` / `isPaneTabId("session:s1:chat") === false`）。</p>
 *
 * <p>**兼容**：旧载荷里的裸 8 值（`files` / `code` / …）**仍然是合法 id**，读侧等价于
 * `pane:right:<id>`，`parsePaneTab` 对它们返回 `null`（它们不是 pane id）——零迁移、
 * 不重写用户键。写侧只在新开关打开时才产 `pane:*`。</p>
 *
 * <p>**会话型 view 不进 `pane:`（`D-1912`）**：主栏会话页签的 id 是 `session:<sid>`（`workTabs.ts`），
 * 容器由 `containerOf` 反推（`session:*` ⇒ main），不需要容器进 id。给 `chat` 也加一个
 * `pane:main:chat:<sid>` 会让同一会话有两种身份，两种写法同时进 `dockTabs` 就是主栏两份页签 ——
 * 所以 `paneTabId` 对非 `session-config` 的 view 传 sid 一律返回 `null`（`panelTabs.spec.ts` 有守卫用例）。
 *
 * <p>**纯函数、零副作用**：不读 `localStorage`、不 import Vue、不 import 组件。
 * 容器归属仍由 `lib/containers.ts` 的 `containerOf` 唯一派生（本文件只提供「从 id 里读容器」）。</p>
 *
 * <p>**与预览壳的关系（已知边界）**：`WorkspaceShellDockview.vue`（`__xhUseDockview`，默认 false）
 * 的面板身份是 `component: id`，组件按 `DOCK_TAB_IDS` 注册 ⇒ 它认得的只有 `view` 段
 * （`pane:<container>:<view>` ⇒ 面板 `view`），`session-config` 在该壳**没有对应组件**，
 * 与 `files` 同型静默忽略（见该文件 `:96-112` 的注释与 task-138 卡面「已知边界」）。</p>
 */
import { DOCK_TAB_IDS } from "../../../composables/useWorkspaceLayout";
import type { ContainerId } from "./containers";

/**
 * 摘要条快捷开关开出来的面板（`D-1907` rev10）。**不是** `DOCK_TAB_IDS` 的一员：
 * 它绑定一个会话（`pane:<container>:session-config:<sid>`），而 `DOCK_TAB_IDS` 里的
 * 面板与会话无关。也因此它不进 i18n 的 `DOCK_TAB_LABEL_KEYS`（那张表是 `Record<DockTabId, string>`），
 * 标签由 `workspace.panelSessionConfig` 单独给。
 */
export const SESSION_CONFIG_VIEW = "session-config";

/** 能出现在 `pane:` id 里的 view：静态面板 8 值 ∪ `session-config`。 */
export type PaneView = (typeof DOCK_TAB_IDS)[number] | typeof SESSION_CONFIG_VIEW;

/**
 * 容器清单：与 `lib/containers.ts` 的 `CONTAINER_IDS` 同值。
 *
 * <p>**刻意不 import**：`containers.ts` 在模块顶层 `new Set(DOCK_TAB_IDS)`（`:53`），
 * 而本文件被 `composables/useWorkspaceLayout.ts` 反向 import（`isDockTabId` 要认 pane id），
 * 引进来就成「初始化期循环」⇒ `DOCK_TAB_IDS` 还在 TDZ 就被读，启动即炸。
 * 这条重复由 `panelTabs.spec.ts` 的逐项相等断言钉住（与 `workTabs.spec.ts` 钉
 * `PANEL_VIEWS ⊂ DOCK_TAB_IDS` 同一手法）。</p>
 */
export const PANE_CONTAINERS = ["main", "right"] as const;

export interface PaneTab {
    /** 规范化后的 id（写入口给的形态，永远带容器）。 */
    readonly id: string;
    readonly container: ContainerId;
    readonly view: PaneView;
    /** 只有 `session-config` 有；静态面板恒 `null`。 */
    readonly sessionId: string | null;
}

const PANE_PREFIX = "pane:";
const SESSION_CONFIG_PREFIX = `${SESSION_CONFIG_VIEW}:`;

/**
 * 静态面板 view 集合：**惰性**构造。
 *
 * <p>不能在模块顶层 `new Set(DOCK_TAB_IDS)` —— 见 `PANE_CONTAINERS` 的注释：
 * 本模块可能在 `DOCK_TAB_IDS` 初始化之前被求值（循环 import），顶层读它就是 TDZ 崩溃。
 * 延迟到第一次调用时读，那时两个模块都已初始化（ESM 活绑定）。</p>
 */
let staticViewSet: ReadonlySet<string> | null = null;

function knownViews(): ReadonlySet<string> {
    staticViewSet ??= new Set<string>([...DOCK_TAB_IDS, SESSION_CONFIG_VIEW]);
    return staticViewSet;
}

export function isPaneContainer(value: unknown): value is ContainerId {
    return value === "main" || value === "right";
}

export function isPaneView(value: unknown): value is PaneView {
    return typeof value === "string" && knownViews().has(value);
}

/**
 * 写入口：`paneTabId("right", "code")` = `pane:right:code`；
 * `paneTabId("main", "session-config", "s1")` = `pane:main:session-config:s1`。
 *
 * <p>契约（与解析严格对称）：`session-config` **必须**带 sessionId；静态面板 **必须不带**
 * （与会话无关的面板挂上会话，就是第二套语义）。违反 ⇒ `null`，调用点必须显式处理，
 * 不允许「先拼出来再说」。</p>
 */
export function paneTabId(
    container: ContainerId,
    view: PaneView,
    sessionId?: string | null,
): string | null {
    if (!isPaneContainer(container) || !isPaneView(view)) return null;
    if (view === SESSION_CONFIG_VIEW) {
        if (typeof sessionId !== "string" || sessionId.length === 0) return null;
        return `${PANE_PREFIX}${container}:${SESSION_CONFIG_VIEW}:${sessionId}`;
    }
    if (sessionId !== undefined && sessionId !== null) return null;
    return `${PANE_PREFIX}${container}:${view}`;
}

/**
 * 解析 id：`pane:<container>:<view>[:<sid>]` ⇒ 四元组；其余（含旧裸 8 值、`session:*`、
 * `panel:*`）⇒ `null`。
 *
 * <p>切法：先按前两个 `:` 切出前缀与容器，剩下整段按 view 判定 —— `session-config:` 之后的
 * **整段都是 session id**（session id 自己可能含冒号，所以用「前缀 + 剩余」而不是再切一次）。</p>
 *
 * <p>未知 view / 缺 session / 静态 view 带尾巴 ⇒ 一律 `null`：读侧靠这条把垃圾丢掉，
 * 不把任意字符串渲染成点开就死的页签（`workTabs.ts:96-97` 同一条纪律）。</p>
 */
export function parsePaneTab(id: unknown): PaneTab | null {
    if (typeof id !== "string" || !id.startsWith(PANE_PREFIX)) return null;
    const rest = id.slice(PANE_PREFIX.length);
    const firstCut = rest.indexOf(":");
    if (firstCut <= 0) return null;
    const container = rest.slice(0, firstCut);
    const tail = rest.slice(firstCut + 1);
    if (!isPaneContainer(container) || tail.length === 0) return null;
    if (tail.startsWith(SESSION_CONFIG_PREFIX)) {
        const sessionId = tail.slice(SESSION_CONFIG_PREFIX.length);
        // 会话 id 里允许再出现冒号（后端 id 不保证），所以这里不再切；只要求非空。
        return sessionId.length === 0
            ? null
            : {
                  id: `${PANE_PREFIX}${container}:${SESSION_CONFIG_VIEW}:${sessionId}`,
                  container,
                  view: SESSION_CONFIG_VIEW,
                  sessionId,
              };
    }
    if (tail.includes(":")) return null;
    if (!knownViews().has(tail) || tail === SESSION_CONFIG_VIEW) return null;
    return {
        id: `${PANE_PREFIX}${container}:${tail}`,
        container,
        view: tail as PaneView,
        sessionId: null,
    };
}

export function isPaneTabId(value: unknown): value is string {
    return parsePaneTab(value) !== null;
}

/** 从 id 读容器（`containerOf` 的 pane 分支用）；不是 pane id ⇒ `null`，由调用方走旧规则。 */
export function paneTabContainer(id: string): ContainerId | null {
    return parsePaneTab(id)?.container ?? null;
}

/** 从 id 读 view（预览壳把 pane id 映射成 dockview 面板 id 用）；不是 pane id ⇒ `null`。 */
export function paneTabView(id: string): PaneView | null {
    return parsePaneTab(id)?.view ?? null;
}

export function paneTabSessionId(id: string): string | null {
    return parsePaneTab(id)?.sessionId ?? null;
}
