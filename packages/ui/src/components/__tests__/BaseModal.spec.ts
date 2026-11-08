import { describe, it, expect, afterEach } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, nextTick } from "vue";
import BaseModal from "../shared/BaseModal.vue";
import { createI18n } from "vue-i18n";

const mounted: VueWrapper[] = [];
const i18n = createI18n({
    legacy: false,
    locale: "zh-CN",
    messages: { "zh-CN": { common: { close: "关闭" } } },
});

function mountModal(options: Parameters<typeof mount>[1] = {}) {
    const wrapper = mount(BaseModal, {
        attachTo: document.body,
        ...options,
        global: { plugins: [i18n], ...(options.global ?? {}) },
    });
    mounted.push(wrapper);
    return wrapper;
}

function pressEscape(target: EventTarget = document.body) {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

afterEach(() => {
    while (mounted.length > 0) mounted.pop()?.unmount();
    document.body.style.overflow = "";
});

describe("BaseModal", () => {
    it("renders when show is true", () => {
        const wrapper = mountModal({
            props: { show: true, title: "Test Modal" },
            slots: { default: "Content here" },
        });
        expect(wrapper.text()).toContain("Test Modal");
        expect(wrapper.text()).toContain("Content here");
    });

    it("does not render when show is false", () => {
        const wrapper = mountModal({
            props: { show: false, title: "Test" },
        });
        expect(wrapper.find('[class*="fixed"]').exists()).toBe(false);
    });

    // Note: backdrop click test skipped due to Teleport limitation in jsdom.
    // Tested manually in Playwright E2E.

    it("renders close button with aria-label", () => {
        const wrapper = mountModal({ props: { show: true, title: "Test" } });
        expect(wrapper.find('button[aria-label="关闭"]').exists()).toBe(true);
    });

    it("exposes dialog semantics and names itself through the title heading", () => {
        const wrapper = mountModal({
            props: { show: true, title: "Delete session?" },
            slots: { default: "Body" },
        });
        const content = document.querySelector<HTMLElement>('[data-testid="modal-content"]');
        const heading = document.querySelector<HTMLElement>('[data-testid="modal-content"] h2');
        expect(content?.getAttribute("role")).toBe("dialog");
        expect(content?.getAttribute("aria-modal")).toBe("true");
        expect(content?.getAttribute("aria-label")).toBeNull();
        expect(heading?.id).toBeTruthy();
        expect(content?.getAttribute("aria-labelledby")).toBe(heading?.id);
        expect(wrapper.text()).toContain("Delete session?");
    });

    it("uses a non-empty aria-label fallback when there is no title", () => {
        const wrapper = mountModal({
            props: { show: true },
            slots: { default: "Body" },
        });
        const content = document.querySelector<HTMLElement>('[data-testid="modal-content"]');
        expect(content?.getAttribute("aria-labelledby")).toBeNull();
        expect(content?.getAttribute("aria-label")).toBe("Dialog");
        expect(wrapper.text()).toContain("Body");
    });

    it("gives every instance a unique title id", () => {
        // One app per mount would reset Vue's useId counter; two modals must share one app.
        const Both = defineComponent({
            components: { BaseModal },
            template:
                '<div><BaseModal :show="true" title="First" /><BaseModal :show="true" title="Second" /></div>',
        });
        mounted.push(mount(Both, { attachTo: document.body, global: { plugins: [i18n] } }));
        const ids = Array.from(
            document.querySelectorAll<HTMLElement>('[data-testid="modal-content"] h2'),
        ).map((heading) => heading.id);
        expect(ids).toHaveLength(2);
        expect(new Set(ids).size).toBe(2);
    });

    it("closes the innermost modal first and keeps the outer one open", () => {
        const outer = mountModal({ props: { show: true, title: "Outer" } });
        const inner = mountModal({ props: { show: true, title: "Inner" } });
        pressEscape();
        expect(inner.emitted("close")).toHaveLength(1);
        expect(outer.emitted("close")).toBeUndefined();

        inner.unmount();
        mounted.splice(mounted.indexOf(inner), 1);
        pressEscape();
        expect(outer.emitted("close")).toHaveLength(1);
    });

    it("restores focus to the opener when the modal closes", async () => {
        const opener = document.createElement("button");
        opener.textContent = "open";
        document.body.append(opener);
        opener.focus();

        const wrapper = mountModal({ props: { show: false, title: "Focus" } });
        await wrapper.setProps({ show: true });
        // The card does not steal focus on open; a keyboard user is already inside it.
        const closeButton = document.querySelector<HTMLButtonElement>(
            '[data-testid="modal-content"] button[aria-label="关闭"]',
        );
        closeButton?.focus();
        expect(document.activeElement).toBe(closeButton);

        await wrapper.setProps({ show: false });
        await nextTick();
        await nextTick();
        expect(document.activeElement).toBe(opener);
        opener.remove();
    });

    it("locks body scroll while open and only unlocks after the last modal closes", async () => {
        document.body.style.overflow = "scroll";
        const outer = mountModal({ props: { show: true, title: "Outer" } });
        const inner = mountModal({ props: { show: true, title: "Inner" } });
        expect(document.body.style.overflow).toBe("hidden");

        inner.unmount();
        mounted.splice(mounted.indexOf(inner), 1);
        expect(document.body.style.overflow).toBe("hidden");

        outer.unmount();
        mounted.splice(mounted.indexOf(outer), 1);
        expect(document.body.style.overflow).toBe("scroll");
    });

    it("keeps Tab inside the card when trapFocus is enabled", async () => {
        const wrapper = mountModal({
            props: { show: true, trapFocus: true },
            slots: {
                default: '<button id="first">first</button><button id="second">second</button>',
            },
        });
        const first = document.querySelector<HTMLButtonElement>("#first");
        const second = document.querySelector<HTMLButtonElement>("#second");
        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        first?.focus();
        second?.focus();
        second?.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
        );
        await nextTick();
        expect(document.activeElement).toBe(first);
        expect(wrapper.text()).toContain("first");
    });
});
