/**
 * BL-262 guard tests (D): the static check must flag unguarded process-global mutation in test
 * code, and must not flag the two legitimate patterns (an `#[ignore]`d isolated test, or a test
 * holding the module's `PROCESS_LOCK`). The real file is covered too: the guard runs against
 * `packages/runtime` in `test:cli`, so a regression there fails the gate.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { analyzeSource, cfgTestRegions, enclosingFunctions } from './check-test-global-state.mjs';

const repoRoot = join(import.meta.dirname, '..');

test('flags set_var inside a plain #[test] fn in a cfg(test) module', () => {
    const source = [
        'fn production() { unsafe { std::env::set_var("A", "1") }; }',
        '#[cfg(test)]',
        'mod tests {',
        '    #[test]',
        '    fn leaks_global_state() {',
        '        unsafe { std::env::set_var("A", "1") };',
        '    }',
        '}',
    ].join('\n');
    const violations = analyzeSource(source, 'x.rs');
    assert.equal(violations.length, 1);
    assert.equal(violations[0].mutator, 'set_var');
    assert.equal(violations[0].function, 'leaks_global_state');
    assert.equal(violations[0].line, 6);
});

test('allows production code outside cfg(test) (the dotenv loader wrapper)', () => {
    const source = [
        '#[allow(unsafe_code)]',
        'fn env_set(key: &str, value: &str) {',
        '    unsafe { std::env::set_var(key, value) };',
        '}',
    ].join('\n');
    assert.deepEqual(analyzeSource(source, 'x.rs'), []);
});

test('allows a chdir test that holds PROCESS_LOCK', () => {
    const source = [
        '#[cfg(test)]',
        'mod tests {',
        '    static PROCESS_LOCK: Mutex<()> = Mutex::new(());',
        '    #[test]',
        '    fn guarded() {',
        '        let _guard = PROCESS_LOCK.lock().unwrap();',
        '        std::env::set_current_dir("/tmp").unwrap();',
        '    }',
        '}',
    ].join('\n');
    assert.deepEqual(analyzeSource(source, 'x.rs'), []);
});

test('allows a #[ignore]d test and nested helpers inside it', () => {
    const source = [
        '#[cfg(test)]',
        'mod tests {',
        '    #[tokio::test]',
        '    #[ignore = "no-git smoke; run isolated (--ignored --test-threads=1)"]',
        '    async fn isolated() {',
        '        struct PathGuard(Option<String>);',
        '        impl Drop for PathGuard {',
        '            fn drop(&mut self) {',
        '                unsafe { std::env::set_var("PATH", "x") };',
        '            }',
        '        }',
        '        unsafe { std::env::set_var("PATH", "/empty") };',
        '    }',
        '}',
    ].join('\n');
    assert.deepEqual(analyzeSource(source, 'x.rs'), [], 'nested Drop helper inherits the ignore');
});

test('allows an explicit `test-global-state: allow` opt-out with a reason', () => {
    const source = [
        '#[cfg(test)]',
        '#[allow(unsafe_code)]',
        '// test-global-state: allow — test-only helper; callers hold PROCESS_LOCK.',
        'fn env_remove(key: &str) {',
        '    unsafe { std::env::remove_var(key) };',
        '}',
    ].join('\n');
    assert.deepEqual(analyzeSource(source, 'x.rs'), []);
});

test('flags remove_var and set_current_dir too', () => {
    const source = [
        '#[cfg(test)]',
        'mod tests {',
        '    #[test]',
        '    fn both() {',
        '        std::env::set_current_dir("/tmp").unwrap();',
        '        unsafe { std::env::remove_var("A") };',
        '    }',
        '}',
    ].join('\n');
    const violations = analyzeSource(source, 'x.rs');
    assert.deepEqual(
        violations.map((violation) => violation.mutator),
        ['set_current_dir', 'remove_var'],
    );
});

test('cfgTestRegions / enclosingFunctions work on brace nesting', () => {
    const source = 'mod a {\n  #[cfg(test)]\n  mod tests {\n    fn inner() { let x = "{ not a brace }"; }\n  }\n}\n';
    const regions = cfgTestRegions(source);
    assert.equal(regions.length, 1);
    const inner = source.indexOf('let x');
    const enclosing = enclosingFunctions(source, inner);
    assert.equal(enclosing[0].name, 'inner');
});

test('the real runtime tree is clean (this is what test:cli enforces)', () => {
    const file = join(repoRoot, 'packages', 'runtime', 'src', 'dotenv_loader.rs');
    const violations = analyzeSource(readFileSync(file, 'utf8'), 'packages/runtime/src/dotenv_loader.rs');
    assert.deepEqual(violations, [], 'BL-262 fix keeps dotenv tests off the process CWD');
    const checkpointApi = join(repoRoot, 'packages', 'runtime', 'src', 'checkpoint_api.rs');
    assert.deepEqual(analyzeSource(readFileSync(checkpointApi, 'utf8'), 'src/checkpoint_api.rs'), []);
});

test('a lifetime does not swallow the rest of a cfg(test) module (task-45)', () => {
    // Regression: `&'static str` used to open a "char literal" that ran to the next quote, so
    // `matchingBrace` returned -1 and the whole module fell out of `cfgTestRegions` — the guard
    // reported OK on files it had never scanned.
    const source = [
        '#[cfg(test)]',
        'mod tests {',
        '    const NAME: &\'static str = "x";',
        '    #[test]',
        '    fn leaks_global_state() {',
        '        unsafe { std::env::set_var("A", "1") };',
        '    }',
        '}',
    ].join('\n');
    assert.equal(cfgTestRegions(source).length, 1, 'the module body must be matched at all');
    const violations = analyzeSource(source, 'x.rs');
    assert.equal(violations.length, 1);
    assert.equal(violations[0].function, 'leaks_global_state');
});

test('braces inside a raw string do not shift the region (task-45)', () => {
    const source = [
        '#[cfg(test)]',
        'mod tests {',
        '    const TEMPLATE: &str = r#"{"a": {"b": 1}}"#;',
        '    #[test]',
        '    fn leaks_global_state() {',
        '        unsafe { std::env::set_var("A", "1") };',
        '    }',
        '}',
    ].join('\n');
    assert.equal(cfgTestRegions(source).length, 1);
    assert.equal(analyzeSource(source, 'x.rs').length, 1);
});

test('char literals holding a brace do not change nesting (task-45)', () => {
    const source = [
        '#[cfg(test)]',
        'mod tests {',
        "    const OPEN: char = '{';",
        "    const CLOSE: char = '}';",
        '    #[test]',
        '    fn leaks_global_state() {',
        '        unsafe { std::env::set_var("A", "1") };',
        '    }',
        '}',
    ].join('\n');
    assert.equal(cfgTestRegions(source).length, 1);
    assert.equal(analyzeSource(source, 'x.rs').length, 1);
});

test('every cfg(test) module in the real main.rs is covered end to end (task-45)', () => {
    const text = readFileSync(join(repoRoot, 'packages', 'runtime', 'src', 'main.rs'), 'utf8');
    const regions = cfgTestRegions(text);
    assert.ok(regions.length >= 9, `expected at least the 9 cfg(test) regions, got ${regions.length}`);
    // This one used to fall outside every region: a lifetime closed the module body early.
    const probe = text.indexOf('fn oauth_mode_broker_failures_map_per_call_site');
    assert.ok(probe > 0, 'probe function must exist in main.rs');
    assert.ok(
        regions.some((region) => probe >= region.start && probe <= region.end),
        'the OAuth-mode test must sit inside a scanned #[cfg(test)] region',
    );
});
