import { computed, ref } from "vue";
import { injectDialogRootContext } from "reka-ui";

/**
 * task-49 第二批：给本仓的 vendor 弹层容器（`DialogContent` / `DialogScrollContent` /
 * `AlertDialogContent` / `SheetContent`）**条件**产出 `aria-modal`。
 *
 * <h3>为什么不是写死 `aria-modal="true"`</h3>
 * <p>`aria-modal="true"` 的意思是「弹层之外的内容对 AT 惰性」。reka-ui 的
 * `DialogContentImpl` 只设 `aria-labelledby` / `aria-describedby`，**不产** `aria-modal`
 * （[源码] `dist/Dialog/DialogContentImpl.js`）。若我们在原语里无条件补 `"true"`，将来真出现
 * `<Dialog :modal="false">`（非模态、允许与背景并行操作）时，这个属性就会**说谎** —— 读屏器会
 * 把用户明明能操作的背景当成惰性，比不写更糟。所以固定：`modal === false` ⇒ **不输出该属性**，
 * 其余（默认 modal=true）⇒ `"true"`。</p>
 *
 * <h3>标志从哪里来（不猜、不用 useAttrs）</h3>
 * <p>`modal` 是 `DialogRoot` 的 prop（默认 `true`），它通过 `DialogRootContext` 下传，
 * 我们用 reka 导出的 `injectDialogRootContext()` 读同一个 context（[源码]
 * `dist/Dialog/DialogRoot.js` 把 `modal` 放进 context）。`AlertDialogRoot` 转发到
 * `DialogRoot` 时**硬编码 `modal: true`**（[源码] `dist/AlertDialog/AlertDialogRoot.js`）
 * ⇒ AlertDialog 永远是模态，走同一条代码路径即可，不需要特例。</p>
 *
 * <p>拿不到 context 时（理论上只有「弹层没挂在任何 Dialog 根内」这一种，那本身就渲染不出来）
 * 用 fallback 当**模态**处理，避免为了一个 a11y 属性把渲染炸掉。</p>
 */
export function useAriaModal() {
    type RootContext = NonNullable<Parameters<typeof injectDialogRootContext>[0]>;
    const root = injectDialogRootContext({ modal: ref(true) } as RootContext);

    return computed(() => (root.modal?.value === false ? undefined : "true"));
}
