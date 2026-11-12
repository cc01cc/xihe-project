// timeout-exempt: E1 需 9 格 × 300 帧真实 rAF（≈16 ms/帧）采样，单格预算 180 s；判据与理由见证据包 §E1
/**
 * BL-602 / task-12 —— E1：`content-visibility:auto` 高度翻转 × 库首次测量补偿的**桩模型自持环**判别。
 *
 * 证据与预注册判据（先读它，本文件只是执行体）：
 *   internal/A03-xihe/evidence/2026-11-12-bl602-rootcause/README.md §4 E1
 *
 * 方法学硬约束（Lead 2026-11-12 加，防自证）：
 * ① 本文件的 `offsetHeight/getBoundingClientRect` 桩是**按 M2 假设造的** ⇒ 本实验最多只能证明
 *    「M2 机制在桩模型下能产生该量级位移」，**不得**据此声称「BL-602 根因已定」；
 * ② 桩的每一条行为都在证据包「桩行为 ↔ 已知事实」表里对应到 file:line 或文档，凭直觉加的行为必须标注；
 * ③ 阴性结果不是测试失败：本文件只断言**桩自身是否按设计生效**（arm A 必须发生高度翻转、arm B 必须不发生）
 *    与 9 格读数是否齐全；判定（准入/不准入）由证据包按预注册规则人工执行 —— 一条"阴性就变红"的判据会被绕过。
 *
 * 三条臂（同一份测试，只切 `offsetHeight/getBoundingClientRect` 的模型）：
 *   flip     = 行高按"是否靠近视口"在 160 px（contain-intrinsic-size:auto 10rem）与实测 45–90 px 间翻转
 *   constant = 行高恒定（无翻转）—— M2 的对照
 *   zero     = offsetHeight 恒 0（= 今天 jsdom 的现状）—— 库测量路径全死，当前基线
 *
 * 隔离声明（桩有意让 W1/W3 静默，只留 W6）：
 * - 所有元素 `getBoundingClientRect().top` 固定 0 ⇒ provider 二次锚定（`restorePrependedAnchor`）与
 *   `restoreAnchor` 的 delta 恒为 0 ⇒ W3/W2 在本实验里不写 scrollTop（证据包 §2 的 W2/W3）；
 * - jsdom 无 ResizeObserver ⇒ `handleResize`（W4 贴底跟随）**不可能触发** ⇒ M4 不在本实验判据内；
 * - 因此本实验若观察到持续写，来源只能是 W6（`@tanstack/virtual-core@3.19.7` `resizeItem` 的
 *   首次测量补偿）+ W1（prepend 同帧补偿，只发生在 prepend 帧）。
 */
import { describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia } from "pinia";
import MessageList from "../components/MessageList.vue";
import type { Message } from "../../../../types";

/* ------------------------------------------------------------------ */
/* 预注册常量（与证据包 §4 E1 逐项对应，改它们等于改判据）              */
/* ------------------------------------------------------------------ */

/** 与 `MessageScrollerItem.vue:32` 的 `contain-intrinsic-size:auto 10rem` 同值（10rem = 160 px）。 */
const INTRINSIC_HEIGHT = 160;
/** 与 `MessageList.vue:314` 的 fallback 同量级；实测短行 ~45 px（BL-603 结案读数）。 */
const BASE_HEIGHT_MIN = 45;
const BASE_HEIGHT_MAX = 90;
const VIEWPORT_HEIGHT = 640;
/**
 * "靠近视口"的判定带宽（= 1 屏）。真实 Chrome 用视口相关边距，本桩取保守固定值并在此声明。
 * **这是全实验唯一没有出处的参数**（证据包 §8.1）⇒ 必须做 320/640/1280 三档敏感度扫描：
 * 用 `XH_BL602_E1_BAND=320|640|1280` 分别跑一次同一 spec；默认 640 = 预注册主档。
 */
const DEFAULT_FLIP_BAND = 640;
const FLIP_BAND = Number(process.env.XH_BL602_E1_BAND ?? DEFAULT_FLIP_BAND) || DEFAULT_FLIP_BAND;
const OVERSCAN = 6;
const FRAMES = 300;
const PREPENDS = 5;
const PAGE_SIZE = 50;
const INITIAL_MESSAGES = 500;
const SEEDS = [602, 603, 604] as const;
type Arm = "flip" | "constant" | "zero";
const ARMS: readonly Arm[] = ["flip", "constant", "zero"];

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

const i18n = createI18n({
    legacy: false,
    locale: "zh",
    messages: {
        zh: {
            workspace: { participantUnknownName: "未知用户" },
            chat: {
                runHeader: { toggle: "展开或折叠 run {run}" },
                followUpStatusCompleted: "已完成",
                followUpStatusFailed: "失败",
                loadOlder: "加载更早的消息",
                loadingOlder: "正在加载更早的消息…",
                foldedOlder: "更早的 {count} 条消息已折叠，点击加载",
            },
        },
    },
});

/** 固定 seed 的 PRNG（mulberry32）—— 三个 seed 各自可复算。 */
function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
}

function buildMessages(from: number, count: number): Message[] {
    return Array.from({ length: count }, (_, offset) => {
        const index = from + offset;
        return {
            id: `bl602-msg-${index}`,
            sessionId: "bl602-e1",
            role: index % 2 === 0 ? "user" : "assistant",
            content: `bl602-row-${index}`,
            timestamp: "2026-11-12T10:00:00.000Z",
            // 单 runId ⇒ 不分组（rows = 消息数 + 1 个日期分隔）
            runId: "run-1",
        } as unknown as Message;
    });
}

const ALL_MESSAGES = buildMessages(0, INITIAL_MESSAGES + PREPENDS * PAGE_SIZE);

interface LayoutState {
    scrollTop: number;
    writes: number;
    lastWriteFrame: number;
}

interface Cell {
    arm: Arm;
    seed: number;
    band: number;
    writeFrames: number;
    maxConsecutiveWriteFrames: number;
    scrollHeightDrift: number;
    totalWrites: number;
    heightChanges: number;
    prependWrites: number;
    frames: number;
}

const CELLS: Cell[] = [];

/** 跑一帧（真实 rAF；jsdom 的 rAF ≈ 16 ms/帧，与既有 MessageListVirtual.spec.ts 同口径）。 */
function nextFrame(): Promise<void> {
    return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

async function runCell(arm: Arm, seed: number): Promise<Cell> {
    const random = mulberry32(seed);
    const baseHeights = Array.from(
        { length: ALL_MESSAGES.length + 1 },
        () => BASE_HEIGHT_MIN + random() * (BASE_HEIGHT_MAX - BASE_HEIGHT_MIN),
    );
    const prefix: number[] = [0];
    for (let index = 0; index < baseHeights.length; index += 1) {
        prefix.push(prefix[index] + baseHeights[index]);
    }

    const state: LayoutState = { scrollTop: 0, writes: 0, lastWriteFrame: -1 };
    let currentFrame = -1;

    const baseHeightAt = (index: number): number =>
        baseHeights[Math.max(0, Math.min(baseHeights.length - 1, index))];

    /** 行高模型：flip 臂按"是否靠近视口"在 160 与实测值之间翻转。 */
    const modelHeightAt = (index: number): number => {
        const base = baseHeightAt(index);
        if (arm === "zero") return 0;
        if (arm === "constant") return base;
        const position = prefix[index] - state.scrollTop;
        const near = position + base > -FLIP_BAND && position < VIEWPORT_HEIGHT + FLIP_BAND;
        return near ? base : INTRINSIC_HEIGHT;
    };

    const originalRect = Element.prototype.getBoundingClientRect;
    const originalScrollTo = (Element.prototype as unknown as { scrollTo?: Element["scrollTo"] })
        .scrollTo;
    const hadOwnClientHeight = Object.prototype.hasOwnProperty.call(
        HTMLElement.prototype,
        "clientHeight",
    );
    const hadOwnOffsetHeight = Object.prototype.hasOwnProperty.call(
        HTMLElement.prototype,
        "offsetHeight",
    );

    let viewport: HTMLElement | null = null;

    // 桩：几何。所有 rect.top 固定 0（有意隔离 W2/W3，见文件头「隔离声明」）。
    Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
        const element = this as HTMLElement;
        const rawIndex = element.dataset.virtualIndex;
        const index = rawIndex === undefined ? Number.NaN : Number(rawIndex);
        const height = Number.isFinite(index) ? modelHeightAt(index) : 0;
        return {
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: 100,
            bottom: height,
            width: 100,
            height,
            toJSON() {
                return {};
            },
        } as DOMRect;
    };

    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
        configurable: true,
        get: () => VIEWPORT_HEIGHT,
    });

    // 桩：offsetHeight 是 `useVirtualMessageWindow.ts:196` 的测量门（<=0 直接跳过）。
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
        configurable: true,
        get(this: HTMLElement) {
            const rawIndex = this.dataset.virtualIndex;
            if (rawIndex === undefined) return 0;
            return modelHeightAt(Number(rawIndex));
        },
    });

    // 桩：库与 commands 都走 `element.scrollTo({top})`（virtual-core `scrollToFn` 默认实现）；
    // 把它路由回本元素的 scrollTop，写入才可被计数。
    (Element.prototype as unknown as { scrollTo: unknown }).scrollTo = function scrollTo(
        this: Element,
        options?: ScrollToOptions,
    ): void {
        const top = typeof options === "number" ? options : (options?.top ?? 0);
        if (this === viewport) {
            (this as HTMLElement).scrollTop = top;
        }
    };

    const wrapper = mount(MessageList, {
        props: { messages: ALL_MESSAGES.slice(PREPENDS * PAGE_SIZE) },
        global: {
            plugins: [i18n, createPinia()],
            stubs: {
                MessageSearch: true,
                Marker: { template: "<div><slot /></div>" },
                RunGroupHeader: true,
                MessageItem: {
                    props: ["message"],
                    template: `<div data-testid="stub-message">{{ message.id }}</div>`,
                },
            },
        },
    });

    try {
        await nextTick();
        await nextTick();
        viewport = wrapper.get('[data-testid="message-scroller-viewport"]').element as HTMLElement;

        // scrollTop 后备值 + 写计数（jsdom 的 scrollTop setter 是 no-op）。
        let top = 0;
        Object.defineProperty(viewport, "scrollTop", {
            configurable: true,
            get: () => top,
            set: (value: number) => {
                if (value === top) return;
                top = value;
                state.scrollTop = value;
                state.writes += 1;
                state.lastWriteFrame = currentFrame;
            },
        });

        // 与真实 DOM 同构的 scrollHeight：顶占位 + 已渲染行（按模型）+ 底占位。
        const viewportElement = viewport;
        Object.defineProperty(viewportElement, "scrollHeight", {
            configurable: true,
            get(this: HTMLElement) {
                const spacer = (testId: string): number => {
                    const node = this.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
                    return node ? Number.parseFloat(node.style.height || "0") || 0 : 0;
                };
                let rendered = 0;
                for (const row of this.querySelectorAll<HTMLElement>(
                    '[data-slot="message-scroller-item"]',
                )) {
                    const rawIndex = row.dataset.virtualIndex;
                    rendered += rawIndex === undefined ? 0 : modelHeightAt(Number(rawIndex));
                }
                return spacer("virtual-top-spacer") + rendered + spacer("virtual-bottom-spacer");
            },
        });

        // 视口高度/滚动读数接上（attach 已在 onMounted 后完成，这里只需把 scrollTop 摆到中部）。
        top = Math.max(0, prefix[Math.min(prefix.length - 1, INITIAL_MESSAGES)] * 0.5);
        state.scrollTop = top;
        viewportElement.dispatchEvent(new Event("scroll"));
        await nextTick();
        await nextFrame();
        await nextTick();

        // —— 5 次 prepend（每次 +50 行更旧的消息）——
        const prependStartWrites = state.writes;
        for (let round = 1; round <= PREPENDS; round += 1) {
            const start = (PREPENDS - round) * PAGE_SIZE;
            const pending = wrapper.setProps({ messages: ALL_MESSAGES.slice(start) });
            for (let tick = 0; tick < 4; tick += 1) await nextTick();
            await nextFrame();
            await pending;
        }
        for (let tick = 0; tick < 4; tick += 1) await nextTick();
        const prependWrites = state.writes - prependStartWrites;

        // —— 300 帧观测：不再改数据；只在 scrollTop 变化后模拟浏览器异步派发 scroll ——
        const samples: Array<{ writes: number; scrollHeight: number }> = [];
        const heightSnapshots: Array<Map<number, number>> = [];
        let lastNotified = state.scrollTop;
        let writeFrames = 0;
        let maxConsecutive = 0;
        let consecutive = 0;

        for (let frame = 0; frame < FRAMES; frame += 1) {
            currentFrame = frame;
            await nextFrame();
            await nextTick();
            if (state.scrollTop !== lastNotified) {
                lastNotified = state.scrollTop;
                viewportElement.dispatchEvent(new Event("scroll"));
                await nextTick();
            }
            const writes = state.writes;
            const previousWrites =
                samples.length === 0
                    ? prependStartWrites + prependWrites
                    : samples[samples.length - 1].writes;
            const wrote = writes > previousWrites;
            if (wrote) {
                writeFrames += 1;
                consecutive += 1;
                maxConsecutive = Math.max(maxConsecutive, consecutive);
            } else {
                consecutive = 0;
            }
            samples.push({ writes, scrollHeight: viewportElement.scrollHeight });

            const snapshot = new Map<number, number>();
            for (const row of viewportElement.querySelectorAll<HTMLElement>(
                '[data-slot="message-scroller-item"]',
            )) {
                const rawIndex = row.dataset.virtualIndex;
                if (rawIndex !== undefined)
                    snapshot.set(Number(rawIndex), modelHeightAt(Number(rawIndex)));
            }
            heightSnapshots.push(snapshot);
        }

        // 高度翻转计数：相邻帧同一行的模型高度变化次数（arm flip 必须 > 0，arm constant 必须 = 0）。
        let heightChanges = 0;
        for (let frame = 1; frame < heightSnapshots.length; frame += 1) {
            const previous = heightSnapshots[frame - 1];
            for (const [index, height] of heightSnapshots[frame]) {
                const before = previous.get(index);
                if (before !== undefined && before !== height) heightChanges += 1;
            }
        }

        const scrollHeights = samples.map((sample) => sample.scrollHeight);
        const scrollHeightDrift = Math.max(...scrollHeights) - Math.min(...scrollHeights);

        // —— 桩自身生效判据（**不断言判定结果**，只断言桩按设计工作）——
        expect(
            wrapper.find('[data-testid="virtual-top-spacer"]').exists(),
            "前置：窗口化必须生效（top spacer 存在），否则本实验测不到库测量路径",
        ).toBe(true);
        const renderedRows = wrapper.findAll('[data-slot="message-scroller-item"]').length;
        expect(renderedRows, "前置：窗口必须小于全表（否则不是窗口化）").toBeLessThan(200);
        expect(renderedRows, "前置：窗口不能为空").toBeGreaterThan(0);
        if (arm === "flip") {
            expect(heightChanges, "arm flip 必须真的发生高度翻转（否则桩没生效）").toBeGreaterThan(
                0,
            );
        }
        if (arm === "constant") {
            expect(heightChanges, "arm constant 不得发生高度翻转").toBe(0);
        }
        if (arm === "zero") {
            expect(heightChanges, "arm zero 的模型高度恒 0 ⇒ 不得有翻转计数").toBe(0);
        }
        expect(state.writes, "写入计数必须真的工作（prepend 帧至少要写一次）").toBeGreaterThan(0);

        return {
            arm,
            seed,
            band: FLIP_BAND,
            writeFrames,
            maxConsecutiveWriteFrames: maxConsecutive,
            scrollHeightDrift,
            totalWrites: state.writes,
            heightChanges,
            prependWrites,
            frames: FRAMES,
        };
    } finally {
        wrapper.unmount();
        Element.prototype.getBoundingClientRect = originalRect;
        if (originalScrollTo) Element.prototype.scrollTo = originalScrollTo;
        else delete (Element.prototype as { scrollTo?: Element["scrollTo"] }).scrollTo;
        if (!hadOwnClientHeight) {
            delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
        }
        if (!hadOwnOffsetHeight) {
            delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
        }
    }
}

describe("BL-602 E1：content-visibility 高度翻转 × 库首测补偿（桩模型）", () => {
    for (const arm of ARMS) {
        for (const seed of SEEDS) {
            it(`arm=${arm} seed=${seed}：采集 ${FRAMES} 帧读数`, async () => {
                const cell = await runCell(arm, seed);
                CELLS.push(cell);
            }, 180_000);
        }
    }

    it("9 格读数齐全并打印判定表（判定由证据包按预注册规则执行）", async () => {
        expect(CELLS.length, "3 臂 × 3 seed 必须各采集一格").toBe(ARMS.length * SEEDS.length);
        const table = CELLS.map((cell) => ({
            arm: cell.arm,
            seed: cell.seed,
            band: cell.band,
            有写帧占比: Number((cell.writeFrames / cell.frames).toFixed(3)),
            最长连续写帧: cell.maxConsecutiveWriteFrames,
            "scrollHeight 漂移(px)": Math.round(cell.scrollHeightDrift),
            总写次数: cell.totalWrites,
            "prepend 期写次数": cell.prependWrites,
            高度翻转次数: cell.heightChanges,
        }));
        // 判定规则（预注册，见证据包 §4 E1）：A 臂 3 seed 全部达标 且 B/C 臂全部达标 ⇒ M2 准入。
        const flipCells = CELLS.filter((cell) => cell.arm === "flip");
        const controlCells = CELLS.filter((cell) => cell.arm !== "flip");
        const admitted =
            flipCells.length === SEEDS.length &&
            flipCells.every(
                (cell) =>
                    cell.writeFrames / cell.frames >= 0.2 &&
                    cell.maxConsecutiveWriteFrames >= 30 &&
                    cell.scrollHeightDrift >= 100,
            ) &&
            controlCells.every(
                (cell) =>
                    cell.writeFrames / cell.frames <= 0.05 &&
                    cell.maxConsecutiveWriteFrames <= 5 &&
                    cell.scrollHeightDrift <= 10,
            );
        // 带宽扫描档（非 640 主档）只产出敏感度读数，不产出准入判定 —— 准入只看预注册主档 640。
        const isMainBand = FLIP_BAND === DEFAULT_FLIP_BAND;
        const verdict = isMainBand
            ? admitted
                ? "M2_ADMITTED"
                : "M2_NOT_ADMITTED"
            : `BAND_SWEEP_${FLIP_BAND}`;
        console.log(
            `[BL-602 E1] band=${FLIP_BAND} verdict=${verdict}\n` + JSON.stringify(table, null, 2),
        );
        const outputPath = process.env.XH_BL602_E1_OUT;
        if (outputPath) {
            // 证据目录消费的可选出口（未设 env 时只打印，不落盘）。
            const fs = await import("node:fs");
            fs.writeFileSync(
                outputPath,
                JSON.stringify(
                    { band: FLIP_BAND, verdict, table, at: new Date().toISOString() },
                    null,
                    2,
                ),
                "utf8",
            );
        }
        expect(table.length).toBe(ARMS.length * SEEDS.length);
    });
});
