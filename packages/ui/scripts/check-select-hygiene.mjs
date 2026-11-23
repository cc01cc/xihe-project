#!/usr/bin/env node
/**
 * check-select-hygiene.mjs — 下拉/弹层一致性门（task-926 / R11 R14 R26 R41 R53）。
 *
 * 为什么另起一门：已有 `check:select-contract` 只量「弹层默认怎么开」（popper / align /
 * 宽度跟触发器），不量「触发器自身能不能收缩」与「同组弹层方向是否只有一种」；
 * `check-dialog-shape` 只管对话框滚动。R11/R14/R26 的真实形态是「触发器内容撑破 flex 子项
 * ⇒ overflow-x 变 auto ⇒ 出现横向滚动条 / 选项被截成 `智…`」，静态门此前完全没覆盖。
 *
 * 规则（红 = exit 1）：
 *   SH1 基座：SelectTrigger 必须 `min-w-0` + `max-w-full` + value `truncate`；SelectValue 自身也必须
 *       `min-w-0` + `truncate`（只改调用点不算修好 —— 卡面要求「基座一次修好」）。
 *   SH2 弹层：SelectContent / ComboboxList 必须 `overflow-x-hidden`，且 Select 的最小宽度
 *       只能落在 Content（`min-w-(--reka-...-trigger-width)`），不得再回到「Content + viewport 各取一次
 *       触发器宽」——实测 534 vs 542，多出的 8px 就是横向滚动条。
 *   SH3 调用点：每个 SelectTrigger / ComboboxTrigger 必须有「可收缩或显式宽度」约束
 *       （`min-w-0` / `max-w-*` / `truncate` / `flex-1` / `w-full` / `w-max` / `w-<scale>` / `min-w-(…)` / `max-w-(…)`）。
 *       存量按「文件 × 规则计数」设基线，只减不增（形如 scripts/check-cp-baseline.mjs）。
 *   SH4 方向：SelectContent / ComboboxContent / DropdownMenuContent / PopoverContent 的默认
 *       `align` 必须是 `start`（用户原话：从图标右下方弹出，而不是左下方造成右对齐观感）；
 *       调用点写 `align="end"` / `align="center"` 一律红，保证同组不会两种方向并存。
 *   SH5 R53：同一文件里 ≥2 个互斥单选被 `Checkbox`（或 `aria-pressed` 开关按钮）表达：
 *       `:model-value="mode === 'a'"` + `mode === 'b'` ⇒ 红（必须 radio / segmented）。
 *
 * 用法：
 *   node packages/ui/scripts/check-select-hygiene.mjs                 # 阻断：新违规 exit 1
 *   node packages/ui/scripts/check-select-hygiene.mjs --report        # report-only（恒 0，除非用法错）
 *   node packages/ui/scripts/check-select-hygiene.mjs --json
 *   node packages/ui/scripts/check-select-hygiene.mjs --path <dir>    # 换扫描根（夹具/子树）
 *   node packages/ui/scripts/check-select-hygiene.mjs --print-baseline
 *   node packages/ui/scripts/check-select-hygiene.mjs --selftest
 *
 * 退出码：0 通过（存量基线覆盖）/ 1 新违规或基线过期 / 2 用法或环境错误。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const EXIT = { PASS: 0, RED: 1, BAD_INPUT: 2 };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_UI_ROOT = path.resolve(HERE, "..");

/**
 * 存量基线：SH3 的 27 个调用点（2026-11-24 task-926 首跑实测）+ SH5 的 R53 存量 1 组
 * （features/workspace/components/WorkspaceCreateDialog.vue 的执行模式开关按钮对）。
 * 只减不增：数量变小要删基线（WARN），变小之外任何新增都红。reviewBy 过期即失败。
 */
export const BASELINE = Object.freeze({
    reviewBy: "2027-03-31",
    entries: [
        { rule: "SH3", file: "src/components/settings/ContextTemplatesPanel.vue", count: 2 },
        {
            rule: "SH3",
            file: "src/components/settings/credentials/CredentialBindingsSection.vue",
            count: 1,
        },
        { rule: "SH3", file: "src/components/settings/InstanceCredentialsPanel.vue", count: 2 },
        { rule: "SH3", file: "src/components/settings/InstanceMcpPanel.vue", count: 2 },
        { rule: "SH3", file: "src/components/settings/RoleBindingsPanel.vue", count: 2 },
        {
            rule: "SH3",
            file: "src/features/org-members/components/OrgUnitWritePanel.vue",
            count: 3,
        },
        {
            rule: "SH3",
            file: "src/features/workspace/chat/components/DelegationDialog.vue",
            count: 1,
        },
        { rule: "SH3", file: "src/features/workspace/chat/components/PdfToolbar.vue", count: 1 },
        { rule: "SH3", file: "src/features/workspace/components/ParticipantRow.vue", count: 2 },
        {
            rule: "SH3",
            file: "src/features/workspace/components/ScheduledTaskCreateDialog.vue",
            count: 4,
        },
        {
            rule: "SH3",
            file: "src/features/workspace/components/WorkspaceAgentsPanel.vue",
            count: 2,
        },
        {
            rule: "SH3",
            file: "src/features/workspace/components/WorkspaceMembersPanel.vue",
            count: 2,
        },
        {
            rule: "SH3",
            file: "src/features/workspace/pages/WorkspaceEnvironmentView.vue",
            count: 1,
        },
        { rule: "SH3", file: "src/views/settings/AuditView.vue", count: 1 },
        // SH4 存量：7 处显式 align="end" 的菜单（都在业务页，不在 task-926 写域）⇒ 基线登记，只减不增；
        // 逐文件修法与行号见交付回执 blockers。
        { rule: "SH4", file: "src/components/sidebar/Sidebar.vue", count: 2 },
        { rule: "SH4", file: "src/features/workspace/chat/components/SessionItem.vue", count: 1 },
        {
            rule: "SH4",
            file: "src/features/workspace/chat/components/WorkspaceSessionGroups.vue",
            count: 1,
        },
        {
            rule: "SH4",
            file: "src/features/workspace/components/WorkspaceContainerAddButton.vue",
            count: 1,
        },
        { rule: "SH4", file: "src/features/workspace/components/WorkspaceDock.vue", count: 1 },
        {
            rule: "SH5",
            file: "src/features/workspace/components/WorkspaceCreateDialog.vue",
            count: 1,
        },
    ],
});

const SCAN_EXTS = new Set([".vue"]);
const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "coverage",
    ".tmp",
    "test-results",
    "playwright-report",
    ".output",
    "__tests__",
    "preview",
]);
const TRIGGER_TAGS = ["SelectTrigger", "ComboboxTrigger"];
const ALIGN_TAGS = ["SelectContent", "ComboboxContent", "DropdownMenuContent", "PopoverContent"];
const VENDOR_TAGS = /src\/components\/ui\/(select|combobox|dropdown-menu|popover)\//;

/** 去掉注释（保持逐字符对齐，行号不漂移）——沿用 check-select-contract 的 stripComments 口径。 */
export function stripComments(text) {
    const blank = (match) => match.replace(/[^\n]/g, " ");
    return text
        .replace(/<!--[\s\S]*?-->/g, blank)
        .replace(/\/\*[\s\S]*?\*\//g, blank)
        .replace(/^[ \t]*\/\/.*$/gm, blank);
}

function walkFiles(root, out = []) {
    if (!existsSync(root)) return out;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            walkFiles(path.join(root, entry.name), out);
            continue;
        }
        if (!SCAN_EXTS.has(path.extname(entry.name))) continue;
        out.push(path.join(root, entry.name));
    }
    return out;
}

/** 取标签开标签文本：从 `<Tag` 读到第一个不在引号内的 `>`。 */
function tagChunk(text, startIndex) {
    let i = startIndex;
    let quote = null;
    while (i < text.length) {
        const ch = text[i];
        if (quote) {
            if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === ">") {
            return text.slice(startIndex, i + 1);
        }
        i += 1;
    }
    return text.slice(startIndex);
}

function lineAt(text, index) {
    return text.slice(0, index).split("\n").length;
}

function readIfExists(abs) {
    try {
        return readFileSync(abs, "utf8");
    } catch {
        return null;
    }
}

function relFile(root, abs) {
    return path.relative(root, abs).split(path.sep).join("/");
}

/** SH3：调用点宽度约束。动态 :class 无法静态判定 ⇒ 记 dynamic，不判红。 */
export function triggerWidthVerdict(tagText) {
    const hasDynamic = /\s:class(=|\s)/.test(tagText) || /\sv-bind=/.test(tagText);
    const literal = /\sclass="([^"]*)"/.exec(tagText);
    if (!literal) return hasDynamic ? { ok: true, dynamic: true } : { ok: false, cls: "" };
    const cls = literal[1];
    const tokens = cls.split(/\s+/).filter(Boolean);
    const constraint = tokens.some((token) => {
        if (token === "w-fit" || token === "w-px" || /^w-\[[0-9.]+(px|rem)\]$/u.test(token)) {
            return false; // 固定像素宽 / 贴内容宽不是「可收缩」
        }
        return (
            token === "min-w-0" ||
            token === "truncate" ||
            token === "flex-1" ||
            token === "w-full" ||
            token === "w-max" ||
            token === "w-auto" ||
            /^(min-w|max-w)-/u.test(token) ||
            /^w-[0-9]/u.test(token) ||
            token.startsWith("w-[")
        );
    });
    return { ok: constraint, dynamic: false, cls };
}

/** SH5：同一文件里的「互斥单选误用 Checkbox / aria-pressed」。 */
export function exclusiveToggleGroups(text) {
    const groups = new Map();
    const tagRe = /<(?:Checkbox|button|Button)[\s\S]*?>/g;
    let match;
    while ((match = tagRe.exec(text)) !== null) {
        const tag = match[0];
        const line = lineAt(text, match.index);
        if (tag.startsWith("<Checkbox")) {
            const bind = /:model-value="([^"]*)"/.exec(tag);
            if (bind) collect(groupKey(bind[1]), "Checkbox", line);
            continue;
        }
        const pressed = /:aria-pressed="([^"]*)"/.exec(tag);
        if (pressed) collect(groupKey(pressed[1]), "aria-pressed", line);
    }
    function groupKey(expr) {
        const m = /([A-Za-z_$][\w.$]*)\s*(?:===|==)\s*(?:"[^"]*"|'[^']*')/u.exec(expr.trim());
        return m ? m[1] : null;
    }
    function collect(key, kind, line) {
        if (!key) return;
        const entry = groups.get(key) ?? { key, kinds: new Set(), lines: [] };
        entry.kinds.add(kind);
        entry.lines.push(line);
        groups.set(key, entry);
    }
    return [...groups.values()].filter((entry) => entry.lines.length >= 2);
}

function pushHit(hits, hit) {
    hits.push(hit);
}

/** 主扫描：返回 red / weak / dynamic / inventory。 */
export function scan(root = DEFAULT_UI_ROOT) {
    const red = [];
    const weak = [];
    const dynamic = [];
    const inventory = [];
    const files = walkFiles(path.join(root, "src"));

    // SH1 / SH2：vendor 基座
    const selectTriggerAbs = path.join(root, "src/components/ui/select/SelectTrigger.vue");
    const selectValueAbs = path.join(root, "src/components/ui/select/SelectValue.vue");
    const selectContentAbs = path.join(root, "src/components/ui/select/SelectContent.vue");
    const comboListAbs = path.join(root, "src/components/ui/combobox/ComboboxList.vue");
    for (const [abs, required, rule] of [
        [selectTriggerAbs, ["min-w-0 max-w-full", "*:data-[slot=select-value]:truncate"], "SH1"],
        [selectValueAbs, ["min-w-0", "truncate"], "SH1"],
    ]) {
        const raw = readIfExists(abs);
        if (raw === null) {
            pushHit(red, {
                rule,
                file: relFile(root, abs),
                line: 1,
                message: "找不到 vendor 文件（扫描根错了？）",
            });
            continue;
        }
        for (const token of required) {
            if (!stripComments(raw).includes(token)) {
                pushHit(red, {
                    rule,
                    file: relFile(root, abs),
                    line: 1,
                    message: `基座缺少可收缩约束 ${token}（调用点逐个补 class 不算修好）`,
                });
            }
        }
    }
    for (const [abs, required, forbidden, rule] of [
        [
            selectContentAbs,
            ["overflow-x-hidden", "min-w-(--reka-select-trigger-width)"],
            /(?:^|[^a-z-])w-\(--reka-select-trigger-width\)/u,
            "SH2",
        ],
        [comboListAbs, ["overflow-x-hidden", "reka-combobox-trigger-width"], null, "SH2"],
    ]) {
        const raw = readIfExists(abs);
        if (raw === null) continue;
        const text = stripComments(raw);
        for (const token of required) {
            if (!text.includes(token)) {
                pushHit(red, {
                    rule,
                    file: relFile(root, abs),
                    line: 1,
                    message: `弹层缺少 ${token}（横向滚动条会从这层漏出）`,
                });
            }
        }
        if (forbidden && forbidden.test(text)) {
            pushHit(red, {
                rule,
                file: relFile(root, abs),
                line: 1,
                message:
                    "弹层仍写死 w-(--reka-…-trigger-width)（再加 p-1 必溢出 8px；最小宽度应只放在 Content）",
            });
        }
    }

    // SH4：vendor 默认方向
    for (const rel of [
        "src/components/ui/select/SelectContent.vue",
        "src/components/ui/combobox/ComboboxList.vue",
        "src/components/ui/dropdown-menu/DropdownMenuContent.vue",
        "src/components/ui/popover/PopoverContent.vue",
    ]) {
        const raw = readIfExists(path.join(root, rel));
        if (raw === null) continue;
        const match = /\balign:\s*(["'])([a-z-]+)\1/u.exec(stripComments(raw));
        if (!match || match[2] !== "start") {
            pushHit(red, {
                rule: "SH4",
                file: rel,
                line: match ? lineAt(stripComments(raw), match.index) : 1,
                message: `弹层默认 align 必须是 start（现值 ${match ? match[2] : "(缺失)"}）；同一组弹层不得 start/end/center 并存`,
            });
        }
    }

    // SH3 / SH4 / SH5：调用点
    for (const abs of files) {
        const rel = relFile(root, abs);
        if (VENDOR_TAGS.test(rel)) continue;
        const raw = readFileSync(abs, "utf8");
        const text = stripComments(raw);

        for (const tagName of TRIGGER_TAGS) {
            let cursor = 0;
            while (true) {
                const open = text.indexOf(`<${tagName}`, cursor);
                if (open === -1) break;
                cursor = open + 1;
                const chunk = tagChunk(text, open);
                const verdict = triggerWidthVerdict(chunk);
                const line = lineAt(text, open);
                if (verdict.dynamic) {
                    dynamic.push({
                        rule: "SH3",
                        file: rel,
                        line,
                        message: "动态 :class，无法静态判定宽度约束",
                    });
                    continue;
                }
                if (!verdict.ok) {
                    pushHit(red, {
                        rule: "SH3",
                        file: rel,
                        line,
                        message: `${tagName} 缺少可收缩约束（min-w-0 / max-w-* / truncate / flex-1 / 显式可伸缩 w-*），长文本会撑出横向滚动条`,
                    });
                }
                inventory.push({ rule: "SH3", file: rel, line, tag: tagName, cls: verdict.cls });
            }
        }

        for (const tagName of ALIGN_TAGS) {
            let cursor = 0;
            while (true) {
                const open = text.indexOf(`<${tagName}`, cursor);
                if (open === -1) break;
                cursor = open + 1;
                const chunk = tagChunk(text, open);
                const align = /\balign\s*=\s*["']([a-z-]+)["']/u.exec(chunk);
                if (align && align[1] !== "start") {
                    pushHit(red, {
                        rule: "SH4",
                        file: rel,
                        line: lineAt(text, open),
                        message: `${tagName} 显式 align="${align[1]}"，与全局 start 并存会造成「左下方弹出/右对齐」观感`,
                    });
                }
            }
        }

        for (const group of exclusiveToggleGroups(text)) {
            pushHit(red, {
                rule: "SH5",
                file: rel,
                line: group.lines[0],
                message: `互斥选项用 ${[...group.kinds].join(" + ")} 表达（变量 ${group.key} 的 ${group.lines.length} 个分支）⇒ 必须 radio / segmented`,
            });
        }
    }

    return { red, weak, dynamic, inventory, scannedFiles: files.length };
}

function countBy(red) {
    const map = new Map();
    for (const hit of red) {
        const key = `${hit.rule}\u0000${hit.file}`;
        map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
}

/** 基线与现值对账：新增红、缩水 WARN、过期红。 */
export function compareBaseline({
    red,
    baseline = BASELINE,
    today = new Date().toLocaleDateString("sv-SE"),
}) {
    const current = countBy(red);
    const entries = baseline.entries ?? [];
    const known = new Map(entries.map((entry) => [`${entry.rule}\u0000${entry.file}`, entry]));
    const added = [];
    const shrunk = [];
    const covered = [];
    for (const [key, count] of current) {
        const entry = known.get(key);
        const [rule, file] = key.split("\u0000");
        if (!entry) {
            added.push({ rule, file, count, baseline: 0 });
        } else if (count > entry.count) {
            added.push({ rule, file, count, baseline: entry.count });
        } else if (count < entry.count) {
            shrunk.push({ rule, file, count, baseline: entry.count });
        } else {
            covered.push({ rule, file, count });
        }
    }
    for (const entry of entries) {
        const key = `${entry.rule}\u0000${entry.file}`;
        if (!current.has(key))
            shrunk.push({ rule: entry.rule, file: entry.file, count: 0, baseline: entry.count });
    }
    const expired = !baseline.reviewBy || baseline.reviewBy < today;
    const ok = added.length === 0 && !expired;
    return { ok, code: ok ? EXIT.PASS : EXIT.RED, added, shrunk, covered, expired, today };
}

function format(result, baselineResult, json) {
    if (json) {
        return `${JSON.stringify(
            {
                ok: baselineResult.ok,
                scannedFiles: result.scannedFiles,
                red: result.red,
                weak: result.weak,
                dynamic: result.dynamic,
                baseline: {
                    reviewBy: BASELINE.reviewBy,
                    added: baselineResult.added,
                    shrunk: baselineResult.shrunk,
                    covered: baselineResult.covered.length,
                    expired: baselineResult.expired,
                },
            },
            null,
            2,
        )}\n`;
    }
    const lines = [];
    lines.push(
        `[select-hygiene] scanned ${result.scannedFiles} files; red ${result.red.length} / new ${baselineResult.added.length}` +
            ` / baseline-covered ${baselineResult.covered.length} / dynamic ${result.dynamic.length}`,
    );
    for (const item of baselineResult.added) {
        lines.push(
            `  RED NEW ${item.rule} ${item.file} (now ${item.count}, baseline ${item.baseline})`,
        );
    }
    if (baselineResult.expired) {
        lines.push(
            `  RED EXPIRED baseline reviewBy=${BASELINE.reviewBy}（过期即失败，先复核再续期）`,
        );
    }
    for (const item of baselineResult.shrunk) {
        lines.push(
            `  WARN SHRINK ${item.rule} ${item.file} (now ${item.count}, baseline ${item.baseline}) — 删掉对应基线行`,
        );
    }
    const coveredKeys = new Set(
        baselineResult.covered.map((item) => `${item.rule}\u0000${item.file}`),
    );
    for (const item of baselineResult.covered) {
        lines.push(`  BASE ${item.rule} ${item.file} ×${item.count}`);
    }
    for (const hit of result.red) {
        if (coveredKeys.has(`${hit.rule}\u0000${hit.file}`)) continue;
        if (baselineResult.shrunk.some((item) => item.rule === hit.rule && item.file === hit.file))
            continue;
        lines.push(`  RED ${hit.rule} ${hit.file}:${hit.line} — ${hit.message}`);
    }
    for (const note of result.dynamic) {
        lines.push(`  NOTE ${note.rule} ${note.file}:${note.line} — ${note.message}`);
    }
    lines.push(
        `[select-hygiene] ${baselineResult.ok ? "PASS" : "FAIL"} (exit ${baselineResult.code})`,
    );
    return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// selftest：在一次性夹具树上证明每条规则正例 + 反例（不碰真实树）
// ---------------------------------------------------------------------------

const FIXTURES = {
    "src/components/ui/select/SelectTrigger.vue": `<template>
    <SelectTrigger :class="cn('flex w-fit min-w-0 max-w-full items-center *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:truncate')">
        <slot />
    </SelectTrigger>
</template>`,
    "src/components/ui/select/SelectValue.vue": `<template><SelectValue class="min-w-0 flex-1 truncate text-left" /></template>`,
    "src/components/ui/select/SelectContent.vue": `<script setup lang="ts">
const props = withDefaults(defineProps(), { position: "popper", align: "start", sideOffset: 4 });
</script>
<template>
    <SelectContent :class="cn('bg-popover w-max min-w-(--reka-select-trigger-width) max-w-(--reka-select-content-available-width) overflow-x-hidden overflow-y-auto p-1')" />
</template>`,
    "src/components/ui/combobox/ComboboxList.vue": `<script setup lang="ts">
const props = withDefaults(defineProps(), { position: "popper", align: "start", sideOffset: 4 });
</script>
<template>
    <ComboboxContent :class="cn('w-(--reka-combobox-trigger-width) min-w-(--reka-combobox-trigger-width) overflow-x-hidden overflow-y-auto')" />
</template>`,
    "src/components/ui/dropdown-menu/DropdownMenuContent.vue": `<script setup lang="ts">
const props = withDefaults(defineProps(), { align: "start", sideOffset: 4 });
</script>
<template><DropdownMenuContent /></template>`,
    "src/components/ui/popover/PopoverContent.vue": `<script setup lang="ts">
const props = withDefaults(defineProps(), { align: "start", sideOffset: 4 });
</script>
<template><PopoverContent /></template>`,
    "src/features/demo/Clean.vue": `<template>
    <SelectTrigger class="min-w-0 w-full"><SelectValue /></SelectTrigger>
    <ComboboxTrigger class="min-w-0 flex-1"><slot /></ComboboxTrigger>
    <SelectContent align="start"><SelectItem value="a">A</SelectItem></SelectContent>
    <Checkbox :model-value="one" />
</template>`,
};

function writeFixture(root, rel, text) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text, "utf8");
}

function resetFixtures(root) {
    rmSync(root, { recursive: true, force: true });
    for (const [rel, text] of Object.entries(FIXTURES)) writeFixture(root, rel, text);
}

function hasRule(red, rule) {
    return red.some((hit) => hit.rule === rule);
}

export function selftest() {
    const root = path.resolve(DEFAULT_UI_ROOT, "..", "..", ".tmp", "task-926-selftest");
    resetFixtures(root);
    const cases = [];
    const clean = scan(root);
    cases.push({ name: "clean fixture", pass: clean.red.length === 0 });

    // SH1：基座丢 min-w-0
    writeFixture(
        root,
        "src/components/ui/select/SelectTrigger.vue",
        FIXTURES["src/components/ui/select/SelectTrigger.vue"].replace("min-w-0 ", ""),
    );
    cases.push({ name: "SH1 base trigger loses min-w-0", pass: hasRule(scan(root).red, "SH1") });

    // SH2：弹层回到「Content + viewport 各取一次触发器宽」
    resetFixtures(root);
    writeFixture(
        root,
        "src/components/ui/select/SelectContent.vue",
        FIXTURES["src/components/ui/select/SelectContent.vue"].replace("overflow-x-hidden ", ""),
    );
    cases.push({
        name: "SH2 content loses overflow-x-hidden",
        pass: hasRule(scan(root).red, "SH2"),
    });

    // SH3：调用点没有任何宽度约束
    resetFixtures(root);
    writeFixture(
        root,
        "src/features/demo/Bad.vue",
        `<template>\n    <SelectTrigger class="rounded border">\n        <SelectValue />\n    </SelectTrigger>\n</template>`,
    );
    cases.push({
        name: "SH3 call site without shrinkability",
        pass: hasRule(scan(root).red, "SH3"),
    });

    // SH3 反证：w-fit 不算可收缩
    writeFixture(
        root,
        "src/features/demo/Bad.vue",
        `<template>\n    <SelectTrigger class="w-fit">\n        <SelectValue />\n    </SelectTrigger>\n</template>`,
    );
    cases.push({
        name: "SH3 w-fit is not a shrink constraint",
        pass: hasRule(scan(root).red, "SH3"),
    });

    // SH4：调用点 align=end
    writeFixture(
        root,
        "src/features/demo/Bad.vue",
        `<template>\n    <SelectContent align="end" class="min-w-0" />\n</template>`,
    );
    cases.push({ name: "SH4 call site align=end", pass: hasRule(scan(root).red, "SH4") });

    // SH5：两个 Checkbox 表达互斥单选
    writeFixture(
        root,
        "src/features/demo/Bad.vue",
        `<template>\n    <Checkbox :model-value="mode === 'a'" />\n    <Checkbox :model-value="mode === 'b'" />\n</template>`,
    );
    cases.push({ name: "SH5 checkbox mutual exclusion", pass: hasRule(scan(root).red, "SH5") });

    // SH5 反证：单选已用 RadioGroup
    writeFixture(
        root,
        "src/features/demo/Bad.vue",
        `<template>\n    <RadioGroup v-model="mode">\n        <RadioGroupItem value="a" />\n        <RadioGroupItem value="b" />\n    </RadioGroup>\n</template>`,
    );
    cases.push({
        name: "SH5 Antipattern cleared by RadioGroup",
        pass: !hasRule(scan(root).red, "SH5"),
    });

    rmSync(root, { recursive: true, force: true });

    const failed = cases.filter((item) => !item.pass);
    for (const item of cases) {
        process.stdout.write(`${item.pass ? "PASS" : "FAIL"} ${item.name}\n`);
    }
    process.stdout.write(
        `[select-hygiene] selftest ${cases.length - failed.length}/${cases.length}\n`,
    );
    return failed.length === 0;
}

function main(argv) {
    if (argv.includes("--selftest")) return selftest() ? EXIT.PASS : EXIT.RED;
    const pathFlag = argv.indexOf("--path");
    const root = pathFlag === -1 ? DEFAULT_UI_ROOT : path.resolve(argv[pathFlag + 1] ?? "");
    if (!existsSync(path.join(root, "src"))) {
        process.stderr.write(`[select-hygiene] 扫描根没有 src/: ${root}\n`);
        return EXIT.BAD_INPUT;
    }
    const result = scan(root);
    if (argv.includes("--print-baseline")) {
        const entries = [...countBy(result.red)].map(([key, count]) => {
            const [rule, file] = key.split("\u0000");
            return { rule, file, count };
        });
        process.stdout.write(
            `${JSON.stringify({ reviewBy: BASELINE.reviewBy, entries }, null, 2)}\n`,
        );
        return EXIT.PASS;
    }
    const baselineResult = compareBaseline({ red: result.red });
    process.stdout.write(format(result, baselineResult, argv.includes("--json")));
    return argv.includes("--report") ? EXIT.PASS : baselineResult.code;
}

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
    process.exitCode = main(process.argv.slice(2));
}
