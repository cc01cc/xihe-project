/**
 * PLAN-0650 M5 tests: retry-round planning + between-round reset SQL.
 *
 * Three contracts worth pinning:
 *   1. **Legacy is opt-in, not lost.** `XIHE_E2E_REBUILD_ON_RETRY=1` must give exactly one round,
 *      i.e. the pre-M5 behaviour where the operator's re-run rebuilds the stack.
 *   2. **Never reset a stack we do not own.** The reuse lane (`XIHE_E2E_EXTERNAL_SERVER=1`) owns its
 *      own stack; an in-process reset there would silently destroy another run's database.
 *   3. **No unquoted identifier reaches `DROP DATABASE`/`TRUNCATE`.** Reset SQL is generated from
 *      runtime-discovered names, so the guard is a safety boundary, not cosmetics.
 *
 * Run: node --test scripts/lib/e2e-rounds.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    DEFAULT_ROUNDS,
    MAX_ROUNDS_CEILING,
    NEVER_TRUNCATE,
    ROUND_RESET_STRATEGIES,
    buildDatabaseTablesQuery,
    buildDumpRestoreCommands,
    buildSeedTableQuery,
    buildTemplateResetSql,
    buildTruncateSql,
    chooseRoundResetStrategy,
    decideRetryRounds,
    roundRunId,
    selectTablesToTruncate,
} from './e2e-rounds.mjs';

test('default is one attempt plus one in-process retry', () => {
    const policy = decideRetryRounds({});
    assert.equal(policy.rounds, DEFAULT_ROUNDS);
    assert.equal(policy.inProcessRetry, true);
    assert.match(policy.reason, /in-process/);
});

test('XIHE_E2E_REBUILD_ON_RETRY=1 restores the legacy single-attempt shape', () => {
    for (const rounds of [undefined, '3', 4]) {
        const policy = decideRetryRounds({ rounds, rebuildOnRetry: true });
        assert.equal(policy.rounds, 1, 'legacy mode must never retry in-process');
        assert.equal(policy.inProcessRetry, false);
        assert.match(policy.reason, /legacy shape/);
    }
});

test('a stack the runner does not own is never retried', () => {
    const policy = decideRetryRounds({ rounds: '3', stackOwned: false });
    assert.equal(policy.rounds, 1);
    assert.equal(policy.inProcessRetry, false);
    assert.match(policy.reason, /not runner-owned/);
});

test('explicit round counts are honoured, capped and normalised', () => {
    assert.equal(decideRetryRounds({ rounds: '1' }).rounds, 1);
    assert.equal(decideRetryRounds({ rounds: 1 }).inProcessRetry, false);
    assert.equal(decideRetryRounds({ rounds: '  3  ' }).rounds, 3);
    assert.equal(decideRetryRounds({ rounds: '99' }).rounds, MAX_ROUNDS_CEILING);
    assert.equal(decideRetryRounds({ rounds: '' }).rounds, DEFAULT_ROUNDS, 'empty env var means "unset"');
});

test('a malformed round count fails closed instead of silently defaulting', () => {
    for (const rounds of ['two', '0', '-1', '1.5', 2.5]) {
        assert.throws(() => decideRetryRounds({ rounds }), TypeError, `rounds=${JSON.stringify(rounds)}`);
    }
});

test('the default reset strategy is the one that can meet the 50% criterion', () => {
    const choice = chooseRoundResetStrategy({});
    assert.equal(choice.strategy, 'truncate');
    assert.equal(choice.measured, false);
    assert.match(choice.reason, /50%/);
});

test('an explicit strategy wins and unknown names throw', () => {
    for (const requested of ROUND_RESET_STRATEGIES) {
        assert.equal(chooseRoundResetStrategy({ requested }).strategy, requested);
    }
    assert.throws(() => chooseRoundResetStrategy({ requested: 'recreate' }), TypeError);
});

test('measured timings override the default (M4 measurement hook)', () => {
    const choice = chooseRoundResetStrategy({
        requested: 'truncate',
        measured: { truncate: 4200, template: 31_000, 'dump-restore': 33_500 },
    });
    assert.equal(choice.strategy, 'truncate');
    assert.equal(choice.measured, true);

    const templateWins = chooseRoundResetStrategy({
        measured: { truncate: 42_000, template: 8_000, 'dump-restore': 9_000 },
    });
    assert.equal(templateWins.strategy, 'template');
    assert.match(templateWins.reason, /8000 ms/);

    // Non-numeric entries are ignored rather than treated as 0 (which would always win).
    const partial = chooseRoundResetStrategy({ measured: { truncate: Number.NaN, template: 12_000 } });
    assert.equal(partial.strategy, 'template');
});

test('per-round run ids are what isolates round 2 from round 1 state', () => {
    assert.equal(roundRunId('host-1-aa', 1), 'host-1-aa');
    assert.equal(roundRunId('host-1-aa', 2), 'host-1-aa-r2');
    assert.notEqual(roundRunId('host-1-aa', 1), roundRunId('host-1-aa', 2));
    assert.throws(() => roundRunId('', 1), TypeError);
    assert.throws(() => roundRunId('host-1', 0), TypeError);
});

test('the truncate statement keeps schema history and quotes every table', () => {
    const sql = buildTruncateSql({
        tables: ['sessions', 'chat_runs', 'flyway_schema_history', 'agent_memories'],
    });
    assert.equal(sql, 'TRUNCATE TABLE "sessions", "chat_runs", "agent_memories" CASCADE;');
    for (const kept of NEVER_TRUNCATE) {
        assert.ok(!sql.includes(kept), `${kept} must survive a reset`);
    }
    assert.equal(buildTruncateSql({ tables: ['a'], cascade: false }), 'TRUNCATE TABLE "a";');
});

test('nothing to truncate yields no statement (and no empty TRUNCATE)', () => {
    assert.equal(buildTruncateSql({ tables: [] }), '');
    assert.equal(buildTruncateSql({ tables: [...NEVER_TRUNCATE] }), '');
});

test('table names are validated before they are interpolated', () => {
    for (const evil of ['sessions; DROP TABLE users', 'a"b', 'a b', '', 'x--', null, 42]) {
        assert.throws(() => buildTruncateSql({ tables: [evil] }), TypeError, `table=${JSON.stringify(evil)}`);
    }
    assert.throws(() => buildTruncateSql({ tables: 'sessions' }), TypeError);
});

test('template reset drops with FORCE and creates from the template', () => {
    assert.deepEqual(buildTemplateResetSql({ database: 'xihe_e2e_a', template: 'xihe_e2e_tpl' }), [
        'DROP DATABASE IF EXISTS "xihe_e2e_a" WITH (FORCE);',
        'CREATE DATABASE "xihe_e2e_a" TEMPLATE "xihe_e2e_tpl";',
    ]);
    assert.throws(() => buildTemplateResetSql({ database: 'x', template: 'x' }), TypeError);
    assert.throws(() => buildTemplateResetSql({ database: 'x-y', template: 'z' }), TypeError);
});

test('dump-restore commands are schema-only, quoted, and never executed here', () => {
    const { dump, restore } = buildDumpRestoreCommands({
        container: 'xihe-e2e-host-x-postgres-1',
        database: 'xihe_e2e_x',
        user: 'xihe',
        dumpPath: '/tmp/x-schema.sql',
    });
    assert.equal(dump.program, 'docker');
    assert.ok(dump.args.includes('--schema-only'), 'the dump must not carry test data');
    assert.ok(dump.args.includes('/tmp/x-schema.sql') || dump.args.includes('--file=/tmp/x-schema.sql'));
    assert.equal(restore.program, 'docker');
    assert.ok(restore.args.includes('ON_ERROR_STOP=1'), 'a failed restore must abort the round, not half-apply');
    assert.throws(
        () => buildDumpRestoreCommands({ container: 'c', database: 'd', user: 'u', dumpPath: '' }),
        TypeError,
    );
    assert.throws(
        () => buildDumpRestoreCommands({ container: 'c; rm -rf /', database: 'd', user: 'u', dumpPath: '/t' }),
        TypeError,
    );
});

test('the table-introspection query stays scoped to the public schema', () => {
    const query = buildDatabaseTablesQuery();
    assert.match(query, /pg_tables/);
    assert.match(query, /schemaname = 'public'/);
    assert.ok(!/TRUNCATE|DROP/i.test(query), 'introspection must be read-only');
});

test('the seed snapshot is what protects the owner account and the imported config', () => {
    const seedQuery = buildSeedTableQuery();
    assert.match(seedQuery, /pg_stat_user_tables/);
    assert.match(seedQuery, /n_live_tup > 0/);
    assert.ok(!/TRUNCATE|DROP|DELETE/i.test(seedQuery), 'introspection must be read-only');

    const all = ['users', 'role_bindings', 'config_values', 'sessions', 'chat_runs', 'flyway_schema_history'];
    const plan = selectTablesToTruncate({
        tables: all,
        seedTables: ['users', 'role_bindings', 'config_values'],
    });
    assert.deepEqual(plan.truncate, ['sessions', 'chat_runs']);
    assert.deepEqual(plan.kept, ['users', 'role_bindings', 'config_values', 'flyway_schema_history']);
    assert.equal(plan.refused, '');
});

test('an empty seed snapshot refuses the reset instead of deleting the owner account', () => {
    const plan = selectTablesToTruncate({ tables: ['users', 'sessions'], seedTables: [] });
    assert.deepEqual(plan.truncate, []);
    assert.match(plan.refused, /owner account/);
    assert.throws(() => selectTablesToTruncate({ tables: 'users', seedTables: ['users'] }), TypeError);
});

test('a reset with no test-data tables is a no-op, not an error', () => {
    const plan = selectTablesToTruncate({
        tables: ['users', 'flyway_schema_history'],
        seedTables: ['users'],
    });
    assert.deepEqual(plan.truncate, []);
    assert.equal(plan.refused, '');
});
