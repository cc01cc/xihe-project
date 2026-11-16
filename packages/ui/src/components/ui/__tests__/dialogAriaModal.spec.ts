import { afterEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { i18n } from "../../../i18n";
import Dialog from "../dialog/Dialog.vue";
import DialogContent from "../dialog/DialogContent.vue";
import DialogScrollContent from "../dialog/DialogScrollContent.vue";
import DialogTitle from "../dialog/DialogTitle.vue";
import AlertDialog from "../alert-dialog/AlertDialog.vue";
import AlertDialogContent from "../alert-dialog/AlertDialogContent.vue";
import AlertDialogTitle from "../alert-dialog/AlertDialogTitle.vue";
import Sheet from "../sheet/Sheet.vue";
import SheetContent from "../sheet/SheetContent.vue";
import SheetTitle from "../sheet/SheetTitle.vue";

/**
 * task-49 第二批：`aria-modal` 必须**条件**产出 —— 默认模态输出 `"true"`，
 * `:modal="false"`（非模态、允许与背景并行操作）**不输出**该属性。
 *
 * <p>为什么这条负例必须存在：无条件写 `"true"` 也能让正例全绿，但那只是把一个错误约定
 * 换成另一个错误约定 —— 非模态弹层会向读屏器宣称「背景惰性」，而用户明明能操作背景。
 * **正例证明补上了，负例证明没有说谎。**</p>
 */
function mountTree(component: ReturnType<typeof defineComponent>) {
    return mount(component, { attachTo: document.body, global: { plugins: [i18n] } });
}

const content = (slot: string) =>
    document.body.querySelector(`[data-slot="${slot}"]`) as HTMLElement | null;

afterEach(() => {
    document.body.innerHTML = "";
});

describe("vendor 弹层容器的 aria-modal 条件产出（task-49）", () => {
    it("DialogContent：默认（modal 未设 ⇒ true）输出 aria-modal=true", async () => {
        const wrapper = mountTree(
            defineComponent({
                render: () =>
                    h(Dialog, { open: true }, () =>
                        h(DialogContent, null, () => h(DialogTitle, null, () => "标题")),
                    ),
            }),
        );
        await flushPromises();

        expect(content("dialog-content")?.getAttribute("aria-modal")).toBe("true");
        wrapper.unmount();
    });

    it("DialogContent：:modal=false ⇒ **不输出**该属性（负例，防「换了个约定」）", async () => {
        const wrapper = mountTree(
            defineComponent({
                render: () =>
                    h(Dialog, { open: true, modal: false }, () =>
                        h(DialogContent, null, () => h(DialogTitle, null, () => "标题")),
                    ),
            }),
        );
        await flushPromises();

        const el = content("dialog-content");
        expect(el, "非模态弹层也要渲染出来（否则这条测的是空）").toBeTruthy();
        expect(el!.hasAttribute("aria-modal")).toBe(false);
        wrapper.unmount();
    });

    it("DialogContent：调用点显式写的 aria-modal 在非模态时也被原语收回（原语权威）", async () => {
        const wrapper = mountTree(
            defineComponent({
                render: () =>
                    h(Dialog, { open: true, modal: false }, () =>
                        h(DialogContent, { "aria-modal": "true" }, () =>
                            h(DialogTitle, null, () => "标题"),
                        ),
                    ),
            }),
        );
        await flushPromises();

        expect(content("dialog-content")!.hasAttribute("aria-modal")).toBe(false);
        wrapper.unmount();
    });

    /**
     * DialogScrollContent 的**内层内容嵌在 `DialogOverlay` 里**（vendored 结构：
     * `<DialogPortal><DialogOverlay><DialogContent>…`）⇒ 非模态时 reka 不渲染 overlay，
     * 连带整块内容都不渲染。这不是本卡引入的：这条用例把该约束**钉住**，免得以后有人以为
     * 「非模态 ScrollContent 没输出 aria-modal」是漏了属性，实际是它压根不渲染。
     */
    it("DialogScrollContent：模态时输出 true；非模态本就整块不渲染（结构约束）", async () => {
        const modalWrapper = mountTree(
            defineComponent({
                render: () =>
                    h(Dialog, { open: true }, () =>
                        h(DialogScrollContent, null, () => h(DialogTitle, null, () => "标题")),
                    ),
            }),
        );
        await flushPromises();
        // 它没给内层 DialogContent 加 data-slot ⇒ 按角色取（reka 设 role=dialog）。
        const el = document.body.querySelector('[role="dialog"]') as HTMLElement;
        expect(el).toBeTruthy();
        expect(el.getAttribute("aria-modal")).toBe("true");
        modalWrapper.unmount();
        document.body.innerHTML = "";

        const nonModalWrapper = mountTree(
            defineComponent({
                render: () =>
                    h(Dialog, { open: true, modal: false }, () =>
                        h(DialogScrollContent, null, () => h(DialogTitle, null, () => "标题")),
                    ),
            }),
        );
        await flushPromises();
        expect(
            document.body.querySelector('[role="dialog"]'),
            "非模态时 overlay 不渲染 ⇒ 嵌在 overlay 里的内容也不渲染",
        ).toBeNull();
        nonModalWrapper.unmount();
    });

    it("AlertDialogContent：永远 true（AlertDialogRoot 硬编码 modal: true）", async () => {
        const wrapper = mountTree(
            defineComponent({
                render: () =>
                    h(AlertDialog, { open: true }, () =>
                        h(AlertDialogContent, null, () => h(AlertDialogTitle, null, () => "标题")),
                    ),
            }),
        );
        await flushPromises();

        expect(content("alert-dialog-content")?.getAttribute("aria-modal")).toBe("true");
        wrapper.unmount();
    });

    it("SheetContent：默认 true，modal=false 不输出", async () => {
        for (const modal of [true, false]) {
            const wrapper = mountTree(
                defineComponent({
                    render: () =>
                        h(Sheet, { open: true, modal }, () =>
                            h(SheetContent, null, () => h(SheetTitle, null, () => "标题")),
                        ),
                }),
            );
            await flushPromises();
            const el = content("sheet-content")!;
            expect(el.hasAttribute("aria-modal"), `modal=${modal}`).toBe(modal);
            wrapper.unmount();
            document.body.innerHTML = "";
        }
    });
});
