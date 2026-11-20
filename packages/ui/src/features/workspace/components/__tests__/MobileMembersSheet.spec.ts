import { describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount } from "@vue/test-utils";
import MobileMembersSheet from "../MobileMembersSheet.vue";
import { i18n } from "../../../../i18n";
import {
    DIALOG_WIDTH_TIERS,
    DIALOG_WIDTH_TIER_PX,
    dialogWidthClass,
} from "../../../../components/ui/dialog/dialogWidths";

/**
 * task-170（R5）：成员 sheet 的宽度必须来自 dialogWidths.ts 档位，不得再出现档位外的裸宽度类。
 *
 * 背景（DSD-1515 之后）：`MobileMembersSheet` 是移动端独立成员面板，原来写死 `w-[88vw] max-w-sm` ——
 * `max-w-sm` 没有 `sm:` 前缀，在档位表里查无此值（档位表只有 `sm:max-w-sm` 起的四档），
 * `check:ui-rulings` 的 R5 因此判红。现在宽度来源是 `dialogWidthClass('confirm')`（= `sm:max-w-sm`）。
 *
 * 断言口径：
 * - 渲染出来的 SheetContent 的宽度类**正好等于**档位表 confirm 档（同时钉住 SSOT 值，档位表改了就红）；
 * - 不残留任何 `max-w-*` 的裸/档位外写法（防止有人「再加一个更窄的上限」把 R5 又踩回去）。
 */
function mountSheet() {
    setActivePinia(createPinia());
    // Teleport 走真实现（sheet 由 reka 的 DialogPortal 传到 body），所以断言从 document 上取元素。
    return mount(MobileMembersSheet, {
        props: { open: true, sessionId: "task-170-session" },
        attachTo: document.body,
        global: {
            plugins: [i18n, createPinia()],
            // 面板正文是重组件（store + 轮询）；本用例只关心外框宽度语义。
            stubs: { SessionParticipantsPanel: true },
        },
    });
}

function sheetElement(): HTMLElement {
    const element = document.querySelector<HTMLElement>('[data-testid="mobile-members-sheet"]');
    expect(element).not.toBeNull();
    return element as HTMLElement;
}

function classListOf(element: HTMLElement): string[] {
    return Array.from(element.classList);
}

describe("MobileMembersSheet width tier (task-170 R5)", () => {
    it("renders the width class from the dialog width tier table, not a bare max-w-*", () => {
        const wrapper = mountSheet();
        const widthClasses = classListOf(sheetElement()).filter((name) =>
            /^[a-z0-9-]*:?max-w-/.test(name),
        );

        expect(DIALOG_WIDTH_TIERS.confirm).toBe("sm:max-w-sm");
        expect(dialogWidthClass("confirm")).toBe(DIALOG_WIDTH_TIERS.confirm);
        expect(widthClasses).toEqual([DIALOG_WIDTH_TIERS.confirm]);
        wrapper.unmount();
    });

    it("keeps the tier pixel value reachable and the mobile 88vw basis intact", () => {
        const wrapper = mountSheet();
        const classes = classListOf(sheetElement());
        // 档位 px 值就是 sheet 在 ≥640px 的上限；<640px 由 w-[88vw] 决定（与 SheetContent 基座同口径）。
        expect(DIALOG_WIDTH_TIER_PX.confirm).toBe(384);
        expect(classes).toContain("w-[88vw]");
        expect(classes).not.toContain("max-w-sm");
        wrapper.unmount();
    });
});
