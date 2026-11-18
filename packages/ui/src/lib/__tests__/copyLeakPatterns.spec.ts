/**
 * 判据一致性守卫（task-57）。
 *
 * <p>9 形态有两个消费方：TS 侧（单测 / mock 车道用例）与 Node 侧（门脚本 scripts/check-copy-leak.mjs）。
 * Node 不能 import TS，所以门里必然存在第二份字面量。**有守卫的重复可以接受，无声的重复不行** ——
 * 本文件把两份逐条对齐，任一侧改了另一侧没改就红在这里，并点名是哪一条。</p>
 *
 * <p>为什么反向也要钉：只让门自己维护一份，判据就变成「门说什么算什么」，
 * 而 DEV-011 §14 的正文与单测断言会静默落后 —— 那正是 task-47 定性的「判据事故」的复发形态。</p>
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LEAK_PATTERNS, findLeaks, summarizeLeaks } from "../copyLeakPatterns";

/**
 * 门脚本与矩阵的路径。**不用 new URL(..., import.meta.url)**：vitest 经 vite 转换后
 * import.meta.url 不是 file 协议（实测 TypeError: The URL must be of scheme file），
 * 而 vitest 的 cwd 恒为本包根（pnpm run test:unit 从 packages/ui 起）。
 * readText() 会把「cwd 不对」显式报出来，不会静默读到别处的文件。
 */
const GATE = resolve("scripts/check-copy-leak.mjs");
const MATRIX = resolve("scripts/copy-leak-matrix.json");

async function readText(path: string): Promise<string> {
    try {
        return await readFile(path, "utf8");
    } catch (e) {
        throw new Error(
            "读不到 " +
                path +
                "（vitest cwd 应为 packages/ui，当前 " +
                process.cwd() +
                "）: " +
                (e as Error).message,
        );
    }
}

/** 从门脚本文本里抠出 [名字, /正则/] 形态对（只认 LEAK_PATTERNS 数组那一段）。 */
function parseGatePatterns(text: string): Array<{ name: string; source: string }> {
    const start = text.indexOf("export const LEAK_PATTERNS");
    expect(start, "门脚本里找不到 LEAK_PATTERNS —— 判据被删了？").toBeGreaterThan(-1);
    const body = text.slice(start, text.indexOf("];", start));
    const out: Array<{ name: string; source: string }> = [];
    const re = /\["([^"]+)",\s*\/(.+)\/([gimsuy]*)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
        out.push({ name: m[1] as string, source: m[2] as string });
    }
    return out;
}

describe("LEAK_PATTERNS 与门脚本逐条对齐", () => {
    it("TS 侧 9 条，顺序与命名固定", () => {
        expect(LEAK_PATTERNS).toHaveLength(9);
        expect(LEAK_PATTERNS.map((x) => x.name)).toEqual([
            "类名",
            "命令",
            "契约文件名",
            "源码 文件:行号",
            "接口路径",
            "权限原子/枚举常量",
            "内部票号",
            "内部术语 读面",
            "内部术语 契约",
        ]);
    });

    it("门脚本的正则源码与 TS 侧逐条相同（漂移即点名哪一条）", async () => {
        const gate = parseGatePatterns(await readText(GATE));
        expect(gate.length, "门脚本形态数").toBe(LEAK_PATTERNS.length);
        const drift: string[] = [];
        LEAK_PATTERNS.forEach((item, i) => {
            const g = gate[i];
            if (!g) return;
            if (g.name !== item.name)
                drift.push("#" + (i + 1) + " 名称：门=" + g.name + " / TS=" + item.name);
            if (g.source !== item.re.source)
                drift.push(
                    "#" +
                        (i + 1) +
                        " " +
                        item.name +
                        " 正则 门=" +
                        g.source +
                        " / TS=" +
                        item.re.source,
                );
        });
        expect(drift, "两侧判据漂移: " + drift.join(" ; ")).toEqual([]);
    });

    it("门脚本用 g 旗标（否则同形态多次会少算）", async () => {
        expect(await readText(GATE)).toContain('new RegExp(re.source, "g"');
    });

    it("矩阵可读且每面都有 route", async () => {
        const matrix = JSON.parse(await readText(MATRIX));
        expect(Array.isArray(matrix.surfaces)).toBe(true);
        expect(matrix.surfaces.length).toBeGreaterThan(0);
        for (const s of matrix.surfaces) expect(typeof s.route).toBe("string");
    });
});

describe("findLeaks 本身（判据不能只靠别人测它）", () => {
    it("干净文本 0 命中", () => {
        expect(findLeaks("知识库暂不可用；这里只读列出本工作区自建的技能定义。")).toEqual([]);
    });

    it("点名形态与命中串，同形态多次只列一次样本", () => {
        const hits = findLeaks(
            "RagProxyController 与 RagProxyService 都在，grep 一下 openapi.yaml",
        );
        expect(hits.map((h) => h.name).sort()).toEqual(["命令", "契约文件名", "类名"]);
        expect(hits.find((h) => h.name === "类名")?.count).toBe(2);
        expect(hits.find((h) => h.name === "类名")?.samples).toEqual([
            "RagProxyController",
            "RagProxyService",
        ]);
    });

    it("内部票号与权限原子都咬，普通中文不咬", () => {
        expect(findLeaks("P-189-3").map((h) => h.name)).toContain("内部票号");
        expect(findLeaks("MANAGE_SKILL_LIBRARY").map((h) => h.name)).toContain("权限原子/枚举常量");
        expect(findLeaks("这条文案讲的是界面本身，没有编号也没有代码")).toEqual([]);
    });

    it("summarizeLeaks 给一行摘要", () => {
        expect(summarizeLeaks(findLeaks("grep"))).toBe("[命令] x1 -> grep");
        expect(summarizeLeaks([])).toBe("");
    });
});
