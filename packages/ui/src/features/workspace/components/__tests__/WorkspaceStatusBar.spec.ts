import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import WorkspaceStatusBar from "../WorkspaceStatusBar.vue";

/**
 * task-312：底部状态栏。
 *
 * <p><b>判据纪律（D-1153）</b>：断言「**实际是哪一态**」，不是「元素存在」。
 * 三态各有独立的 `data-connection-state` 取值 + 独立文案，所以三态之间**可以互相区分**；
 * 只断言 `toBeTruthy()` 的测试对「三态都渲染成同一个样子」是免疫的 —— 那正是要防的回归。</p>
 *
 * <p><b>反向验证</b>：把 `connectionState` 的 `connecting` 优先级去掉（先判 connected），
 * 「重连中」会读成「已连接」⇒ 本文件第 2 条用例变红。见证据包 §task-312。</p>
 */

const i18n = createI18n({
    legacy: false,
    locale: "zh",
    messages: {
        zh: {
            workspace: {
                eventsConnected: "文件事件已连接",
                eventsConnecting: "文件事件连接中",
                eventsDisconnected: "文件事件未连接",
                statusBarUsage: "in {input} · out {output}",
            },
            sidebar: { pendingApprovalBadge: "待审批" },
        },
    },
});

function mountBar(props: Record<string, unknown> = {}) {
    return mount(WorkspaceStatusBar, {
        props: {
            connected: false,
            connecting: false,
            pendingApprovalTotal: 0,
            ...props,
        },
        global: { plugins: [i18n] },
    });
}

function stateOf(wrapper: ReturnType<typeof mountBar>): string | null {
    return (
        wrapper
            .find('[data-testid="workspace-status-connection"]')
            .attributes("data-connection-state") ?? null
    );
}

describe("WorkspaceStatusBar（task-312）", () => {
    it("三态各自渲染出**不同的** data-connection-state 与不同文案（不是「都渲染了」就算过）", () => {
        const connecting = mountBar({ connecting: true });
        const connected = mountBar({ connected: true });
        const disconnected = mountBar({});

        // ① 三个取值必须互不相同 —— 这条能抓住「三态塌成一态」
        const states = [stateOf(connecting), stateOf(connected), stateOf(disconnected)];
        expect(states).toEqual(["connecting", "connected", "disconnected"]);
        expect(new Set(states).size).toBe(3);

        // ② 文案也必须互不相同（只有属性不同、文案一样 = 用户看不出三态）
        const texts = [connecting, connected, disconnected].map((w) =>
            w.find('[data-testid="workspace-status-connection"]').text(),
        );
        expect(new Set(texts).size).toBe(3);
        expect(texts[0]).toContain("连接中");
        expect(texts[1]).toContain("已连接");
        expect(texts[2]).toContain("未连接");
    });

    it("connecting 优先于 connected —— 重连中即使 isConnected 仍是 true，也不能读成「已连接」", () => {
        // 这是 useWorkspaceSSE 的真实形态：重连期间 isConnected 可能保留上一轮的 true。
        // 若派生顺序写反（先判 connected），这一条必红。
        const wrapper = mountBar({ connected: true, connecting: true });
        expect(stateOf(wrapper)).toBe("connecting");
        expect(wrapper.find('[data-testid="workspace-status-connection"]').text()).toContain(
            "连接中",
        );
    });

    it("待审批：0 时不渲染（0 条是常态，占位等于噪音）；>0 时渲染出数字", async () => {
        const zero = mountBar({ pendingApprovalTotal: 0 });
        expect(zero.find('[data-testid="workspace-status-pending"]').exists()).toBe(false);

        const some = mountBar({ pendingApprovalTotal: 3 });
        const el = some.find('[data-testid="workspace-status-pending"]');
        expect(el.exists()).toBe(true);
        expect(el.text()).toContain("3");
        expect(el.text()).toContain("待审批");
    });

    it("用量：无 run（null/undefined）不渲染；有 run 时渲染 in/out，且 0 也是有效读数", () => {
        expect(
            mountBar({ usageInput: null }).find('[data-testid="workspace-status-usage"]').exists(),
        ).toBe(false);
        expect(mountBar({}).find('[data-testid="workspace-status-usage"]').exists()).toBe(false);

        const withRun = mountBar({ usageInput: 1234, usageOutput: 567 });
        const el = withRun.find('[data-testid="workspace-status-usage"]');
        expect(el.exists()).toBe(true);
        expect(el.text()).toContain("1234");
        expect(el.text()).toContain("567");

        // 0 是有效读数 —— 不能因为 0 就隐藏（那会让「刚发一条消息还没回」看起来像「没有用量」）
        const zeroUsage = mountBar({ usageInput: 0, usageOutput: 0 });
        expect(zeroUsage.find('[data-testid="workspace-status-usage"]').exists()).toBe(true);
        expect(zeroUsage.find('[data-testid="workspace-status-usage"]').text()).toContain("0");
    });

    it("被否决的候选不得出现在状态栏里（防复发：git 分支 / 模型名）", () => {
        // task-307 §② 判不合格的 5 条里，最容易被人「顺手加回来」的是这两条。
        // 这条不是测样式，是测「没有偷偷加数据源」—— 状态栏文本里不该出现分支名/模型名这类词。
        const wrapper = mountBar({ connected: true, pendingApprovalTotal: 0 });
        const text = wrapper.text();
        expect(text).not.toMatch(/分支|branch/i);
        expect(text).not.toMatch(/模型|model/i);
    });
});
