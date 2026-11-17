#!/usr/bin/env node
/**
 * task-76: a "readout field" in an emitted receipt must BE a readout, never a literal.
 *
 * <p>Root cause (reported by task-74): e2e/mock/task43-rsi-observation.spec.ts carried
 * checks.pageFailures: 0 in its evidence object -- a hardcoded literal: the test signature never
 * destructured the pageFailures fixture, so that line was the file's only occurrence. It is not in
 * the judgement chain, yet it claims in DATA that "this gate ran and was clean". The real gate is
 * e2e/mock/helpers/mock-test.ts (auto fixture teardown -> expectNoPageFailures); so the lie is the
 * receipt cell, not the assertion. This class (claim = readout, written as a constant) had no
 * instrument before this checker.</p>
 *
 * <p><b>Criterion (deliberately narrow -- see check-orphan-snapshots.mjs on "a criterion that
 * misfires is worse than none")</b>:</p>
 *
 * 1. Only EVIDENCE EMISSION SITES: the object literal serialised by testInfo.attach(...) /
 *    writeFileSync(...) / writeFile(...) / appendFileSync(...) via JSON.stringify(<identifier>).
 *    Route stub bodies (route.fulfill({ body: JSON.stringify(x) })) are OUT of scope: there
 *    "failed: []" builds the data under test, it claims nothing.
 * 2. Only READOUT NAMES (READOUT_KEYS, exact names, no prefix/substring matching -- prose fields
 *    such as verdictOrder must not be mis-hit), and only when the value is a PURE LITERAL
 *    (0 / false / [] / {} / "pass" / null ...).
 * 3. EXEMPTION (needs provenance) = ACCUMULATOR: the field grows via <key>.push( / <key>.unshift(
 *    in the same file, i.e. it really is a readout (empty at first, filled by event listeners).
 *    The test is the provenance itself, not a whitelist: whitelists rot, machine criteria do not.
 *
 * <p><b>Two known blind spots (honestly registered)</b>: (a) no AST -- strings/comments are
 * stripped and braces balanced, so a REGEX LITERAL containing "{" or "}" inside the receipt object
 * could confuse the depth (0 instances in the current tree); (b) only the direct
 * JSON.stringify(<identifier>) form is recognised -- member expressions such as
 * JSON.stringify(x.checks) are out of scope (0 instances today; add the criterion when one
 * appears rather than assuming it never will).</p>
 *
 * <p>Usage: this module exports the criterion only; the real-tree scan and the positive/negative
 * cases live in e2e/fixtures/__tests__/receipt-readouts.test.mjs (pnpm run test:e2e:fixtures,
 * already wired into mise validate).</p>
 */

const BACKTICK = "\u0060";
const BACKSLASH = "\\";

/** Readout names (exact names only; no prefix/substring matching). */
export const READOUT_KEYS = new Set([
    "pageFailures",
    "consoleErrors",
    "pageErrors",
    "failedResponses",
    "unexpected",
    "unexpectedCount",
    "skipped",
    "skippedCount",
    "checks",
    "counts",
    "errors",
    "failures",
    "errorCount",
    "failCount",
    "ok",
    "passed",
    "failed",
    "total",
    "clean",
    "leak",
    "issues",
    "problems",
    "verdict",
]);

/** Evidence emission sites. "attach" alone is too broad, so it must carry testInfo. */
const EMITTER_PATTERN = /\b(testInfo\s*\.\s*attach|writeFileSync|writeFile|appendFileSync)\s*\(/g;

/** Pure literals: numbers / booleans / empty containers / plain quoted strings / null. */
const NUMBER_LITERAL = /^[-+]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?n?$/;
const STRING_LITERAL = /^(["'])[^\\"\n$]*\1$/;

function isQuote(ch) {
    return ch === '"' || ch === "'" || ch === BACKTICK;
}

/** Find the call arguments for the "(" at openIdx; null when unbalanced. */
function callArguments(source, openIdx) {
    let depth = 0;
    let quote = null;
    for (let i = openIdx; i < source.length; i += 1) {
        const ch = source[i];
        if (quote) {
            if (ch === "\\") i += 1;
            else if (ch === quote) quote = null;
            continue;
        }
        if (isQuote(ch)) {
            quote = ch;
            continue;
        }
        if (ch === "(") depth += 1;
        else if (ch === ")") {
            depth -= 1;
            if (depth === 0) return source.slice(openIdx + 1, i);
        }
    }
    return null;
}

/** Identifiers serialised at an evidence emission site. */
export function emittedObjectNames(source) {
    const names = new Set();
    EMITTER_PATTERN.lastIndex = 0;
    let match;
    while ((match = EMITTER_PATTERN.exec(source)) !== null) {
        const args = callArguments(source, match.index + match[0].length - 1);
        if (args === null) continue;
        const stringify = /JSON\.stringify\(\s*([A-Za-z_$][\w$]*)\s*(?:,[^)]*)?\)/.exec(args);
        if (stringify) names.add(stringify[1]);
    }
    return names;
}

/** Brace index of "const x[: T] = {" (-1 when absent). */
function declarationBrace(source, name) {
    const declRe = new RegExp(
        String.raw`(?:const|let|var)\s+` + name + String.raw`\s*(?::[^=]+)?=\s*\{`,
    );
    const found = declRe.exec(source);
    return found ? found.index + found[0].length - 1 : -1;
}

/** Matching close brace for the open brace at openIdx; -1 when unbalanced. */
function matchingBrace(source, openIdx) {
    let depth = 0;
    let quote = null;
    for (let i = openIdx; i < source.length; i += 1) {
        const ch = source[i];
        if (quote) {
            if (ch === "\\") i += 1;
            else if (ch === quote) quote = null;
            continue;
        }
        if (isQuote(ch)) {
            quote = ch;
            continue;
        }
        if (ch === "{") depth += 1;
        else if (ch === "}") {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function isPureLiteral(valueText) {
    const value = valueText.trim();
    if (value === "true" || value === "false" || value === "null" || value === "undefined") {
        return true;
    }
    if (value === "[]" || value === "{}") return true;
    if (NUMBER_LITERAL.test(value)) return true;
    return STRING_LITERAL.test(value);
}

/** Accumulator exemption: the field grows via .push( / .unshift( somewhere in this file. */
function isAccumulator(source, key) {
    const escaped = key.replace(/[^A-Za-z0-9_]/g, (ch) => BACKSLASH + ch);
    return new RegExp(String.raw`\.` + escaped + String.raw`\s*(?:\.push|\.unshift)\s*\(`).test(
        source,
    );
}

/** Split one object body into depth-0 entries (comma separated), keeping offsets. */
function topLevelEntries(body) {
    const entries = [];
    let depth = 0;
    let quote = null;
    let segmentStart = 0;
    for (let i = 0; i < body.length; i += 1) {
        const ch = body[i];
        if (quote) {
            if (ch === "\\") i += 1;
            else if (ch === quote) quote = null;
            continue;
        }
        if (isQuote(ch)) {
            quote = ch;
            continue;
        }
        if (ch === "{" || ch === "[" || ch === "(") {
            depth += 1;
            continue;
        }
        if (ch === "}" || ch === "]" || ch === ")") {
            depth -= 1;
            continue;
        }
        if (depth === 0 && ch === ",") {
            const raw = body.slice(segmentStart, i);
            if (raw.trim().length > 0) {
                entries.push({ offset: segmentStart, text: raw.trim() });
            }
            segmentStart = i + 1;
        }
    }
    const tail = body.slice(segmentStart);
    if (tail.trim().length > 0) {
        entries.push({ offset: segmentStart, text: tail.trim() });
    }
    return entries;
}

/** Shorthand-following depth cap (a receipt is never 8 objects deep). */
const MAX_DEPTH = 8;

/** Walk one object body, recursing into nested object literals. */
function walkObject(body, bodyOffset, source, prefix, out, visited = new Set()) {
    for (const entry of topLevelEntries(body)) {
        // Shorthand property (task-76 mutation B, measured): a receipt written as
        // { ..., checks, ... } passes the object by NAME. Without this branch the scan stops at
        // the outer object and a bad field one level down reads as "no hits" -- i.e. the gate
        // goes green precisely on the tidy refactor that keeps the bug. Follow the identifier.
        const shorthand = /^([A-Za-z_$][\w$]*)$/.exec(entry.text);
        if (shorthand !== null) {
            const name = shorthand[1];
            const scope = prefix + "|" + name;
            if (prefix.split(".").length <= MAX_DEPTH && !visited.has(scope)) {
                const brace = declarationBrace(source, name);
                const close = brace >= 0 ? matchingBrace(source, brace) : -1;
                if (close > brace) {
                    visited.add(scope);
                    const inner = prefix.length > 0 ? prefix + "." + name : name;
                    walkObject(
                        source.slice(brace + 1, close),
                        brace + 1,
                        source,
                        inner,
                        out,
                        visited,
                    );
                }
            }
            continue;
        }
        const match = /^([A-Za-z_$][\w$]*|"[^"]*"|'[^']*')\s*:\s*([\s\S]*)$/.exec(entry.text);
        if (match === null) continue;
        const key = match[1].replace(/^["']|["']$/g, "");
        const valueText = match[2].trim();
        const path = prefix.length > 0 ? prefix + "." + key : key;
        const entryStart = body.indexOf(entry.text, entry.offset);
        const valueStart = entryStart + entry.text.indexOf(match[2]);
        if (valueText.startsWith("{")) {
            const closeIdx = matchingBrace(valueText, 0);
            if (closeIdx > 0) {
                walkObject(
                    valueText.slice(1, closeIdx),
                    bodyOffset + valueStart + 1,
                    source,
                    path,
                    out,
                    visited,
                );
            }
            continue;
        }
        if (!READOUT_KEYS.has(key)) continue;
        if (!isPureLiteral(valueText)) continue;
        if (isAccumulator(source, key)) continue;
        const line = source.slice(0, bodyOffset + valueStart).split("\n").length;
        out.push({ line, path, key, value: valueText });
    }
}

/**
 * Blank out comments while PRESERVING string literals and every byte offset.
 *
 * <p>Why this exists (measured, task-76 mutation A): with the literal restored plus a trailing
 * comment ("pageFailures: 0, // MUTATION A ..."), the entry value read as
 * "0 // MUTATION A ...", isPureLiteral() said false, and the gate stayed GREEN on a tree that
 * carries the bug. A criterion defeated by a comment is worse than none: it reports clean exactly
 * when someone wrote an explanation next to the lie. Blanking (not deleting) keeps offsets intact,
 * so line numbers and nested-object recursion stay valid.</p>
 */
export function blankComments(source) {
    let out = "";
    let quote = null;
    let inBlock = false;
    for (let i = 0; i < source.length; i += 1) {
        const ch = source[i];
        if (inBlock) {
            if (ch === "*" && source[i + 1] === "/") {
                out += "  ";
                i += 1;
                inBlock = false;
            } else {
                out += ch === "\n" ? "\n" : " ";
            }
            continue;
        }
        if (quote) {
            out += ch;
            if (ch === "\\") {
                out += source[i + 1] ?? "";
                i += 1;
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (isQuote(ch)) {
            quote = ch;
            out += ch;
            continue;
        }
        if (ch === "/" && source[i + 1] === "/") {
            while (i < source.length && source[i] !== "\n") {
                out += " ";
                i += 1;
            }
            if (i < source.length) out += "\n";
            continue;
        }
        if (ch === "/" && source[i + 1] === "*") {
            out += "  ";
            i += 1;
            inBlock = true;
            continue;
        }
        out += ch;
    }
    return out;
}

/**
 * Scan one source text for "claims a readout, actually a literal" fields in emitted evidence.
 *
 * @param {string} source file text
 * @param {string} [file] file name for reporting
 * @returns {Array<{file: string, line: number, path: string, key: string, value: string}>}
 */
export function scanReceiptReadouts(source, file = "<source>") {
    const violations = [];
    const masked = blankComments(source);
    for (const name of emittedObjectNames(masked)) {
        const brace = declarationBrace(masked, name);
        if (brace < 0) continue;
        const close = matchingBrace(masked, brace);
        if (close < 0) continue;
        walkObject(masked.slice(brace + 1, close), brace + 1, masked, "", violations);
    }
    for (const hit of violations) hit.file = file;
    return violations;
}
