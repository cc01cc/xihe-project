import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reactive } from "vue";

const agentState = reactive({
    status: "idle",
    currentToolCall: null,
    pendingApprovals: [] as Array<{ sessionId?: string; state?: string }>,
});

vi.mock("../../../stores/agent", () => ({
    useAgentStore: () => ({ agentState }),
}));
// MobileChatSheet reads sessionStore.sessions for agentPrincipalId (cad8e727);
// keep it mocked like the agent store so the component does not need an active Pinia.
vi.mock("../../../stores/session", () => ({
    useSessionStore: () => ({ sessions: [] }),
}));
// cad8e727 added useI18n() to the component setup; other specs mock vue-i18n the same way.
vi.mock("vue-i18n", () => ({
    useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("../../ui/sheet/Sheet.vue", () => ({
    default: { template: "<div><slot /></div>" },
}));
vi.mock("../../ui/sheet/SheetContent.vue", () => ({
    default: {
        name: "SheetContent",
        emits: ["pointerDownOutside"],
        template: "<div><slot /></div>",
    },
}));
vi.mock("../../ui/sheet/SheetHeader.vue", () => ({
    default: { template: "<div><slot /></div>" },
}));
vi.mock("../../ui/sheet/SheetTitle.vue", () => ({
    default: { template: "<div><slot /></div>" },
}));
vi.mock("../../ui/sheet/SheetDescription.vue", () => ({
    default: { template: "<div><slot /></div>" },
}));
vi.mock("../../chat/ChatPanel.vue", () => ({
    default: { template: "<div />" },
}));
vi.mock("@lucide/vue", () => ({
    MessageCircle: { template: "<i />" },
}));

import MobileChatSheet from "../MobileChatSheet.vue";

/**
 * PLAN-0342 review fix: the outside-dismissal guard must stay scoped to this
 * sheet's session, mirroring ChatPanel's approval filter.
 */
describe("MobileChatSheet approval dismissal guard", () => {
    beforeEach(() => {
        agentState.pendingApprovals = [];
    });

    function mountOpen(sessionId: string) {
        const wrapper = mount(MobileChatSheet, { props: { sessionId } });
        (wrapper.vm as unknown as { toggle: () => void }).toggle();
        return wrapper;
    }

    function emitPointerDownOutside(wrapper: ReturnType<typeof mountOpen>) {
        const content = wrapper.findComponent({ name: "SheetContent" });
        const event = { preventDefault: vi.fn() };
        content.vm.$emit("pointerDownOutside", event);
        return event;
    }

    it("keeps outside dismissal when another session has a pending approval", () => {
        agentState.pendingApprovals = [{ sessionId: "other-session", state: "pending" }];

        const event = emitPointerDownOutside(mountOpen("session-1"));

        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it("blocks outside dismissal while this session's approval is pending", () => {
        agentState.pendingApprovals = [{ sessionId: "session-1", state: "pending" }];

        const event = emitPointerDownOutside(mountOpen("session-1"));

        expect(event.preventDefault).toHaveBeenCalled();
    });
});
