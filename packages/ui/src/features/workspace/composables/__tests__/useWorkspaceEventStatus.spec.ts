import { describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../../../i18n";
import { useWorkspaceConnectionStore } from "../../../../stores/workspaceConnection";
import { useWorkspaceEventStatus } from "../useWorkspaceEventStatus";

/**
 * 文件事件连接态四态派生（task-10 item 3 / batch-2 #3）。
 *
 * <p><b>为什么单独测这个 composable</b>：它是状态栏与聊天页徽标的**唯一派生链**。
 * 收敛之前两处各写一套（状态栏四态、页面二态），同一屏会同时说「未订阅」和「重连中」。
 * 把派生本身钉住，两个使用点就只剩视觉差异 —— 再有人加一套判断，这里会先红。</p>
 */
function probe(seed: (store: ReturnType<typeof useWorkspaceConnectionStore>) => void) {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useWorkspaceConnectionStore();
    seed(store);
    const snapshot = { state: "", label: "" };
    const Probe = defineComponent({
        setup() {
            const status = useWorkspaceEventStatus();
            return () => {
                snapshot.state = status.state.value;
                snapshot.label = status.label.value;
                return h("i");
            };
        },
    });
    mount(Probe, { global: { plugins: [pinia, i18n] } });
    return snapshot;
}

describe("useWorkspaceEventStatus", () => {
    it("未订阅 ⇒ 本页未订阅文件事件（不是「断了」，也不是「重连中」）", () => {
        const s = probe(() => {});
        expect(s.state).toBe("unsubscribed");
        expect(s.label).toBe("本页未订阅文件事件");
    });

    it("订阅中正在连接 ⇒ 文件事件连接中", () => {
        const s = probe((store) => {
            store.subscribed = true;
            store.connecting = true;
        });
        expect(s.state).toBe("connecting");
        expect(s.label).toBe("文件事件连接中");
    });

    it("订阅且已连接 ⇒ 文件事件已连接", () => {
        const s = probe((store) => {
            store.subscribed = true;
            store.connected = true;
        });
        expect(s.state).toBe("connected");
        expect(s.label).toBe("文件事件已连接");
    });

    it("订阅了但没连上 ⇒ 文件事件未连接", () => {
        const s = probe((store) => {
            store.subscribed = true;
        });
        expect(s.state).toBe("disconnected");
        expect(s.label).toBe("文件事件未连接");
    });

    it("顺序有语义：重连瞬间 connected 仍为 true，必须读成 connecting 而不是 connected", () => {
        const s = probe((store) => {
            store.subscribed = true;
            store.connected = true;
            store.connecting = true;
        });
        expect(s.state).toBe("connecting");
    });

    it("未订阅优先于任何连接读数（没订阅方时 connected=false 不代表故障）", () => {
        const s = probe((store) => {
            store.connected = false;
            store.connecting = false;
        });
        expect(s.state).toBe("unsubscribed");
    });
});
