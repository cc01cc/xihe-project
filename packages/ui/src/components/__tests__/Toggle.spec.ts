import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import { Toggle } from "../ui/toggle";

/** PLAN-0697 contract: pressed state is machine readable, disabled propagates, variants apply. */
function mountToggle(props: Record<string, unknown> = {}) {
    return mount(Toggle, { props, slots: { default: "Bold" } });
}

describe("Toggle (vendored reka-nova)", () => {
    it("renders an unpressed button with aria-pressed/data-state", () => {
        const button = mountToggle().get("button");
        expect(button.attributes("data-slot")).toBe("toggle");
        expect(button.attributes("data-state")).toBe("off");
        expect(button.attributes("aria-pressed")).toBe("false");
        expect(button.text()).toBe("Bold");
    });

    it("toggles aria-pressed/data-state on click (uncontrolled)", async () => {
        const wrapper = mountToggle();
        const button = wrapper.get("button");
        await button.trigger("click");
        expect(button.attributes("aria-pressed")).toBe("true");
        expect(button.attributes("data-state")).toBe("on");
        await button.trigger("click");
        expect(button.attributes("aria-pressed")).toBe("false");
    });

    it("propagates disabled", () => {
        expect(mountToggle({ disabled: true }).get("button").attributes("disabled")).toBeDefined();
    });

    it("applies variant/size classes", () => {
        const classes = mountToggle({ variant: "outline", size: "lg" }).get("button").classes();
        expect(classes).toContain("border");
        expect(classes).toContain("h-9");
    });
});
