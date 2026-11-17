import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import ConfirmModal from "../shared/ConfirmModal.vue";
import { i18n } from "../../i18n";

/**
 * task-150：ConfirmModal 的「成功」必须有依据 —— 组件旧实现把「用户点了确认」无条件当成
 * 「操作成功了」（D-1782 同族：UI 报告了它并不知道的结果）。现行契约（卡面形态①）：
 *
 * - @confirm 的 handler 返回 Promise：resolve ⇒ 才显示 "Operation completed" 并 1.5s 关窗；
 *   reject ⇒ 窗保持打开、[data-testid=confirm-error] 留在窗内、**不自动关**（卡面验收：
 *   模拟删除 API 500 ⇒ 用户看到失败原因，且窗口不自动关）。
 * - handler 同步 / 不返回 Promise：维持旧的「点击即成功」（向后兼容口，见组件头注）。
 *
 * 注意 emit 与 prop 的分工：@confirm 的模板绑定在编译产物里就是 onConfirm prop，有 prop 时
 * 组件直接调用它（拿 Promise）而**不再 emit**；没有 onConfirm 时才走 emit（所以下面前四条
 * 存量用例全部不传 onConfirm，断言的是 emit 路径，行为与旧版一致）。
 */

function mountModal(props: Record<string, unknown> = {}): VueWrapper {
    return mount(ConfirmModal, {
        global: { plugins: [i18n] },
        props: { show: true, title: "Confirm", ...props },
    });
}

function confirmButton(wrapper: VueWrapper) {
    return wrapper.findAll("button").filter((b) => b.text().includes("Confirm"))[0];
}

/** 可手动 settle 的 Promise —— 用来钉「等待期间用户取消」的时序。 */
function deferred<T = void>() {
    let resolve!: (v: T | PromiseLike<T>) => void, reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe("ConfirmModal（存量行为：无 onConfirm 的 emit 路径，向后兼容）", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("renders title and description", () => {
        const wrapper = mount(ConfirmModal, {
            global: { plugins: [i18n] },
            props: { show: true, title: "Delete?", description: "This cannot be undone" },
        });
        expect(wrapper.text()).toContain("Delete?");
        expect(wrapper.text()).toContain("This cannot be undone");
    });

    it("emits confirm on confirm button click", async () => {
        const wrapper = mountModal();
        await confirmButton(wrapper).trigger("click");
        expect(wrapper.emitted("confirm")).toBeTruthy();
    });

    it("emits cancel on cancel button click", async () => {
        const wrapper = mountModal();
        const cancelBtn = wrapper.findAll("button").filter((b) => b.text().includes("Cancel"));
        if (cancelBtn.length) await cancelBtn[0].trigger("click");
        expect(wrapper.emitted("cancel")).toBeTruthy();
    });

    it("auto-closes after 1.5s on confirm", async () => {
        const wrapper = mountModal();
        await confirmButton(wrapper).trigger("click");
        expect(wrapper.emitted("confirm")).toBeTruthy();
        vi.advanceTimersByTime(1500);
        expect(wrapper.emitted("close")).toBeTruthy();
    });

    it("shows destructive style when destructive prop is true", () => {
        const wrapper = mount(ConfirmModal, {
            global: { plugins: [i18n] },
            props: { show: true, title: "Delete?", destructive: true },
        });
        expect(wrapper.html()).toContain("bg-destructive");
    });
});

describe("ConfirmModal（task-150 异步契约：成功才置 succeeded）", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("handler resolve 后才显示 Operation completed，1.5s 后才 close", async () => {
        const d = deferred();
        const wrapper = mountModal({ onConfirm: () => d.promise });
        await confirmButton(wrapper).trigger("click");
        // 结果未回来之前不许先报成功 —— 「点了确认即成功」正是旧缺陷的行为。
        expect(wrapper.text()).not.toContain("Operation completed");
        d.resolve();
        await flushPromises();
        expect(wrapper.text()).toContain("Operation completed");
        expect(wrapper.emitted("close")).toBeFalsy();
        vi.advanceTimersByTime(1500);
        expect(wrapper.emitted("close")).toBeTruthy();
    });

    it("成功闪现期间调用方把 :show 置 false，窗口仍保持可见直到定时关窗（holdOpen）", async () => {
        const wrapper = mountModal({ onConfirm: () => Promise.resolve() });
        await confirmButton(wrapper).trigger("click");
        await flushPromises();
        // 模拟 KnowledgeBaseView 的成功路径：resolve 前先 pendingDeleteId = null（:show → false）。
        await wrapper.setProps({ show: false });
        expect(wrapper.find('[data-testid="modal-content"]').exists()).toBe(true);
        expect(wrapper.text()).toContain("Operation completed");
        vi.advanceTimersByTime(1500);
        expect(wrapper.emitted("close")).toBeTruthy();
    });

    it("handler 同步返回（非 Promise）⇒ 维持旧的点击即成功（向后兼容口）", async () => {
        const wrapper = mountModal({ onConfirm: () => undefined });
        await confirmButton(wrapper).trigger("click");
        await flushPromises();
        expect(wrapper.text()).toContain("Operation completed");
        vi.advanceTimersByTime(1500);
        expect(wrapper.emitted("close")).toBeTruthy();
    });

    it("等待期间用户取消 ⇒ 迟到的 resolve 不再报成功", async () => {
        const d = deferred();
        const wrapper = mountModal({ onConfirm: () => d.promise });
        await confirmButton(wrapper).trigger("click");
        const cancelBtn = wrapper.findAll("button").find((b) => b.text().includes("Cancel"))!;
        await cancelBtn.trigger("click");
        d.resolve();
        await flushPromises();
        expect(wrapper.text()).not.toContain("Operation completed");
        // close 只来自取消那一次，成功定时器被代次守卫拦掉。
        expect(wrapper.emitted("close")).toHaveLength(1);
    });
});

describe("ConfirmModal（task-150 失败路径：卡面验收——API 500 时原因留在窗内、窗口不自动关）", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    /** 模拟删除 API 500：handler 抛错（等价于调用方 catch 后 rethrow 的契约形态）。 */
    const deleteApi500 = () => Promise.reject(new Error("Request failed with status 500"));

    it("reject ⇒ 失败原因显示在窗内，不报 Operation completed，推进 5s 也不关窗", async () => {
        const wrapper = mountModal({ onConfirm: deleteApi500 });
        await confirmButton(wrapper).trigger("click");
        await flushPromises();

        const errorBox = wrapper.find('[data-testid="confirm-error"]');
        expect(errorBox.exists()).toBe(true);
        expect(errorBox.text()).toContain("500");
        expect(wrapper.text()).not.toContain("Operation completed");
        // 按钮仍在 ⇒ 用户可重试或取消；close 未发 ⇒ 窗口不自动关。
        expect(confirmButton(wrapper).exists()).toBe(true);
        vi.advanceTimersByTime(5000);
        expect(wrapper.emitted("close")).toBeFalsy();
    });

    it("reject 时优先展示 :error 传入的文案（调用方 catch 后格式化）", async () => {
        const wrapper = mountModal({
            onConfirm: deleteApi500,
            error: "删除失败：文档被其他任务锁定",
        });
        await confirmButton(wrapper).trigger("click");
        await flushPromises();
        const errorBox = wrapper.find('[data-testid="confirm-error"]');
        expect(errorBox.exists()).toBe(true);
        expect(errorBox.text()).toContain("删除失败：文档被其他任务锁定");
        expect(errorBox.text()).not.toContain("Request failed");
    });

    it("失败后重开（:show false→true）⇒ 上一扇窗的错误态被清掉", async () => {
        const wrapper = mountModal({ onConfirm: deleteApi500 });
        await confirmButton(wrapper).trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="confirm-error"]').exists()).toBe(true);

        await wrapper.setProps({ show: false });
        await wrapper.setProps({ show: true });
        expect(wrapper.find('[data-testid="confirm-error"]').exists()).toBe(false);
        // 重开后可以再次确认（新代次）。
        expect(confirmButton(wrapper).exists()).toBe(true);
    });

    it("失败后可重试：第二次 confirm 的 resolve 会正常报成功", async () => {
        let attempts = 0;
        const wrapper = mountModal({
            onConfirm: () => {
                attempts += 1;
                return attempts === 1 ? deleteApi500() : Promise.resolve();
            },
        });
        await confirmButton(wrapper).trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="confirm-error"]').exists()).toBe(true);

        await confirmButton(wrapper).trigger("click");
        await flushPromises();
        expect(wrapper.find('[data-testid="confirm-error"]').exists()).toBe(false);
        expect(wrapper.text()).toContain("Operation completed");
    });
});
