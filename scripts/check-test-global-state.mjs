#!/usr/bin/env node
/**
 * BL-262 guard (D): no **process-global mutation** in Rust test code unless it is explicitly
 * isolated. This is the "把教训变成静态门" half of the fix — the CWD race itself was removed by
 * making the tests take an absolute root, and this check stops the next one from sneaking back in.
 *
 * Why a check and not a doc line: the failing mode is invisible in review (a `set_var` inside a
 * `#[test]` looks local) and only shows up as a random failure in a *different* module, exactly
 * how BL-262 hid for weeks (`cargo test --lib` red 9/10 times, a different checkpoint test each run).
 *
 * Rule: inside `#[cfg(test)]` regions, `set_var(`, `remove_var(` and `set_current_dir(` are only
 * allowed when the innermost enclosing function either
 *   - is annotated `#[ignore]` (explicitly run isolated), or
 *   - mentions `PROCESS_LOCK` in its body (the module's env/cwd serializer).
 * Nested helpers (e.g. a `Drop` guard inside an `#[ignore]` test) are allowed by walking outward.
 *
 * Usage:
 *   node scripts/check-test-global-state.mjs [--root <dir> ...] [--json]
 *   (default roots: packages/runtime/src, packages/runtime/tests)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** Process-global mutators that make parallel tests order-dependent. */
export const GLOBAL_MUTATORS = Object.freeze(['set_var', 'remove_var', 'set_current_dir']);

const MUTATOR_PATTERN = new RegExp(`\\b(${GLOBAL_MUTATORS.join('|')})\\s*\\(`, 'gu');
const FN_PATTERN = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/gu;

const DEFAULT_ROOTS = ['packages/runtime/src', 'packages/runtime/tests'];

function lineAt(text, index) {
    let line = 1;
    for (let cursor = 0; cursor < index; cursor += 1) {
        if (text.charCodeAt(cursor) === 10) line += 1;
    }
    return line;
}

/** Index of the `}` matching the `{` at `open`, or -1. Ignores braces inside strings/chars/comments. */
export function matchingBrace(text, open) {
    let depth = 0;
    let state = 'code';
    for (let index = open; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];
        if (state === 'line-comment') {
            if (char === '\n') state = 'code';
            continue;
        }
        if (state === 'block-comment') {
            if (char === '*' && next === '/') {
                state = 'code';
                index += 1;
            }
            continue;
        }
        if (state === 'string') {
            if (char === '\\') index += 1;
            else if (char === '"') state = 'code';
            continue;
        }
        if (state === 'char') {
            if (char === '\\') index += 1;
            else if (char === "'") state = 'code';
            continue;
        }
        if (char === '/' && next === '/') {
            state = 'line-comment';
            index += 1;
            continue;
        }
        if (char === '/' && next === '*') {
            state = 'block-comment';
            index += 1;
            continue;
        }
        if (char === '"') {
            state = 'string';
            continue;
        }
        if (char === "'" && /[\w\\]/.test(next ?? '')) {
            state = 'char';
            continue;
        }
        if (char === '{') depth += 1;
        else if (char === '}') {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    return -1;
}

/** `#[cfg(test)]` regions (module bodies). */
export function cfgTestRegions(text) {
    const regions = [];
    const marker = /#\[cfg\(test\)\]/gu;
    let match;
    while ((match = marker.exec(text)) !== null) {
        const open = text.indexOf('{', match.index);
        if (open < 0) continue;
        const close = matchingBrace(text, open);
        if (close < 0) continue;
        regions.push({ start: open, end: close });
    }
    return regions;
}

/**
 * Functions enclosing `position`, innermost first.
 * Bodies are found by matching braces from the first `{` after the parameter list.
 */
export function enclosingFunctions(text, position) {
    const found = [];
    FN_PATTERN.lastIndex = 0;
    let match;
    while ((match = FN_PATTERN.exec(text)) !== null) {
        if (match.index > position) break;
        const open = text.indexOf('{', match.index);
        if (open < 0 || open > position) continue;
        const close = matchingBrace(text, open);
        if (close < position) continue;
        found.push({ name: match[1], start: match.index, open, close });
    }
    return found.sort((left, right) => right.start - left.start);
}

/**
 * Attribute/comment lines directly above `fnStart`.
 * The caller's own line prefix (`async `, `pub `, `pub(crate) `) is dropped first — otherwise it
 * reads as "code" and stops the scan before the `#[ignore]` above it.
 */
function attributesBefore(text, fnStart) {
    const before = text.slice(0, fnStart).split(/\r?\n/u);
    before.pop();
    const collected = [];
    for (let index = before.length - 1; index >= 0; index -= 1) {
        const line = before[index].trim();
        if (line === '' || line.startsWith('#[') || line.startsWith('//')) {
            collected.push(line);
            continue;
        }
        break;
    }
    return collected;
}

function isAllowed(text, fn) {
    const attributes = attributesBefore(text, fn.start);
    // Explicit opt-out with a reason: helpers that only wrap a call site already under a lock.
    if (attributes.some((line) => line.includes('test-global-state: allow'))) return true;
    if (attributes.some((line) => line.startsWith('#[ignore'))) return true;
    return text.slice(fn.open, fn.close).includes('PROCESS_LOCK');
}

/**
 * @param {string} text Rust source
 * @param {string} [file] label for reports
 * @returns {Array<{file: string, line: number, mutator: string, snippet: string, function: string}>}
 */
export function analyzeSource(text, file = '<inline>') {
    const regions = cfgTestRegions(text);
    if (regions.length === 0) return [];
    const violations = [];
    MUTATOR_PATTERN.lastIndex = 0;
    let match;
    while ((match = MUTATOR_PATTERN.exec(text)) !== null) {
        const position = match.index;
        const region = regions.find((candidate) => position >= candidate.start && position <= candidate.end);
        if (!region) continue;
        const functions = enclosingFunctions(text, position);
        if (functions.some((fn) => isAllowed(text, fn))) continue;
        const line = lineAt(text, position);
        const sourceLine = text.split(/\r?\n/u)[line - 1]?.trim() ?? '';
        violations.push({
            file,
            line,
            mutator: match[1],
            function: functions[0]?.name ?? '(top-level)',
            snippet: sourceLine.length > 120 ? `${sourceLine.slice(0, 117)}...` : sourceLine,
        });
    }
    return violations;
}

/** @param {string} file @returns {string[]} */
function rustFiles(root) {
    const out = [];
    const walk = (dir) => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile() && entry.name.endsWith('.rs')) out.push(full);
        }
    };
    try {
        if (statSync(root).isFile()) return [root];
    } catch {
        return [];
    }
    walk(root);
    return out.sort();
}

function main() {
    const argv = process.argv.slice(2);
    const roots = [];
    let json = false;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--json') json = true;
        else if (arg === '--root') roots.push(argv[(index += 1)]);
        else if (arg.startsWith('--root=')) roots.push(arg.slice('--root='.length));
        else if (arg === '--help' || arg === '-h') {
            console.log('usage: node scripts/check-test-global-state.mjs [--root <dir-or-file> ...] [--json]');
            console.log('default roots: packages/runtime/src packages/runtime/tests');
            process.exit(0);
        } else {
            console.error(`[test-global-state] unknown option: ${arg}`);
            process.exit(2);
        }
    }
    const base = resolve(import.meta.dirname, '..');
    const targets = (roots.length > 0 ? roots : DEFAULT_ROOTS).map((root) => resolve(base, root));
    const violations = [];
    for (const target of targets) {
        for (const file of rustFiles(target)) {
            violations.push(...analyzeSource(readFileSync(file, 'utf8'), relative(base, file).split('\\').join('/')));
        }
    }
    if (json) {
        console.log(JSON.stringify({ roots: targets.map((target) => relative(base, target)), violations }, null, 2));
    } else if (violations.length === 0) {
        console.log(`[test-global-state] OK: no unguarded process-global mutation in test code (${targets.map((target) => relative(base, target)).join(', ')})`);
    } else {
        console.error('[test-global-state] FAIL: process-global mutation in test code must be `#[ignore]`d or hold PROCESS_LOCK:');
        for (const violation of violations) {
            console.error(`  ${violation.file}:${violation.line} ${violation.mutator}() in ${violation.function}() — ${violation.snippet}`);
        }
    }
    process.exit(violations.length === 0 ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
