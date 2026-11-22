#!/usr/bin/env node
/**
 * check-i18n-hardcoded.mjs — template-level hardcoded-copy gate (task-763).
 *
 * Parses every `.vue` template with `vue/compiler-sfc` and reports:
 *   - TEXT nodes containing CJK (any Han script character);
 *   - TEXT nodes that look like a sentence (>= 3 words, first word capitalized);
 *   - literal user-visible attributes: placeholder / aria-label / title / alt.
 *
 * Excluded by construction: `{{ }}` interpolations, `:attr` bindings, comments,
 * `<script>` / `<style>`, `__tests__` and `preview` directories, `src/i18n/index.ts`
 * (not a template anyway). No regex scanning of source text.
 *
 * Allowlist: `scripts/i18n-hardcoded-allowlist.json`, keyed by
 * `file:line@text-hash`, each entry carrying `reason` and `owner-task`.
 * Stale entries are red (the list must match the current tree exactly).
 *
 * Usage:
 *   node scripts/check-i18n-hardcoded.mjs                 # check (exit 0/1/2)
 *   node scripts/check-i18n-hardcoded.mjs --json
 *   node scripts/check-i18n-hardcoded.mjs --write-allowlist
 *   options: --root <dir> --allowlist <file>
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileTemplate, parse } from "vue/compiler-sfc";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(HERE, "..");
const DEFAULT_ROOT = path.join(UI_ROOT, "src");
const DEFAULT_ALLOWLIST = path.join(HERE, "i18n-hardcoded-allowlist.json");

const VISIBLE_ATTRS = new Set(["placeholder", "aria-label", "title", "alt"]);
const SKIP_DIRS = new Set(["__tests__", "preview"]);
const HAN = /\p{Script=Han}/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const KEY_RE = /^.+:\d+@[0-9a-f]{10}$/;

function parseArgs(argv) {
    const out = {
        root: DEFAULT_ROOT,
        allowlist: DEFAULT_ALLOWLIST,
        json: false,
        writeAllowlist: false,
        help: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--json") out.json = true;
        else if (arg === "--write-allowlist") out.writeAllowlist = true;
        else if (arg === "--help" || arg === "-h") out.help = true;
        else if (arg === "--root") out.root = path.resolve(UI_ROOT, argv[++i]);
        else if (arg === "--allowlist") out.allowlist = path.resolve(UI_ROOT, argv[++i]);
        else throw new Error(`unknown argument: ${arg}`);
    }
    return out;
}

function walkVueFiles(root) {
    const files = [];
    const visit = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue;
                visit(full);
            } else if (entry.isFile() && entry.name.endsWith(".vue")) {
                files.push(full);
            }
        }
    };
    visit(root);
    return files;
}

function textHash(text) {
    return createHash("sha256").update(text).digest("hex").slice(0, 10);
}

function keyFor(relativeFile, line, text) {
    return `${relativeFile}:${line}@${textHash(text)}`;
}

function looksLikeSentence(text) {
    const words = text.split(/\s+/u).filter((word) => LETTER_OR_NUMBER.test(word));
    return words.length >= 3 && /^[A-Z]/u.test(words[0]);
}

function isHardcoded(text) {
    return HAN.test(text) || looksLikeSentence(text);
}

function nodeText(node) {
    return typeof node.content === "string" ? node.content : "";
}

function scanTemplate(descriptor, relativeFile, filename) {
    const template = descriptor.template;
    if (!template) return { hits: [], errors: [] };
    const compiled = compileTemplate({
        source: template.content,
        filename,
        id: relativeFile,
        // Static hoisting rewrites static subtrees into string codegen and removes their text
        // nodes from the AST, which silently drops copy inside otherwise-static v-else branches
        // (task-763 review: KnowledgeBaseView v-else upload copy was missed). Keep the full tree.
        compilerOptions: { hoistStatic: false },
    });
    if (compiled.errors?.length) {
        return {
            hits: [],
            errors: compiled.errors.map(
                (error) => `${relativeFile}: template parse failed: ${String(error)}`,
            ),
        };
    }
    const lineBase = (template.loc?.start?.line ?? 1) - 1;
    const hits = [];
    const seen = new WeakSet();
    const recordText = (node, text) => {
        const trimmed = text.trim();
        if (!trimmed || !LETTER_OR_NUMBER.test(trimmed) || !isHardcoded(trimmed)) return;
        hits.push({
            file: relativeFile,
            line: lineBase + node.loc.start.line,
            column: node.loc.start.column,
            text: trimmed,
            key: keyFor(relativeFile, lineBase + node.loc.start.line, trimmed),
        });
    };

    // compiler-sfc emits different container shapes: normal children in `children`,
    // v-if/v-else branches in IF_NODE.branches[], v-for children in FOR_NODE.children[].
    // Walk every object-valued field (except source positions and the derived `codegenNode`,
    // which duplicates the tree) so new container shapes cannot become blind spots
    // (task-763 review: v-if branch was missed => false green).
    // AttributeNode values are themselves TextNodes (type 2) carrying the literal value, so
    // they must be handled at the attribute node and never re-walked as element copy —
    // otherwise `class` / SVG `d="M3 7v10…"` etc. become false positives.
    const SKIP_FIELDS = new Set(["loc", "parent", "codegenNode"]);
    const visit = (node) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
            for (const item of node) visit(item);
            return;
        }
        if (seen.has(node)) return;
        seen.add(node);
        if (node.type === 6) {
            if (VISIBLE_ATTRS.has(node.name) && typeof node.value?.content === "string") {
                recordText(node, node.value.content);
            }
            return;
        }
        if (node.type === 2) {
            recordText(node, nodeText(node));
        }
        for (const [key, value] of Object.entries(node)) {
            if (SKIP_FIELDS.has(key)) continue;
            if (value && typeof value === "object") visit(value);
        }
    };
    visit(compiled.ast);
    return { hits, errors: [] };
}

/** Scan one SFC source string (public for unit tests; no filesystem side effects). */
export function scanSfc(source, relativeFile = "fixture.vue") {
    const parsed = parse(source, { filename: relativeFile });
    if (parsed.errors?.length) {
        return {
            hits: [],
            errors: parsed.errors.map(
                (error) => `${relativeFile}: SFC parse failed: ${String(error)}`,
            ),
        };
    }
    return scanTemplate(parsed.descriptor, relativeFile, relativeFile);
}

export function scanRoot(root = DEFAULT_ROOT) {
    const hits = [];
    const errors = [];
    for (const file of walkVueFiles(root)) {
        const relative = path.relative(UI_ROOT, file).split(path.sep).join("/");
        if (relative === "src/i18n/index.ts") continue;
        let source;
        try {
            source = fs.readFileSync(file, "utf8");
        } catch (error) {
            errors.push(`${relative}: cannot read: ${error.message}`);
            continue;
        }
        const result = scanSfc(source, relative);
        hits.push(...result.hits);
        errors.push(...result.errors);
    }
    hits.sort(
        (a, b) =>
            a.file.localeCompare(b.file) ||
            a.line - b.line ||
            a.column - b.column ||
            a.text.localeCompare(b.text),
    );
    // The allowlist key is file:line@text-hash, so two AST occurrences on one line with the same
    // text (e.g. title="粗体" + text 粗体) are one key. Keep the first, report raw occurrences.
    const occurrences = hits.length;
    const byKey = new Map();
    for (const hit of hits) {
        if (!byKey.has(hit.key)) byKey.set(hit.key, hit);
    }
    return { hits: [...byKey.values()], occurrences, errors };
}

export function loadAllowlist(file) {
    if (!fs.existsSync(file)) return { entries: {}, problems: [] };
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
        return { entries: {}, problems: [`allowlist is not valid JSON: ${error.message}`] };
    }
    const raw = parsed?.entries ?? parsed;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { entries: {}, problems: ["allowlist must be an object keyed by file:line@hash"] };
    }
    const entries = {};
    const problems = [];
    for (const [key, value] of Object.entries(raw)) {
        if (key === "version" || key === "note") continue;
        if (!KEY_RE.test(key)) {
            problems.push(`invalid key (expected file:line@10-hex-hash): ${key}`);
            continue;
        }
        const reason = typeof value === "object" ? value?.reason : "";
        const ownerTask = typeof value === "object" ? value?.["owner-task"] : "";
        if (typeof reason !== "string" || !reason.trim()) {
            problems.push(`missing reason: ${key}`);
        }
        if (typeof ownerTask !== "string" || !ownerTask.trim()) {
            problems.push(`missing owner-task: ${key}`);
        }
        entries[key] = value;
    }
    return { entries, problems };
}

function writeAllowlist(file, hits, previous) {
    const entries = {};
    for (const hit of hits) {
        entries[hit.key] = previous[hit.key] ?? {
            reason: "首轮存量硬编码冻结；由 task-757/759 及各面卡片迁移，禁止整目录豁免",
            "owner-task": "task-763",
        };
    }
    const ordered = {};
    for (const key of Object.keys(entries).sort()) ordered[key] = entries[key];
    const payload = {
        version: 1,
        note: "task-763 template hardcoded-copy baseline: file:line@text-hash; every row needs reason + owner-task",
        entries: ordered,
    };
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return Object.keys(ordered).length;
}

function printText(hit) {
    return `${hit.file}:${hit.line}:${hit.column}  ${hit.text}`;
}

function main(argv) {
    const args = parseArgs(argv);
    if (args.help) {
        console.log(
            "usage: node scripts/check-i18n-hardcoded.mjs [--json] [--write-allowlist] [--root <dir>] [--allowlist <file>]",
        );
        return 0;
    }
    const { hits, occurrences, errors } = scanRoot(args.root);
    const allowload = loadAllowlist(args.allowlist);

    if (args.writeAllowlist) {
        const count = writeAllowlist(args.allowlist, hits, allowload.entries);
        console.log(
            `[i18n-hardcoded] wrote ${count} allowlist entries -> ${path.relative(UI_ROOT, args.allowlist)}`,
        );
        console.log(
            `[i18n-hardcoded] hits=${hits.length} occurrences=${occurrences} errors=${errors.length}`,
        );
        for (const error of errors) console.error(error);
        return errors.length ? 2 : 0;
    }

    const allowlisted = hits.filter((hit) => allowload.entries[hit.key]);
    const unallowlisted = hits.filter((hit) => !allowload.entries[hit.key]);
    const currentKeys = new Set(hits.map((hit) => hit.key));
    const stale = Object.keys(allowload.entries)
        .filter((key) => !currentKeys.has(key))
        .sort();
    const problems = [...allowload.problems];
    const ok =
        errors.length === 0 &&
        problems.length === 0 &&
        unallowlisted.length === 0 &&
        stale.length === 0;

    if (args.json) {
        console.log(
            JSON.stringify(
                {
                    ok,
                    hits: hits.length,
                    occurrences,
                    allowlisted: allowlisted.length,
                    unallowlisted: unallowlisted.map((hit) => ({ ...hit })),
                    stale,
                    problems,
                    errors,
                },
                null,
                2,
            ),
        );
    } else {
        for (const hit of unallowlisted) console.log(printText(hit));
        for (const key of stale) console.log(`STALE ${key}`);
        for (const problem of problems) console.log(`BAD ${problem}`);
        for (const error of errors) console.log(`ERROR ${error}`);
        console.log(
            `[i18n-hardcoded] hits=${hits.length} occurrences=${occurrences} allowlisted=${allowlisted.length} ` +
                `unallowlisted=${unallowlisted.length} stale=${stale.length} problems=${problems.length}`,
        );
    }
    return ok ? 0 : unallowlisted.length > 0 || stale.length > 0 || problems.length > 0 ? 1 : 2;
}

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (error) {
        console.error(`[i18n-hardcoded] ${error?.message ?? error}`);
        process.exitCode = 2;
    }
}
