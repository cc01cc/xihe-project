#!/usr/bin/env node
/**
 * PLAN-0702 / BL-342: dark-theme WCAG contrast audit.
 *
 * Zero-dependency Node script. Parses the UI token blocks (:root + .dark) from
 * packages/ui/src/styles/main.css, resolves var() chains (up to 4 hops), understands
 * #hex / rgb()/rgba() / oklch(), composites alpha over the worst-case backdrop, and
 * reports the 18 text pairs (>=4.5) plus ring/brand-accent (>=3.0).
 *
 * Usage: node scripts/ux/contrast-audit.mjs [--json] [--self-test] [--css <path>]
 * Exit: 0 = all pairs pass, 1 = ratio below threshold, 2 = parse failure (never a silent green).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const DEFAULT_CSS = resolve(REPO_ROOT, "packages/ui/src/styles/main.css");

const TEXT_MIN = 4.5;
const NON_TEXT_MIN = 3.0;

/** 18 text pairs + 1 non-text pair (the frozen list from PLAN-0702 M1 preflight). */
const PAIRS = [
    ["foreground/background", "foreground", "background"],
    ["foreground/card", "foreground", "card"],
    ["foreground/popover", "foreground", "popover"],
    ["card-foreground/card", "card-foreground", "card"],
    ["popover-foreground/popover", "popover-foreground", "popover"],
    ["muted-foreground/background", "muted-foreground", "background"],
    ["muted-foreground/card", "muted-foreground", "card"],
    ["muted-foreground/muted", "muted-foreground", "muted"],
    ["foreground-subtle/background", "foreground-subtle", "background"],
    ["primary-foreground/primary", "primary-foreground", "primary"],
    ["brand-foreground/brand", "brand-foreground", "brand"],
    ["bubble-foreground/bubble", "bubble-foreground", "bubble"],
    ["link/background", "link", "background"],
    // The default A'' palette intentionally has no --destructive-foreground (only C1/C3
    // theme files define it); destructive is used as *text* in the default theme, so the
    // audited pair is destructive-on-background and the fill pair stays a C1/C3 concern.
    ["destructive/background", "destructive", "background"],
    ["badge-foreground/badge", "badge-foreground", "badge"],
    ["accent-foreground/accent", "accent-foreground", "accent"],
    ["action-foreground/action", "action-foreground", "action"],
    ["sidebar-foreground/sidebar", "sidebar-foreground", "sidebar"],
    ["ring/background", "ring", "background", NON_TEXT_MIN],
];

function fail(message) {
    console.error("contrast-audit: " + message);
    process.exit(2);
}

function parseArgs(argv) {
    const out = { json: false, selfTest: false, css: DEFAULT_CSS };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--json") out.json = true;
        else if (arg === "--self-test") out.selfTest = true;
        else if (arg === "--css") {
            if (!argv[i + 1]) fail("--css needs a path");
            out.css = resolve(argv[++i]);
        } else if (arg === "--help" || arg === "-h") {
            console.log("usage: node scripts/ux/contrast-audit.mjs [--json] [--self-test] [--css <path>]");
            process.exit(0);
        } else fail("unknown argument: " + arg);
    }
    return out;
}

function stripComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Extract the declaration map of every selector block whose header matches selectorRe. */
function readTokenBlocks(css, selectorRe) {
    const text = stripComments(css);
    const tokens = {};
    let found = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== "{") continue;
        const close = matchBrace(text, i);
        if (close < 0) fail("unbalanced braces in CSS");
        const header = text.slice(text.lastIndexOf("}", i) + 1, i).trim();
        if (!selectorRe.test(header)) { i = close; continue; }
        found++;
        const body = text.slice(i + 1, close);
        for (const decl of body.split(";")) {
            const m = decl.match(/^\s*--([\w-]+)\s*:\s*([\s\S]+?)\s*$/);
            if (m) tokens[m[1]] = m[2].trim();
        }
        i = close;
    }
    return { tokens, found };
}

function matchBrace(text, open) {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") { depth--; if (depth === 0) return i; }
    }
    return -1;
}

function resolveToken(tokens, name, hops = 0) {
    if (Object.prototype.hasOwnProperty.call(tokens, name)) {
        const value = tokens[name].trim();
        const varMatch = value.match(/^var\(\s*--([\w-]+)\s*(?:,\s*([^)]+))?\)$/);
        if (varMatch) {
            if (hops >= 4) fail("var() chain deeper than 4 hops at --" + name);
            const next = varMatch[1];
            if (!Object.prototype.hasOwnProperty.call(tokens, next)) {
                if (varMatch[2] !== undefined) return varMatch[2].trim();
                fail("unresolved var(--" + next + ") referenced by --" + name);
            }
            return resolveToken(tokens, next, hops + 1);
        }
        return value;
    }
    fail("missing token --" + name);
}

/** Parse #hex / rgb(a) / oklch into {r,g,b,a} in 0..255 / 0..1 (sRGB). */
function parseColor(raw) {
    const value = raw.trim().toLowerCase();
    let m = value.match(/^#([0-9a-f]{3,8})$/);
    if (m) {
        let hex = m[1];
        if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
        if (hex.length === 4) hex = hex.split("").map((c) => c + c).join("");
        if (hex.length !== 6 && hex.length !== 8) fail("bad hex color: " + raw);
        const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
        const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
        return { r, g, b, a };
    }
    m = value.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
        const parts = m[1].split(/[,\s/]+/).filter(Boolean).map((p) => p.trim());
        if (parts.length < 3) fail("bad rgb color: " + raw);
        const channel = (p) => {
            const n = p.endsWith("%") ? parseFloat(p) * 2.55 : parseFloat(p);
            if (!Number.isFinite(n)) fail("bad rgb channel: " + raw);
            return Math.max(0, Math.min(255, n));
        };
        const alpha = parts.length > 3
            ? (parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]))
            : 1;
        return { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a: clamp01(alpha) };
    }
    m = value.match(/^oklch\(([^)]+)\)$/);
    if (m) {
        const parts = m[1].split(/[,\s/]+/).filter(Boolean).map((p) => p.trim());
        if (parts.length < 3) fail("bad oklch color: " + raw);
        const l = parts[0].endsWith("%") ? parseFloat(parts[0]) / 100 : parseFloat(parts[0]);
        const c = parseFloat(parts[1]);
        const h = parseFloat(parts[2]);
        const alpha = parts.length > 3
            ? (parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]))
            : 1;
        if (![l, c, h].every(Number.isFinite)) fail("bad oklch color: " + raw);
        return { ...oklchToSrgb(l, c, h), a: clamp01(alpha) };
    }
    fail("unsupported color value: " + raw);
}

function clamp01(n) { return Math.max(0, Math.min(1, n)); }
function clamp255(n) { return Math.max(0, Math.min(255, n)); }

/** OKLCH -> linear sRGB -> gamma sRGB (0..255). */
function oklchToSrgb(l, c, hDeg) {
    const h = (hDeg * Math.PI) / 180;
    const a = c * Math.cos(h);
    const b = c * Math.sin(h);
    const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = l - 0.0894841775 * a - 1.2914855480 * b;
    const l3 = l_ ** 3;
    const m3 = m_ ** 3;
    const s3 = s_ ** 3;
    const lin = [
        4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
        -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
        -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3,
    ];
    const gamma = (v) => {
        const x = Math.max(0, Math.min(1, v));
        return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
    };
    return { r: clamp255(gamma(lin[0])), g: clamp255(gamma(lin[1])), b: clamp255(gamma(lin[2])) };
}

function composite(fg, bg) {
    const a = fg.a + bg.a * (1 - fg.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
        r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
        g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
        b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
        a,
    };
}

function relativeLuminance({ r, g, b }) {
    const lin = (v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a, b) {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
}

/** Worst-case composite of a translucent backdrop over black and over white. */
function worstBackdrops(bg) {
    if (bg.a >= 1) return [bg];
    return [composite(bg, { r: 0, g: 0, b: 0, a: 1 }), composite(bg, { r: 255, g: 255, b: 255, a: 1 })];
}

function pairRatio(tokens, fgName, bgName) {
    const fg = parseColor(resolveToken(tokens, fgName));
    const bg = parseColor(resolveToken(tokens, bgName));
    let worst = Infinity;
    for (const backdrop of worstBackdrops(bg)) {
        const solidFg = fg.a < 1 ? composite(fg, backdrop) : fg;
        worst = Math.min(worst, contrast(solidFg, backdrop));
    }
    return worst;
}

function evaluate(tokens) {
    return PAIRS.map(([pair, fg, bg, threshold]) => {
        const ratio = pairRatio(tokens, fg, bg);
        const min = threshold ?? TEXT_MIN;
        return { pair, fg, bg, ratio: Number(ratio.toFixed(3)), min, pass: ratio >= min };
    });
}

function selfTest() {
    const black = parseColor("#000");
    const white = parseColor("#fff");
    const checks = [
        ["black/white ~21", Math.abs(contrast(black, white) - 21) < 0.05],
        ["#777/white below 4.5", contrast(parseColor("#777777"), white) < 4.5],
        ["oklch(0.577 0.245 27.325) parses", parseColor("oklch(0.577 0.245 27.325)").r > 100],
    ];
    const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
    if (failed.length) fail("self-test failed: " + failed.join(", "));
    console.log("self-test: ok (" + checks.length + " fixtures)");
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.selfTest) { selfTest(); return; }

    let css;
    try { css = readFileSync(args.css, "utf8"); }
    catch (e) { fail("cannot read CSS " + args.css + ": " + e.message); }

    const root = readTokenBlocks(css, /^:root\b/);
    if (root.found === 0) fail("no :root block in " + args.css);
    const dark = readTokenBlocks(css, /^\.dark\b/);
    if (dark.found === 0) fail("no .dark block in " + args.css);
    const tokens = { ...root.tokens, ...dark.tokens };

    const results = evaluate(tokens);
    const failed = results.filter((r) => !r.pass);
    const minRatio = Math.min(...results.map((r) => r.ratio));

    if (args.json) {
        console.log(JSON.stringify({ css: args.css, minRatio, pass: failed.length === 0, pairs: results }, null, 2));
    } else {
        console.log("| pair | fg | bg | ratio | threshold | pass |");
        console.log("| --- | --- | --- | ---: | ---: | --- |");
        for (const r of results) {
            console.log("| " + r.pair + " | " + r.fg + " | " + r.bg + " | " + r.ratio.toFixed(2)
                + " | " + r.min.toFixed(1) + " | " + (r.pass ? "PASS" : "FAIL") + " |");
        }
        if (failed.length) {
            console.error("contrast-audit: " + failed.length + " pair(s) below threshold: "
                + failed.map((r) => r.pair + "=" + r.ratio.toFixed(2)).join(", "));
        }
        // Last line is the machine-readable verdict.
        console.log("minRatio=" + minRatio.toFixed(2) + (failed.length ? " FAIL" : ""));
    }
    process.exit(failed.length ? 1 : 0);
}

main();
