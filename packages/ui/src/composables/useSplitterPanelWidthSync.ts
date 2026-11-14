import { watch, type Ref } from "vue";

/**
 * store → splitter 面板 的宽度通道（task-2 / 原 task-613）。
 *
 * 为什么要有这个件，而不是在组件里写一个 inline watch：
 * 这条通道的三条判据（拖拽期不写回 / 折叠态不写回 / 组宽变化按 px 重算）**全部是"不该发生的事"**——
 * 只靠 e2e 的绿读数，没法把「没触发」与「触发了但没造成可见差异」区分开（D-1423 同族：读数 0 要能
 * 区分没失败与没接线）。抽出来的唯一目的是让这三条能**数调用次数**地被钉住；它只有一个消费者
 * （WorkspaceWorkbench 的文件树 panel），没有第二个实现，也不承担别的职责。被否决的更简方案 =
 * 组件内 inline watch：单测无从取到，只能靠 e2e 行为间接证明，注入型反例（拖拽中写 store）写不出来。
 *
 * 语义（[实测] 见 `__tests__/useSplitterPanelWidthSync.spec.ts`）：
 * - `width` 变化 ⇒ 把该 px 宽度应用给面板（release/keyboard/dblclick 之外的通用通道：外部改 store、
 *   clamp 取整、迁移都靠这条）；
 * - `groupSize` 变化 ⇒ 也应用一次：reka 侧收/发**百分比**，px→% 的基数就是组宽；组宽在挂载期会变长
 *   （宿主链 `transition-[flex-grow] duration-300`，实测 410→1158），用未稳组宽算出的 % 在组宽变大后
 *   不再等于存储 px（实测修掉每帧写回后 reload 渲染成 207px 而 store 是 200）——这条同时是
 *   「持久化是 px」契约的落点；
 * - `isDragging` 为真 ⇒ 一律不应用。**结构上**拖拽期 store 根本不写（commit 只在 release/键盘/双击），
 *   这条是兜底：将来若有人在拖拽中写 store，也不能回灌成「自我强写」循环（那正是本 bug 的形态）；
 * - `isCollapsed()` 为真 ⇒ 不应用：折叠由 reka 的 `collapse()` 管，写回展开宽会把 rail 顶掉。
 *
 * **误差契约（B 方案登记，task-28 / Lead 台账 2026-11-15）**：`store px → 渲染 px 的误差 ≤1%+1px；折叠档 ≤2.5%；禁止对渲染宽断言整数。`
 * 原因：reka 侧收/发的是**百分比**（内联 `flex: <p> 1 0px`），px→% 必然量化；resize handle 的 `-ml-1`
 * 参与 grow 分配 ⇒ 渲染宽与存储 px 不是恒等关系。**折叠档与展开档不同源，不许合成一个数**：
 * `data-state=collapsed` 时 layout 只有 4.44%，同一份绝对误差在 40px 上被放大到 ~2.4%（展开档 0.1–0.5%）。
 * 五档读数（1024/1280/1440/1600/1920）与被证伪的三条假设见 task-28；判据出处**唯一**在
 * `DEV-011 §6.2`（zh/en 两语同条），spec 侧只许写指针，不许抄第二版。
 */
export interface SplitterPanelWidthSyncOptions {
    /** 存储侧宽度（px），唯一事实源。 */
    width: Ref<number>;
    /** %→px 的换算基数（组宽，px）。 */
    groupSize: Ref<number>;
    /** 拖拽进行中（bridge 的 `resizing`）。 */
    isDragging: Ref<boolean>;
    /** 折叠态判定（折叠宽度由 reka 的 collapse 管，不走这条通道）。 */
    isCollapsed: () => boolean;
    /** 把 px 宽度应用给面板（bridge 的 `resizeToWidth`）。 */
    apply: (widthPx: number) => void;
}

export function useSplitterPanelWidthSync(options: SplitterPanelWidthSyncOptions): void {
    const { width, groupSize, isDragging, isCollapsed, apply } = options;
    watch(
        [width, groupSize],
        ([nextWidth]) => {
            if (isDragging.value || isCollapsed()) return;
            apply(nextWidth);
        },
        { flush: "post" },
    );
}
