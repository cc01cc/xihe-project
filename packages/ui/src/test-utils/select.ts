import { nextTick } from "vue";
import type { VueWrapper } from "@vue/test-utils";
import { Select, SelectItem } from "@/components/ui/select";

/**
 * PLAN-0698 helper: the migrated pages use the shadcn-vue/reka `Select` (a button
 * trigger + a popup) instead of a native `<select>`. Unit tests keep asserting the
 * same semantics by emitting the same `update:modelValue` the trigger would emit;
 * the real click path is covered by the Playwright mock/E2E lane.
 *
 * `selector` may be any descendant of the Select (typically the trigger's
 * `data-testid`); when only one Select is mounted it can be omitted.
 */
type Wrapper = VueWrapper<unknown>;

// jsdom lacks a few DOM APIs reka's Select reaches for when the popup opens.
if (typeof Element !== "undefined") {
    const proto = Element.prototype as Element & { scrollIntoView?: () => void };
    if (!proto.scrollIntoView) proto.scrollIntoView = () => {};
}

/** jsdom lacks the Pointer Capture API that reka's SelectTrigger calls on pointerdown. */
function stubPointerCapture(element: Element) {
    const el = element as HTMLElement & {
        hasPointerCapture?: (pointerId: number) => boolean;
        setPointerCapture?: (pointerId: number) => void;
        releasePointerCapture?: (pointerId: number) => void;
    };
    if (!el.hasPointerCapture) el.hasPointerCapture = () => false;
    if (!el.setPointerCapture) el.setPointerCapture = () => {};
    if (!el.releasePointerCapture) el.releasePointerCapture = () => {};
}

export function selectRoots(wrapper: Wrapper) {
    return wrapper.findAllComponents(Select);
}

export function findSelectRoot(wrapper: Wrapper, selector?: string) {
    const roots = selectRoots(wrapper);
    if (!selector) return roots.length === 1 ? roots[0] : undefined;
    return roots.find((root) => root.find(selector).exists());
}

export async function setSelectValue(wrapper: Wrapper, selector: string, value: unknown) {
    const root = findSelectRoot(wrapper, selector);
    if (!root) throw new Error(`No <Select> matches ${selector}`);
    root.vm.$emit("update:modelValue", value);
    await nextTick();
}

export async function setOnlySelectValue(wrapper: Wrapper, value: unknown) {
    const root = findSelectRoot(wrapper);
    if (!root) throw new Error("Expected exactly one <Select>");
    root.vm.$emit("update:modelValue", value);
    await nextTick();
}

export async function setSelectValueAt(wrapper: Wrapper, index: number, value: unknown) {
    const root = selectRoots(wrapper)[index];
    if (!root) throw new Error(`No <Select> at index ${index}`);
    root.vm.$emit("update:modelValue", value);
    await nextTick();
}

export function selectValueAt(wrapper: Wrapper, index: number) {
    return selectRoots(wrapper)[index]?.props("modelValue");
}

export function selectModelValue(wrapper: Wrapper, selector: string) {
    return findSelectRoot(wrapper, selector)?.props("modelValue");
}

export function selectCount(wrapper: Wrapper) {
    return selectRoots(wrapper).length;
}

export async function openSelectAt(wrapper: Wrapper, index: number) {
    const root = selectRoots(wrapper)[index];
    if (!root) throw new Error(`No <Select> at index ${index}`);
    const trigger = root.get('[data-slot="select-trigger"]');
    stubPointerCapture(trigger.element);
    await trigger.trigger("pointerdown");
    await nextTick();
    await nextTick();
}

export async function openSelect(wrapper: Wrapper, selector: string) {
    const trigger = wrapper.get(selector);
    stubPointerCapture(trigger.element);
    await trigger.trigger("pointerdown");
    await nextTick();
    await nextTick();
}

/** Emit on the Select whose trigger lives inside `ancestorSelector` (e.g. a list row). */
export async function setSelectWithin(wrapper: Wrapper, ancestorSelector: string, value: unknown) {
    const root = selectRoots(wrapper).find((candidate) => {
        const trigger = candidate.find('[data-slot="select-trigger"]');
        return (
            trigger.exists() && Boolean((trigger.element as HTMLElement).closest(ancestorSelector))
        );
    });
    if (!root) throw new Error(`No <Select> inside ${ancestorSelector}`);
    root.vm.$emit("update:modelValue", value);
    await nextTick();
}

export function selectItemComponents(wrapper: Wrapper) {
    return wrapper.findAllComponents(SelectItem);
}

export function renderedOptionCount(): number {
    return document.querySelectorAll('[role="option"]').length;
}

/** Values of the SelectItem children (works after `openSelectAt`). */
export function selectItemValues(wrapper: Wrapper): unknown[] {
    return wrapper.findAllComponents(SelectItem).map((item) => item.props("value"));
}

/** Scoped variant: only the items inside the Select matching `selector`. */
export function selectItemValuesFor(wrapper: Wrapper, selector: string): unknown[] {
    const root = findSelectRoot(wrapper, selector);
    if (!root) throw new Error(`No <Select> matches ${selector}`);
    return root.findAllComponents(SelectItem).map((item) => item.props("value"));
}

export function selectItemTextsFor(wrapper: Wrapper, selector: string): string[] {
    const root = findSelectRoot(wrapper, selector);
    if (!root) throw new Error(`No <Select> matches ${selector}`);
    return root.findAllComponents(SelectItem).map((item) => item.text());
}

/** Rendered labels of the SelectItem children (works after `openSelectAt`). */
export function selectItemTexts(wrapper: Wrapper): string[] {
    return wrapper.findAllComponents(SelectItem).map((item) => item.text());
}
