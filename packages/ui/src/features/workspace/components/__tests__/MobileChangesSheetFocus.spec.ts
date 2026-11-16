import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { i18n } from "../../../../i18n";
import MobileChangesSheet from "../MobileChangesSheet.vue";
import SheetContent from "../../../../components/ui/sheet/SheetContent.vue";

/**
 * task-56（D-1752 / WCAG 2.4.3）：移动 changes/monitor 抽屉关闭后，焦点必须落在**常驻**的
 * `workspace-toolbar-more-mobile`，不能落到 `body`。
 *
 * <p>为什么这条要单独钉：入口在工具条溢出菜单里，`overflowNav()` 选中即关菜单 ⇒ 触发元素被卸载，
 * reka 默认「还给触发器」对已卸载元素是空操作。**只测「抽屉能关」不会红**，必须测 activeElement。</p>
 */
const MORE_TRIGGER = '[data-testid="workspace-toolbar-more-mobile"]';

function mountSheet(tab: "changes" | "monitor") {
    return mount(MobileChangesSheet, {
        props: { open: true, workspaceId: "ws-1", sessionId: "sess-1", tab },
        attachTo: document.body,
        global: {
            plugins: [i18n],
            // 面板体与本判据无关（各自有独立 spec），替身掉以免拖进 store / API。
            stubs: {
                WorkspaceChangesPanel: true,
                SessionParticipantsPanel: true,
                SessionMonitorPanel: true,
            },
        },
    });
}

function addPersistentTrigger() {
    const btn = document.createElement("button");
    btn.setAttribute("data-testid", "workspace-toolbar-more-mobile");
    btn.textContent = "more";
    document.body.appendChild(btn);
    return btn;
}

afterEach(() => {
    document.body.innerHTML = "";
});

describe("MobileChangesSheet 关闭后的焦点归还（task-56）", () => {
    for (const tab of ["changes", "monitor"] as const) {
        it(`${tab}：Esc/关闭后 activeElement = 常驻 more 按钮（不是 body）`, async () => {
            const trigger = addPersistentTrigger();
            const wrapper = mountSheet(tab);
            await flushPromises();
            expect(document.querySelector('[data-testid="mobile-changes-sheet"]')).toBeTruthy();

            await wrapper.setProps({ open: false });
            await flushPromises();
            await vi.waitFor(() => {
                expect(document.activeElement).toBe(trigger);
            });
            expect(document.activeElement).not.toBe(document.body);
            wrapper.unmount();
        });
    }

    it("handler 契约：有常驻触发器 ⇒ preventDefault（reka 不再抢回）并聚焦它", async () => {
        const trigger = addPersistentTrigger();
        const wrapper = mountSheet("changes");
        await flushPromises();

        const event = new Event("closeAutoFocus", { cancelable: true });
        wrapper.findComponent(SheetContent).vm.$emit("closeAutoFocus", event);

        expect(event.defaultPrevented).toBe(true);
        // 这里只判「接管了」：抽屉此刻仍是 open，reka FocusScope 会把焦点拉回层内，
        // 所以 activeElement 判据放在上面两条**真关闭**的集成用例里（那才是产品路径）。
        expect(trigger.isConnected).toBe(true);
        wrapper.unmount();
    });

    it("handler 契约：没有常驻触发器 ⇒ 不 preventDefault，保留 reka 默认回位（files/chat 不被带坏）", async () => {
        const wrapper = mountSheet("changes");
        await flushPromises();
        expect(document.querySelector(MORE_TRIGGER)).toBeNull();

        const event = new Event("closeAutoFocus", { cancelable: true });
        wrapper.findComponent(SheetContent).vm.$emit("closeAutoFocus", event);

        expect(event.defaultPrevented).toBe(false);
        wrapper.unmount();
    });
});
