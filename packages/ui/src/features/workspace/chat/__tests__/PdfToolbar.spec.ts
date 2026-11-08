import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import PdfToolbar from "../components/PdfToolbar.vue";
import {
    openSelectAt,
    selectItemTexts,
    selectItemValues,
    setOnlySelectValue,
} from "../../../../test-utils/select";

describe("PdfToolbar", () => {
    it("renders page counter", () => {
        const wrapper = mount(PdfToolbar, {
            props: { pageNum: 1, totalPages: 5, scale: 1.0 },
        });
        expect(wrapper.text()).toContain("1 / 5");
    });

    it("disables prev button on first page", () => {
        const wrapper = mount(PdfToolbar, {
                props: { pageNum: 1, totalPages: 5, scale: 1.0 },
            }),
            buttons = wrapper.findAll("button");
        expect(buttons[0].attributes("disabled")).toBeDefined();
    });

    it("disables next button on last page", () => {
        const wrapper = mount(PdfToolbar, {
                props: { pageNum: 5, totalPages: 5, scale: 1.0 },
            }),
            buttons = wrapper.findAll("button");
        expect(buttons[1].attributes("disabled")).toBeDefined();
    });

    it("enables prev button after first page", () => {
        const wrapper = mount(PdfToolbar, {
                props: { pageNum: 3, totalPages: 5, scale: 1.0 },
            }),
            buttons = wrapper.findAll("button");
        expect(buttons[0].attributes("disabled")).toBeUndefined();
        expect(buttons[1].attributes("disabled")).toBeUndefined();
    });

    it("emits prev on prev button click", async () => {
        const wrapper = mount(PdfToolbar, {
            props: { pageNum: 2, totalPages: 5, scale: 1.0 },
        });
        await wrapper.findAll("button")[0].trigger("click");
        expect(wrapper.emitted("prev")).toBeDefined();
    });

    it("emits next on next button click", async () => {
        const wrapper = mount(PdfToolbar, {
            props: { pageNum: 2, totalPages: 5, scale: 1.0 },
        });
        await wrapper.findAll("button")[1].trigger("click");
        expect(wrapper.emitted("next")).toBeDefined();
    });

    it("renders zoom select with 5 options", async () => {
        const wrapper = mount(PdfToolbar, {
            props: { pageNum: 1, totalPages: 5, scale: 1.0 },
        });
        await openSelectAt(wrapper, 0);
        expect(selectItemValues(wrapper)).toEqual(["0.5", "0.75", "1", "1.5", "2"]);
        expect(selectItemTexts(wrapper)[2]).toContain("100%");
    });

    it("emits update:scale on zoom change", async () => {
        const wrapper = mount(PdfToolbar, {
            props: { pageNum: 1, totalPages: 5, scale: 1.0 },
        });
        await setOnlySelectValue(wrapper, "1.5");
        expect(wrapper.emitted("update:scale")).toBeDefined();
        expect(wrapper.emitted("update:scale")![0]).toEqual([1.5]);
    });
});
