/**
 * 机器判据：对话框宽度业务值必须能覆盖 vendor 默认值（`task-98`）。
 *
 * <p><b>机制（不是风格偏好）</b>：vendor `src/components/ui/dialog/DialogContent.vue` 的默认 class 里
 * 宽度是**带响应式变体**的 `sm:max-w-sm`（384px）；`src/components/ui/alert-dialog/AlertDialogContent.vue`
 * 同形（`data-[size=default]:sm:max-w-sm`）。宽度合并走 `src/lib/utils.ts` 的 `cn` = `twMerge(clsx(...))`，
 * 而 **twMerge 只在同一条变体通道里互相覆盖** —— 业务裸写 `max-w-2xl` 时两条不算冲突、都留在 class 上，
 * ≥640px 时 `sm:max-w-sm` 胜出 ⇒ 业务意图被静默压成 384px：内容按窄宽度 reflex 折行、高度翻倍、
 * 底部按钮掉出视口（`task-98` 的改前/改后读数在回执里，本注释不复制会随滚动容器变动的数值 —— D-1767）。
 * 只有同通道的 `sm:max-w-*` 才会把 `sm:max-w-sm` 换掉。</p>
 *
 * <p><b>判据</b>：`<DialogContent>` / `<AlertDialogContent>` 的**静态** class 里出现裸 `max-w-*` 时，
 * 同一标签上必须同时有**至少一个** `sm:max-w-*`。</p>
 *
 * <p><b>为什么是「至少一个同通道」而不是「同值」</b>：`max-w-lg sm:max-w-2xl` 是合法的响应式意图
 * （窄屏 512 / ≥640 宽 672），twMerge 实测两条都保留。真正要防的是**完全没有 sm: 对家**这个状态，
 * 那才是 vendor 默认值取胜的唯一条件。同值写法（`max-w-2xl sm:max-w-2xl`）是当前主流形，不是判据要求。</p>
 *
 * <p><b>为什么要连「有 sm: 但对家更窄」一起判</b>：只判「没有 sm: 对家」时，写 `max-w-2xl sm:max-w-sm`
 * 就能让判据变绿而缺陷原样保留（`sm:max-w-sm` 正是 vendor 那个值）—— 那是「改断言让它绿」的同一个形态，
 * 不是修好。故：裸值 ≥384px 且同通道对家更窄 ⇒ 也红（裸值在 ≥640px 永远不生效 = 死值）。反向形态
 * （`max-w-xs sm:max-w-2xl`，窄屏小、宽屏大）不受影响；任意值 `max-w-[…]` 静态比不了，不判。</p>
 *
 * <p><b>没有豁免表</b>：`src/**` 全部 `.vue` 逐文件扫。唯一不进判定的路径是两个 vendor 原语目录
 * （`components/ui/dialog`、`components/ui/alert-dialog`）—— 那里是**判据的成因本身**（默认值就写在那儿），
 * 不是被判的调用方。除此之外不因「这个文件是别人的」「它历史上就写对了」而放行。</p>
 *
 * <p><b>判据不覆盖什么（写清而不是装作覆盖了）</b>：</p>
 * <ol>
 *   <li><b>动态 class</b>：`:class="cn(...)"` 里的宽度静态不可判 ⇒ 只计数、不判定。静态字符串形态
 *       （`class="…"`、`:class="'…'"`、无插值模板字面量）照判，堵掉「换个写法就绕过」。</li>
 *   <li><b>高度与可达性</b>：宽度对了不等于装得进视口 —— `RoleEditorDialog` 宽度修好后内容总量仍远超
 *       单屏（原子清单很长），所以它另加了 `max-h-[85vh] overflow-y-auto`（与 `WorkspaceCreateDialog`、
 *       `ScheduledTaskCreateDialog` 同形）。这一半只能靠浏览器读数验，静态扫描证明不了，本文件不假装能证。</li>
 * </ol>
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");

/**
 * 宽度默认值带响应式变体的两个 vendor 元素（机制入口）。
 * 同时登记 kebab-case 拼法：Vue 里 `<dialog-content>` 也能挂同一个组件，只认 PascalCase 会留一个
 * 「换个写法就绕过」的缺口。
 */
const WIDTH_BEARING_ELEMENTS = [
    "DialogContent",
    "AlertDialogContent",
    "dialog-content",
    "alert-dialog-content",
] as const;

/** vendor 原语本体（判据的成因，不是判据对象）—— 除这两个目录外没有放行。 */
const PRIMITIVE_DIRS = ["components/ui/dialog", "components/ui/alert-dialog"] as const;

export interface Finding {
    file: string;
    line: number;
    element: string;
    detail: string;
}

export interface ScanReport {
    files: number;
    elements: number;
    dynamicElements: number;
    findings: Finding[];
}

interface OpeningTag {
    tag: string;
    line: number;
}

function vueFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === "node_modules" ? [] : vueFiles(full);
        return entry.name.endsWith(".vue") ? [full] : [];
    });
}

/**
 * 取开标签原文：从 `<Name` 起**按引号状态**扫到第一个不在引号内的 `>`。
 * 属性跨行（`class` 单独占一行）与属性值里含 `>` 都成立。
 */
function openingTags(text: string, name: string): OpeningTag[] {
    const tags: OpeningTag[] = [];
    const needle = "<" + name;
    let from = 0;
    while (true) {
        const start = text.indexOf(needle, from);
        if (start < 0) break;
        const next = text[start + needle.length] ?? "";
        if (!/\s|>|\//.test(next)) {
            from = start + needle.length;
            continue;
        }
        let quote: string | null = null,
            end = -1;
        for (let i = start; i < text.length; i += 1) {
            const ch = text[i];
            if (quote) {
                if (ch === quote) quote = null;
                continue;
            }
            if (ch === "'" || ch === '"') {
                quote = ch;
                continue;
            }
            if (ch === ">") {
                end = i + 1;
                break;
            }
        }
        if (end < 0) break;
        tags.push({
            tag: text.slice(start, end),
            line: text.slice(0, start).split(/\r?\n/).length,
        });
        from = end;
    }
    return tags;
}

/**
 * 取标签上的**静态** class 值：`class="…"`，以及 `:class="'…'"` / `:class="`…`"`（无插值）。
 * 动态表达式（`cn(...)`、含插值的模板字面量）记为 `dynamic: true` ⇒ 由调用方只计数、不判定。
 */
function staticClassValues(tag: string): { values: string[]; dynamic: boolean } {
    const values: string[] = [];
    let dynamic = false;
    // 两种引号都认：oxfmt 不重写模板里的属性引号，只认双引号会留一个可绕过的缺口。
    for (const match of tag.matchAll(/(?<![:@\w-])class=(?:"([^"]*)"|'([^']*)')/g)) {
        values.push(match[1] ?? match[2] ?? "");
    }
    for (const match of tag.matchAll(/(?<![:@\w-]):class=(?:"([^"]*)"|'([^']*)')/g)) {
        const raw = (match[1] ?? match[2] ?? "").trim();
        const literal = stringLiteral(raw);
        if (literal === null) dynamic = true;
        else values.push(literal);
    }
    return { values, dynamic };
}

/** 只认无插值的静态字符串字面量（单引号 / 双引号换皮 / 反引号）；其余返回 null。 */
function stringLiteral(raw: string): string | null {
    for (const quote of ["'", '"', "`"]) {
        if (raw.length < 2 || raw[0] !== quote || raw[raw.length - 1] !== quote) continue;
        const inner = raw.slice(1, -1);
        if (inner.includes("$") || inner.includes("\\") || inner.includes(quote)) return null;
        return inner;
    }
    return null;
}

/**
 * 容器刻度**从装好的 tailwindcss 的 `theme.css` 读**，不在本文件抄一张 px 表 —— 抄表会随升级静默过期
 * （D-1767）。这里只比较 **rem 数值**（同一条轴，root 字号影响被约掉），所以永远不需要 `16px` 这个常数。
 * 读不到 theme.css ⇒ 判据没有事实源，**直接抛**（不静默降级成「一律放行」）。
 */
const CONTAINER_REM: Record<string, number> = (() => {
    const themeCss = createRequire(import.meta.url).resolve("tailwindcss/theme.css");
    const rem: Record<string, number> = {};
    for (const match of readFileSync(themeCss, "utf8").matchAll(
        /--container-([a-z0-9]+):\s*(\d+(?:\.\d+)?)rem;/g,
    )) {
        rem[match[1]] = Number(match[2]);
    }
    if (Object.keys(rem).length === 0)
        throw new Error("tailwindcss/theme.css 里没读到 --container-* 刻度");
    return rem;
})();

/** 命名刻度 token ⇒ rem；任意值（`max-w-[…]`）与 `full`/`none` 等未登记值返回 null（不判）。 */
function tokenRem(token: string, prefix: string): number | null {
    return CONTAINER_REM[token.slice(prefix.length)] ?? null;
}

export function widthFindingsForElement(
    element: string,
    classValues: string[],
    file: string,
    line: number,
): Finding[] {
    const tokens = classValues.flatMap((value) => value.split(/\s+/).filter(Boolean));
    const bare = tokens.filter((token) => token.startsWith("max-w-"));
    if (bare.length === 0) return [];
    const smTokens = tokens.filter((token) => token.startsWith("sm:max-w-"));
    if (smTokens.length === 0) {
        return bare.map((token) => ({
            file,
            line,
            element,
            detail:
                "裸 " +
                token +
                " 没有 sm: 对家 ⇒ vendor 的 sm:max-w-sm 在 ≥640px 胜出（宽度被压成 384px）",
        }));
    }
    /**
     * 有对家也不行的情况：对家比业务裸值**更窄** ⇒ 业务值在 ≥640px 被压成对家的宽度。
     * 这只咬「业务想要更宽、却在 sm: 通道收窄」这一个形态（与上面那条同一后果），
     * 不复述「同值/更宽」的合法响应式写法。任意值（`max-w-[…]`）不判 —— 静态比不了。
     */
    const narrowed: Finding[] = [];
    for (const bareToken of bare) {
        const bareRem = tokenRem(bareToken, "max-w-");
        if (bareRem === null || bareRem <= CONTAINER_REM.sm) continue;
        for (const smToken of smTokens) {
            const smRem = tokenRem(smToken, "sm:max-w-");
            if (smRem === null || smRem >= bareRem) continue;
            narrowed.push({
                file,
                line,
                element,
                detail:
                    "裸 " +
                    bareToken +
                    " 的 sm: 对家 " +
                    smToken +
                    " 更窄 ⇒ ≥640px 时业务值被压成 " +
                    smRem +
                    "rem（想「≥640 收窄」请写任意值或显式注明意图）",
            });
        }
    }
    return narrowed;
}

export function scanSource(
    text: string,
    file: string,
): {
    elements: number;
    dynamicElements: number;
    findings: Finding[];
} {
    const findings: Finding[] = [];
    let elements = 0,
        dynamicElements = 0;
    for (const element of WIDTH_BEARING_ELEMENTS) {
        for (const { tag, line } of openingTags(text, element)) {
            elements += 1;
            const { values, dynamic } = staticClassValues(tag);
            if (dynamic) dynamicElements += 1;
            if (values.length === 0) continue;
            findings.push(...widthFindingsForElement(element, values, file, line));
        }
    }
    return { elements, dynamicElements, findings };
}

export function scanRepo(root = SRC): ScanReport {
    const findings: Finding[] = [];
    let files = 0,
        elements = 0,
        dynamicElements = 0;
    for (const full of vueFiles(root)) {
        const rel = relative(root, full).replace(/\\/g, "/");
        if (PRIMITIVE_DIRS.some((dir) => rel === dir || rel.startsWith(dir + "/"))) continue;
        files += 1;
        const scanned = scanSource(readFileSync(full, "utf8"), "src/" + rel);
        elements += scanned.elements;
        dynamicElements += scanned.dynamicElements;
        findings.push(...scanned.findings);
    }
    return { files, elements, dynamicElements, findings };
}

describe("对话框宽度：业务 max-w-* 必须能在 sm: 通道覆盖 vendor 默认值（task-98）", () => {
    it("判据本体：裸 max-w 缺对家或对家更窄 ⇒ red；成对 / 仅 sm: / 窄屏小宽屏大 ⇒ green", () => {
        const bare = widthFindingsForElement("DialogContent", ["max-w-2xl"], "synthetic.vue", 10);
        expect(bare).toHaveLength(1);
        expect(bare[0].detail).toContain("max-w-2xl");
        expect(
            widthFindingsForElement(
                "DialogContent",
                ["max-h-[85vh] overflow-y-auto max-w-2xl sm:max-w-2xl"],
                "synthetic.vue",
                10,
            ),
        ).toEqual([]);
        expect(
            widthFindingsForElement("DialogContent", ["sm:max-w-md"], "synthetic.vue", 10),
        ).toEqual([]);
        expect(
            widthFindingsForElement(
                "DialogContent",
                ["max-w-lg sm:max-w-2xl"],
                "synthetic.vue",
                10,
            ),
        ).toEqual([]);
        expect(
            widthFindingsForElement("AlertDialogContent", ["max-w-2xl"], "synthetic.vue", 10),
        ).toHaveLength(1);
        // 「只判没有对家」会被 `max-w-2xl sm:max-w-sm` 绕过（对家就是 vendor 值本身）⇒ 也必须红。
        expect(
            widthFindingsForElement(
                "DialogContent",
                ["max-w-2xl sm:max-w-sm"],
                "synthetic.vue",
                10,
            ),
        ).toHaveLength(1);
        // 反向形态（窄屏小、宽屏大）是合法响应式意图，不得误伤。
        expect(
            widthFindingsForElement(
                "DialogContent",
                ["max-w-xs sm:max-w-2xl"],
                "synthetic.vue",
                10,
            ),
        ).toEqual([]);
        // 任意值不判（静态比不了 px）。
        expect(
            widthFindingsForElement(
                "DialogContent",
                ["max-w-[42rem] sm:max-w-md"],
                "synthetic.vue",
                10,
            ),
        ).toEqual([]);
    });

    it("解析面：跨行标签与静态 :class 照判；动态 :class 只计数不判定；相似元素名不误命中", () => {
        const multiLine = [
            "<DialogContent",
            '    class="max-w-lg"',
            '    data-testid="synthetic-dialog"',
            ">",
        ].join("\n");
        const multi = scanSource(multiLine, "synthetic.vue");
        expect(multi.elements).toBe(1);
        expect(multi.findings).toHaveLength(1);
        expect(
            scanSource(`<DialogContent :class="'max-w-xl'" />`, "synthetic.vue").findings,
        ).toHaveLength(1);
        const dynamic = scanSource(
            `<DialogContent :class="cn('rounded-xl! top-1/3', props.class)" />`,
            "synthetic.vue",
        );
        expect(dynamic.elements).toBe(1);
        expect(dynamic.dynamicElements).toBe(1);
        expect(dynamic.findings).toEqual([]);
        const nested = scanSource(
            "<DialogTrigger><DialogContent /></DialogTrigger>",
            "synthetic.vue",
        );
        expect(nested.elements).toBe(1);
        expect(nested.findings).toEqual([]);
        const lookalike = scanSource('<DialogContentShell class="max-w-xl" />', "synthetic.vue");
        expect(lookalike.elements).toBe(0);
        // 「换个写法」不得绕过：kebab 元素名、单引号属性值都照判。
        expect(
            scanSource("<dialog-content class='max-w-xl' />", "synthetic.vue").findings,
        ).toHaveLength(1);
        expect(
            scanSource('<alert-dialog-content class="max-w-xl" />', "synthetic.vue").findings,
        ).toHaveLength(1);
        expect(
            scanSource("<DialogContent :class=\"'max-w-xl'\" />", "synthetic.vue").findings,
        ).toHaveLength(1);
    });

    it("三处既有正确写法必须仍然绿（判据不误伤「本来就对」的）", () => {
        // 这三处是本卡的对照组：写法本来就带 sm: 通道，宽度一直生效。
        // 断言它们零命中，证明判据只咬「缺 sm: 对家」这个状态，而不是见 max-w-* 就红。
        const scanOf = (file: string) =>
            scanSource(readFileSync(join(SRC, file), "utf8"), "src/" + file);
        for (const file of [
            "features/workspace/components/ScheduledTaskCreateDialog.vue",
            "features/workspace/components/WorkspaceCreateDialog.vue",
            "features/workspace/chat/components/AttachmentPreviewDialog.vue",
        ]) {
            const scanned = scanOf(file);
            expect(scanned.elements, file).toBe(1);
            expect(scanned.findings, file).toEqual([]);
        }
    });

    it("仓库实况：src/** 没有一处「裸 max-w-* 缺 sm: 对家或对家更窄」", () => {
        const report = scanRepo();
        expect(report.files).toBeGreaterThan(0);
        expect(report.elements).toBeGreaterThan(0);
        expect(report.findings.map((f) => f.file + ":" + f.line + " " + f.detail)).toEqual([]);
    });
});
