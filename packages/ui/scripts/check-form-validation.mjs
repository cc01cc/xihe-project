#!/usr/bin/env node
/**
 * task-927：表单受控输入 → 共享校验器接入普查门（R9 / R13 / R24）。
 *
 * 判据：产品面 `.vue` 里，位于表单容器（`<form>` / `FormRoot` / `FieldRoot` /
 * `FieldGroup` / dialog 内容 / `label` 等）内的受控输入（`input` / `textarea` / `select`
 * 或 vendor `Input` / `Textarea` / `Select`，且带 `v-model`）必须：
 *   1. 所在 SFC 从 `lib/formValidation` 导入共享校验器；
 *   2. 元素上带 `data-form-field="<rule id>"` 标记。
 *
 * 为什么用标记而不是猜 `:error` / `aria-invalid`：静态扫描无法证明「某个 prop 真的由共享
 * 校验器产出」；显式标记是唯一可机械判定的接入契约。规则 id 本身由
 * `src/lib/__tests__/formValidation.spec.ts` 校验（未知 id 在那里红）。
 *
 * 存量只减不增：默认对照 `internal/A03-xihe/evidence/<日期>-task-927/baseline.json`。
 * 新增未接入输入 ⇒ exit 1；基线只允许通过 `--write-baseline` **收缩**（拒绝增长）。
 *
 * 已知盲区（诚实登记）：① 只扫产品面 `src/**`，排除 `src/components/ui/**`（vendor
 * 原语透传包装）与 `src/preview/**`；② 自定义 fixed modal 若既不是已知容器标签、也没有
 * `<label>` 祖先，会漏判 —— 漏判方向是「少报」，不会误伤已接入字段；③ 只判标记与导入，
 * 运行时的错误态/提交禁用语义由 `formValidation.spec.ts` 钉住。
 *
 * 用法：node scripts/check-form-validation.mjs [--json] [--baseline <path>]
 *        [--write-baseline] [--selftest]
 * 退出码：0 基线内 / 1 新增未接入或 write-baseline 试图增长 / 2 用法或环境错误 /
 *         selftest 不符 1。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "vue/compiler-sfc";

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_BASELINE = resolve(
    ROOT,
    "../../../internal/A03-xihe/evidence/2026-11-24-task-927/baseline.json",
);
const FORM_CONTAINERS = new Set([
    "form",
    "FormRoot",
    "FieldRoot",
    "Field",
    "FieldGroup",
    "FieldSet",
    "DialogContent",
    "AlertDialogContent",
    "SheetContent",
    "DrawerContent",
    "ModalContent",
    "fieldset",
    "label",
]);
const CONTROLLED_TAGS = new Set(["input", "textarea", "select", "Input", "Textarea", "Select"]);
const VALIDATOR_IMPORT = /from\s+["'][^"']*lib\/formValidation["']/;

function collectVueFiles() {
    const out = execFileSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "--", "src"],
        { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return out
        .split(/\r?\n/)
        .filter(Boolean)
        .filter((file) => file.endsWith(".vue"))
        .filter((file) => !file.includes("__tests__"))
        .filter((file) => !file.includes("/preview/"))
        .filter((file) => !file.startsWith("src/components/ui/"));
}

function hasValidatorImport(descriptor) {
    const scripts = [descriptor.scriptSetup?.content, descriptor.script?.content].filter(Boolean);
    return scripts.some((content) => VALIDATOR_IMPORT.test(content));
}

function modelExpression(props) {
    const model = props.find((prop) => prop.name === "model");
    if (!model) return null;
    return (model.exp?.content ?? model.arg?.content ?? "").replace(/\s+/g, " ").trim();
}

function markerValue(props) {
    const marker = props.find(
        (prop) =>
            prop.name === "data-form-field" ||
            (prop.name === "bind" && prop.arg?.content === "data-form-field"),
    );
    if (!marker) return null;
    if (marker.type === 6) return "static";
    return (marker.exp?.content ?? "").replace(/\s+/g, " ").trim() || null;
}

function analyzeSfc(source, file) {
    const parsed = parse(source, { filename: file });
    if (parsed.errors.length > 0) {
        throw new Error(`SFC parse failed: ${parsed.errors.map(String).join("; ")}`);
    }
    const ast = parsed.descriptor.template?.ast;
    if (!ast) return { violations: [], controlled: 0 };

    const imported = hasValidatorImport(parsed.descriptor);
    const violations = [];
    let controlled = 0;

    function walk(node, ancestors) {
        if (!node || typeof node !== "object") return;
        if (node.type === 1) {
            const tag = node.tag;
            const model = modelExpression(node.props ?? []);
            const inForm = ancestors.some((ancestor) => FORM_CONTAINERS.has(ancestor));
            if (CONTROLLED_TAGS.has(tag) && model && inForm) {
                controlled += 1;
                const marker = markerValue(node.props);
                if (!marker || !imported) {
                    violations.push({
                        file,
                        line: node.loc?.start?.line ?? 1,
                        tag,
                        model,
                        reason: !marker ? "missing-marker" : "missing-import",
                    });
                }
            }
            ancestors = ancestors.concat(tag);
        }
        if (Array.isArray(node.children)) {
            for (const child of node.children) walk(child, ancestors);
        }
    }

    walk(ast, []);
    return { violations, controlled };
}

function scan() {
    const files = collectVueFiles();
    const all = [];
    let controlled = 0;
    for (const file of files) {
        const source = readFileSync(join(ROOT, file), "utf8");
        let result;
        try {
            result = analyzeSfc(source, file);
        } catch (error) {
            error.message = `${file}: ${error.message}`;
            throw error;
        }
        controlled += result.controlled;
        all.push(...result.violations);
    }

    const occurrences = new Map();
    for (const site of all) {
        const base = `${site.file}|${site.tag}|${site.model}`;
        const occurrence = occurrences.get(base) ?? 0;
        occurrences.set(base, occurrence + 1);
        site.occurrence = occurrence;
        site.key = `${base}|${occurrence}`;
    }
    all.sort(
        (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.key.localeCompare(b.key),
    );
    return { files: files.length, controlled, sites: all };
}

function loadBaseline(path) {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.entries)) {
        throw new Error(`${path}: baseline.entries is not an array`);
    }
    return parsed;
}

function compare(sites, baseline) {
    const baseKeys = new Set((baseline?.entries ?? []).map((entry) => entry.key));
    const currentKeys = new Set(sites.map((site) => site.key));
    return {
        added: sites.filter((site) => !baseKeys.has(site.key)),
        stale: (baseline?.entries ?? []).filter((entry) => !currentKeys.has(entry.key)),
    };
}

function writeBaseline(path, sites) {
    mkdirSync(dirname(path), { recursive: true });
    const payload = {
        task: "task-927",
        generatedAt: "2026-11-24",
        scanner: "packages/ui/scripts/check-form-validation.mjs",
        note: "只减不增：新接入字段后重跑 --write-baseline 收缩；不要手改 key。",
        entries: sites.map((site) => ({
            key: site.key,
            file: site.file,
            line: site.line,
            tag: site.tag,
            model: site.model,
        })),
    };
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function formatSite(site) {
    return `${site.file}:${site.line} <${site.tag}> v-model="${site.model}" [${site.reason}]`;
}

function selftest() {
    const cases = [
        {
            name: "unmarked input + marked input in form; search outside form ignored",
            source: `
<script setup lang="ts">
import { validateField } from "@/lib/formValidation";
</script>
<template>
  <form>
    <Input v-model="plain" />
    <Input v-model="wired" data-form-field="provider.connectionKey" />
    <input v-model="native" />
  </form>
  <div><input v-model="search" /></div>
</template>`,
            expect: 2,
        },
        {
            name: "bound marker + import ⇒ connected",
            source: `
<script setup lang="ts">
import { validateField } from "@/lib/formValidation";
</script>
<template>
  <form><Input v-model="name" :data-form-field="ruleId" /></form>
</template>`,
            expect: 0,
        },
        {
            name: "marker without import still fails",
            source: `
<script setup lang="ts"></script>
<template>
  <form><input v-model="name" data-form-field="principal.name" /></form>
</template>`,
            expect: 1,
        },
        {
            name: "label ancestor counts as a form container",
            source: `
<script setup lang="ts"></script>
<template>
  <label><input v-model="name" /></label>
</template>`,
            expect: 1,
        },
        {
            name: "uncontrolled select (no v-model) ignored",
            source: `
<script setup lang="ts"></script>
<template>
  <form><Select><SelectItem value="a" /></Select></form>
</template>`,
            expect: 0,
        },
    ];

    let failures = 0;
    for (const testCase of cases) {
        const result = analyzeSfc(testCase.source, `fixture-${failures}.vue`);
        const ok = result.violations.length === testCase.expect;
        console.log(
            `${ok ? "PASS" : "FAIL"} selftest: ${testCase.name} ` +
                `(expected ${testCase.expect}, got ${result.violations.length})`,
        );
        if (!ok) {
            failures += 1;
            for (const site of result.violations) console.log(`  ${formatSite(site)}`);
        }
    }
    return failures === 0 ? 0 : 1;
}

function printHelp() {
    console.log(
        [
            "check-form-validation.mjs — task-927 form validation adoption gate",
            "",
            "Usage: node scripts/check-form-validation.mjs [options]",
            "  --baseline <path>   baseline file (default: internal/A03-xihe/evidence/2026-11-24-task-927/baseline.json)",
            "  --write-baseline    shrink/refresh the baseline; refuses to add new sites",
            "  --json              machine-readable output",
            "  --selftest          run in-memory fixture checks",
            "  --help, -h          print this help",
        ].join("\n"),
    );
}

function main(argv) {
    if (argv.includes("--help") || argv.includes("-h")) {
        printHelp();
        return 0;
    }
    if (argv.includes("--selftest")) return selftest();

    let baselinePath = DEFAULT_BASELINE;
    const baselineIndex = argv.indexOf("--baseline");
    if (baselineIndex >= 0) {
        baselinePath = resolve(ROOT, argv[baselineIndex + 1] ?? "");
        if (!argv[baselineIndex + 1]) {
            console.error("FAIL --baseline 缺少路径");
            return 2;
        }
    }
    const json = argv.includes("--json");
    const write = argv.includes("--write-baseline");

    let result;
    try {
        result = scan();
    } catch (error) {
        console.error(`FAIL 扫描失败：${error.message}`);
        return 2;
    }

    let baseline;
    try {
        baseline = loadBaseline(baselinePath);
    } catch (error) {
        console.error(`FAIL 读取基线失败：${error.message}`);
        return 2;
    }

    if (write) {
        const baselineKeys = new Set((baseline?.entries ?? []).map((entry) => entry.key));
        if (baseline && result.sites.some((site) => !baselineKeys.has(site.key))) {
            const { added } = compare(result.sites, baseline);
            console.error(`FAIL --write-baseline 拒绝增长：新增 ${added.length} 个未接入输入`);
            for (const site of added) console.error(`  ${formatSite(site)}`);
            return 1;
        }
        writeBaseline(baselinePath, result.sites);
        console.log(
            `BASELINE 写入 ${baselinePath}：${result.sites.length} 个存量未接入输入` +
                (baseline ? `（原 ${baseline.entries.length}）` : ""),
        );
        return 0;
    }

    if (!baseline) {
        console.error(`FAIL 基线不存在：${baselinePath}（先跑 --write-baseline 建基线）`);
        return 2;
    }

    const { added, stale } = compare(result.sites, baseline);
    if (json) {
        console.log(
            JSON.stringify(
                {
                    files: result.files,
                    controlled: result.controlled,
                    violations: result.sites.length,
                    baseline: baseline.entries.length,
                    added,
                    stale,
                },
                null,
                2,
            ),
        );
        return added.length === 0 ? 0 : 1;
    }

    console.log(
        `FORM-VALIDATION files=${result.files} controlled=${result.controlled} ` +
            `violations=${result.sites.length} baseline=${baseline.entries.length}`,
    );
    if (stale.length > 0) {
        console.log(
            `NOTE 基线有 ${stale.length} 条已消失（可收缩，未自动改写；需要时跑 --write-baseline）`,
        );
    }
    if (added.length > 0) {
        console.error(`FAIL 新增 ${added.length} 个未接入共享校验器的受控输入：`);
        for (const site of added) console.error(`  ${formatSite(site)}`);
        return 1;
    }
    console.log("OK 基线内：没有新增未接入输入");
    return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
    process.exitCode = main(process.argv.slice(2));
}

export { analyzeSfc, compare, main, scan, selftest };
