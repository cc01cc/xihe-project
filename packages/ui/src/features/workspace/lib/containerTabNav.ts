import {
    visibleContainers,
    type ActiveColumn,
    type ContainerId,
    type ContainerMode,
} from "./containers";

/**
 * task-184（`BL-561` 扩展 / `D-1600`）：**容器页签行的键盘契约**。
 *
 * <p>为什么单独成纯函数模块：键盘判定要能在 jsdom 里单测（`D-1600` ①②③ 三条判据全部落在这层），
 * 而「真的把焦点挪过去」只能在浏览器里读 `document.activeElement` ⇒ 逻辑与效果分开取证。</p>
 *
 * <p>键位来自 `workspace-shell-refresh-design.md` §4.3（accepted-design）+ `D-1600`：
 * `F6`/`Shift+F6` = 容器行之间循环焦点；`Ctrl+Alt+Arrow*` = 跨组移动/建组（**焦点限定在页签行内**，
 * 见 `resolveMoveKey` 注释）。</p>
 */

export type MoveDirection = "left" | "right" | "split";

export interface ContainerRow {
    readonly container: ContainerId;
    readonly tabs: readonly { readonly id: string }[];
    readonly activeId: string | null;
}

/**
 * 行内入口页签 = **激活页签**，没有则**首个**（`D-1600` ①）。
 *
 * <p>为什么不直接用「首个」：`F6` 进到一个容器时，用户期望落在**这个容器当前正在看的那个页签**上，
 * 而不是最左边那个 —— 否则每次跨容器都要再重新选一次。</p>
 */
export function rowEntryTabId(row: ContainerRow): string | null {
    if (row.activeId !== null && row.tabs.some((tab) => tab.id === row.activeId)) {
        return row.activeId;
    }
    return row.tabs.length > 0 ? row.tabs[0].id : null;
}

/**
 * 可遍历的行 = **真的渲染了页签行**的行（顺序 = 调用方给的渲染顺序）。
 *
 * <p>为什么必须过滤而不是直接用容器常量表：空容器**不渲染页签行**（`WorkspaceContainerTabs`
 * 的 `allowEmpty` 默认 false，`task-174` 定的），所以 `CONTAINER_IDS` 里的两格与 DOM 里的行数
 * 不是一回事（右栏在 <1800 收起时就没有行）；照 DOM 顺序会「跳过一行跳到不相邻的容器」，
 * 照常量表会把焦点送到不存在的行上。</p>
 */
export function focusableRows(rows: readonly ContainerRow[]): readonly ContainerRow[] {
    return rows.filter((row) => rowEntryTabId(row) !== null);
}

/**
 * 页签行上报的按键事实（组件 → 调用方）。
 *
 * <p>为什么判定不放在组件里：只有调用方（`WorkspaceWorkbench`）知道「一共有哪些行」，
 * 组件只知道自己是哪一行。组件上报**事实**，调用方做**判定** —— 这样判定面可以纯函数单测。</p>
 */
export interface ContainerRowKeyPayload {
    /** 上报者属于哪个容器行（判定要用它算「下一行」）。 */
    readonly container: ContainerId;
    readonly key: string;
    readonly shift: boolean;
    /** 非 null = 移动/建组键；null = 焦点导航键（`F6`）。 */
    readonly direction: MoveDirection | null;
    readonly event: KeyboardEvent;
}

export interface NavContext {
    readonly rows: readonly ContainerRow[];
    readonly current: ContainerId | null;
    readonly shift: boolean;
}

export type NavOutcome =
    | {
          readonly kind: "focus";
          readonly container: ContainerId;
          readonly tabId: string;
          readonly preventDefault: true;
      }
    | {
          readonly kind: "none";
          readonly reason: "not-navigation-key" | "no-rows" | "single-row";
          readonly preventDefault: false;
      };

/**
 * `F6` / `Shift+F6` 的判定。
 *
 * <p>三条硬约束（`D-1600`）：</p>
 * <ol>
 *   <li>顺序取自**渲染出来的行**（`focusableRows`），落点 = 目标行入口页签；</li>
 *   <li>**只有一行时 no-op 且 `preventDefault: false`** —— 浏览器/OS 的 `F6` 本来有默认行为，
 *       我们没做任何事时不许把它吞掉（吞掉 = 用户失去浏览器级 F6）；</li>
 *   <li>真移动焦点时才 `preventDefault: true`（否则焦点会被我们挪一次、再被平台挪一次）。</li>
 * </ol>
 */
export function resolveNavKey(key: string, context: NavContext): NavOutcome {
    if (key !== "F6") return { kind: "none", reason: "not-navigation-key", preventDefault: false };
    const rows = focusableRows(context.rows);
    if (rows.length === 0) return { kind: "none", reason: "no-rows", preventDefault: false };
    if (rows.length === 1) return { kind: "none", reason: "single-row", preventDefault: false };

    const step = context.shift ? -1 : 1;
    const currentIndex = rows.findIndex((row) => row.container === context.current);
    // 焦点不在任何页签行里（例如从内容区按 F6）：前进进第一行，后退进最后一行。
    let targetIndex: number;
    if (currentIndex < 0) {
        targetIndex = step > 0 ? 0 : rows.length - 1;
    } else {
        targetIndex = (currentIndex + step + rows.length) % rows.length;
    }
    const target = rows[targetIndex];
    const tabId = rowEntryTabId(target);
    if (tabId === null) return { kind: "none", reason: "no-rows", preventDefault: false };
    return { kind: "focus", container: target.container, tabId, preventDefault: true };
}

export interface MoveContext {
    readonly rows: readonly ContainerRow[];
    readonly current: ContainerId | null;
}

export type MoveOutcome = {
    readonly kind: "blocked";
    readonly reason: "no-neighbor" | "layout-model-cannot-move";
    readonly preventDefault: false;
};

/**
 * `Ctrl+Alt+ArrowLeft|Right|Down`（跨组移动 / 新建组）的判定。
 *
 * <p>**今天恒为 blocked，且这是有意的**：默认路径（手写 dock）的容器归属是
 * **`containerOf(tabId)` 的纯函数**（`lib/containers.ts`：`DOCK_TAB_IDS` ⇒ right，其余 ⇒ main；`D-1777`/`D-1778`），
 * 也就是「这个面板属于哪个容器」**不是可写状态** ⇒ 跨组移动在这个模型里**不可表达**。
 * 能表达它的是 S2c 的 `panels[].groups`（`workspace-shell-refresh-design.md` §3.4.2/§5），
 * 所以本卡只把**判定与理由**落地，键位与 UI 等模型到位再接线。</p>
 *
 * <p>为什么现在就要这个函数：`D-1600` ③ 要求「无相邻组 ⇒ 置灰 + 播报，不做静默 no-op」。
 * 静默 no-op 与「没实现」不可区分，正是本卡现象（按了没反应）的成因。把理由做成返回值，
 * 调用方就**必须**给用户一句话，而不是什么都不发生。</p>
 *
 * <p>`Ctrl+Alt+Arrow*` 与 CodeMirror `defaultKeymap` 的关系（`D-1600` ①）：编辑器里
 * `Ctrl-Alt-ArrowUp/Down` = `addCursorAbove/Below`，所以这些键**只在页签行内**由我们接管；
 * 焦点在编辑器时不进这个函数。</p>
 */
export function resolveMoveKey(direction: MoveDirection, context: MoveContext): MoveOutcome {
    void direction;
    const rows = focusableRows(context.rows);
    if (rows.length <= 1) return { kind: "blocked", reason: "no-neighbor", preventDefault: false };
    return { kind: "blocked", reason: "layout-model-cannot-move", preventDefault: false };
}

/**
 * task-174 / `D-1545`：**按形态筛出要渲染的行**（可见性只影响渲染，不影响归属）。
 *
 * <p>用户裁定原文：「两栏仍然是两栏，只是同时间只能显示单栏，可以进行切换」。所以：
 * 桌面 ⇒ 全部行；窄屏 ⇒ 恰一个（`activeColumn` 指向的那一栏），而**归属不变** ——
 * 这条与 `containerOf` 的纯函数性是一对：`containerOf` 保证「页签不搬家」，
 * 本函数保证「不渲染 ≠ 不存在」。</p>
 *
 * <p>为什么要成一个函数而不是在模板里 `filter`：`D-1544` 第 3 条禁止模板自己判宽度/形态，
 * 且这里有「空行不参与键盘遍历」的既有语义（`focusableRows`）——两件事分开测才不会互相掩盖。</p>
 */
export function rowsForMode<T extends ContainerRow>(
    rows: readonly T[],
    mode: ContainerMode,
    activeColumn: ActiveColumn,
): readonly T[] {
    const visible = visibleContainers(mode, activeColumn);
    return rows.filter((row) => visible.includes(row.container));
}
