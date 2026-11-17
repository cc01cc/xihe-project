import { onBeforeUnmount, ref, watch, type Ref } from "vue";

import { logger } from "../lib/logger";

/**
 * PLAN-0753 T3: integration layer between reka's Splitter primitives and our
 * hand-rolled resize contracts (PLAN-0626 one-frame-behind fix, PLAN-0582
 * persistence, DEV-011 keyboard discipline). reka owns the flex layout and the
 * pointer drag; this bridge keeps OUR invariants on top of it:
 *
 * - the store/persistence sees exactly one write: on pointer release (from
 *   getSize(), the ground truth), or immediately for keyboard/double-click
 *   (we know the width we requested);
 * - `@resize` events never commit by themselves - during a drag they only feed
 *   the imperative width bubble (no reactive write per pointer move), and
 *   constraint-driven re-inits stay display-only (clamps must not write back);
 * - keyboard keys are routed by the consumer (verbatim parity with the old
 *   handlers) through a capture-phase listener on the SplitterGroup ancestor;
 *   preventDefault stops reka's percent-based internal resize (ruling ①);
 * - collapse()/expand() bridge navOpen/navYielded-style state machines without
 *   touching min constraints (collapse may go below minSize by design); they are
 *   gated on layoutReady **exactly like resizeToWidth** (task-147: reka's
 *   collapsePanel asserts on a layout it has not initialized yet) and replayed in
 *   order once the first @resize proves the layout exists;
 * - viewport changes re-issue resize(displayClamp(userWidth)) - ruling ③'s
 *   watcher - so a display clamp crossing never lands in the store.
 */
export interface SplitterPanelBridgeOptions {
    /** Stored-width clamp (rounds + bounds); applied to keyboard/dblclick/release. */
    clamp: (width: number) => number;
    /** Ground-truth committed width read for keyboard Home/End and watchers. */
    currentWidth: () => number;
    /** Store write: pointer release, keyboard and double-click only. */
    commit: (width: number) => void;
    /** Double-click reset target (stored width). */
    defaultWidth: number;
    /** Keyboard map: consumer returns the next stored width or null to ignore. */
    onKeyResize: (key: string) => number | null;
    /** Element px -> stored width (Sidebar adds a fixed icon rail). */
    toWidth?: (px: number) => number;
    /** Stored width -> element px. */
    toPx?: (width: number) => number;
    /** Display-only viewport clamp; its result never reaches commit. */
    displayResize?: (width: number, viewportWidth: number) => number;
    /** Viewport width source for the display-clamp watcher. */
    viewportWidth?: Ref<number>;
    /** Live width bubble; its text is written imperatively during drags. */
    bubble?: Ref<HTMLElement | null>;
    /**
     * task-94 (B): 面板在 reka 里的尺寸单位换算。默认 `px`（内部 group 曾用 px）。
     * 内层 group 现在用 **百分比**：组里只要有 px 面板且首次测量拿不到 groupSize，
     * reka 的 `convertPanelConstraintsToPercent` 就返回 null（`units.ts:29-38`）⇒ `layout`
     * 永远初始化不了 ⇒ 重渲染期 `isPanelCollapsed → getPanelSize` 断言。
     * 因此 reka 侧一律收/发 %，**持久化仍是 px**：两个方向都经由这里换算，
     * 产品语义（用户设定的像素宽度、min/max/collapsed 也都是 px）不丢。
     */
    sizeUnit?: { toPx: (value: number) => number; fromPx: (px: number) => number };
    /** The resize handle id whose keys this bridge routes (fallthrough `id`). */
    handleId: string;
    /** Skip keyboard routing when the panel is collapsed (handle is v-if'd away). */
    isCollapsed?: () => boolean;
}

/** Exposed shape of reka's SplitterPanel (subset we drive). */
export interface SplitterPanelExposed {
    collapse: () => void;
    expand: () => void;
    resize: (size: number) => void;
    isCollapsed: () => boolean;
    isExpanded: () => boolean;
}

const RESIZE_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

/**
 * 就绪前积压的**命令式意图**。三种形态共用**一条有序队列**（而不是 width / transition
 * 两条队列），理由见 `enqueue` 的注释。
 */
type PanelIntent = { kind: "resize"; width: number } | { kind: "collapse" } | { kind: "expand" };

export function useSplitterPanelBridge(options: SplitterPanelBridgeOptions) {
    const panelRef = ref<SplitterPanelExposed | null>(null);
    /** Start/end only: toggles the bubble and is-resizing; never tracks the pointer. */
    const resizing = ref(false);
    let draggingActive = false;
    /** 本次拖拽中 reka 最后报出的元素像素宽（release 用它，不回读 getSize，见 onResize 注释）。 */
    let lastDragPx: number | null = null;

    function pxToWidth(px: number): number {
        return options.toWidth ? options.toWidth(px) : px;
    }

    function widthToPx(width: number): number {
        return options.toPx ? options.toPx(width) : width;
    }

    /** reka 报出的尺寸 → 元素像素；percent 组按当前组宽折算。 */
    function reportedPx(size: number): number {
        return options.sizeUnit ? options.sizeUnit.toPx(size) : size;
    }

    /**
     * reka 的 layout 何时才算可用：**它自己报过一次尺寸**才为 true。
     *
     * <p>依据（vendor 源码，不是我们的假设）：`SplitterGroup.js:202-232` 初始化 layout 后调用
     * `callPanelCallbacks`，而 `utils/callPanelCallbacks.js:14-17` 在
     * `lastNotifiedSize == null`（首帧必然如此）时**必调** `onResize` ⇒ 宿主只要绑了
     * `@resize`（本仓两处消费者都绑了：`WorkspaceWorkbench.vue` 的树面板、
     * `AppLayout.vue` 的导航面板），首帧就一定有一次就绪信号。</p>
     *
     * <p>为什么必须有这道门：`SplitterPanel.resize()` 在 layout 还没初始化时走
     * `SplitterGroup.js:315-316` 的 `assert(panelSize != null)` **硬抛**（`utils/assert.js:5`），
     * 在 `:ref` 投递后的 nextTick 里调用它会变成一条未处理的 Promise rejection
     * （task-51 实测 3 条）。**collapse()/expand() 是同一道门**（task-147）：`collapsePanel`
     * 在 `SplitterGroup.js:383` 对同一个 `panelSize` 断言，而从 `AppLayout.vue` 的 watcher
     * 抛出去就是整页崩（那正是「pinned 右栏 + 会话列让位」的必经时序）。vendor 不提供
     * `isLayoutReady`，只在文档里写「resize(1-100)」（`docs/content/meta/SplitterPanel.md`）
     * —— 所以就绪判据只能由我们按上面那条 vendor 事实来定，且三条入口必须共用它。</p>
     */
    const layoutReady = ref(false);
    /**
     * 就绪前积压的意图，**有序**（见 `enqueue` / `flushPendingIntents`）。
     *
     * <p>task-147：这个槽原先只装宽度（`pendingWidth: number | null`，单槽后写覆盖）。
     * collapse()/expand() 当时**没过这道门**，而它们在 layout 未初始化时调
     * `SplitterGroup.js:377-405` 的 `collapsePanel`，那里的
     * `assert(panelSize != null, 'Panel size not found')` 取的是 `layout[panelIndex]`
     * （`panelDataHelper`，同文件 `:488-500`）—— layout 还没初始化时它是 `undefined` ⇒
     * **硬抛**。触发路径是 pinned 右栏把主列挤到 <640/720，工作台的既测量值让会话列
     * （本面板）让位 ⇒ `navPanelCollapsed` 翻转 ⇒ `AppLayout.vue` 的 watch 在我们的
     * 首帧 `@resize` 之前就调了 collapse()（实测 1280/1440/1455 崩，1460 不崩）。</p>
     */
    const pendingIntents: PanelIntent[] = [];
    /** 排队深度（给调用方/测试读的投影；`layoutReady` 是唯一真相，这个只是它的影子）。 */
    const pendingCount = ref(0);
    /**
     * **合并**计数：排队值被新值取代。这是**正常路径**（viewport 连续变化 / DevTools 开合都会发生），
     * 所以只计数、不告警，且**不参与**「正常路径恒 0」这条不变量。
     */
    const coalesced = ref(0);
    /**
     * **真丢弃**计数：意图消失了。只有两条路径 —— ①卸载时仍有排队；②就绪态调用但面板引用已释放。
     * 正常路径**恒 0**（这是可被测试断言的产品不变量），每条都 `console.warn` 一次（下面门控）。
     */
    const dropped = ref(0);
    /** 一次性告警门控：多次 mount 最坏 N 条 warn，不刷屏。 */
    let warnedDrop = false;

    function warnDrop(reason: string): void {
        dropped.value += 1;
        if (warnedDrop) return;
        warnedDrop = true;
        logger.warn(
            "[splitter-bridge] " +
                options.handleId +
                ": " +
                reason +
                "；本次意图被丢弃（累计 " +
                dropped.value +
                " 次）",
        );
    }

    /**
     * 唯一真正调用 reka 的地方。
     *
     * <p>收敛之前这条调用散在 4 处（`resizeToWidth` / 键盘 / 双击 / viewport watcher），
     * 修一个 bug 要同时想到 4 个入口 —— 收敛成一条路之后，「什么时候允许调 reka」只需要在这里判。</p>
     *
     * <p>**不判 `isCollapsed`**：三个调用方各自已判（`onDblclick` / `onKeydownCapture` /
     * viewport watcher 都先 `return`），在这里再判会把「折叠态本来就不该 resize」记成丢弃，
     * 反而污染 `dropped` 的不变量。</p>
     */
    function applyResize(width: number): void {
        const panel = panelRef.value;
        if (!panel) {
            warnDrop("面板引用已释放");
            return;
        }
        const px = widthToPx(width);
        panel.resize(options.sizeUnit ? options.sizeUnit.fromPx(px) : px);
    }

    /** 折叠/展开的唯一出口：与 applyResize 同口径——引用不在就记丢弃，绝不静默。 */
    function applyTransition(kind: "collapse" | "expand"): void {
        const panel = panelRef.value;
        if (!panel) {
            warnDrop("面板引用已释放");
            return;
        }
        if (kind === "collapse") panel.collapse();
        else panel.expand();
    }

    /** 执行一条意图（就绪后的公共出口；排队与直通走同一份代码）。 */
    function applyIntent(intent: PanelIntent): void {
        if (intent.kind === "resize") applyResize(intent.width);
        else applyTransition(intent.kind);
    }

    function syncPendingCount(): void {
        pendingCount.value = pendingIntents.length;
    }

    /**
     * 就绪前入队。
     *
     * <p>**一条有序队列，不是 width / transition 两条队列**（task-147 的判据）：</p>
     * <ul>
     *   <li><b>跨类别的顺序是语义，不是实现细节。</b> `AppLayout.vue` 在展开时先
     *       `expand()` 再 `resizeToWidth(effectiveNavWidth)`——reka 的 `expandPanel` 会
     *       用 `panelSizeBeforeCollapseRef` 的旧尺寸**覆盖**布局（`SplitterGroup.js:407-435`），
     *       所以那条 resize 必须落在 expand **之后**；反过来「先夹取宽度、再因让位折叠」
     *       要求 resize 落在 collapse **之前**。任何固定的「先刷宽度再刷状态」或反向顺序
     *       都会把其中一个方向做错 ⇒ 只有按调用顺序重放才对。</li>
     *   <li><b>宽度可以合并，状态转移不可以。</b> 宽度是绝对值：被后写覆盖不改变语义
     *       （只记 `coalesced`）。折叠/展开是**状态转移**：`collapse → expand → collapse`
     *       一旦被合并成「最后一笔」或「净效果」，中间那次 expand 就不再发生，而
     *       `panelSizeBeforeCollapseRef` 的记账、以及它对**后续宽度**的影响都跟着变
     *       （expand 之后的 resize 才是生效的那笔）⇒ 会翻转最终态。所以转移一律 1:1 入队。</li>
     *   <li>合并只发生在**相邻且同类**的情形：队尾也是 resize 才替换（见下）。被转移隔开的
     *       两笔宽度**不合并**——它们的相对位置就是语义。</li>
     * </ul>
     */
    function enqueue(intent: PanelIntent): void {
        const tail = pendingIntents[pendingIntents.length - 1];
        if (intent.kind === "resize" && tail?.kind === "resize") {
            // 覆盖不是「合并」：上一笔意图还没落地就被新值取代 —— 对宽度语义无害（绝对值），
            // 但它**不是丢弃**（意图被更新仍是意图），所以进 coalesced 而不进 dropped。
            pendingIntents[pendingIntents.length - 1] = intent;
            coalesced.value += 1;
            syncPendingCount();
            return;
        }
        pendingIntents.push(intent);
        syncPendingCount();
    }

    /**
     * 按序重放：逐条 `shift` 出来再执行。用 `while` 而不是「先 copy 再 forEach」是因为
     * 执行中若再入队（当前无此路径——执行走的是就绪态直通，不会回到 `enqueue`）也同批处理，
     * 不会留下永不复种的尾巴。`markLayoutReady` 先置位再 flush，因此重放本身不会再入队 ⇒
     * 循环必然收敛。
     */
    function flushPendingIntents(): void {
        while (pendingIntents.length > 0) {
            const intent = pendingIntents.shift() as PanelIntent;
            syncPendingCount();
            applyIntent(intent);
        }
    }

    /** 首帧尺寸到达 ⇒ layout 已初始化，按序补上积压的意图。 */
    function markLayoutReady(): void {
        if (layoutReady.value) return;
        layoutReady.value = true;
        flushPendingIntents();
    }

    function onResize(size: number): void {
        // 就绪信号必须在 draggingActive 早退**之前**接上：非拖拽期的首帧 @resize 正是 layout
        // 初始化那一次，放在后面就永远等不到就绪（实测：放后面时排队永不 flush）。
        markLayoutReady();
        if (!draggingActive) return;
        // reka 的 @resize 就是它自己对这一帧的最终值（px 组=像素、% 组=百分比，都已过约束夹取），
        // 因此 release 沿用它即可 —— 不再回读 getSize()。BL-562 的根因就在这里：
        // getSize() 会 assert(layout[panelIndex] != null)，而 reka 的 "drag 结束" 事件可以在
        // 「group 还没量到几何 / 布局尚未重算」的窗口里到达（实测：在 handle 命中区内按下即抬起、
        // 一次 resize 都没有，也会走 dragging(true) → dragging(false)），此时 layout 里没有该面板，
        // vendor 断言直接抛未捕获错误。用「本帧自己报的值」把这条依赖整段拿掉。
        const px = reportedPx(size);
        lastDragPx = px;
        // Pointer path only: bubble imperative, no reactive write, no commit.
        const bubble = options.bubble?.value;
        if (bubble) bubble.textContent = `${pxToWidth(px)}px`;
    }

    function onDragging(active: boolean): void {
        if (active === draggingActive) return;
        draggingActive = active;
        resizing.value = active;
        if (active) {
            lastDragPx = null;
            return;
        }
        const bubble = options.bubble?.value;
        if (bubble) bubble.textContent = "";
        const reported = lastDragPx;
        lastDragPx = null;
        // 一次 resize 事件都没收到 ⇒ 这不是一次真实拖拽（命中区内按下即抬起，或几何还没量到）。
        // 没拖过就没有新宽度可写：既不读面板尺寸，也不写 store（写进去只会是脏值）。
        if (reported === null || options.isCollapsed?.()) return;
        // Release: one store write, same tick as the bubble drop so Vue batches
        // the render (useLiveResize release rule).
        options.commit(options.clamp(pxToWidth(reported)));
    }

    /**
     * Capture-phase listener for the SplitterGroup ancestor: preventDefault stops
     * reka's internal percent-based keyboard resize (its listener checks
     * defaultPrevented first), then we resize imperatively and commit immediately.
     */
    function onKeydownCapture(event: KeyboardEvent): void {
        if (event.defaultPrevented || !RESIZE_KEYS.has(event.key)) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const handle = target.closest("[data-panel-resize-handle-id]");
        if (!handle || handle.getAttribute("data-panel-resize-handle-id") !== options.handleId)
            return;
        if (options.isCollapsed?.()) return;
        const next = options.onKeyResize(event.key);
        if (next === null) return;
        event.preventDefault();
        const clamped = options.clamp(next);
        resizeToWidth(clamped);
        options.commit(clamped);
    }

    /**
     * 三个命令式入口的返回值统一是「这一笔**此刻**是否已经落到 reka」：
     * `true` = 已生效；`false` = 已排队（等首帧 @resize 后按序重放）。
     *
     * <p>为什么不返回 void：task-147 之前调用方（`AppLayout.vue` 的 watch）在未就绪时
     * 什么也拿不到，于是「调过了」被当成「做完了」。排队不等于吞掉——它必须有 flush 时机
     * （首帧 @resize），且调用方要能分辨两者；`pendingCount` / `layoutReady` 提供同一事实的
     * 响应式投影。</p>
     */
    function resizeToWidth(width: number): boolean {
        if (!layoutReady.value) {
            enqueue({ kind: "resize", width });
            return false;
        }
        applyResize(width);
        return true;
    }

    function onDblclick(): void {
        if (options.isCollapsed?.()) return;
        const width = options.clamp(options.defaultWidth);
        resizeToWidth(width);
        options.commit(width);
    }

    /**
     * 折叠：与 `resizeToWidth` **同口径** gate `layoutReady`（task-147）。
     *
     * <p>为什么不能「就绪前先调，崩了再说」：未初始化时 reka 的 `collapsePanel` 走
     * `assert(panelSize != null)`，在 watcher 里抛出的错误会冒到 Vue 的错误处理，
     * 整块壳跟着挂（实测 pageerror + console error 各一条）。这不是「偶发」，是
     * 「pinned 右栏 + 会话列让位」这条路的**必经**时序。</p>
     */
    function collapse(): boolean {
        if (!layoutReady.value) {
            enqueue({ kind: "collapse" });
            return false;
        }
        applyTransition("collapse");
        return true;
    }

    /** 展开：与 `collapse` 同一道门、同一条队列（顺序由调用方决定，见 `enqueue`）。 */
    function expand(): boolean {
        if (!layoutReady.value) {
            enqueue({ kind: "expand" });
            return false;
        }
        applyTransition("expand");
        return true;
    }

    // Destructured consts keep the narrowing valid inside the watcher callback: an
    // optional property of the options object is NOT narrowed for the closure.
    const { viewportWidth, displayResize } = options;
    if (viewportWidth && displayResize) {
        watch(viewportWidth, (vw) => {
            if (draggingActive || options.isCollapsed?.()) return;
            // Ruling ③: constraint/viewport crossings re-initialize defaultSize;
            // re-issue the user's width clamped for display, never committed.
            // 收敛到 resizeToWidth：viewer 变化同样要考虑「layout 还没就绪」的窗口，
            // 且它在 percent 组里必须走 sizeUnit 换算（原先直接传 px，percent 组会写成 px）。
            resizeToWidth(displayResize(options.currentWidth(), vw));
        });
    }

    // 卸载时还有排队 ⇒ 意图消失（不是合并），必须响亮地记一次再清槽。
    // warn 只出一条（`warnDrop` 的一次性门控），`dropped` 按**笔数**如实计。
    onBeforeUnmount(() => {
        if (pendingIntents.length === 0) return;
        const lost = pendingIntents.length;
        pendingIntents.length = 0;
        syncPendingCount();
        for (let index = 0; index < lost; index += 1) {
            warnDrop("layout 始终未就绪，排队的意图从未生效");
        }
    });

    return {
        panelRef,
        resizing,
        /** reka 是否已报过一次尺寸（= layout 已初始化）；未就绪时三条命令式入口只排队。 */
        layoutReady,
        /** 排队深度（`layoutReady` 的影子；调用方据此判断「还没落地」而不是「已经做完」）。 */
        pendingCount,
        /** 合并计数（正常路径可 >0，不参与不变量）。 */
        coalesced,
        /** 真丢弃计数（正常路径恒 0；测试可直接断言）。 */
        dropped,
        onResize,
        onDragging,
        onKeydownCapture,
        onDblclick,
        resizeToWidth,
        collapse,
        expand,
    };
}
