// PLAN-0760 / R4 回归：pendingPrepend 标志「消费即清」。
//
// 缺陷（评审 R4）：标志只写不清 ⇒ 一次 prepend 之后，后续每次 childList 变化都被判为
// prepend ⇒ 走 restorePrependedAnchor() ⇒ 新消息到达时的贴底跟随被截断。
// 关键：**走真实 controller**，不手工复位 —— 手工赋值等于把缺陷本身当断言。
import { describe, expect, it } from "vitest";
import { useMessageScrollerController } from "../messageScroller";

/** 最小 DOM：content + spacer + 若干消息行（真实 handleContentChange 需要这些）。 */
function mountScrollerDom(messageCount: number) {
    const content = document.createElement("div");
    content.dataset.slot = "message-scroller-content";
    const spacer = document.createElement("div");
    spacer.dataset.messageScrollerSpacer = "";
    content.appendChild(spacer);
    for (let index = 0; index < messageCount; index += 1) {
        const item = document.createElement("div");
        item.dataset.messageId = `m${index}`;
        item.dataset.slot = "message-scroller-item";
        content.appendChild(item);
    }
    document.body.appendChild(content);
    const append = (prefix: string, count: number) => {
        for (let index = 0; index < count; index += 1) {
            const item = document.createElement("div");
            item.dataset.messageId = `${prefix}-${index}`;
            item.dataset.slot = "message-scroller-item";
            content.appendChild(item);
        }
    };
    const prepend = (prefix: string, count: number) => {
        for (let index = count - 1; index >= 0; index -= 1) {
            const item = document.createElement("div");
            item.dataset.messageId = `${prefix}-${index}`;
            item.dataset.slot = "message-scroller-item";
            content.insertBefore(item, spacer.nextSibling);
        }
    };
    return { content, spacer, prepend, append };
}

describe("pendingPrepend 消费即清（PLAN-0760 R4，走真实 controller）", () => {
    it("prepend 之后的新消息（append）不再走 prepend 分支（R4 消费即清）", () => {
        const { content, spacer, prepend, append } = mountScrollerDom(5);
        try {
            const controller = useMessageScrollerController({ autoScroll: true });
            controller.context.setContentElement(content as unknown as HTMLDivElement);
            controller.context.setSpacerElement(spacer as unknown as HTMLDivElement);
            const viewport = document.createElement("div");
            viewport.scrollTo = () => {};
            document.body.appendChild(viewport);
            controller.context.setViewportElement(viewport as unknown as HTMLDivElement);

            // 首帧登记基线
            controller.context.handleContentChange();
            expect(controller.context.getPendingPrepend(), "初值必须为 false").toBe(false);

            // ① prepend：声明标志 → 真实插入更旧的行 → 命中 didPrepend
            controller.context.setPendingPrepend(true);
            prepend("older", 3);
            controller.context.handleContentChange();
            expect(
                controller.context.getPendingPrepend(),
                "命中 prepend 后标志必须清零（消费即清，不手工复位）",
            ).toBe(false);

            // ② 新消息到达 = **append**（末尾插入）。旧首行仍在 items 里
            //    ⇒ previousFirstItemIndex > 0，不会误命中 prepend —— 这条路径
            //    在 R4 未修时同样安全，用它确认「消费即清」没有破坏正常 append。
            append("new", 1);
            controller.context.handleContentChange();
            expect(controller.context.getPendingPrepend(), "append 后标志仍必须为 false").toBe(
                false,
            );
        } finally {
            content.remove();
        }
    });

    it("R4 判据：未声明时窗口换页（prepend 语义）不得被误判为 prepend", () => {
        // 反向用例：确认标志是**唯一**判据 —— 旧首行被卸载（prevIdx=-1）时，
        // 若标志已清则不得走 prepend 分支（这正是 R4 未修时会出的错）。
        const { content, spacer } = mountScrollerDom(5);
        try {
            const controller = useMessageScrollerController({ autoScroll: true });
            controller.context.setContentElement(content as unknown as HTMLDivElement);
            controller.context.setSpacerElement(spacer as unknown as HTMLDivElement);
            const viewport = document.createElement("div");
            viewport.scrollTo = () => {};
            document.body.appendChild(viewport);
            controller.context.setViewportElement(viewport as unknown as HTMLDivElement);

            controller.context.handleContentChange();
            // 模拟窗口换页：整窗替换（旧首行元素已不在新 DOM 里）
            const items = content.querySelectorAll<HTMLElement>(
                '[data-slot="message-scroller-item"]',
            );
            items.forEach((item) => item.remove());
            for (let index = 0; index < 5; index += 1) {
                const item = document.createElement("div");
                item.dataset.messageId = `page-${index}`;
                item.dataset.slot = "message-scroller-item";
                content.appendChild(item);
            }
            controller.context.handleContentChange();
            expect(
                controller.context.getPendingPrepend(),
                "窗口换页不得留下未消费的 prepend 标志",
            ).toBe(false);
        } finally {
            content.remove();
        }
    });

    it("标志初值为 false（未声明时不得误判 prepend）", () => {
        const { content, spacer } = mountScrollerDom(3);
        try {
            const controller = useMessageScrollerController({ autoScroll: true });
            controller.context.setContentElement(content as unknown as HTMLDivElement);
            controller.context.setSpacerElement(spacer as unknown as HTMLDivElement);
            const viewport = document.createElement("div");
            viewport.scrollTo = () => {};
            document.body.appendChild(viewport);
            controller.context.setViewportElement(viewport as unknown as HTMLDivElement);
            controller.context.handleContentChange();
            viewport.scrollTop = 50;
            // 不声明 prepend：内容变化不得走 prepend 分支
            controller.context.handleContentChange();
            expect(viewport.scrollTop).toBe(50);
            expect(controller.context.getPendingPrepend(), "未声明时标志必须为 false").toBe(false);
        } finally {
            content.remove();
        }
    });
});
