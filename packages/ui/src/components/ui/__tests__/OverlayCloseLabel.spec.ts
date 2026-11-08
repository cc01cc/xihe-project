import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { createI18n } from "vue-i18n";
import { defineComponent } from "vue";
import { DialogRoot } from "reka-ui";
import DialogContent from "../dialog/DialogContent.vue";
import DialogScrollContent from "../dialog/DialogScrollContent.vue";
import SheetContent from "../sheet/SheetContent.vue";

const i18n = createI18n({
    legacy: false,
    locale: "zh-CN",
    messages: { "zh-CN": { common: { close: "关闭" } } },
});

function mountInDialog(component: object) {
    const Wrapper = defineComponent({
        components: { DialogRoot, Content: component },
        template: '<DialogRoot :open="true"><Content /></DialogRoot>',
    });
    return mount(Wrapper, {
        attachTo: document.body,
        global: { plugins: [i18n] },
    });
}

function closeLabels(): string[] {
    return [...document.querySelectorAll<HTMLElement>(".sr-only")]
        .map((node) => node.textContent?.trim() ?? "")
        .filter(Boolean);
}

describe("overlay close labels (BL-154)", () => {
    it.each([
        ["DialogContent", DialogContent],
        ["DialogScrollContent", DialogScrollContent],
        ["SheetContent", SheetContent],
    ])("localises the %s close label under zh-CN", (_name, component) => {
        const wrapper = mountInDialog(component);
        expect(closeLabels()).toContain("关闭");
        expect(closeLabels()).not.toContain("Close");
        wrapper.unmount();
    });
});
