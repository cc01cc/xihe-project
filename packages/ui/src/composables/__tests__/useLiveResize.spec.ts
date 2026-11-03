import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useLiveResize } from "../useLiveResize";

interface HarnessOptions {
    clamp?: (width: number) => number;
    grow?: "left" | "right";
    elementWidth?: (width: number) => number;
}

function mountHarness(options: HarnessOptions = {}) {
    const commit = vi.fn<(width: number) => void>();
    const clamp = options.clamp ?? ((width: number) => Math.round(width));
    const Harness = defineComponent({
        setup() {
            const panel = ref<HTMLElement | null>(null),
                bubble = ref<HTMLElement | null>(null);
            const { resizingWidth, start } = useLiveResize({
                clamp,
                currentWidth: () => 360,
                grow: options.grow ?? "right",
                commit,
                panel,
                bubble,
                elementWidth: options.elementWidth,
            });
            return () =>
                h("div", [
                    h(
                        "div",
                        {
                            ref: panel,
                            "data-testid": "panel",
                            style: { width: "360px" },
                            class: { "is-resizing": resizingWidth.value !== null },
                        },
                        [
                            resizingWidth.value === null
                                ? null
                                : h(
                                      "span",
                                      { ref: bubble, "data-testid": "bubble" },
                                      `${resizingWidth.value}px`,
                                  ),
                        ],
                    ),
                    h(
                        "button",
                        {
                            "data-testid": "handle",
                            onMousedown: (event: MouseEvent) => start(event),
                        },
                        "drag",
                    ),
                ]);
        },
    });
    return { wrapper: mount(Harness), commit };
}

function fire(type: "mousemove" | "mouseup" | "pointerup" | "pointercancel", clientX = 0) {
    document.dispatchEvent(new MouseEvent(type, { clientX }));
}

describe("useLiveResize", () => {
    it("writes the width to the element during the drag without committing", async () => {
        const { wrapper, commit } = mountHarness();

        await wrapper.get('[data-testid="handle"]').trigger("mousedown", { clientX: 100 });
        fire("mousemove", 140);
        await nextTick();

        expect(commit).not.toHaveBeenCalled();
        expect((wrapper.get('[data-testid="panel"]').element as HTMLElement).style.width).toBe(
            "400px",
        );
        expect(wrapper.get('[data-testid="bubble"]').text()).toBe("400px");
        expect(wrapper.get('[data-testid="panel"]').classes()).toContain("is-resizing");
    });

    it("commits exactly once on release and stops tracking the pointer", async () => {
        const { wrapper, commit } = mountHarness();

        await wrapper.get('[data-testid="handle"]').trigger("mousedown", { clientX: 100 });
        fire("mousemove", 130);
        fire("mousemove", 150);
        expect(commit).not.toHaveBeenCalled();

        fire("mouseup");
        expect(commit).toHaveBeenCalledTimes(1);
        expect(commit).toHaveBeenCalledWith(410);

        await nextTick();
        expect(wrapper.get('[data-testid="panel"]').classes()).not.toContain("is-resizing");
        expect(wrapper.find('[data-testid="bubble"]').exists()).toBe(false);

        fire("mousemove", 300);
        expect(commit).toHaveBeenCalledTimes(1);
    });

    it("keeps the panel clamp and supports the left-growing dock", async () => {
        const { wrapper, commit } = mountHarness({
            grow: "left",
            clamp: (width) => Math.min(480, Math.max(320, Math.round(width))),
        });

        await wrapper.get('[data-testid="handle"]').trigger("mousedown", { clientX: 1000 });
        fire("mousemove", 1200);
        await nextTick();
        expect((wrapper.get('[data-testid="panel"]').element as HTMLElement).style.width).toBe(
            "320px",
        );

        fire("mouseup");
        expect(commit).toHaveBeenCalledWith(320);
    });

    it("maps the panel width to the element width (nav rail offset)", async () => {
        const { wrapper } = mountHarness({ elementWidth: (width) => 56 + width });

        await wrapper.get('[data-testid="handle"]').trigger("mousedown", { clientX: 0 });
        fire("mousemove", 24);
        await nextTick();

        expect((wrapper.get('[data-testid="panel"]').element as HTMLElement).style.width).toBe(
            "440px",
        );
        expect(wrapper.get('[data-testid="bubble"]').text()).toBe("384px");
    });

    it("treats pointerup and pointercancel as the end of the drag", async () => {
        const first = mountHarness();
        await first.wrapper.get('[data-testid="handle"]').trigger("mousedown", { clientX: 0 });
        fire("mousemove", 16);
        fire("pointerup");
        expect(first.commit).toHaveBeenCalledWith(376);

        const second = mountHarness();
        await second.wrapper.get('[data-testid="handle"]').trigger("mousedown", { clientX: 0 });
        fire("mousemove", 8);
        fire("pointercancel");
        expect(second.commit).toHaveBeenCalledTimes(1);
        expect(second.commit).toHaveBeenCalledWith(368);
    });
});
