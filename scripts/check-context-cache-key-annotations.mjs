#!/usr/bin/env node
/**
 * task-29 (S/M) ratchet: every test-source annotation that changes the Spring TestContext **cache
 * key** must be registered in the baseline TSV.
 *
 * Why this exists: the 255 context-reuse work made "how many Spring contexts boot" a first-class
 * budget (70 per-class + 1 reused). A new `@DirtiesContext` / `@TestPropertySource` / `@MockitoBean`
 * in `src/test/java` silently creates another context key — the suite gets slower, and the
 * bucketing guard (ContextReuseBucketingTest R1/R2) only looks at classes that extend one of the
 * two integration bases. This script covers the whole test tree.
 *
 * Ratchet rules (enforced by ContextReuseBucketingTest R4 on the same TSV):
 *   1. every current occurrence must be in the baseline  ⇒ a new annotation fails;
 *   2. no baseline row may be stale (the occurrence disappeared) ⇒ the baseline cannot rot;
 *   3. the baseline's reasonCode is derived, not hand-written: it is the annotation's category,
 *      so a row cannot carry an invented explanation.
 *
 * Scope: every .java file under packages/control-plane/src/test/java (all test sources, not only integration
 * bases). Granularity: one row per (annotation, file); a second occurrence of an already-registered
 * annotation in the same file is not a new row (the card fixes the three columns).
 * Comments are stripped before matching (an annotation named in a Javadoc is not evidence).
 *
 * Usage:
 *   node scripts/check-context-cache-key-annotations.mjs            # check (default)
 *   node scripts/check-context-cache-key-annotations.mjs --check    # same, explicit
 *   node scripts/check-context-cache-key-annotations.mjs --write    # regenerate the baseline TSV
 *   node scripts/check-context-cache-key-annotations.mjs --json     # {ok, rows, new, stale, ...}
 *   options: --root <dir> (scan root), --baseline <file> (TSV)
 *
 * Exit codes: 0 = current == baseline; 1 = drift; 2 = usage / IO failure.
 * The Java guard re-scans with the same rules, so the two implementations cross-check each other:
 * if they ever disagree, `--write` followed by the guard (or the reverse) exposes the disagreement.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ROOT = path.join(ROOT, 'packages/control-plane/src/test/java');
const DEFAULT_BASELINE = path.join(
    ROOT,
    'packages/control-plane/src/test/resources/context-reuse/context-cache-key-annotations.tsv',
);

/**
 * The nine annotations the card fixes, each mapped to its derived reasonCode category.
 * Do not add a name here without updating ContextReuseBucketingTest R4's vocabulary — the guard
 * treats the TSV's reasonCode as derived and rejects anything else.
 */
export const ANNOTATION_REASONS = Object.freeze({
    '@SpringBootTest': 'suite-context',
    '@DirtiesContext': 'isolation',
    '@TestPropertySource': 'property-variant',
    '@DynamicPropertySource': 'property-variant',
    '@ActiveProfiles': 'profile-variant',
    '@MockitoBean': 'bean-override',
    '@MockitoSpyBean': 'bean-override',
    '@Import': 'fixture-config',
    '@TestConfiguration': 'fixture-config',
});

export const ANNOTATIONS = Object.freeze(Object.keys(ANNOTATION_REASONS));
export const REASON_CODES = Object.freeze([...new Set(Object.values(ANNOTATION_REASONS))]);

const HEADER = [
    '# context cache-key annotation baseline — task-29 (PLAN-0691 / PLAN-0682 context-reuse)',
    '#',
    '# 生成：node scripts/check-context-cache-key-annotations.mjs --write（不得手抄；守卫会重算并逐行比对）',
    '# 列：annotation <TAB> file（相对 src/test/java）<TAB> reasonCode（由注解类别推导，不接受自定义理由）',
    '# 词汇：' + ANNOTATIONS.map((name) => name + '=' + ANNOTATION_REASONS[name]).join(' | '),
    '# 规则：当前 ⊆ 基线（新增未登记即红）；基线 ⊆ 当前（消失的行必须同步删除，防腐化）；行序稳定（annotation,file）',
    '# 粒度：每个 (annotation, file) 一行；同文件同注解的第二处不是新行（列结构由卡面固定为三列）',
];

function parseArgs(argv) {
    const out = {
        root: DEFAULT_ROOT,
        baseline: DEFAULT_BASELINE,
        write: false,
        json: false,
        help: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--write') out.write = true;
        else if (arg === '--check') out.write = false;
        else if (arg === '--json') out.json = true;
        else if (arg === '--help' || arg === '-h') out.help = true;
        else if (arg === '--root') out.root = path.resolve(ROOT, argv[++index]);
        else if (arg === '--baseline') out.baseline = path.resolve(ROOT, argv[++index]);
        else throw new Error('unknown argument: ' + arg);
    }
    return out;
}

/** Strip block comments and line comments; `//` inside a string literal is not a comment. */
export function stripComments(source) {
    const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//gu, '');
    const lines = withoutBlocks.split(/\n/u);
    const kept = lines.map((line) => {
        let inString = false;
        for (let index = 0; index + 1 < line.length; index += 1) {
            const current = line[index];
            if (current === '"' && (index === 0 || line[index - 1] !== '\\')) {
                inString = !inString;
            }
            if (!inString && current === '/' && line[index + 1] === '/') {
                return line.slice(0, index);
            }
        }
        return line;
    });
    return kept.join('\n');
}

function walkJavaFiles(root) {
    const files = [];
    const entries = fs.readdirSync(root, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.java')) continue;
        files.push(path.join(entry.parentPath ?? entry.path, entry.name));
    }
    return files;
}

/** Scan the whole test tree; keys are `annotation + TAB + repo-relative file`. */
export function scan(root) {
    const occurrences = new Map();
    for (const file of walkJavaFiles(root)) {
        const relative = path.relative(root, file).split(path.sep).join('/');
        const stripped = stripComments(fs.readFileSync(file, 'utf8'));
        for (const annotation of ANNOTATIONS) {
            const simple = annotation.slice(1);
            const pattern = new RegExp(
                '^\\s*@(?:[A-Za-z_][A-Za-z0-9_.]*\\.)?' + simple + '\\b',
                'mu',
            );
            if (pattern.test(stripped)) {
                occurrences.set(annotation + '\t' + relative, ANNOTATION_REASONS[annotation]);
            }
        }
    }
    return occurrences;
}

function sortedKeys(map) {
    // Plain UTF-16 code-unit order (NOT localeCompare): the Java guard re-sorts with
    // String.compareTo and rejects an out-of-order baseline, so both orders must be identical.
    return [...map.keys()].sort();
}

function loadBaseline(file) {
    if (!fs.existsSync(file)) throw new Error('baseline missing: ' + file);
    const rows = new Map();
    const problems = [];
    const text = fs.readFileSync(file, 'utf8');
    for (const [index, line] of text.split(/\n/u).entries()) {
        if (line === '' || line.startsWith('#')) continue;
        const columns = line.split('\t');
        if (columns.length !== 3) {
            problems.push('line ' + (index + 1) + ': expected 3 tab-separated columns: ' + line);
            continue;
        }
        const [annotation, relative, reason] = columns;
        if (!ANNOTATION_REASONS[annotation]) {
            problems.push('line ' + (index + 1) + ': unknown annotation ' + annotation);
            continue;
        }
        if (reason !== ANNOTATION_REASONS[annotation]) {
            problems.push('line ' + (index + 1) + ': reasonCode ' + reason
                + ' is not derived (' + ANNOTATION_REASONS[annotation] + ')');
            continue;
        }
        const key = annotation + '\t' + relative;
        if (rows.has(key)) {
            problems.push('line ' + (index + 1) + ': duplicate row ' + annotation + ' ' + relative);
            continue;
        }
        rows.set(key, reason);
    }
    return { rows, problems };
}

function render(rows) {
    const lines = [...HEADER];
    for (const key of sortedKeys(rows)) {
        lines.push(key + '\t' + rows.get(key));
    }
    return lines.join('\n') + '\n';
}

function diff(current, baseline) {
    const fresh = sortedKeys(current).filter((key) => !baseline.has(key));
    const stale = sortedKeys(baseline).filter((key) => !current.has(key));
    return { fresh, stale };
}

function describe(key) {
    const [annotation, file] = key.split('\t');
    return annotation + '  ' + file;
}

function main(argv) {
    const args = parseArgs(argv);
    if (args.help) {
        console.log('usage: node scripts/check-context-cache-key-annotations.mjs [--check|--write]');
        console.log('       [--root <dir>] [--baseline <file>] [--json]');
        return 0;
    }
    const current = scan(args.root);
    if (args.write) {
        fs.writeFileSync(args.baseline, render(current), 'utf8');
        if (args.json) {
            console.log(JSON.stringify({
                ok: true,
                mode: 'write',
                rows: current.size,
                path: args.baseline,
            }, null, 2));
        } else {
            console.log('[context-cache-key] wrote ' + current.size + ' rows -> '
                + path.relative(ROOT, args.baseline));
        }
        return 0;
    }
    const baseline = loadBaseline(args.baseline);
    const { fresh, stale } = diff(current, baseline.rows);
    const ok = baseline.problems.length === 0 && fresh.length === 0 && stale.length === 0;
    if (args.json) {
        console.log(JSON.stringify({
            ok,
            mode: 'check',
            rows: current.size,
            baselineRows: baseline.rows.size,
            fresh: fresh.map(describe),
            stale: stale.map(describe),
            problems: baseline.problems,
        }, null, 2));
    } else {
        console.log('[context-cache-key] rows=' + current.size + ' baseline=' + baseline.rows.size
            + ' fresh=' + fresh.length + ' stale=' + stale.length);
        for (const key of fresh) console.log('  NEW   ' + describe(key));
        for (const key of stale) console.log('  STALE ' + describe(key));
        for (const problem of baseline.problems) console.log('  BAD   ' + problem);
    }
    return ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (error) {
        console.error('[context-cache-key] ' + error.message);
        process.exitCode = 2;
    }
}
