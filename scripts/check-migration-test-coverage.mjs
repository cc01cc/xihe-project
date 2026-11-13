#!/usr/bin/env node
// Does every test that lives under a `migration` test directory actually get run by the
// migration sweep?
//
// The gap this closes (task-181, found in task-178): a test that the standard command does not
// select is a test nobody runs. It exists, it is green, and it protects nothing -- while the
// reading "234/234 green" makes everyone believe the guard surface is covered. That is the same
// failure shape as a constraint that is never violated or a gate that never fires.
//
// The cause was a naming convention used as a selector: `-Dtest=*Migration*` selects by CLASS
// NAME, so any test in the migration directory whose class is not named "...Migration..." is
// silently outside the sweep. Renaming the tests is not an option: they are already cited by
// line in evidence packs and cards, and a rename invalidates those anchors.
//
// So the rule is a MANIFEST, not a convention:
//
//   every `*Test.java` under `**/migration/**` must either
//     (a) declare a class whose name contains "Migration", or
//     (b) be listed in scripts/migration-test-manifest.json with a reason.
//
// Neither => exit 1, and the file is printed. `--test-filter` prints the explicit, complete
// `-Dtest=` list (no wildcard) so the sweep is driven by the list instead of by luck.
//
// FAIL-CLOSED: zero files found means the scan is broken (wrong root, moved directory), not that
// coverage is perfect -- exit 2. A gate that can pass on an empty tree is not a gate.
//
// Known blind spot, stated instead of hidden: this only looks inside `**/migration/**`. A guard
// test that lives in some other test package is invisible here. The rule for such a test is the
// same (list it somewhere a human reads), but this script cannot enforce what it cannot see.
//
// Exit codes: 0 clean / 1 findings / 2 unreadable input (including an empty scan).
//
// Usage:
//   node scripts/check-migration-test-coverage.mjs            # check the real tree
//   node scripts/check-migration-test-coverage.mjs --json     # same, machine-readable
//   node scripts/check-migration-test-coverage.mjs --test-filter   # -! 'Dtest=' list: '*Migration*' + the classes it misses
//   node scripts/check-migration-test-coverage.mjs --selftest
//   node scripts/check-migration-test-coverage.mjs --root <dir> --manifest <file>

import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from
    'node:fs';
import { join, relative, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const CODES = {
    NOT_COVERED: 'E_TEST_NOT_NAMED_OR_LISTED',
    MANIFEST_STALE: 'E_MANIFEST_STALE',
    MANIFEST_NO_REASON: 'E_MANIFEST_NO_REASON',
    MANIFEST_DUPLICATE: 'E_MANIFEST_DUPLICATE',
    NO_FILES: 'E_NO_TEST_FILES',
    UNREADABLE: 'E_UNREADABLE_INPUT',
};

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..');
const DEFAULT_MANIFEST = join(HERE, 'migration-test-manifest.json');
const CLASS_DECLARATION = /^[ \t]*(?:(?:public|final|abstract|sealed|non-sealed|static)[ \t]+)*class[ \t]+([A-Za-z_$][\w$]*)/m;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /\/\/[^\n]*/g;
const MIGRATION_NAME = /Migration/;

function parseArgs(argv) {
    const options = { json: false, selftest: false, testFilter: false, root: DEFAULT_ROOT, manifest: DEFAULT_MANIFEST };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--json') {
            options.json = true;
        } else if (arg === '--selftest') {
            options.selftest = true;
        } else if (arg === '--test-filter') {
            options.testFilter = true;
        } else if (arg === '--root') {
            index += 1;
            options.root = resolve(argv[index]);
        } else if (arg === '--manifest') {
            index += 1;
            options.manifest = resolve(argv[index]);
        } else {
            throw new Error('unknown argument: ' + arg);
        }
    }
    return options;
}

/** All `*Test.java` files that sit under a path segment named exactly `migration`. */
function collectTestFiles(root) {
    const found = [];
    const packages = join(root, 'packages');
    let entries;
    try {
        entries = readdirSync(packages, { withFileTypes: true });
    } catch (error) {
        return { files: [], unreadable: true, message: error.message };
    }
    const walk = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const full = join(directory, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile() && entry.name.endsWith('Test.java')) {
                const parts = relative(root, full).split(sep);
                if (parts.includes('migration')) {
                    found.push(full);
                }
            }
        }
    };
    for (const entry of entries) {
        if (entry.isDirectory() && statSync(join(packages, entry.name)).isDirectory()) {
            walk(join(packages, entry.name));
        }
    }
    return { files: found.sort(), unreadable: false, message: null };
}

function declaredClassName(source) {
    // Comments first: a javadoc that says "the class also drops the index" must not be mistaken
    // for a declaration (it was, in the first version of this script -- 5 false findings on the
    // real tree). Then anchor at a line start, so only a real declaration matches.
    const code = source.replace(BLOCK_COMMENT, ' ').replace(LINE_COMMENT, ' ');
    const match = CLASS_DECLARATION.exec(code);
    return match ? match[1] : null;
}

function loadManifest(manifestPath) {
    let raw;
    try {
        raw = readFileSync(manifestPath, 'utf8');
    } catch (error) {
        return { entries: [], findings: [{ code: CODES.UNREADABLE, message: 'manifest unreadable: ' + error.message }] };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        return { entries: [], findings: [{ code: CODES.UNREADABLE, message: 'manifest is not JSON: ' + error.message }] };
    }
    const entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
    const findings = [];
    if (!Array.isArray(parsed && parsed.entries)) {
        findings.push({ code: CODES.UNREADABLE, message: 'manifest has no "entries" array' });
    }
    return { entries, findings };
}

function check(options) {
    const findings = [];
    const scanned = collectTestFiles(options.root);
    if (scanned.unreadable) {
        return { findings: [{ code: CODES.UNREADABLE, message: scanned.message }], classes: [], files: [] };
    }
    if (scanned.files.length === 0) {
        return {
            findings: [{ code: CODES.NO_FILES, message: 'no *Test.java found under any migration/ test directory -- the scan itself is broken' }],
            classes: [],
            files: [],
        };
    }

    const manifest = loadManifest(options.manifest);
    findings.push(...manifest.findings);
    const listed = new Map();
    for (const entry of manifest.entries) {
        const path = typeof entry === 'object' && entry ? entry.path : null;
        if (typeof path !== 'string' || path.length === 0) {
            findings.push({ code: CODES.MANIFEST_NO_REASON, message: 'manifest entry without a path: ' + JSON.stringify(entry) });
            continue;
        }
        if (listed.has(path)) {
            findings.push({ code: CODES.MANIFEST_DUPLICATE, message: 'manifest lists the same path twice: ' + path });
        }
        listed.set(path, entry);
        if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
            findings.push({ code: CODES.MANIFEST_NO_REASON, message: 'manifest entry has no reason (a listed name without a why is a silent exemption): ' + path });
        }
    }

    const classes = [];
    for (const file of scanned.files) {
        const path = relative(options.root, file).split(sep).join('/');
        let source;
        try {
            source = readFileSync(file, 'utf8');
        } catch (error) {
            findings.push({ code: CODES.UNREADABLE, message: 'cannot read ' + path + ': ' + error.message });
            continue;
        }
        const className = declaredClassName(source);
        if (className === null) {
            findings.push({ code: CODES.NOT_COVERED, message: path + ' declares no class the scanner can see' });
            continue;
        }
        classes.push({ path, className, namedMigrations: MIGRATION_NAME.test(className) });
        if (MIGRATION_NAME.test(className)) {
            continue;
        }
        if (!listed.has(path)) {
            findings.push({
                code: CODES.NOT_COVERED,
                message: path + ' (class ' + className + ') is named ' +
                    'neither "...Migration..." nor in the manifest => -Dtest=*Migration* does not run it',
            });
        }
    }

    for (const path of listed.keys()) {
        if (!scanned.files.some((file) => relative(options.root, file).split(sep).join('/') === path)) {
            findings.push({ code: CODES.MANIFEST_STALE, message: 'manifest lists a file that does not exist: ' + path });
        }
    }

    return { findings, classes, files: scanned.files };
}

// The filter must not silently NARROW coverage. `-Dtest=*Migration*` also selects classes named
// "...Migration..." that live OUTSIDE the migration directory (session/, integration/, ...); a
// bare list of the in-directory classes would drop them without anybody noticing -- the same
// failure shape this script exists to catch. So the filter is the wildcard (keeps what it covered)
// PLUS every in-directory class the wildcard does NOT select (adds what it missed).
function renderTestFilter(classes) {
    const missed = classes.filter((entry) => !MIGRATION_NAME.test(entry.className))
        .map((entry) => entry.className)
        .sort();
    return ['*Migration*', ...missed].join(',');
}

function writeFixture(root, relativePath, className) {
    const full = join(root, ...relativePath.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, 'package fixture;\n\nclass ' + className + ' {\n}\n', 'utf8');
}

function selftest() {
    const base = mkdtempSync(join(tmpdir(), 'migration-coverage-selftest-'));
    const results = [];
    const run = (name, build, expect, expectClassName) => {
        const root = join(base, name);
        mkdirSync(join(root, 'packages', 'control-plane', 'src', 'test', 'java'), { recursive: true });
        const manifestPath = join(root, 'manifest.json');
        const manifest = build(root);
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
        const result = check({ root, manifest: manifestPath });
        const codes = result.findings.map((finding) => finding.code).sort();
        const expected = expect.slice().sort();
        const classNames = result.classes.map((entry) => entry.className);
        const classNameOk = expectClassName === undefined || classNames.includes(expectClassName);
        const passed = JSON.stringify(codes) === JSON.stringify(expected) && classNameOk;
        results.push({
            name,
            passed,
            expected,
            actual: codes,
            findings: result.findings,
            classNames,
            expectClassName,
        });
    };
    const prefix = 'packages/control-plane/src/test/java/fixture/migration/';

    run('all-named', (root) => {
        writeFixture(root, prefix + 'FooMigrationTest.java', 'FooMigrationTest');
        writeFixture(root, prefix + 'BarMigrationTest.java', 'BarMigrationTest');
        return { entries: [] };
    }, []);

    // The card's negative control: a class that is neither named Migration nor listed.
    run('unnamed-not-listed', (root) => {
        writeFixture(root, prefix + 'FooMigrationTest.java', 'FooMigrationTest');
        writeFixture(root, prefix + 'WidgetConcurrencyTest.java', 'WidgetConcurrencyTest');
        return { entries: [] };
    }, [CODES.NOT_COVERED]);

    run('unnamed-but-listed', (root) => {
        writeFixture(root, prefix + 'WidgetConcurrencyTest.java', 'WidgetConcurrencyTest');
        return { entries: [{ path: prefix + 'WidgetConcurrencyTest.java', reason: 'concurrency semantics, not migration naming' }] };
    }, []);

    run('listed-without-reason', (root) => {
        writeFixture(root, prefix + 'WidgetConcurrencyTest.java', 'WidgetConcurrencyTest');
        return { entries: [{ path: prefix + 'WidgetConcurrencyTest.java' }] };
    }, [CODES.MANIFEST_NO_REASON]);

    run('stale-entry', (root) => {
        writeFixture(root, prefix + 'FooMigrationTest.java', 'FooMigrationTest');
        return { entries: [{ path: prefix + 'GoneConcurrencyTest.java', reason: 'used to exist' }] };
    }, [CODES.MANIFEST_STALE]);

    run('duplicate-entry', (root) => {
        writeFixture(root, prefix + 'WidgetConcurrencyTest.java', 'WidgetConcurrencyTest');
        return {
            entries: [
                { path: prefix + 'WidgetConcurrencyTest.java', reason: 'first' },
                { path: prefix + 'WidgetConcurrencyTest.java', reason: 'second' },
            ],
        };
    }, [CODES.MANIFEST_DUPLICATE]);

    run('empty-scan', () => {
        return { entries: [] };
    }, [CODES.NO_FILES]);

    // The rule is the CLASS name, not the file name: a file called WidgetTest.java whose class is
    // named WidgetMigrationTest is inside the sweep, because -Dtest filters on class names.
    // Regression for the first version of this script: a javadoc mentioning "class <something>"
    // was taken as the declaration, so the reported class names were nonsense and five real
    // files were flagged as uncovered. The declaration must come from code, never from prose.
    run('comment-mentions-class', (root) => {
        const rel = prefix + 'ProseTrapTest.java';
        const full = join(root, ...rel.split('/'));
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, [
            'package fixture;',
            '',
            '/**',
            ' * This migration test proves the class also drops the index, and the class replaces',
            ' * the old name. Prose must not be read as a declaration.',
            ' */',
            'class WidgetConcurrencyTest {',
            '}',
            '',
        ].join('\n'), 'utf8');
        return { entries: [] };
    }, [CODES.NOT_COVERED], 'WidgetConcurrencyTest');

    run('class-named-migration', (root) => {
        writeFixture(root, prefix + 'WidgetTest.java', 'WidgetMigrationTest');
        return { entries: [] };
    }, []);

    let failures = 0;
    for (const result of results) {
        const label = result.passed ? 'PASS' : 'FAIL';
        console.log('[selftest] ' + label + ' ' + result.name +
            (result.passed ? '' : ' expected=' + JSON.stringify(result.expected) + ' actual=' + JSON.stringify(result.actual)));
        if (!result.passed) {
            failures += 1;
        }
    }
    console.log('[selftest] ' + (results.length - failures) + '/' + results.length + ' cases passed');
    rmSync(base, { recursive: true, force: true });
    return failures === 0 ? 0 : 1;
}

function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error('[migration-test-coverage] ' + CODES.UNREADABLE + ': ' + error.message);
        return 2;
    }
    if (options.selftest) {
        return selftest();
    }
    const { findings, classes } = check(options);
    const named = classes.filter((entry) => entry.namedMigrations).length;
    const listed = classes.length - named;
    if (options.testFilter) {
        for (const finding of findings) {
            console.error('[migration-test-coverage] ' + finding.code + ' ' + finding.message);
        }
        if (findings.length > 0) {
            console.error('[migration-test-coverage] refusing to print a filter from an incomplete tree');
            return 1;
        }
        console.log(renderTestFilter(classes));
        return 0;
    }
    if (options.json) {
        console.log(JSON.stringify({ findings, classes, counts: { files: classes.length, named, listed } }, null, 2));
    } else {
        for (const finding of findings) {
            console.log('[migration-test-coverage] ' + finding.code + ' ' + finding.message);
        }
        console.log('[migration-test-coverage] files=' + classes.length + ' named=' + named +
            ' listed=' + listed + ' findings=' + findings.length);
        if (findings.length === 0) {
            console.log('[migration-test-coverage] OK');
        }
    }
    if (findings.some((finding) => finding.code === CODES.UNREADABLE || finding.code === CODES.NO_FILES)) {
        return 2;
    }
    return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    process.exitCode = main();
}

export { check, collectTestFiles, declaredClassName, parseArgs, renderTestFilter, CODES };

