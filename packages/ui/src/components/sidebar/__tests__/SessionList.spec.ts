import { describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../../i18n";
import { useChatStore } from "../../../stores/chat";
import { useSessionStore } from "../../../stores/session";
import SessionItem from "../SessionItem.vue";
import SessionList from "../SessionList.vue";

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("SessionList parent-child deletion warning (PLAN-0408 T3.2)", () => {
    it("warns that spawned children continue, and deletes only after confirmation", async () => {
        setActivePinia(createPinia());
        const sessionStore = useSessionStore();
        sessionStore.sessions = [
            {
                id: SESSION_ID,
                title: "Parent session",
                createdAt: "2026-09-27T00:00:00Z",
                updatedAt: "2026-09-27T00:00:00Z",
                workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                context: { agents: [] },
            },
        ];
        const deleteSession = vi.spyOn(sessionStore, "deleteSession").mockResolvedValue();
        const clearSession = vi.spyOn(useChatStore(), "clearSession");
        const wrapper = mount(SessionList, {
            global: { plugins: [i18n], stubs: { Teleport: true } },
        });
        const item = wrapper.findComponent(SessionItem);

        item.vm.$emit("delete", SESSION_ID);
        await flushPromises();

        expect(wrapper.get('[data-testid="session-delete-warning"]').text()).toContain(
            "由它派生的子会话和运行会保留，并可继续独立运行",
        );
        expect(deleteSession).not.toHaveBeenCalled();

        await wrapper.get('[data-testid="session-delete-cancel"]').trigger("click");
        expect(deleteSession).not.toHaveBeenCalled();

        item.vm.$emit("delete", SESSION_ID);
        await flushPromises();
        await wrapper.get('[data-testid="session-delete-confirm"]').trigger("click");
        await flushPromises();

        expect(deleteSession).toHaveBeenCalledWith(SESSION_ID);
        expect(clearSession).toHaveBeenCalledWith(SESSION_ID);
        wrapper.unmount();
    });
});
