#!/usr/bin/env node
/**
 * i18n 常驻门禁（task-96 / PLAN-0752 T5.1）。**只读**：不改源码、不改 locale、不写任何文件。
 *
 * 为什么需要它：2026-11-10 的一次性扫描（task-95）抓到 `ApprovalModal.vue` 把
 * `workspace.approvalResolvedElsewhereDraftKept` 写成 `chat.*` —— 静态类型不报、单测不崩、页面照渲染，
 * 用户看到的是**一串裸 key**。这类缺陷只有把三件事都查一遍才发现：
 *
 *  1. **两侧键集合差集**：zh-CN / en-US 任一侧缺键 ⇒ 缺的那侧渲染裸 key（或回退到另一语言）；
 *  2. **同键 {placeholder} 漂移**：两侧参数集合不一致 ⇒ 运行时渲染出 "undefined" 或漏值；
 *  3. **源码里的静态 `t("…")` 引用**：键路径写错/前缀写错 ⇒ 运行时裸 key。第 3 条正是本次缺陷的类别，
 *     所以它点名 `file:line`，而不是只报一个键名。
 *
 * 判据：真实仓库 exit 0 且**零输出**；有问题 exit 1 并逐条点名；结构/IO 问题 exit 2（不是 1：脚本自己
 * 出问题不等于产品有问题）。
 *
 * 用法：
 *   node scripts/i18n-scan.mjs              # 扫本仓（脚本所在仓库根）
 *   node scripts/i18n-scan.mjs --json       # 结构化输出（CI/工具用）
 *   node scripts/i18n-scan.mjs --root <dir> # 扫另一个根（单测夹具用）
 *   node scripts/i18n-scan.mjs --help
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOCALE_MODULE = "packages/ui/src/i18n/index.ts";
const SOURCE_DIR = "packages/ui/src";
const SOURCE_EXTENSIONS = [".vue", ".ts"];
/** 期望存在的两个 locale（缺一个就不是"翻译没做全"而是"文件结构坏了"）。 */
const EXPECTED_LOCALES = ["zh-CN", "en-US"];
const SKIP_DIRS = new Set(["node_modules", "__tests__", "dist", "preview"]);
const SKIP_FILE_SUFFIXES = [".spec.ts", ".test.ts", ".d.ts"];

class ScanError extends Error {}

/** 命令行解析（未知参数直接 usage 报错，别把拼错的参数当成"没传"）。 */
function parseArgs(argv) {
    const options = { root: DEFAULT_ROOT, json: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--json") options.json = true;
        else if (arg === "--help" || arg === "-h") options.help = true;
        else if (arg === "--root") {
            const value = argv[++i];
            if (!value) throw new ScanError("--root 需要一个目录参数");
            options.root = resolve(value);
        } else throw new ScanError(`未知参数：${arg}`);
    }
    return options;
}

const USAGE = `用法：
  node scripts/i18n-scan.mjs [--json] [--root <dir>]

  --json        以 JSON 输出（含 findings 明细）
  --root <dir>  扫描指定根目录（默认：脚本所在仓库根）
  --help        打印本说明

检查项：两侧键集合差集 / 同键 {placeholder} 漂移 / 源码静态 t("…") 引用 / 未闭合或字面花括号 / 漏译。
退出码：0 通过（无输出）；1 发现问题；2 脚本自身或仓库结构问题。`;

const posix = (value) => value.split(sep).join("/");

/**
 * 取 `const messages = {...}`：该文件除首行 import 外是**纯字面量 JS**（无 as const / 接口 / 泛型），
 * 所以去掉 import、把 export 去掉、用 stub 顶替 createI18n，在 `new Function` 里跑一遍即可 ——
 * 不把 vue / vue-i18n 拉进 Node，也不自己写对象解析器（手写 parser 是明令禁止的）。
 */
function readLocaleMessages(root) {
    const entry = join(root, LOCALE_MODULE);
    let source;
    try {
        source = readFileSync(entry, "utf8");
    } catch {
        throw new ScanError(`读不到 locale 文件：${posix(relative(root, entry))}（--root 指错了吗？）`);
    }
    if (!source.includes("export const i18n = createI18n(")) {
        throw new ScanError(`${LOCALE_MODULE} 结构变了：找不到 ` + '"export const i18n = createI18n("');
    }
    const body = source
        .replace(/^import[^\n]*\n/m, "")
        .replace("export const i18n = createI18n(", "const i18n = createI18n(");
    let messages;
    try {
        messages = new Function("createI18n", body + "\nreturn i18n.global.messages;")((options) => ({
            global: { messages: options.messages },
        }));
    } catch (error) {
        throw new ScanError(`解析 ${LOCALE_MODULE} 的 messages 失败：${error.message}`);
    }
    if (!messages || typeof messages !== "object") {
        throw new ScanError(`${LOCALE_MODULE} 没有导出可用的 messages 对象`);
    }
    return messages;
}

function flatten(object, prefix = "", out = new Map()) {
    for (const [key, value] of Object.entries(object)) {
        const full = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === "object" && !Array.isArray(value)) flatten(value, full, out);
        else out.set(full, String(value));
    }
    return out;
}

/** `{name}` 形式的插值参数，两侧必须一致；`{...}` 这种字面花括号是文案错误（DEV-011 §8）。 */
function placeholders(value) {
    return new Set([...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]));
}
const countChar = (value, char) => value.split(char).length - 1;

/**
 * 花括号体检。**只报真·漏替换**，两类合法写法必须放行（否则门禁会被噪音喂到没人看）：
 *  - vue-i18n 字面量插值 `{'@'}`（本仓 `chat.delivery.mentioned` 用它显示 @ 符号）；
 *  - JSON 样板文案：本仓 `settings.jsonPlaceholder` 是 textarea 的 mcpServers 样例，花括号是内容本身。
 * 真正的漏替换形态是 `{...}`、`{ … }`、`${x}` 这类**非标识符**花括号。
 */
function braceFindings(locale, key, value) {
  if (/\{[^{}]*"/.test(value)) return []; // JSON 样板：花括号里有引号
  const findings = [];
  for (const match of value.matchAll(/\{[^{}]*\}/g)) {
    const inner = match[0].slice(1, -1);
    if (/^[A-Za-z_]\w*$/.test(inner)) continue; // 插值参数（两侧一致性由 placeholder-drift 管）
    if (/^'.*'$/.test(inner)) continue; // vue-i18n 字面量
    findings.push({
      kind: "literal-brace",
      locale,
      key,
      detail: `含未替换花括号 ${match[0]}（应改成插值参数或去掉）`,
    });
  }
  if (countChar(value, "{") !== countChar(value, "}")) {
    findings.push({ kind: "unbalanced-brace", locale, key, detail: "花括号不配对" });
  }
  return findings;
}
const hasCjk = (value) => /[\u4e00-\u9fff]/.test(value);

function collectSourceFiles(dir, files = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) collectSourceFiles(full, files);
            continue;
        }
        if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
        if (SKIP_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
        files.push(full);
    }
    return files;
}

/** `t("a.b.c")` 静态引用；模板字符串/变量拼接无法静态判定，不计入（也不假报）。 */
const STATIC_CALL = /\bt\(\s*(["'`])([\w.-]+)\1/g;

function lineOf(text, index) {
    let line = 1;
    for (let i = 0; i < index; i++) if (text[i] === "\n") line++;
    return line;
}

function scan(root) {
    const messages = readLocaleMessages(root);
    const localeIds = Object.keys(messages);
    const findings = [];
    for (const locale of EXPECTED_LOCALES) {
        if (!localeIds.includes(locale)) {
            findings.push({ kind: "missing-locale", locale, detail: `messages 里没有 ${locale}` });
        }
    }
    const [primary, secondary] = EXPECTED_LOCALES;
    if (findings.length > 0) {
        return { root, localeIds, counts: null, findings };
    }

    const primaryKeys = flatten(messages[primary]);
    const secondaryKeys = flatten(messages[secondary]);
    const missingInSecondary = [...primaryKeys.keys()].filter((key) => !secondaryKeys.has(key)).sort();
    const missingInPrimary = [...secondaryKeys.keys()].filter((key) => !primaryKeys.has(key)).sort();
    for (const key of missingInSecondary) {
        findings.push({ kind: "missing-key", locale: secondary, key, detail: `${primary} 有、${secondary} 缺` });
    }
    for (const key of missingInPrimary) {
        findings.push({ kind: "missing-key", locale: primary, key, detail: `${secondary} 有、${primary} 缺` });
    }

    for (const key of [...primaryKeys.keys()].filter((key) => secondaryKeys.has(key))) {
        const left = [...placeholders(primaryKeys.get(key))].sort();
        const right = [...placeholders(secondaryKeys.get(key))].sort();
        if (left.join(",") !== right.join(",")) {
            findings.push({
                kind: "placeholder-drift",
                key,
                detail: `${primary}={${left.join(",")}} / ${secondary}={${right.join(",")}}`,
            });
        }
        // 漏译：两侧逐字相同且原文含中文 —— 英文侧留中文就是没翻
        if (secondaryKeys.get(key) === primaryKeys.get(key) && hasCjk(primaryKeys.get(key))) {
            findings.push({ kind: "untranslated", key, detail: `${secondary} 与 ${primary} 逐字相同` });
        }
        for (const [locale, table] of [
            [primary, primaryKeys],
            [secondary, secondaryKeys],
        ]) {
            findings.push(...braceFindings(locale, key, table.get(key)));
        }
    }

    const files = collectSourceFiles(join(root, SOURCE_DIR));
    for (const file of files) {
        const text = readFileSync(file, "utf8");
        const seen = new Set();
        for (const match of text.matchAll(STATIC_CALL)) {
            const key = match[2];
            const missing = [primary, secondary].filter((locale) =>
                locale === primary ? !primaryKeys.has(key) : !secondaryKeys.has(key),
            );
            if (missing.length === 0) continue;
            const rel = posix(relative(root, file));
            const line = lineOf(text, match.index ?? 0);
            const id = `${rel}:${line}:${key}`;
            if (seen.has(id)) continue;
            seen.add(id);
            findings.push({
                kind: "unresolved-t",
                file: rel,
                line,
                key,
                detail: `t("${key}") 在 ${missing.join(" / ")} 里都不存在`,
                missingIn: missing,
            });
        }
    }

    return {
        root,
        localeIds,
        counts: {
            primary: primaryKeys.size,
            secondary: secondaryKeys.size,
            uniqueKeys: new Set([...primaryKeys.keys(), ...secondaryKeys.keys()]).size,
            sourceFiles: files.length,
        },
        findings,
    };
}

function formatFinding(finding) {
    if (finding.kind === "unresolved-t") {
        return `  unresolved-t     ${finding.file}:${finding.line}  ${finding.key}（${finding.detail}）`;
    }
    if (finding.kind === "missing-key") {
        return `  missing-key      ${finding.locale}  ${finding.key}（${finding.detail}）`;
    }
    if (finding.kind === "placeholder-drift") {
        return `  placeholder-drift ${finding.key}  ${finding.detail}`;
    }
    if (finding.kind === "missing-locale") {
        return `  missing-locale   ${finding.locale}  ${finding.detail}`;
    }
    return `  ${finding.kind.padEnd(17)}${finding.locale ?? ""} ${finding.key ?? ""}  ${finding.detail}`;
}

function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`i18n-scan: ${error.message}\n\n${USAGE}\n`);
        return 2;
    }
    if (options.help) {
        process.stdout.write(USAGE + "\n");
        return 0;
    }
    let result;
    try {
        if (!statSync(options.root).isDirectory()) throw new ScanError(`--root 不是目录：${options.root}`);
        result = scan(options.root);
    } catch (error) {
        process.stderr.write(`i18n-scan: ${error instanceof ScanError ? error.message : error.stack}\n`);
        return 2;
    }

    const ok = result.findings.length === 0;
    if (options.json) {
        process.stdout.write(
            JSON.stringify(
                {
                    schema: 1,
                    ok,
                    root: posix(result.root),
                    locales: result.localeIds,
                    counts: result.counts,
                    findings: result.findings,
                },
                null,
                2,
            ) + "\n",
        );
        return ok ? 0 : 1;
    }
    // 通过时**不输出**：门禁的默认形态是"没话就是好话"，输出越多越容易被当噪音过滤掉
    if (!ok) {
        process.stdout.write(`i18n-scan: ${result.findings.length} 项问题\n`);
        for (const finding of result.findings) process.stdout.write(formatFinding(finding) + "\n");
        process.stdout.write(
            `\n口径：两侧键集合必须相等；同键 {placeholder} 集合必须相等；源码 t("…") 的键必须两侧都存在。\n`,
        );
    }
    return ok ? 0 : 1;
}

process.exitCode = main();
