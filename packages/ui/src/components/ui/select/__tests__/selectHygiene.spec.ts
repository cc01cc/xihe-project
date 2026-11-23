/**
 * task-926：下拉基座与静态门的自证。
 *
 * jsdom 没有布局引擎，量不出 scrollWidth/clientWidth，所以这里钉两件事：
 *  1. vendor 基座源码必须带「可收缩 + 省略」约束（R11/R14/R26 的根因层，卡面要求基座一次修好）；
 *  2. 静态门的纯函数对 R53（互斥单选误用 Checkbox/aria-pressed）与宽度判定的正反例。
 * 真实像素由 evidence/2026-11-24-task-926 的修前/修后浏览器截图承担。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    exclusiveToggleGroups,
    stripComments,
    triggerWidthVerdict,
} from "../../../../../scripts/check-select-hygiene.mjs";

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("select/combobox vendor base (task-926)", () => {
    it("SelectTrigger 自身可收缩，SelectValue 可省略", () => {
        const trigger = source("../SelectTrigger.vue");
        expect(trigger).toContain("min-w-0 max-w-full");
        expect(trigger).toContain("*:data-[slot=select-value]:truncate");
        expect(trigger).toContain("overflow-hidden");
        const value = source("../SelectValue.vue");
        expect(value).toContain("min-w-0");
        expect(value).toContain("truncate");
    });

    it("SelectContent 的最小宽度在 Content 层、且锁死横向溢出", () => {
        const content = source("../SelectContent.vue");
        expect(content).toContain("min-w-(--reka-select-trigger-width)");
        expect(content).toContain("max-w-(--reka-select-content-available-width)");
        expect(content).toContain("overflow-x-hidden");
        // 固定宽度回到 Content 会和 p-1 叠加，实测多出 8px 横向滚动条。
        expect(stripComments(content)).not.toMatch(/(^|[^a-z-])w-\(--reka-select-trigger-width\)/u);
    });

    it("ComboboxList 同样锁死横向溢出", () => {
        const list = source("../../combobox/ComboboxList.vue");
        expect(list).toContain("overflow-x-hidden");
        expect(list).toContain("reka-combobox-trigger-width");
    });

    it("弹层默认方向统一为 start（R41）", () => {
        expect(source("../../popover/PopoverContent.vue")).toContain('align: "start"');
        expect(source("../../dropdown-menu/DropdownMenuContent.vue")).toContain('align: "start"');
        expect(source("../SelectContent.vue")).toContain('align: "start"');
    });
});

describe("check-select-hygiene pure rules", () => {
    it("宽度判定：缺约束/仅 w-fit 不通过，min-w-0 与动态 class 通过", () => {
        expect(triggerWidthVerdict('<SelectTrigger class="rounded border">').ok).toBe(false);
        expect(triggerWidthVerdict('<SelectTrigger class="w-fit">').ok).toBe(false);
        expect(triggerWidthVerdict('<SelectTrigger class="min-w-0">').ok).toBe(true);
        expect(triggerWidthVerdict('<SelectTrigger class="w-full">').ok).toBe(true);
        expect(triggerWidthVerdict('<SelectTrigger :class="triggerClass">')).toEqual({
            ok: true,
            dynamic: true,
        });
    });

    it("R53：两个 Checkbox 表达互斥单选 → 命中；RadioGroup → 不命中", () => {
        const bad = `<Checkbox :model-value="mode === 'a'" />\n<Checkbox :model-value="mode === 'b'" />`;
        expect(exclusiveToggleGroups(bad)).toHaveLength(1);
        expect(exclusiveToggleGroups(bad)[0]?.key).toBe("mode");

        const toggles = `<button :aria-pressed="mode === 'a'" />\n<button :aria-pressed="mode === 'b'" />`;
        expect(exclusiveToggleGroups(toggles)).toHaveLength(1);

        const good = `<RadioGroup v-model="mode"><RadioGroupItem value="a" /><RadioGroupItem value="b" /></RadioGroup>`;
        expect(exclusiveToggleGroups(good)).toHaveLength(0);
    });
});
