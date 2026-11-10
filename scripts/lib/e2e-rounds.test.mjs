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
import { join } from 'node:path';
import { test } from 'node:test';

import {
    AUTHORIZATION_SURFACE_TABLES,
    DEFAULT_ROUNDS,
    MAX_ROUNDS_CEILING,
    NEVER_TRUNCATE,
    ROUND_RESET_STRATEGIES,
    buildDatabaseTablesQuery,
    buildDumpRestoreCommands,
    buildForeignKeySnapshotQuery,
    buildSeedCountQuery,
    buildTemplateResetSql,
    buildTruncateSql,
    chooseRoundResetStrategy,
    decideRetryRounds,
    keepTablesReferencedByKept,
    parseForeignKeySnapshot,
    parseSeedCounts,
    resolveSpecHostRoot,
    roundRunId,
    seedTablesFromCounts,
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

test('the seed snapshot is deterministic count(*) — not the async stats collector', () => {
    const tables = ['users', 'role_bindings', 'config_values', 'sessions'];
    const seedQuery = buildSeedCountQuery(tables);
    assert.match(seedQuery, /count\(\*\)/);
    assert.match(seedQuery, /UNION ALL/);
    for (const table of tables) assert.match(seedQuery, new RegExp(`'${table}'`));
    assert.ok(!/pg_stat_user_tables|n_live_tup/.test(seedQuery), 'must not depend on stats freshness');
    assert.ok(!/TRUNCATE|DROP|DELETE|UPDATE/i.test(seedQuery), 'introspection must be read-only');
    assert.throws(() => buildSeedCountQuery([]), TypeError);
    assert.throws(() => buildSeedCountQuery(['users; DROP TABLE grants']), TypeError);

    const rows = parseSeedCounts('users|1\nrole_bindings|3\nsessions|0\n');
    assert.deepEqual(seedTablesFromCounts(rows), ['users', 'role_bindings']);
    assert.throws(() => parseSeedCounts('not a count row'), TypeError);

    const all = ['users', 'role_bindings', 'config_values', 'sessions', 'chat_runs', 'flyway_schema_history'];
    const plan = selectTablesToTruncate({
        tables: all,
        seedTables: ['users', 'role_bindings', 'config_values'],
    });
    assert.deepEqual(plan.truncate, ['sessions', 'chat_runs']);
    assert.deepEqual(plan.kept, ['users', 'role_bindings', 'config_values', 'flyway_schema_history']);
    assert.equal(plan.refused, '');
});

test('the authorization surface is never truncated (users + roles + grants)', () => {
    for (const table of AUTHORIZATION_SURFACE_TABLES) {
        assert.ok(NEVER_TRUNCATE.includes(table), `${table} must survive a truncate reset`);
    }
    const plan = selectTablesToTruncate({
        tables: ['users', 'grants', 'sessions'],
        seedTables: ['sessions'],
    });
    assert.deepEqual(plan.truncate, []);
    assert.ok(plan.kept.includes('users') && plan.kept.includes('grants'));
});

test('pg_constraint direction keeps any table a kept table references', () => {
    const fkQuery = buildForeignKeySnapshotQuery();
    assert.match(fkQuery, /pg_constraint/);
    assert.match(fkQuery, /conrelid/);
    assert.match(fkQuery, /confrelid/);
    assert.ok(!/TRUNCATE|DROP|DELETE/i.test(fkQuery), 'introspection must be read-only');

    const edges = parseForeignKeySnapshot('role_bindings|roles\nsessions|users\npublic.session_branches|public.sessions\n');
    assert.deepEqual(edges, [
        { from: 'role_bindings', to: 'roles' },
        { from: 'sessions', to: 'users' },
        { from: 'session_branches', to: 'sessions' },
    ]);
    assert.throws(() => parseForeignKeySnapshot('only-one-part'), TypeError);

    // `grants` is kept and references `roles`; `roles` is therefore not truncatable via CASCADE.
    const extra = keepTablesReferencedByKept({
        truncate: ['roles', 'sessions'],
        kept: ['grants'],
        foreignKeys: [
            { from: 'grants', to: 'roles' },
            { from: 'sessions', to: 'users' },
        ],
    });
    assert.deepEqual(extra, ['roles']);
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

// ---------------------------------------------------------------------------
// BL-560: a spec must resolve the host root from the process-level fixed env, not
// from the per-round XIHE_E2E_RUN_ID. The runner passes XIHE_WORKSPACE_HOST_ROOT to
// Playwright (e2e-host.mjs:2195-2198) so every round reads the same root the runner
// and native services use.
// ---------------------------------------------------------------------------
test('BL-560: the explicit XIHE_WORKSPACE_HOST_ROOT wins over the per-round RUN_ID', () => {
    const base = 'H:\\proj\\.tmp\\e2e-host\\host-1';
    const root = resolveSpecHostRoot(
        { XIHE_WORKSPACE_HOST_ROOT: base, XIHE_E2E_RUN_ID: 'host-1-r2' },
        { projectDir: 'H:\\proj' },
    );
    assert.equal(root, base, 'the process-level fixed root must win, not the -r2 round id');
});

test('BL-560: without the env, a per-round RUN_ID yields a per-round root that diverges from the runner root', () => {
    const projectDir = 'H:\\proj';
    const round2 = resolveSpecHostRoot({ XIHE_E2E_RUN_ID: 'host-1-r2' }, { projectDir });
    const runnerRoot = join(projectDir, '.tmp', 'e2e-host', 'host-1');
    assert.notEqual(round2, runnerRoot, 'the deficient path reads a different root than the runner');
    assert.equal(round2, join(projectDir, '.tmp', 'e2e-host', 'host-1-r2'));
    // The fix: the runner sets the env, so the spec never reaches the deficient path.
    const fixed = resolveSpecHostRoot(
        { XIHE_WORKSPACE_HOST_ROOT: runnerRoot, XIHE_E2E_RUN_ID: 'host-1-r2' },
        { projectDir },
    );
    assert.equal(fixed, runnerRoot);
});

test('BL-560: returns the caller default when neither env nor run id is present', () => {
    const fallback = 'H:\\proj\\.xihe-workspaces';
    assert.equal(resolveSpecHostRoot({}, { defaultRoot: fallback }), fallback);
    assert.equal(resolveSpecHostRoot({}, {}), null);
});
