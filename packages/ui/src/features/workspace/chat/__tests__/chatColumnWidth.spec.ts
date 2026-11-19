import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * task-130 / D-1910（2026-11-20 用户裁定「能固化成用例的都固化」）：会话单列列宽。
 *
 * 契约：单列 fluid-then-cap —— 先流式、到上限封顶。四处（composer 内层 / 消息列 /
 * 跟进队列 / 团队看板）共用同一个列宽基数 min(父宽, --chat-column-max)，
 * 气泡另有可读性上限 --chat-bubble-max（宽屏 lg 档）；md 档仍是 75%，两档不得合并。
 *
 * 断言层级：jsdom 不加载产品 CSS、也不做层叠（test.css 未开启），getComputedStyle 拿不到
 * 真实宽度；所以这里锁「token 单一定义 + 四处消费 + 旧口径不残留」三层源码契约，
 * 像素级对齐仍归真栈浏览器复测（task-130 已留读数）。
 * 同类先例：chatBubbleTypography.spec.ts（字阶 token 的唯一性）。
 */

const uiRoot = process.cwd();
const readSource = (relativePath: string): string =>
    readFileSync(resolve(uiRoot, relativePath), "utf8");

/**
 * D-1910 的期望值：**只在这里写一次**。
 *
 * 消费点断言只引用 token 名、不引用字面量 —— 以后调上限只改这一处；
 * 若把 96rem 抄到多个断言里，改值时必然漏一处（这正是两套栅格年代的成因）。
 */
const COLUMN_MAX = "96rem";
const BUBBLE_MAX = "44em";

const COLUMN = "--chat-column-max";
const BUBBLE = "--chat-bubble-max";

/** 旧口径族：列宽写死 896（max-w-4xl）或用 100% - 2rem 拼宽度。 */
const LEGACY_WIDTHS = [
    "max-w-4xl",
    "w-[calc(100%_-_2rem)]",
    "max-w-[896px]",
    "w-[calc(100%-2rem)]",
] as const;

const COLUMN_CONSUMERS = [
    { path: "src/features/workspace/chat/components/InputArea.vue", where: "composer 内层" },
    { path: "src/features/workspace/chat/components/MessageList.vue", where: "消息列根" },
    { path: "src/features/workspace/chat/components/FollowUpQueuePanel.vue", where: "跟进队列" },
    { path: "src/features/workspace/chat/components/TeamBoardPanel.vue", where: "团队看板" },
] as const;

const MESSAGE_ITEM = "src/features/workspace/chat/components/MessageItem.vue";

/**
 * 取**全部**匹配规则的声明块（按出现顺序）。
 *
 * 与 chatBubbleTypography.spec.ts 同形（task-362）：main.css 现在有不止一处顶层 :root，
 * token 定义在第几处 :root 不是契约内容，所以取块方式必须与块数无关。
 */
function declarationBlocks(css: string, selector: string): string[] {
    const blocks: string[] = [];
    let from = 0;
    for (;;) {
        const open = css.indexOf(`${selector} {`, from);
        if (open < 0) return blocks;
        let depth = 0;
        let end = -1;
        for (let index = open + selector.length; index < css.length; index += 1) {
            if (css[index] === "{") depth += 1;
            else if (css[index] === "}") {
                depth -= 1;
                if (depth === 0) {
                    end = index;
                    break;
                }
            }
        }
        if (end < 0) throw new Error(`样式契约解析失败：${selector} 的声明块未闭合`);
        blocks.push(css.slice(open, end + 1));
        from = end + 1;
    }
}

/** 取源码里所有静态 class 属性的值（单/多行均可，模板字符串除外）。 */
function classAttributes(source: string): string[] {
    return [...source.matchAll(/\bclass="([^"]*)"/g)].map((match) => match[1] as string);
}

/** 该文件里消费了指定 token 的 class 属性值（不含注释里提到的）。 */
function classesUsingToken(source: string, token: string): string[] {
    const needle = `max-w-(${token})`;
    return classAttributes(source).filter((value) => value.includes(needle));
}

describe("chat column width（D-1910 / task-130）", () => {
    it("main.css 在 :root 单点定义列宽与气泡上限，值就是 D-1910 的取值", () => {
        const main = readSource("src/styles/main.css");
        const roots = declarationBlocks(main, ":root").join("\n");
        expect(roots.length, "main.css 至少要有一处顶层 :root").toBeGreaterThan(0);
        expect(roots, "列宽 token 缺失或值漂移").toContain(`${COLUMN}: ${COLUMN_MAX}`);
        expect(roots, "气泡上限 token 缺失或值漂移").toContain(`${BUBBLE}: ${BUBBLE_MAX}`);

        // 不变量：两个 token 全站只定义一次 —— 以后有人按主题/断点重定义，这里会红。
        expect(
            main.match(/--chat-column-max:\s/g)?.length ?? 0,
            `${COLUMN} 只能定义一次（当前 main.css 里出现了多次）`,
        ).toBe(1);
        expect(
            main.match(/--chat-bubble-max:\s/g)?.length ?? 0,
            `${BUBBLE} 只能定义一次（当前 main.css 里出现了多次）`,
        ).toBe(1);
    });

    for (const { path, where } of COLUMN_CONSUMERS) {
        it(`${where}共用列宽基数：mx-auto + max-w-(${COLUMN})`, () => {
            const source = readSource(path);
            const using = classesUsingToken(source, COLUMN);
            expect(
                using.length,
                `${where}（${path}）没有消费 max-w-(${COLUMN})：四处必须共用同一个列宽基数`,
            ).toBe(1);
            expect(
                using[0],
                `${where}（${path}）的列宽容器必须同时带 mx-auto，否则封顶后不居中`,
            ).toContain("mx-auto");
        });

        it(`${where}不残留旧口径（896 / 100%-2rem）`, () => {
            const source = readSource(path);
            for (const legacy of LEGACY_WIDTHS) {
                expect(
                    source,
                    `${where}（${path}）仍残留旧口径 ${legacy}：列宽必须只走 ${COLUMN}`,
                ).not.toContain(legacy);
            }
            expect(
                source,
                `${where}（${path}）不得自己重定义 ${COLUMN}（token 只许在 main.css 定义）`,
            ).not.toContain(`${COLUMN}:`);
        });
    }

    it("MessageItem 气泡：lg 走 --chat-bubble-max，md 仍是 75%（两档未合并）", () => {
        const source = readSource(MESSAGE_ITEM);
        const using = classesUsingToken(source, BUBBLE);
        expect(using.length, `MessageItem 气泡容器没有消费 max-w-(${BUBBLE})`).toBe(1);

        const value = using[0] as string;
        expect(value, "气泡上限必须挂在 lg 断点上").toContain(`lg:max-w-(${BUBBLE})`);
        expect(value, "md 档必须仍是 75% 上限（两档不得合并成同一档）").toContain("md:max-w-[75%]");
        // 反向：token 一旦不带断点前缀，就等于把两档合并了。
        expect(value, "lg 的 token 不得同时以无断点形态出现（否则等于两档合并）").not.toMatch(
            /(^|\s)max-w-\(--chat-bubble-max\)/,
        );

        for (const legacy of LEGACY_WIDTHS) {
            expect(source, `MessageItem 仍残留旧列宽口径 ${legacy}`).not.toContain(legacy);
        }
        expect(
            source,
            `MessageItem 不得自行重定义 ${BUBBLE}（token 只许在 main.css 定义）`,
        ).not.toContain(`${BUBBLE}:`);
    });
});
