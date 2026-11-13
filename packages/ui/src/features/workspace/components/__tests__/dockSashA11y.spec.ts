import { afterEach, describe, expect, it, vi } from "vitest";
import {
    attachDockSashA11y,
    clampRatio,
    nextSashRatio,
    ratioToPercent,
    SASH_KEYBOARD_STEP_PX,
    SASH_MAX_RATIO,
    SASH_MIN_RATIO,
    stepRatioForWidth,
    type SashRatioState,
} from "../dockSashA11y";

const baseState = (over: Partial<SashRatioState> = {}): SashRatioState => ({
    ratio: 0.5,
    resetRatio: 0.5,
    minRatio: SASH_MIN_RATIO,
    maxRatio: SASH_MAX_RATIO,
    stepRatio: 0.02,
    ...over,
});

afterEach(() => {
    document.body.innerHTML = "";
});

describe("clampRatio", () => {
    it("把越界值夹回区间", () => {
        expect(clampRatio(0.05, 0.1, 0.9)).toBe(0.1);
        expect(clampRatio(0.95, 0.1, 0.9)).toBe(0.9);
        expect(clampRatio(0.42, 0.1, 0.9)).toBe(0.42);
    });

    it("非有限值退到下限而不是产出 NaN", () => {
        expect(clampRatio(Number.NaN, 0.1, 0.9)).toBe(0.1);
        expect(clampRatio(Number.POSITIVE_INFINITY, 0.1, 0.9)).toBe(0.9);
    });
});

describe("stepRatioForWidth", () => {
    it("一次按键约等于 16px 的手感", () => {
        expect(stepRatioForWidth(1600)).toBeCloseTo(16 / 1600, 6);
        expect(stepRatioForWidth(1600)).toBeCloseTo(SASH_KEYBOARD_STEP_PX / 1600, 6);
    });

    it("容器极宽时增量有下限（否则按了等于没按）", () => {
        expect(stepRatioForWidth(1_000_000)).toBe(0.005);
    });

    it("容器极窄时增量有上限（否则一次跳掉半个屏）", () => {
        expect(stepRatioForWidth(10)).toBe(0.25);
    });

    it("拿不到宽度时不抛错、退回下限", () => {
        expect(stepRatioForWidth(0)).toBe(0.005);
        expect(stepRatioForWidth(Number.NaN)).toBe(0.005);
        expect(stepRatioForWidth(-100)).toBe(0.005);
    });
});

describe("nextSashRatio", () => {
    it("ArrowLeft 让分隔条左移（前一组变窄）", () => {
        expect(nextSashRatio(baseState(), "ArrowLeft")).toBeCloseTo(0.48, 6);
    });

    it("ArrowRight 让分隔条右移（后一组变窄）", () => {
        expect(nextSashRatio(baseState(), "ArrowRight")).toBeCloseTo(0.52, 6);
    });

    it("Home / End 到两端", () => {
        expect(nextSashRatio(baseState(), "Home")).toBe(SASH_MIN_RATIO);
        expect(nextSashRatio(baseState(), "End")).toBe(SASH_MAX_RATIO);
    });

    it("到边界后不再越界", () => {
        expect(nextSashRatio(baseState({ ratio: 0.11 }), "ArrowLeft")).toBe(SASH_MIN_RATIO);
        expect(nextSashRatio(baseState({ ratio: 0.89 }), "ArrowRight")).toBe(SASH_MAX_RATIO);
    });

    it("不归适配层管的键返回 null（调用方据此不 preventDefault）", () => {
        expect(nextSashRatio(baseState(), "Tab")).toBeNull();
        expect(nextSashRatio(baseState(), "Enter")).toBeNull();
        expect(nextSashRatio(baseState(), "a")).toBeNull();
    });

    it("step 非法时退回 0.005，不产出 NaN", () => {
        const out = nextSashRatio(baseState({ stepRatio: Number.NaN }), "ArrowRight");
        expect(out).toBeCloseTo(0.505, 6);
    });
});

describe("ratioToPercent", () => {
    it("播报整数百分比", () => {
        expect(ratioToPercent(0.5)).toBe(50);
        expect(ratioToPercent(1 / 3)).toBe(33);
        expect(ratioToPercent(0.6667)).toBe(67);
    });

    it("越界与非有限值都不播 NaN", () => {
        expect(ratioToPercent(-1)).toBe(0);
        expect(ratioToPercent(2)).toBe(100);
        expect(ratioToPercent(Number.NaN)).toBe(0);
    });
});

describe("attachDockSashA11y（DOM）", () => {
    const setup = (over: Partial<SashRatioState> = {}) => {
        const container = document.createElement("div");
        const sash = document.createElement("div");
        sash.className = "dv-sash dv-enabled";
        container.appendChild(sash);
        document.body.appendChild(container);
        const state = { current: baseState(over) };
        const apply = vi.fn<(el: HTMLElement, ratio: number) => void>((_el, ratio) => {
            state.current = { ...state.current, ratio };
        });
        const measure = vi.fn<() => SashRatioState>(() => state.current);
        const dispose = attachDockSashA11y(container, { label: "调整分栏", measure, apply });
        return { container, sash, state, apply, measure, dispose };
    };

    it("把 separator 语义挂到 .dv-sash 上（dockview 自己不给）", () => {
        const { sash } = setup();
        expect(sash.getAttribute("role")).toBe("separator");
        expect(sash.getAttribute("aria-orientation")).toBe("vertical");
        expect(sash.getAttribute("aria-label")).toBe("调整分栏");
        expect(sash.getAttribute("tabindex")).toBe("0");
        expect(sash.getAttribute("aria-valuenow")).toBe("50");
        expect(sash.getAttribute("aria-valuemin")).toBe("10");
        expect(sash.getAttribute("aria-valuemax")).toBe("90");
    });

    it("方向键真的调用 apply，且方向符合约定", () => {
        const { sash, apply } = setup();
        sash.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        expect(apply).toHaveBeenCalledTimes(1);
        expect(apply.mock.calls[0]?.[1]).toBeCloseTo(0.52, 6);
    });

    it("按完键后 aria-valuenow 跟着实际值走", () => {
        const { sash } = setup();
        sash.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
        expect(sash.getAttribute("aria-valuenow")).toBe("90");
    });

    it("播报以【实际】为准：apply 没生效就不谎报", () => {
        const container = document.createElement("div");
        const sash = document.createElement("div");
        sash.className = "dv-sash";
        container.appendChild(sash);
        document.body.appendChild(container);
        // apply 什么都不做 —— 模拟「被最小宽度挡住、布局没变」
        attachDockSashA11y(container, {
            label: "调整分栏",
            measure: () => baseState({ ratio: 0.5 }),
            apply: vi.fn<(el: HTMLElement, ratio: number) => void>(),
        });
        sash.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        expect(sash.getAttribute("aria-valuenow")).toBe("50");
    });

    it("Home / End 到边界", () => {
        const { sash, apply } = setup();
        sash.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
        expect(apply.mock.calls[0]?.[1]).toBe(SASH_MIN_RATIO);
        sash.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
        expect(apply.mock.calls[1]?.[1]).toBe(SASH_MAX_RATIO);
    });

    it("无关按键不调用 apply", () => {
        const { sash, apply } = setup();
        sash.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        expect(apply).not.toHaveBeenCalled();
    });

    it("双击回到 resetRatio", () => {
        const { sash, apply } = setup({ ratio: 0.3, resetRatio: 0.5 });
        sash.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        expect(apply.mock.calls[0]?.[1]).toBe(0.5);
    });

    it("组数为 1（measure 返回 null）时什么都不挂", () => {
        const container = document.createElement("div");
        const sash = document.createElement("div");
        sash.className = "dv-sash";
        container.appendChild(sash);
        document.body.appendChild(container);
        attachDockSashA11y(container, {
            label: "调整分栏",
            measure: () => null,
            apply: vi.fn<(el: HTMLElement, ratio: number) => void>(),
        });
        expect(sash.getAttribute("role")).toBeNull();
        expect(sash.getAttribute("tabindex")).toBeNull();
    });

    it("dockview 增删组后新建的 sash 也会被挂上（MutationObserver）", async () => {
        const { container } = setup();
        const later = document.createElement("div");
        later.className = "dv-sash";
        container.appendChild(later);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(later.getAttribute("role")).toBe("separator");
        expect(later.getAttribute("tabindex")).toBe("0");
    });

    it("dispose 后属性被清掉、监听不再触发", () => {
        const { sash, apply, dispose } = setup();
        dispose();
        expect(sash.getAttribute("role")).toBeNull();
        expect(sash.getAttribute("tabindex")).toBeNull();
        sash.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        expect(apply).not.toHaveBeenCalled();
    });
});
