/**
 * task-69 · 页签三元组（S1 纯函数层，本卡**不接线**：TabBar/Workbench/Dock 的消费者改造在 task-140）。
 *
 * 页签 id = `(workspaceId 命名空间, sessionId 可空, view)` 的三元组：workspace 由持久键承担，
 * id 字符串里只带 session 与 view。`container` **不进 id**，由 view 派生（chat ⇒ main，其余 ⇒ right），
 * 保住 `lib/containers.ts` 的不变式「归属是数据、与宽度无关、不落盘」。
 *
 * 旧格式 `session:<sid>`（无 view 段）= chat，**只在读侧迁移**；写侧只产三元组。
 * 这条旧格式读规则是为 task-69 之后的持久键拆分（task-140 S2）留的迁移口，
 * 现在没有任何 writer 消费它 —— 本文件零副作用，纯派生。
 */
import { DOCK_MAX_TABS } from "../../../composables/useWorkspaceLayout";
import type { ContainerId } from "./containers";

/** 会话视图：必须绑定一个会话。`chat` 落 main，其余落 right。 */
export const SESSION_VIEWS = [
    "chat",
    "context",
    "monitor",
    "members",
    "changes",
    "delegation",
] as const;
export type SessionView = (typeof SESSION_VIEWS)[number];

/**
 * 工作区视图：与具体会话无关。**必须是 `DOCK_TAB_IDS` 的子集**（本文件不复制面板 IA 清单，
 * 单测 `workTabs.spec.ts` 有一条集合包含断言把两者钉在一起）。
 */
export const PANEL_VIEWS = ["files", "code", "agents"] as const;
export type PanelView = (typeof PANEL_VIEWS)[number];

/** main 行可见上限（工作台 `max-visible-tabs`）；right 行沿用 `DOCK_MAX_TABS`。 */
export const MAIN_MAX_TABS = 8;

export type WorkTabId = `session:${string}:${SessionView}` | `panel:${PanelView}`;

export interface WorkTab {
    readonly id: WorkTabId;
    /** `panel:*` 恒 null。 */
    readonly sessionId: string | null;
    readonly view: SessionView | PanelView;
}

const SESSION_PREFIX = "session:";
const PANEL_PREFIX = "panel:";

const SESSION_VIEW_SET: ReadonlySet<string> = new Set(SESSION_VIEWS);
const PANEL_VIEW_SET: ReadonlySet<string> = new Set(PANEL_VIEWS);

export function isSessionView(value: unknown): value is SessionView {
    return typeof value === "string" && SESSION_VIEW_SET.has(value);
}

export function isPanelView(value: unknown): value is PanelView {
    return typeof value === "string" && PANEL_VIEW_SET.has(value);
}

/** 新写入口：`workTabIdForSession("a")` = chat（唯一的默认值，别在调用点各写一遍）。 */
export function workTabIdForSession(sessionId: string, view: SessionView = "chat"): WorkTabId {
    return `${SESSION_PREFIX}${sessionId}:${view}`;
}

export function workTabIdForPanel(view: PanelView): WorkTabId {
    return `${PANEL_PREFIX}${view}`;
}

/**
 * 解析 id：**先新格式，再旧格式**。
 *
 * - `session:<sid>:<view>` ⇒ 三元组；
 * - `session:<sid>`（旧载荷，无 view 段）⇒ 视作 chat，返回**新格式 id**（迁移读）；
 * - `panel:<view>` ⇒ 工作区视图；其余（含 C3 之前的页面 id `environment` / `settings`）⇒ null。
 *
 * 用 `lastIndexOf(":")` 切 view 段：session id 万一含冒号，也只会把最后一段当视图，
 * 且该段必须命中清单，否则整串回落到旧格式判定。
 */
export function parseWorkTab(id: string): WorkTab | null {
    if (typeof id !== "string" || id.length === 0) return null;
    if (id.startsWith(PANEL_PREFIX)) {
        const view = id.slice(PANEL_PREFIX.length);
        return isPanelView(view) ? { id: workTabIdForPanel(view), sessionId: null, view } : null;
    }
    if (!id.startsWith(SESSION_PREFIX)) return null;
    const rest = id.slice(SESSION_PREFIX.length);
    if (rest.length === 0) return null;
    const cut = rest.lastIndexOf(":");
    if (cut > 0) {
        const view = rest.slice(cut + 1);
        const sessionId = rest.slice(0, cut);
        return isSessionView(view)
            ? { id: workTabIdForSession(sessionId, view), sessionId, view }
            : null;
    }
    // 旧格式（**整串没有 view 段**）⇒ chat：只读迁移，写侧永远产三元组。
    // 有冒号但末段不是合法视图 ⇒ 非法（不猜成「含冒号的 session id」：那会把损坏载荷渲染成死页签）。
    if (cut >= 0) return null;
    return { id: workTabIdForSession(rest, "chat"), sessionId: rest, view: "chat" };
}

export function isWorkTabId(value: unknown): value is WorkTabId {
    return typeof value === "string" && parseWorkTab(value) !== null;
}

export function sessionIdOfWorkTab(id: WorkTabId): string | null {
    return parseWorkTab(id)?.sessionId ?? null;
}

export function viewOfWorkTab(id: WorkTabId): SessionView | PanelView {
    return parseWorkTab(id)?.view ?? "chat";
}

/** 归属纯函数：`chat` ⇒ main，其余全部 ⇒ right（与宽度 / mode 无关）。 */
export function containerOfWorkTab(id: WorkTabId): ContainerId {
    return viewOfWorkTab(id) === "chat" ? "main" : "right";
}

function capFor(container: ContainerId): number {
    return container === "main" ? MAIN_MAX_TABS : DOCK_MAX_TABS;
}

/**
 * 净化页签集合：丢弃非法、去重（保序）、**按容器各自**限流（main 8 / right 6）。
 *
 * 上限按容器而不是整体：两行是同一空间的两个投影，一行满了不该吃掉另一行的额度
 * （否则先开 6 个右侧面板就能把 main 行挤到 2 个）。
 */
export function normalizeWorkTabs(value: unknown): WorkTabId[] {
    if (!Array.isArray(value)) return [];
    const out: WorkTabId[] = [];
    const used: Record<ContainerId, number> = { main: 0, right: 0 };
    for (const raw of value) {
        const tab = typeof raw === "string" ? parseWorkTab(raw) : null;
        if (!tab) continue;
        if (out.includes(tab.id)) continue;
        const container = containerOfWorkTab(tab.id);
        if (used[container] >= capFor(container)) continue;
        used[container] += 1;
        out.push(tab.id);
    }
    return out;
}

/**
 * 旧载荷迁移：`openTabs: ["session:a", ...]` ⇒ `["session:a:chat", ...]`。
 * 与 `normalizeWorkTabs` 同一实现是刻意的 —— 迁移不是第二条规则，只是「旧格式能被解析」。
 */
export function migrateLegacyOpenTabs(value: unknown): WorkTabId[] {
    return normalizeWorkTabs(value);
}
