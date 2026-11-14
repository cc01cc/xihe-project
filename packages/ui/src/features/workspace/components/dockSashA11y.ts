/**
 * dockview 分隔条（\u0060.dv-sash\u0060）的无障碍适配层。
 *
 * 背景（BL-561，task-326 裁 b）：
 * dockview 8.9.0 的 \u0060.dv-sash\u0060 只有鼠标能力（\u0060cursor: ew-resize\u0060），
 * \u0060role\u0060 / \u0060aria-valuenow\u0060 / \u0060tabindex\u0060 全为 null、不可聚焦、
 * 方向键与 Home/End 不产生任何变化。而 \u0060.dv-tab\u0060 反而是有 \u0060role="tab"\u0060 与
 * \u0060tabindex\u0060 的 —— 所以缺口**只在分隔条**，不是「dockview 没有 a11y」。
 *
 * 本模块**不改 dockview、不改 vendor 样式**：只在渲染出的 \u0060.dv-sash\u0060 外面包一层
 * 键盘契约，形状照抄 \u0060WorkspaceDock.vue\u0060 的 \u0060dock-resizer\u0060
 * （\u0060role="separator"\u0060 + 方向键 ±step + Home/End 到边界 + 双击复位），
 * 只把量纲从「dock 整体像素宽」换成「相邻两组之间的占比」。
 *
 * 为什么量纲必须是占比而不是像素：\u0060dock-resizer\u0060 调的是 \u0060dockWidth\u0060（320–480，
 * 有 \u0060xihe-layout-ws:<id>\u0060 持久键）；sash 调的是 dockview 内部两组的分割比例，
 * XH 侧没有对应持久键。两个量纲塞进同一个手柄，\u0060aria-valuenow\u0060 播哪个都会在另一种
 * 操作下变成错值 —— 那是用可访问性缺陷换语义缺陷（裁 b 否决 c 的理由）。
 *
 * 本文件**不 import 任何东西**（不含 Vue、不含 dockview）：
 * 「组宽度是多少、怎么设」由调用方通过 \u0060measure\u0060 / \u0060apply\u0060 注入，
 * 这样键盘逻辑可以在 jsdom 里单测，而「真的改变了布局」由 POC / 真栈量。
 */

/** 与 \u0060WorkspaceDock.vue\u0060 的 \u0060DOCK_WIDTH_KEYBOARD_STEP\u0060 同值：一次按键约等于 16px 的手感。 */
export const SASH_KEYBOARD_STEP_PX = 16;

/** 占比下限：再小就不是分割而是遮挡了。 */
export const SASH_MIN_RATIO = 0.1;
/** 占比上限：对称。 */
export const SASH_MAX_RATIO = 0.9;

/** 单次按键占比增量的下限（容器极宽时 \u0060stepPx/totalPx\u0060 会小到按不动）。 */
const MIN_STEP_RATIO = 0.005;
/** 单次按键占比增量的上限（容器极窄时一次按键会跳掉半屏）。 */
const MAX_STEP_RATIO = 0.25;

export interface SashRatioState {
    /** 当前占比：前一组宽度 / 两组合计宽度，0..1。 */
    ratio: number;
    /** 双击复位的目标占比。 */
    resetRatio: number;
    minRatio: number;
    maxRatio: number;
    /** 单次方向键的占比增量。 */
    stepRatio: number;
}

export function clampRatio(ratio: number, minRatio: number, maxRatio: number): number {
    // 只有 NaN 退回下限；±Infinity 走正常夹取（+∞ → 上限、−∞ → 下限），
    // 否则「远端值」会被当成「不知道」而落到相反的一侧。
    if (Number.isNaN(ratio)) return minRatio;
    return Math.min(maxRatio, Math.max(minRatio, ratio));
}

/**
 * 把「一次按键想走的像素」换成「占比增量」。
 *
 * \u0060totalPx\u0060 不是常量：窗口缩放、侧栏开关都会改变它，所以每次按键都重新算，
 * 不缓存 —— 缓存会让「窗口变宽后按一次跳很远」。
 */
export function stepRatioForWidth(totalPx: number, stepPx: number = SASH_KEYBOARD_STEP_PX): number {
    if (!Number.isFinite(totalPx) || totalPx <= 0) return MIN_STEP_RATIO;
    return Math.min(MAX_STEP_RATIO, Math.max(MIN_STEP_RATIO, stepPx / totalPx));
}

/**
 * 按键 → 新占比。返回值 \u0060null\u0060 表示这个键不归适配层管（不要 \u0060preventDefault\u0060）。
 *
 * 方向约定：**箭头指哪、分隔条就往哪走**。
 * \u0060ArrowLeft\u0060 ⇒ 分隔条左移 ⇒ 前一组变窄 ⇒ 占比减小；
 * \u0060ArrowRight\u0060 ⇒ 后一组变窄 ⇒ 占比增大。
 * 这与 \u0060dock-resizer\u0060 的「ArrowLeft 让 dock 变宽」并不矛盾 —— 那是「让容器变大」，
 * 这是「让分界移动」，两个手柄的物理方向各自符合直觉。
 */
export function nextSashRatio(state: SashRatioState, key: string): number | null {
    const step =
        Number.isFinite(state.stepRatio) && state.stepRatio > 0 ? state.stepRatio : MIN_STEP_RATIO;
    let next: number | null = null;
    if (key === "ArrowLeft") next = state.ratio - step;
    else if (key === "ArrowRight") next = state.ratio + step;
    else if (key === "Home") next = state.minRatio;
    else if (key === "End") next = state.maxRatio;
    if (next === null) return null;
    return clampRatio(next, state.minRatio, state.maxRatio);
}

/** \u0060aria-valuenow\u0060 播报的值：整数百分比，与 \u0060aria-valuemin/max\u0060 同量纲。 */
export function ratioToPercent(ratio: number): number {
    if (Number.isNaN(ratio)) return 0;
    return Math.round(Math.min(1, Math.max(0, ratio)) * 100);
}

export interface DockSashA11yOptions {
    /** separator 的可读名（i18n 由调用方给，本模块不持有文案）。 */
    label: string;
    /** 读当前状态；返回 \u0060null\u0060 表示这条 sash 现在不适合加 a11y（例如组数为 1）。 */
    measure: (sash: HTMLElement) => SashRatioState | null;
    /** 应用新占比。真实布局由调用方设为 \u0060group.api.setSize({ size })\u0060。 */
    apply: (sash: HTMLElement, ratio: number) => void;
    /** 双击复位。缺省时回到 \u0060state.resetRatio\u0060。 */
    reset?: (sash: HTMLElement) => void;
}

/**
 * 固定宽（如折叠成 40px rail）时的区间：min == max == 该固定宽占比。
 *
 * task-538 F2：rail 态曾经沿用展开态的 200–320px 约束 ⇒ `aria-valuenow=5` 小于 `aria-valuemin=25`，
 * 读屏会念「5%，范围 25–40%」—— 一个自相矛盾的播报。区间**必须随折叠态更新**，而不是只在展开态成立。
 */
export function fixedRatioBounds(
    totalPx: number,
    widthPx: number,
): { minRatio: number; maxRatio: number } | null {
    if (!(totalPx > 0) || !(widthPx >= 0)) return null;
    const ratio = Math.min(1, widthPx / totalPx);
    return { minRatio: ratio, maxRatio: ratio };
}

/**
 * 容器 → 一次「重新量并重写 aria」的回调（task-538）。
 *
 * 为什么需要它：首帧装饰发生在 dockview **首轮布局未完成**时（实测树 200 / 主列 98 ⇒ 分母 298，
 * 于是 now=67/min=67/max=100）；布局稳定到 240/558 之后没有任何事件再触发 sync ⇒ 读数错 37 个百分点
 * 且不自愈，直到用户聚焦/按键才纠正。收敛点由调用方给（复用 task-524 的宿主 ResizeObserver），
 * 本模块只负责「再算一次」—— 不新开第二个观察者。
 */
const RESYNC = new WeakMap<HTMLElement, () => void>();

/** 让某容器的 sash a11y 立刻按当前几何重算一次。未 attach 过的容器是 no-op。 */
export function resyncDockSashA11y(container: HTMLElement | null | undefined): void {
    if (!container) return;
    RESYNC.get(container)?.();
}

/** 标记已经装饰过的 sash，避免 MutationObserver 重复挂监听。 */
const DECORATED = "data-dock-sash-a11y";

function orientationOf(sash: HTMLElement): "vertical" | "horizontal" {
    const cls = sash.className;
    // dockview 用 class 区分左右分界与上下分界；判断不出来时按左右（XH 当前只有左右）。
    return /dv-horizontal/.test(cls) ? "horizontal" : "vertical";
}

/**
 * 给容器内所有 \u0060.dv-sash\u0060 挂上键盘契约，返回卸载函数。
 *
 * 用 \u0060MutationObserver\u0060 而不是一次性扫描：dockview 增删组时会重建 sash 节点，
 * 一次扫描会在第一次拖拽分裂后失效（那时用户已经以为能用键盘了）。
 */
export function attachDockSashA11y(
    container: HTMLElement,
    options: DockSashA11yOptions,
): () => void {
    const cleanups = new Map<HTMLElement, () => void>();

    const sync = (sash: HTMLElement): SashRatioState | null => {
        const state = options.measure(sash);
        if (!state) {
            sash.removeAttribute("aria-valuenow");
            sash.removeAttribute("aria-valuemin");
            sash.removeAttribute("aria-valuemax");
            return null;
        }
        sash.setAttribute("role", "separator");
        sash.setAttribute("aria-orientation", orientationOf(sash));
        sash.setAttribute("aria-label", options.label);
        sash.setAttribute("aria-valuemin", String(ratioToPercent(state.minRatio)));
        sash.setAttribute("aria-valuemax", String(ratioToPercent(state.maxRatio)));
        sash.setAttribute("aria-valuenow", String(ratioToPercent(state.ratio)));
        sash.setAttribute("tabindex", "0");
        sash.setAttribute(DECORATED, "true");
        return state;
    };

    const decorate = (sash: HTMLElement) => {
        if (cleanups.has(sash)) return;
        if (!sync(sash)) return;

        const onKeydown = (event: KeyboardEvent) => {
            const state = options.measure(sash);
            if (!state) return;
            const next = nextSashRatio(state, event.key);
            if (next === null) return;
            event.preventDefault();
            options.apply(sash, next);
            // apply 之后重读 —— 布局受最小宽度约束，实际值可能不等于请求值，
            // 播报必须以**实际**为准，否则读屏会说出一个不存在的比例。
            sync(sash);
        };
        const onDblclick = (event: MouseEvent) => {
            event.preventDefault();
            const state = options.measure(sash);
            if (!state) return;
            if (options.reset) options.reset(sash);
            else options.apply(sash, state.resetRatio);
            sync(sash);
        };
        const onFocus = () => sync(sash);

        sash.addEventListener("keydown", onKeydown);
        sash.addEventListener("dblclick", onDblclick);
        sash.addEventListener("focus", onFocus);
        cleanups.set(sash, () => {
            sash.removeEventListener("keydown", onKeydown);
            sash.removeEventListener("dblclick", onDblclick);
            sash.removeEventListener("focus", onFocus);
        });
    };

    const scan = () => {
        container.querySelectorAll<HTMLElement>(".dv-sash").forEach(decorate);
    };

    scan();
    const resync = () => {
        // 先补装饰（新 sash 可能刚被库塞进来），再把**所有已装饰**的 sash 重算一遍：
        // 「已装饰」不等于「读数还对」—— 首帧那次装饰就是对着未完成的布局算的。
        scan();
        cleanups.forEach((_off, sash) => {
            if (sash.isConnected) sync(sash);
        });
    };
    RESYNC.set(container, resync);
    const observer = new MutationObserver(scan);
    observer.observe(container, { childList: true, subtree: true });

    return () => {
        RESYNC.delete(container);
        observer.disconnect();
        cleanups.forEach((off) => off());
        cleanups.clear();
        container.querySelectorAll<HTMLElement>(".dv-sash[" + DECORATED + "]").forEach((sash) => {
            [
                "role",
                "aria-orientation",
                "aria-label",
                "aria-valuemin",
                "aria-valuemax",
                "aria-valuenow",
                "tabindex",
                DECORATED,
            ].forEach((attr) => sash.removeAttribute(attr));
        });
    };
}
