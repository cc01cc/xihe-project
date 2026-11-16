import { describe, it, afterEach, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { i18n } from "../../../../i18n";
import { expectModalDialog } from "../../../../test-utils/modalDialog";
import CheckpointDialogShell from "../components/CheckpointDialogShell.vue";

/**
 * task-49：`CheckpointDialogShell` 是「一套内容、两套容器」的响应式外壳 —— 桌面走 vendor
 * `DialogContent`、移动走 vendor `SheetContent`。**两者都是 reka 的 Dialog 原语**，都**不产**
 * `aria-modal`（源码只设 aria-labelledby/describedby）⇒ 两支各补一次，缺一支就等于「只有在
 * 手机上读屏破功」，这种半修比不修更难发现。
 *
 * <p>为什么必须有这条断言：本组件此前**没有任何 spec 覆盖**（`checkpoint-dialog` 这个 testid
 * 在全仓 spec 里从未出现），所以它的对话框语义是「谁都没读过」的状态。</p>
 */
function stubViewport(isMobile: boolean) {
    vi.stubGlobal("matchMedia", (query: string) => ({
        matches: isMobile ? query.includes("max-width: 767px") : false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    }));
}

function mountShell() {
    return mount(CheckpointDialogShell, {
        props: { show: true, title: "回到这个检查点？", description: "之后的消息会被丢弃。" },
        attachTo: document.body,
        global: { plugins: [i18n] },
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
});

describe("CheckpointDialogShell 的模态语义（task-49）", () => {
    it("桌面支（DialogContent）带 role/aria-modal，名字来自 DialogTitle", async () => {
        stubViewport(false);
        const wrapper = mountShell();
        await flushPromises();

        expectModalDialog("checkpoint-dialog", "dialog", "回到这个检查点？");
        wrapper.unmount();
    });

    it("移动支（SheetContent）同样带 role/aria-modal，名字来自 SheetTitle", async () => {
        stubViewport(true);
        const wrapper = mountShell();
        await flushPromises();

        expectModalDialog("checkpoint-dialog-mobile", "dialog", "回到这个检查点？");
        wrapper.unmount();
    });
});
