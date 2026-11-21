/**
 * 机器判据：对话框宽度**只能来自档位表**（task-137；机制成因见 task-98 的注释与 evidence）。
 *
 * <p><b>为什么是「只能来自档位表」而不是「必须带 sm: 对家」</b>：task-98 只拦住了「裸 `max-w-*` 缺
 * `sm:` 对家」这个形态，结果是 20 个调用点各自拼 `max-w-md sm:max-w-md` / `max-w-4xl sm:max-w-4xl`
 * 四套刻度，宽度照样被 vendor 默认值（`sm:max-w-sm`=384px）语言化地压回窄档 —— 用户看到的就是
 * 「弹窗都非常窄」（task-137 的全量盘点在 `internal/A03-xihe/evidence/2026-11-20-dialog-width-scale`）。
 * 换成档位后，调用点只说**语义**：`<DialogContent width="config">`，class 里不再出现任何宽度 token；
 * 宽度只有一处可改（`dialogWidths.ts`）。</p>
 *
 * <p><b>三条规则</b>：</p>
 * <ol>
 *   <li><b>硬判（红）</b>：宽度类元素（`<DialogContent>` / `<AlertDialogContent>` /
 *       `<DialogScrollContent>`，含 kebab 拼法）的静态 class 里不得出现 `max-w-*` / `sm:max-w-*`
 *       宽度 token（白名单只留真正的布局值：`max-w-full` / `max-w-none` / `max-w-[calc(100%-2rem)]`）。</li>
 *   <li><b>硬判（红）</b>：`width` 属性若写成静态字符串，必须是档位表里的值（`confirm`/`form`/`config`/`workbench`）。</li>
 *   <li><b>report-only（永不红）</b>：静态判不了的调用点（`:class` 动态拼宽度、`width` 是表达式）记为
 *       「未归档」，只在测试输出里报警 —— 让新调用点漏登记时**看得见**，但不拿静态不可判当缺陷。
 *       真正拦回归的是规则 1（宽度 token 一律不许出现），它可静态判、无豁免表。</li>
 * </ol>
 *
 * <p><b>没有豁免表</b>：`src/**` 全部 `.vue` 逐文件扫，不进判定的只有三个 vendor 原语目录
 * （`components/ui/dialog`、`components/ui/alert-dialog`、`components/ui/sheet`）—— 那里是档位表的落地实现，
 * 不是被判的调用方。</p>
 *
 * <p><b>Sheet 已并入本判据（task-185）</b>：`<SheetContent>`（含 kebab 拼法）与 Dialog 同规则 ——
 * 静态 class 里不得出现宽度 token，宽度只能来自 `width="confirm|form|config|workbench"`。
 * Sheet 与 Dialog 共用同一张 px 表，差别只在 Sheet 的宽度必须带 `data-[side=*]:` 前缀才能压过原语默认值
 * （跨变体不折叠，见下方「机制自证」用例），所以档位 class 由 `sheetWidthClass(side, tier)` 包一层前缀。</p>
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
    DIALOG_WIDTH_TIERS,
    DIALOG_WIDTH_TIER_PX,
    isDialogWidthTier,
    sheetWidthClass,
    type DialogWidthTier,
} from "../dialogWidths";
import { cn } from "../../../../lib/utils";

const SRC = resolve(process.cwd(), "src");

/** 宽度类元素（含 kebab 拼法：Vue 里 `<dialog-content>` 挂的是同一个组件，只认 PascalCase 会留缺口）。 */
const WIDTH_BEARING_ELEMENTS = [
    "DialogContent",
    "AlertDialogContent",
    "DialogScrollContent",
    "SheetContent",
    "sheet-content",
    "dialog-content",
    "alert-dialog-content",
    "dialog-scroll-content",
] as const;

/** vendor 原语本体（档位表的实现处，不是判据对象）。 */
const PRIMITIVE_DIRS = [
    "components/ui/dialog",
    "components/ui/alert-dialog",
    "components/ui/sheet",
] as const;

/** 布局用的 max-w（不是"宽度档位"，不参与判定）。 */
const ALLOWED_MAX_W = new Set(["max-w-full", "max-w-none", "max-w-[calc(100%-2rem)]"]);

export interface Finding {
    file: string;
    line: number;
    element: string;
    detail: string;
}

/** 静态判不了的调用点：只报警，不判红。 */
export interface Unarchived {
    file: string;
    line: number;
    element: string;
    reason: string;
}

export interface ScanReport {
    files: number;
    elements: number;
    dynamicElements: number;
    explicitTiers: number;
    findings: Finding[];
    unarchived: Unarchived[];
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

/** 取开标签原文：从 `<Name` 起按引号状态扫到第一个不在引号内的 `>`（属性跨行、值里含 `>` 都成立）。 */
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
        let quote: string | null = null;
        let end = -1;
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

/** 标签上的静态 class 值（`class="…"`、`:class="'…'"`）；动态表达式只记 `dynamic`。 */
function classValues(tag: string): { values: string[]; dynamic: boolean } {
    const values: string[] = [];
    let dynamic = false;
    for (const match of tag.matchAll(/(?<![:@\w-])class=(?:"([^"]*)"|'([^']*)')/g)) {
        values.push(match[1] ?? match[2] ?? "");
    }
    for (const match of tag.matchAll(/(?<![:@\w-]):class=(?:"([^"]*)"|'([^']*)')/g)) {
        const literal = stringLiteral((match[1] ?? match[2] ?? "").trim());
        if (literal === null) {
            if (/max-w-/.test(match[1] ?? match[2] ?? "")) dynamic = true;
            continue;
        }
        values.push(literal);
    }
    return { values, dynamic };
}

function stringLiteral(raw: string): string | null {
    for (const quote of ["'", '"', "`"]) {
        if (raw.length < 2 || raw[0] !== quote || raw[raw.length - 1] !== quote) continue;
        const inner = raw.slice(1, -1);
        if (inner.includes("$") || inner.includes("\\") || inner.includes(quote)) return null;
        return inner;
    }
    return null;
}

/** `width` 属性的静态值；动态表达式返回 `{ dynamic: true }`。 */
function widthAttr(tag: string): { value?: string; dynamic: boolean } {
    const staticMatch = tag.match(/(?<![:@\w-])width=(?:"([^"]*)"|'([^']*)')/);
    if (staticMatch)
        return { value: (staticMatch[1] ?? staticMatch[2] ?? "").trim(), dynamic: false };
    const boundMatch = tag.match(/(?<![:@\w-]):width=(?:"([^"]*)"|'([^']*)')/);
    if (boundMatch) {
        const literal = stringLiteral((boundMatch[1] ?? boundMatch[2] ?? "").trim());
        return literal === null ? { dynamic: true } : { value: literal.trim(), dynamic: false };
    }
    return { dynamic: false };
}

export function checkElement(
    element: string,
    tag: string,
    file: string,
    line: number,
): { findings: Finding[]; unarchived: Unarchived[]; explicitTier: boolean } {
    const findings: Finding[] = [];
    const unarchived: Unarchived[] = [];
    const { values, dynamic } = classValues(tag);
    const tokens = values.flatMap((value) => value.split(/\s+/).filter(Boolean));
    for (const token of tokens) {
        if (ALLOWED_MAX_W.has(token)) continue;
        if (!/^(?:sm:)?max-w-/.test(token)) continue;
        findings.push({
            file,
            line,
            element,
            detail:
                token +
                ' ⇒ 宽度不得来自调用点 class；改用档位 width="confirm|form|config|workbench"（dialogWidths.ts）',
        });
    }
    const width = widthAttr(tag);
    if (width.dynamic) {
        unarchived.push({ file, line, element, reason: ":width 是表达式，静态不可判档位" });
    } else if (width.value !== undefined) {
        if (isDialogWidthTier(width.value)) {
            return { findings, unarchived, explicitTier: true };
        }
        // 静态写了非档位值：这属于"既非默认档又非档位表"⇒ report-only 报警（历史遗留不被本卡拦死）。
        unarchived.push({
            file,
            line,
            element,
            reason:
                'width="' +
                width.value +
                '" 不在档位表（' +
                Object.keys(DIALOG_WIDTH_TIERS).join("/") +
                "）",
        });
    } else if (dynamic) {
        unarchived.push({
            file,
            line,
            element,
            reason: ":class 表达式里出现 max-w-*，静态不可判档位",
        });
    }
    return {
        findings,
        unarchived,
        explicitTier: width.value !== undefined && isDialogWidthTier(width.value),
    };
}

export function scanSource(
    text: string,
    file: string,
): {
    elements: number;
    dynamicElements: number;
    explicitTiers: number;
    findings: Finding[];
    unarchived: Unarchived[];
} {
    const findings: Finding[] = [];
    const unarchived: Unarchived[] = [];
    let elements = 0;
    let dynamicElements = 0;
    let explicitTiers = 0;
    for (const element of WIDTH_BEARING_ELEMENTS) {
        for (const { tag, line } of openingTags(text, element)) {
            elements += 1;
            const result = checkElement(element, tag, file, line);
            if (result.explicitTier) explicitTiers += 1;
            if (classValues(tag).dynamic) dynamicElements += 1;
            findings.push(...result.findings);
            unarchived.push(...result.unarchived);
        }
    }
    return { elements, dynamicElements, explicitTiers, findings, unarchived };
}

export function scanRepo(root = SRC): ScanReport {
    const findings: Finding[] = [];
    const unarchived: Unarchived[] = [];
    let files = 0;
    let elements = 0;
    let dynamicElements = 0;
    let explicitTiers = 0;
    for (const full of vueFiles(root)) {
        const rel = relative(root, full).replace(/\\/g, "/");
        if (PRIMITIVE_DIRS.some((dir) => rel === dir || rel.startsWith(dir + "/"))) continue;
        files += 1;
        const scanned = scanSource(readFileSync(full, "utf8"), "src/" + rel);
        elements += scanned.elements;
        dynamicElements += scanned.dynamicElements;
        explicitTiers += scanned.explicitTiers;
        findings.push(...scanned.findings);
        unarchived.push(...scanned.unarchived);
    }
    return { files, elements, dynamicElements, explicitTiers, findings, unarchived };
}

function describeFinding(finding: Finding): string {
    return finding.file + ":" + finding.line + " <" + finding.element + "> " + finding.detail;
}

describe("对话框宽度只能来自档位表（task-137，承接 task-98）", () => {
    it("判据本体：class 里出现宽度 token ⇒ 红；width 档位 ⇒ 绿；非档位值 ⇒ report-only", () => {
        const bare = checkElement(
            "DialogContent",
            '<DialogContent class="max-w-2xl sm:max-w-2xl">',
            "synthetic.vue",
            10,
        );
        expect(bare.findings).toHaveLength(2);
        expect(bare.findings[0].detail).toContain("max-w-2xl");
        expect(bare.findings[1].detail).toContain("sm:max-w-2xl");

        const tier = checkElement(
            "DialogContent",
            '<DialogContent width="config">',
            "synthetic.vue",
            10,
        );
        expect(tier.findings).toEqual([]);
        expect(tier.unarchived).toEqual([]);
        expect(tier.explicitTier).toBe(true);

        const unknownTier = checkElement(
            "DialogContent",
            '<DialogContent width="huge">',
            "synthetic.vue",
            10,
        );
        expect(unknownTier.findings).toEqual([]);
        expect(unknownTier.explicitTier).toBe(false);
        expect(unknownTier.unarchived[0].reason).toContain("不在档位表");

        const dynamicWidth = checkElement(
            "DialogContent",
            '<DialogContent :width="props.width">',
            "synthetic.vue",
            10,
        );
        expect(dynamicWidth.findings).toEqual([]);
        expect(dynamicWidth.unarchived[0].reason).toContain("表达式");

        const dynamicClass = checkElement(
            "DialogContent",
            "<DialogContent :class=\"cn('max-w-2xl', props.class)\">",
            "synthetic.vue",
            10,
        );
        expect(dynamicClass.findings).toEqual([]);
        expect(dynamicClass.unarchived[0].reason).toContain(":class 表达式");

        // 布局用的 max-w 不参与判定（白名单）。
        expect(
            checkElement(
                "DialogContent",
                '<DialogContent class="max-w-[calc(100%-2rem)] max-w-full">',
                "synthetic.vue",
                10,
            ).findings,
        ).toEqual([]);
    });

    it("解析面：跨行标签、单引号、kebab 元素名照判；相似元素名不误命中", () => {
        const multiLine = [
            "<DialogContent",
            '    width="config"',
            '    class="max-h-[85vh] overflow-y-auto"',
            ">",
        ].join("\n");
        const parsed = scanSource(multiLine, "synthetic.vue");
        expect(parsed.elements).toBe(1);
        expect(parsed.explicitTiers).toBe(1);
        expect(parsed.findings).toEqual([]);

        expect(
            scanSource("<dialog-content class='max-w-xl' />", "synthetic.vue").findings,
        ).toHaveLength(1);
        expect(
            scanSource('<alert-dialog-content class="max-w-xl" />', "synthetic.vue").findings,
        ).toHaveLength(1);
        expect(
            scanSource('<DialogScrollContent class="max-w-xl" />', "synthetic.vue").findings,
        ).toHaveLength(1);
        expect(
            scanSource('<DialogContentShell class="max-w-xl" />', "synthetic.vue").elements,
        ).toBe(0);
        expect(
            scanSource("<DialogContent :class=\"'max-w-xl'\" />", "synthetic.vue").findings,
        ).toHaveLength(1);
    });

    it("档位表本体：四档 + px 刻度与 Lead 裁定一致（task-137）", () => {
        expect(Object.keys(DIALOG_WIDTH_TIERS)).toEqual(["confirm", "form", "config", "workbench"]);
        expect(DIALOG_WIDTH_TIER_PX).toEqual({
            confirm: 384,
            form: 512,
            config: 768,
            workbench: 1024,
        });
        for (const [tier, cls] of Object.entries(DIALOG_WIDTH_TIERS)) {
            expect(cls, tier).toMatch(/^sm:max-w-(sm|lg|3xl|5xl)$/);
        }
        expect(isDialogWidthTier("config")).toBe(true);
        expect(isDialogWidthTier("huge")).toBe(false);
        // agent 配置弹窗 ≥768px（J3）：config 档即 768，不许降档。
        expect(DIALOG_WIDTH_TIER_PX.config).toBeGreaterThanOrEqual(768);
    });

    it("agent 配置弹窗（AgentPrincipalDetailDrawer）用 config 档 + 两列布局（J3）", () => {
        const source = readFileSync(
            join(SRC, "components/settings/AgentPrincipalDetailDrawer.vue"),
            "utf8",
        );
        const drawer = /<DialogContent[\s\S]*?width="config"[\s\S]*?>/.exec(source);
        expect(drawer, '抽屉必须显式 width="config"').not.toBeNull();
        // 两列：标签列 7.5rem + 内容列，≥640px 生效（<style> 块里的 .apd-two-col）
        expect(source).toContain(".apd-two-col");
        expect(source).toContain("grid-template-columns: 7.5rem minmax(0, 1fr)");
        expect(source).toContain(".apd-two-col > :not(h3)");
    });

    it("仓库实况：src/** 没有一处调用点自带宽度 token；未归档调用点只报警", () => {
        const report = scanRepo();
        expect(report.files).toBeGreaterThan(0);
        expect(report.elements).toBeGreaterThan(0);
        expect(report.findings.map(describeFinding)).toEqual([]);
        // 阶段目标（task-137 全量盘点）：显式档位覆盖 ≥20 个调用点；其余走默认档 confirm。
        expect(report.explicitTiers).toBeGreaterThanOrEqual(20);
        if (report.unarchived.length > 0) {
            // report-only：漏登记要看得见，但不判红（静态不可判 ≠ 缺陷）。
            for (const item of report.unarchived) {
                console.warn(
                    "[dialog-width] 未归档调用点 " +
                        item.file +
                        ":" +
                        item.line +
                        " <" +
                        item.element +
                        "> " +
                        item.reason,
                );
            }
        }
        expect(Array.isArray(report.unarchived)).toBe(true);
    });
});

describe("Sheet 宽度必须来自档位表（task-185，J1/J2）", () => {
    it("正例：width 档位 ⇒ 绿且计入显式档位；反例：写死 sm:max-w-lg ⇒ 红", () => {
        const tier = checkElement(
            "SheetContent",
            '<SheetContent side="right" width="config" class="w-full overflow-y-auto">',
            "synthetic.vue",
            10,
        );
        expect(tier.findings).toEqual([]);
        expect(tier.unarchived).toEqual([]);
        expect(tier.explicitTier).toBe(true);

        const hardcoded = checkElement(
            "SheetContent",
            '<SheetContent side="right" class="w-full sm:max-w-lg">',
            "synthetic.vue",
            10,
        );
        expect(hardcoded.findings).toHaveLength(1);
        expect(hardcoded.findings[0].detail).toContain("sm:max-w-lg");

        const hardcodedDefault = scanSource(
            '<SheetContent side="left" class="max-w-sm">',
            "synthetic.vue",
        );
        expect(hardcodedDefault.findings).toHaveLength(1);
        expect(hardcodedDefault.elements).toBe(1);
    });

    it("包装面：左/右侧下发带侧向前缀的档位 class；上/下侧不下发宽度", () => {
        expect(sheetWidthClass("right", "config")).toBe("data-[side=right]:sm:max-w-3xl");
        expect(sheetWidthClass("left", "form")).toBe("data-[side=left]:sm:max-w-lg");
        expect(sheetWidthClass("top", "config")).toBe("");
        expect(sheetWidthClass("bottom", "config")).toBe("");
        // 未登记档位仍回落默认档，但侧向前缀不丢（否则会静默变回跨变体形态）。
        const unknownTier = "huge" as unknown as DialogWidthTier;
        expect(sheetWidthClass("right", unknownTier)).toBe(
            "data-[side=right]:" + DIALOG_WIDTH_TIERS.confirm,
        );
    });

    it("机制自证：跨变体不折叠（裸 class 被原语默认值压回 384 的成因），同变体才折叠", () => {
        const bare = cn("data-[side=right]:sm:max-w-sm", "sm:max-w-lg").split(/\s+/);
        expect(bare).toContain("data-[side=right]:sm:max-w-sm");
        expect(bare).toContain("sm:max-w-lg");

        const tier = cn("data-[side=right]:sm:max-w-sm", sheetWidthClass("right", "config")).split(
            /\s+/,
        );
        expect(tier).not.toContain("data-[side=right]:sm:max-w-sm");
        expect(tier).toContain("data-[side=right]:sm:max-w-3xl");
    });

    it("原语面：SheetContent.vue 不再自带 sm:max-w-sm 字面量，宽度只走 sheetWidthClass", () => {
        const source = readFileSync(join(SRC, "components/ui/sheet/SheetContent.vue"), "utf8");
        expect(source).not.toContain("sm:max-w-sm");
        expect(source).toContain("sheetWidthClass(props.side, props.width)");
        expect(source).toContain('width: "confirm"');
        expect(source).toContain(":data-sheet-width=");
    });

    it("仓库实况：成员详情抽屉走 config 档（J3 ≥640），且 Sheet 调用点零宽度 token", () => {
        const source = readFileSync(
            join(SRC, "features/org-members/components/OrgMemberDetailSheet.vue"),
            "utf8",
        );
        expect(source).toContain('width="config"');
        expect(DIALOG_WIDTH_TIER_PX.config).toBeGreaterThanOrEqual(640);
        expect(scanSource(source, "OrgMemberDetailSheet.vue").findings).toEqual([]);

        const report = scanRepo();
        expect(report.findings.map(describeFinding)).toEqual([]);
    });
});

export type { DialogWidthTier };
