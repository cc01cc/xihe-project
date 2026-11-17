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
 * <p>**本门同时咬 `Intl.DateTimeFormat` 的「没有 locale 参数」形态**（`(undefined, …)` 与 `()`）——
 * 它与 `toLocale*` 是同一根因的另一种写法：`undefined` locale 同样落回
 * `Intl.DateTimeFormat().resolvedOptions().locale`（**浏览器**语言）。
 * `task-73` 收口时这一族被登记为**盲区**（当时实测两处：`RunTraceTimeline`、`SessionDerivedStatePanel`），
 * `task-91` 把那两处改成走 `lib/dateFormat.ts` 并把盲区改成**实检** ⇒ 现在这条门对本族也**红得起来**，
 * 盲区清零。判据形态见 `BROWSER_LOCALE_INTL` 的三条正则与它们的正/负例。</p>
 *
 * <p>**为什么不是「扫所有 `Intl.DateTimeFormat(`」**：带 locale 的构造（`new Intl.DateTimeFormat(locale.value, …)`）
 * 是显式语言，与 `toLocaleString("zh-CN")` 同性质，不在禁令内；而 `Intl.DateTimeFormat().resolvedOptions().timeZone`
 * 读的是**时区**不是语言（`ScheduledTaskCreateDialog` 的排程初值用它），也豁免 —— 唯一剩下的裸读是
 * `resolvedOptions().locale`，它确实属于本族，故只在 `.timeZone` 上开豁免口子。</p>
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

/**
 * 无参 `toLocaleString()`：有参形态（`toLocaleString("zh-CN")`）是显式语言，不在禁令内。
 *
 * <p>后三条同族：`Intl.DateTimeFormat` **不带 locale 参数**的两种写法 —— `(undefined, …)` 与 `()`。
 * 它们同样落回浏览器 locale（`task-91` 之前是登记在册的盲区，现在是实检）。</p>
 *
 * <p>第三条的正则带一个**负向先行**：`Intl.DateTimeFormat().resolvedOptions().timeZone` 读的是
 * **时区**、不是语言（排程新建弹窗拿它当默认时区），不属本族。同一处链上的 `.locale` 是裸读语言，
 * 所以要报 —— 先行只放过 `.timeZone` 这一种后继。</p>
 */
const BARE_CALLS = [
    { pattern: /\.toLocaleDateString\s*\(\s*\)/g, form: ".toLocaleDateString()" },
    { pattern: /\.toLocaleTimeString\s*\(\s*\)/g, form: ".toLocaleTimeString()" },
    { pattern: /\.toLocaleString\s*\(\s*\)/g, form: ".toLocaleString()" },
    {
        pattern: /Intl\.DateTimeFormat\s*\(\s*undefined\s*[,)]/g,
        form: "Intl.DateTimeFormat(undefined, …)",
    },
    {
        // 无参构造；只放过 `resolvedOptions().timeZone`（时区读数），其余（包括 `.locale`）都算本族。
        pattern: /Intl\.DateTimeFormat\s*\(\s*\)(?!\s*\.resolvedOptions\s*\(\s*\)\s*\.timeZone)/g,
        form: "Intl.DateTimeFormat()",
    },
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
    it("src/** 里没有裸 toLocale* 一族，也没有不带 locale 的 Intl.DateTimeFormat", () => {
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

    it("同族的 `Intl.DateTimeFormat` 无 locale 形态也红得起来（task-91 的盲区改实检）", () => {
        // 这一条不验真树（上面那条已验），只验**判据本身**：四种写法都必须命中，三种显式语言/时区读数必须不命中。
        const offendersSample = stripComments(
            [
                'new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(d);',
                "new Intl.DateTimeFormat(undefined);",
                "new Intl.DateTimeFormat();",
                "Intl.DateTimeFormat().resolvedOptions().locale;",
            ].join("\n"),
        );
        const cleanSample = stripComments(
            [
                'new Intl.DateTimeFormat(locale.value, { dateStyle: "medium" }).format(d);',
                'Intl.DateTimeFormat("zh-CN", opts).format(d);',
                "Intl.DateTimeFormat().resolvedOptions().timeZone;",
            ].join("\n"),
        );
        const hit = BARE_CALLS.filter(({ pattern }) => {
            pattern.lastIndex = 0;
            return new RegExp(pattern.source).test(offendersSample);
        }).map((entry) => entry.form);
        expect(hit).toEqual(["Intl.DateTimeFormat(undefined, …)", "Intl.DateTimeFormat()"]);
        for (const { pattern } of BARE_CALLS) {
            expect(new RegExp(pattern.source).test(cleanSample), pattern.source).toBe(false);
        }
    });
});
