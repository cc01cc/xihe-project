import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `task-73` 的反回归机器门：`src/**` 里**不许**再出现「用浏览器 locale 渲染日期」的调用。
 *
 * <p>为什么需要一条源码扫描而不是只测行为：真因不是「格式不对」，而是**语言轴与日期轴分离**。
 * `new Date(x).toLocaleString()` / `.toLocaleDateString()` / `.toLocaleTimeString()` 不带 locale
 * 时读的是 `Intl.DateTimeFormat().resolvedOptions().locale`（**浏览器**语言），不是界面语言
 * （`i18n.global.locale`）。这类调用**在英文机器上看起来完全正确**，所以行为测试抓不住它：
 * 二十处旧调用点当时没有一处被单测判红。唯一能挡住回归的是在源码层禁掉这种写法，
 * 要求一律走 `src/lib/dateFormat.ts`。</p>
 *
 * <p>**本门只咬 `toLocale*` 一族，不咬裸 `Intl.DateTimeFormat(undefined, …)`** —— 后者是同一根因的另一个
 * 写法（`undefined` locale 同样落回浏览器 locale），但 `task-73` 的 21 处里没有它；留作已知盲区，
 * 现状实测仍有两处（`features/workspace/monitor/RunTraceTimeline.vue:27`、
 * `features/workspace/chat/components/SessionDerivedStatePanel.vue:30`），已在收据里报给 Lead，
 * 未擅自扩大改动面。**盲区写在门里**，否则下一个人会以为「门绿 = 全仓没有浏览器 locale 渲染」。</p>
 *
 * <p>豁免只有两处，都**不是**用户可见日期：`lib/logger.ts`（控制台日志前缀，固定 `zh-CN` 是有意的，
 * 日志不是产品文案）与 `lib/dateFormat.ts`（唯一入口自身，其文档注释里必须提到旧写法）。
 * 另加 `components/settings/ProviderHub.vue` 的 `Number#toLocaleString()`
 * （数字千分位、语言无关，不在本卡的日期轴内）。</p>
 */

const SRC = resolve(process.cwd(), "src");

/** 豁免清单一律带理由；下面的用例会校验这些文件真实存在（防止清单腐烂）。 */
const ALLOWED = new Map<string, string>([
    ["lib/logger.ts", "控制台日志前缀：固定 zh-CN 是有意的，日志不是产品文案"],
    ["lib/dateFormat.ts", "唯一入口本体：文档注释里必须能提到旧写法"],
    ["components/settings/ProviderHub.vue", "Number#toLocaleString() 千分位：数字轴，与日期轴无关"],
    [
        "lib/__tests__/dateFormatGate.spec.ts",
        "反回归门自身：负例必须把这些形态**写成字符串**才验得出正则没写错；它是测试文件，不渲染任何界面",
    ],
]);

/** 去掉注释后再扫：注释里提到旧写法（比如本文件的说明）不算违规。 */
function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            return entry.name === "node_modules" ? [] : sourceFiles(full);
        }
        return /\.(ts|vue)$/.test(entry.name) ? [full] : [];
    });
}

/** 无参 `toLocaleString()`：有参形态（`toLocaleString("zh-CN")`）是显式语言，不在禁令内。 */
const BARE_CALLS = [
    { pattern: /\.toLocaleDateString\s*\(\s*\)/g, form: ".toLocaleDateString()" },
    { pattern: /\.toLocaleTimeString\s*\(\s*\)/g, form: ".toLocaleTimeString()" },
    { pattern: /\.toLocaleString\s*\(\s*\)/g, form: ".toLocaleString()" },
];

function offenders(): string[] {
    const found: string[] = [];
    for (const file of sourceFiles(SRC)) {
        const rel = relative(SRC, file).replace(/\\/g, "/");
        if (ALLOWED.has(rel)) continue;
        const code = stripComments(readFileSync(file, "utf8"));
        for (const { pattern, form } of BARE_CALLS) {
            const matches = code.match(pattern);
            if (matches) found.push(rel + " -> " + form + " x" + String(matches.length));
        }
    }
    return found;
}

describe("日期渲染反回归门（task-73）", () => {
    it("src/** 里没有裸 toLocaleString / toLocaleDateString / toLocaleTimeString", () => {
        expect(offenders()).toEqual([]);
    });

    it("豁免清单里的文件都还在（清单不长草）", () => {
        const missing: string[] = [];
        for (const rel of ALLOWED.keys()) {
            try {
                readFileSync(join(SRC, rel), "utf8");
            } catch {
                missing.push(rel);
            }
        }
        expect(missing).toEqual([]);
    });

    it("扫描器本身能识别违规（负例：临时拼一份源码字符串再过同一个判定）", () => {
        // 正例与负例走**同一个**正则集合，证明上面那条绿灯不是「正则写错了但恰好没命中」。
        const bad = stripComments(
            "const a = new Date(x).toLocaleString();\nconst b = d.toLocaleDateString();\n",
        );
        const hits = BARE_CALLS.filter(({ pattern }) => {
            pattern.lastIndex = 0;
            return new RegExp(pattern.source).test(bad);
        });
        expect(hits.map((hit) => hit.form)).toEqual([".toLocaleDateString()", ".toLocaleString()"]);
        const good = stripComments('formatDateTime(x);\nnew Date(x).toLocaleString("zh-CN");\n');
        for (const { pattern } of BARE_CALLS) {
            expect(new RegExp(pattern.source).test(good), pattern.source).toBe(false);
        }
    });
});
