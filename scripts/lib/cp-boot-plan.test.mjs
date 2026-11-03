/**
 * PLAN-0650 B-2 tests: the `--jar-mode` decision table.
 *
 * The case that matters is `auto` + no jar: it used to mean `run` (`mvn spring-boot:run`), and
 * `run` never writes a jar, so every host-E2E round recompiled the CP (BL-205 ②, 1.5–2 min × 8
 * rounds). It must now mean `build-then-use`. Every other row is asserted to stay exactly where
 * it was, because the fix must not quietly change forced modes.
 *
 * Run: node --test scripts/lib/cp-boot-plan.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JAR_MODES, decideCpBoot } from './cp-boot-plan.mjs';

test('auto + no jar builds once and reuses (the BL-205 ② fix)', () => {
    const plan = decideCpBoot({ jarMode: 'auto', hasJar: false, stale: false });
    assert.equal(plan.action, 'build-then-use');
    assert.match(plan.reason, /no CP jar/);
    assert.notEqual(plan.action, 'run', 'auto must never fall back to mvn spring-boot:run when no jar exists');
});

test('auto is the default mode', () => {
    assert.equal(decideCpBoot({}).action, 'build-then-use');
    assert.equal(decideCpBoot({ hasJar: false }).action, 'build-then-use');
});

test('auto + fresh jar boots it as-is', () => {
    assert.deepEqual(decideCpBoot({ jarMode: 'auto', hasJar: true, stale: false }), {
        action: 'use',
        reason: 'fresh',
        stale: false,
    });
});

test('auto + stale jar rebuilds before boot (a stale jar is never used silently)', () => {
    const plan = decideCpBoot({ jarMode: 'auto', hasJar: true, stale: true });
    assert.equal(plan.action, 'build-then-use');
    assert.match(plan.reason, /stale/);
});

test('forced use boots whatever exists and reports staleness', () => {
    assert.deepEqual(decideCpBoot({ jarMode: 'use', hasJar: true, stale: false }), {
        action: 'use',
        reason: 'fresh (forced use)',
        stale: false,
    });
    assert.deepEqual(decideCpBoot({ jarMode: 'use', hasJar: true, stale: true }), {
        action: 'use',
        reason: 'stale, forced by --jar-mode=use',
        stale: true,
    });
});

test('forced use with no jar keeps the old spring-boot:run fallback', () => {
    const plan = decideCpBoot({ jarMode: 'use', hasJar: false });
    assert.equal(plan.action, 'run');
    assert.match(plan.reason, /--jar-mode=use/);
});

test('forced rebuild always builds, with or without an existing jar', () => {
    for (const hasJar of [false, true]) {
        const plan = decideCpBoot({ jarMode: 'rebuild', hasJar, stale: false });
        assert.equal(plan.action, 'build-then-use');
        assert.match(plan.reason, /--jar-mode=rebuild/);
    }
});

test('forced run and forced native are passed through untouched', () => {
    assert.deepEqual(decideCpBoot({ jarMode: 'run', hasJar: true, stale: true }), {
        action: 'run',
        reason: '--jar-mode=run',
        stale: true,
    });
    assert.equal(decideCpBoot({ jarMode: 'native', hasJar: false }).action, 'native');
});

test('every accepted --jar-mode maps to a concrete action', () => {
    const seen = new Set();
    for (const jarMode of JAR_MODES) {
        for (const hasJar of [false, true]) {
            for (const stale of [false, true]) {
                const plan = decideCpBoot({ jarMode, hasJar, stale });
                assert.ok(
                    ['native', 'run', 'use', 'build-then-use'].includes(plan.action),
                    `${jarMode}/${hasJar}/${stale} produced ${plan.action}`,
                );
                assert.equal(typeof plan.reason, 'string');
                assert.ok(plan.reason.length > 0, `${jarMode}: every decision needs a reason for the log`);
                seen.add(jarMode);
            }
        }
    }
    assert.deepEqual([...seen].sort(), [...JAR_MODES].sort());
});

test('an unknown mode throws instead of guessing a boot path', () => {
    assert.throws(() => decideCpBoot({ jarMode: 'auto2' }), TypeError);
    assert.throws(() => decideCpBoot({ jarMode: '' }), TypeError);
});
