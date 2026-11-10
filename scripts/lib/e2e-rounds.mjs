/**
 * PLAN-0650 M5 (T5.1/T5.2/T5.4): retry-round planning and between-round state reset.
 *
 * Why this module exists: host E2E used to pay a **full stack rebuild** for every retry. A failed
 * Playwright run tore the whole isolated stack down (`compose down --volumes`, new PG container,
 * `initdb`, fresh Flyway, four processes), so eight walkthrough rounds cost ~40 min of mostly
 * identical work (BL-205 ③). The single biggest lever was the CP artifact (fixed by M3's
 * `build-then-use`) and the second was the stack itself: the only thing a retry actually needs is
 * *fresh application state*, not a fresh container.
 *
 * Contract:
 * - **Retries are in-process by default** (`XIHE_E2E_RETRY_ROUNDS`, default 2 = one retry).
 *   `XIHE_E2E_REBUILD_ON_RETRY=1` restores the legacy shape: one attempt per process, so the
 *   operator's re-run rebuilds the stack (exactly what happened before M5).
 * - A retry is only offered when the runner **owns** the stack. In reuse lanes
 *   (`XIHE_E2E_EXTERNAL_SERVER=1`) someone else owns it, so the effective round count is 1 —
 *   resetting a stack we do not own would be an unannounced destructive action on another run.
 * - Reset strategies (all three produce the same observable effect: no test data from the failed
 *   round survives):
 *     - `truncate`     keep the stack up, truncate every public table except the schema history —
 *                      fastest by far (no service restart), which is what the ≤50% criterion needs;
 *     - `template`     stop services, `DROP DATABASE … WITH (FORCE)` + `CREATE DATABASE … TEMPLATE`
 *                      from a pre-migrated snapshot DB;
 *     - `dump-restore` stop services, drop/recreate, restore a `pg_dump --schema-only` dump.
 *   The default is `truncate` because it is the only one that can satisfy "round-2 startup ≤ 50%
 *   of round-1" without restarting the Control Plane; the other two are kept as measured
 *   fallbacks (M4 picks the winner from real timings via `chooseRoundResetStrategy({ measured })`).
 * - Every SQL string is built here, from validated identifiers, so the runner cannot interpolate an
 *   unquoted name into `DROP DATABASE`/`TRUNCATE`.
 */
import { join } from 'node:path';

/** Highest accepted `XIHE_E2E_RETRY_ROUNDS` value; beyond this a lane is misconfigured, not slow. */
export const MAX_ROUNDS_CEILING = 5;

/** Rounds when the operator says nothing: one attempt + one in-process retry. */
export const DEFAULT_ROUNDS = 2;

/**
 * Tables that must survive a `truncate` reset (schema state, not test data).
 *
 * task-238/247: the authorization surface is **boot state**, not test data — the CP seeds the
 * SUPER_ADMIN binding + materialized `grants` at boot. A truncate reset that wipes them makes the
 * next round's `POST /api/v1/config/import` fail with `403` (`AuthorizationDeniedException` on
 * `holdsActionAtom('WRITE_INSTANCE_CONTENT')`). Keeping the whole family (including `users`, which
 * every later request authenticates against) also protects against `TRUNCATE … CASCADE` wiping it
 * through an FK reference.
 *
 * task-247: `pg_constraint` is consulted separately (see `keepTablesReferencedByKept`) so the list
 * cannot be defeated by a new FK from a kept table into a truncated one.
 */
export const AUTHORIZATION_SURFACE_TABLES = Object.freeze([
    'users',
    'roles',
    'role_permissions',
    'role_bindings',
    'grants',
]);

export const NEVER_TRUNCATE = Object.freeze([
    'flyway_schema_history',
    ...AUTHORIZATION_SURFACE_TABLES,
]);

/** Reset strategies in the order the runner prefers them when timings tie. */
export const ROUND_RESET_STRATEGIES = Object.freeze(['truncate', 'template', 'dump-restore']);

/**
 * @param {object} options
 * @param {number|string} [options.rounds]         `XIHE_E2E_RETRY_ROUNDS`
 * @param {boolean} [options.rebuildOnRetry]       `XIHE_E2E_REBUILD_ON_RETRY === '1'`
 * @param {boolean} [options.stackOwned]           false in the reuse lanes (`XIHE_E2E_EXTERNAL_SERVER=1`)
 * @returns {{rounds: number, inProcessRetry: boolean, reason: string}}
 */
export function decideRetryRounds({ rounds, rebuildOnRetry = false, stackOwned = true } = {}) {
    if (rebuildOnRetry) {
        return {
            rounds: 1,
            inProcessRetry: false,
            reason:
                'XIHE_E2E_REBUILD_ON_RETRY=1: legacy shape — one attempt per process, so a re-run '
                + 'rebuilds the stack',
        };
    }
    if (!stackOwned) {
        return {
            rounds: 1,
            inProcessRetry: false,
            reason: 'stack is not runner-owned (reuse lane): resetting it would destroy another run',
        };
    }
    const requested = rounds === undefined || rounds === null || `${rounds}`.trim() === ''
        ? DEFAULT_ROUNDS
        : Number(rounds);
    if (!Number.isInteger(requested) || requested < 1) {
        throw new TypeError(
            `decideRetryRounds: XIHE_E2E_RETRY_ROUNDS must be an integer >= 1, got ${JSON.stringify(rounds)}`,
        );
    }
    const effective = Math.min(requested, MAX_ROUNDS_CEILING);
    return {
        rounds: effective,
        inProcessRetry: effective > 1,
        reason: effective === 1
            ? 'single round (XIHE_E2E_RETRY_ROUNDS=1)'
            : `${effective} rounds: in-process retry with a between-round state reset `
                + `(capped at ${MAX_ROUNDS_CEILING} by MAX_ROUNDS_CEILING)`,
    };
}

/**
 * Pick the between-round reset strategy.
 *
 * @param {object} options
 * @param {string} [options.requested] `XIHE_E2E_ROUND_RESET` (truncate | template | dump-restore)
 * @param {Record<string, number>} [options.measured] observed milliseconds per strategy (M4 evidence)
 * @returns {{strategy: string, reason: string, measured: boolean}}
 */
export function chooseRoundResetStrategy({ requested, measured = null } = {}) {
    if (requested !== undefined && !ROUND_RESET_STRATEGIES.includes(requested)) {
        throw new TypeError(
            `chooseRoundResetStrategy: unknown XIHE_E2E_ROUND_RESET ${JSON.stringify(requested)} `
            + `(expected one of ${ROUND_RESET_STRATEGIES.join('|')})`,
        );
    }
    if (measured && typeof measured === 'object') {
        const usable = ROUND_RESET_STRATEGIES.filter((name) => Number.isFinite(measured[name]));
        if (usable.length > 0) {
            const fastest = usable.reduce((best, name) => (measured[name] < measured[best] ? name : best), usable[0]);
            return {
                strategy: fastest,
                reason: `fastest measured strategy: ${fastest} (${measured[fastest]} ms)`,
                measured: true,
            };
        }
    }
    if (requested) {
        return { strategy: requested, reason: `forced by XIHE_E2E_ROUND_RESET=${requested}`, measured: false };
    }
    return {
        strategy: 'truncate',
        reason:
            'default: truncate keeps the stack up (no CP restart), the only strategy that can meet '
            + 'the "round-2 startup <= 50% of round-1" criterion',
        measured: false,
    };
}

/**
 * Per-round test identity. Specs key their workspaces/sessions/fixtures off `XIHE_E2E_RUN_ID`, so a
 * new id per round is what makes round 2 unable to see round 1's host-root artifacts.
 */
export function roundRunId(runId, round) {
    if (typeof runId !== 'string' || runId.length === 0) {
        throw new TypeError('roundRunId: runId must be a non-empty string');
    }
    if (!Number.isInteger(round) || round < 1) {
        throw new TypeError(`roundRunId: round must be an integer >= 1, got ${JSON.stringify(round)}`);
    }
    return round === 1 ? runId : `${runId}-r${round}`;
}

/**
 * BL-560: the host root a spec should read artifacts from. The runner passes the
 * process-level fixed root via XIHE_WORKSPACE_HOST_ROOT; without it, specs that build
 * the root from the per-round XIHE_E2E_RUN_ID (<root>-r2, ...) read a wrong directory
 * on round 2+. The runner now always sets the env (e2e-host.mjs:2195-2198); this helper
 * is the single, tested resolution point so specs and the runner agree on the shape.
 *
 * Returns null when the env is absent AND no run id is available, so callers can
 * decide their own fallback rather than silently guessing.
 */
export function resolveSpecHostRoot(env, { projectDir = '', defaultRoot = null } = {}) {
    const explicit = env?.XIHE_WORKSPACE_HOST_ROOT;
    if (explicit) return explicit;
    const runId = env?.XIHE_E2E_RUN_ID;
    if (runId && projectDir) {
        // Deliberate: this is the BL-560-deficient path — a per-round id yields a
        // per-round root that diverges from the runner's fixed root. Kept only so the
        // self-test can assert the divergence is caught, not silently used.
        return join(projectDir, '.tmp', 'e2e-host', runId);
    }
    return defaultRoot;
}

/** The introspection query the `truncate` strategy needs (kept here so it is testable text). */

export function buildDatabaseTablesQuery() {
    return "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename";
}

/**
 * Deterministic boot-seed detection (task-247).
 *
 * `pg_stat_user_tables.n_live_tup` is filled asynchronously by the stats collector, so a table the
 * CP seeded seconds ago can still report 0 rows — which classified `grants`/`role_bindings` as "not
 * seed" and let the retry truncate the authorization surface (the `403` root cause). `count(*)` per
 * table inside **one** statement removes the dependency on statistics freshness and on `ANALYZE`.
 *
 * @param {string[]} tables every `public` table name (from `buildDatabaseTablesQuery()`)
 * @returns {string} one `SELECT … UNION ALL …` statement; psql prints `name|count` rows in `-A -t` mode
 */
export function buildSeedCountQuery(tables) {
    if (!Array.isArray(tables) || tables.length === 0) {
        throw new TypeError('buildSeedCountQuery: tables must be a non-empty array');
    }
    return tables
        .map((name) => {
            const table = requireIdentifier(name, 'table');
            return `SELECT '${table}' AS table_name, count(*)::bigint AS row_count FROM ${quoteIdentifier(table)}`;
        })
        .join(' UNION ALL ');
}

/**
 * Parse `buildSeedCountQuery()` output (`-A -t` psql, one row per line as `table|count`).
 *
 * @param {string} stdout
 * @returns {{table: string, rowCount: number}[]}
 */
export function parseSeedCounts(stdout) {
    if (typeof stdout !== 'string') throw new TypeError('parseSeedCounts: stdout must be a string');
    const rows = [];
    for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        const match = /^([A-Za-z_][A-Za-z0-9_]*)\|(\d+)$/.exec(trimmed);
        if (!match) throw new TypeError(`parseSeedCounts: unexpected row ${JSON.stringify(trimmed)}`);
        rows.push({ table: match[1], rowCount: Number(match[2]) });
    }
    return rows;
}

/** Tables whose `count(*)` was already non-zero right after boot (the protected seed set). */
export function seedTablesFromCounts(rows) {
    if (!Array.isArray(rows)) throw new TypeError('seedTablesFromCounts: rows must be an array');
    return rows.filter((row) => row.rowCount > 0).map((row) => row.table);
}

/**
 * Foreign-key snapshot (`pg_constraint`, direction preserved): `TRUNCATE … CASCADE` follows an FK
 * **from** the referencing table **to** the referenced one, so a kept table pointing at a truncated
 * table would be truncated as well. The runner captures this at boot and extends the keep list
 * instead of trusting the static `NEVER_TRUNCATE` alone.
 */
export function buildForeignKeySnapshotQuery() {
    return "SELECT c.conrelid::regclass::text || '|' || c.confrelid::regclass::text "
        + "FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace "
        + "WHERE c.contype = 'f' AND n.nspname = 'public' ORDER BY 1";
}

/**
 * Parse `buildForeignKeySnapshotQuery()` output (`from_table|to_table` per line). `regclass` text
 * may carry a schema prefix; only bare names are returned (the runner only acts on `public`).
 */
export function parseForeignKeySnapshot(stdout) {
    if (typeof stdout !== 'string') throw new TypeError('parseForeignKeySnapshot: stdout must be a string');
    const rows = [];
    for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        const [from, to] = trimmed.split('|');
        if (!from || !to) throw new TypeError(`parseForeignKeySnapshot: unexpected row ${JSON.stringify(trimmed)}`);
        rows.push({ from: from.replace(/^public\./, ''), to: to.replace(/^public\./, '') });
    }
    return rows;
}

/**
 * Keep-list additions required by FK direction: every table a kept table references must also be
 * kept, otherwise `CASCADE` would truncate the kept table through that reference.
 *
 * @param {object} options
 * @param {string[]} options.truncate candidate truncate list (computed before this call)
 * @param {string[]} options.kept     tables already protected
 * @param {{from: string, to: string}[]} options.foreignKeys snapshot rows
 * @returns {string[]} extra tables to keep
 */
export function keepTablesReferencedByKept({ truncate, kept, foreignKeys } = {}) {
    if (!Array.isArray(truncate) || !Array.isArray(kept) || !Array.isArray(foreignKeys)) {
        throw new TypeError('keepTablesReferencedByKept: truncate/kept/foreignKeys must be arrays');
    }
    const keptSet = new Set(kept);
    const truncateSet = new Set(truncate);
    const extra = [];
    for (const { from, to } of foreignKeys) {
        if (keptSet.has(from) && truncateSet.has(to)) extra.push(to);
    }
    return [...new Set(extra)];
}

/**
 * Tables a between-round reset should truncate: everything public, minus the boot-time seed tables,
 * minus the schema history.
 *
 * @param {object} options
 * @param {string[]} options.tables   every `public` table
 * @param {string[]} options.seedTables tables that were non-empty before the first spec ran
 * @param {string[]} [options.keep]    extra tables that must survive
 * @returns {{truncate: string[], kept: string[], refused: string}}
 *   `refused` is non-empty when the seed snapshot is unusable — the caller must then NOT truncate
 *   (truncating everything would delete the owner account) and fall back to a full rebuild.
 */
export function selectTablesToTruncate({ tables, seedTables, keep = NEVER_TRUNCATE } = {}) {
    if (!Array.isArray(tables) || !Array.isArray(seedTables)) {
        throw new TypeError('selectTablesToTruncate: tables and seedTables must be arrays');
    }
    if (seedTables.length === 0) {
        return {
            truncate: [],
            kept: [],
            refused:
                'seed-table snapshot is empty: truncating would delete the owner account and the '
                + 'imported config, so this reset is refused (fall back to a stack rebuild)',
        };
    }
    const keepSet = new Set([...keep, ...seedTables]);
    const truncate = tables.filter((name) => !keepSet.has(name));
    const kept = tables.filter((name) => keepSet.has(name));
    return { truncate, kept, refused: '' };
}

/**
 * Build the single `TRUNCATE` statement for every public table except the keep list.
 *
 * @param {object} options
 * @param {string[]} options.tables every `public` table name, as reported by the introspection query
 * @param {string[]} [options.keep]  tables that carry schema state and must survive
 * @param {boolean} [options.cascade] PostgreSQL `CASCADE` (needed for FK-referencing tables)
 * @returns {string} one statement, or `''` when there is nothing to truncate
 */
export function buildTruncateSql({ tables, keep = NEVER_TRUNCATE, cascade = true } = {}) {
    if (!Array.isArray(tables)) {
        throw new TypeError('buildTruncateSql: tables must be an array');
    }
    const keepSet = new Set(keep);
    const targets = tables.filter((name) => !keepSet.has(name));
    for (const name of targets) {
        requireIdentifier(name, 'table');
    }
    if (targets.length === 0) {
        return '';
    }
    const list = targets.map((name) => quoteIdentifier(name)).join(', ');
    return `TRUNCATE TABLE ${list}${cascade ? ' CASCADE' : ''};`;
}

/**
 * Drop-and-recreate a database from a pre-migrated template (`template` strategy).
 *
 * @param {object} options
 * @param {string} options.database the round database to recreate
 * @param {string} options.template the migrated-but-empty snapshot database
 * @returns {string[]} statements to run in order against a maintenance database
 */
export function buildTemplateResetSql({ database, template } = {}) {
    requireIdentifier(database, 'database');
    requireIdentifier(template, 'template');
    if (database === template) {
        throw new TypeError('buildTemplateResetSql: database and template must differ');
    }
    return [
        `DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE);`,
        `CREATE DATABASE ${quoteIdentifier(database)} TEMPLATE ${quoteIdentifier(template)};`,
    ];
}

/**
 * Drop-and-recreate an empty database (`dump-restore` strategy: the schema arrives from the dump
 * afterwards, so there is no template to copy).
 *
 * @param {object} options
 * @param {string} options.database
 * @returns {string[]} statements to run in order against a maintenance database
 */
export function buildBlankDatabaseResetSql({ database } = {}) {
    requireIdentifier(database, 'database');
    return [
        `DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE);`,
        `CREATE DATABASE ${quoteIdentifier(database)};`,
    ];
}

/**
 * Existence probe used to create the template database only once.
 * @param {string} database
 * @returns {string} `1` when it exists, empty otherwise
 */
export function buildDatabaseExistsQuery(database) {
    requireIdentifier(database, 'database');
    return `SELECT 1 FROM pg_database WHERE datname = '${database}'`;
}

/**
 * Command lines for the `dump-restore` strategy (`pg_dump --schema-only` + `psql -f`).
 * Nothing is executed here: the runner owns that, and these commands are exactly what M4 measures.
 *
 * @param {object} options
 * @param {string} options.container Postgres container name
 * @param {string} options.database  round database
 * @param {string} options.user      Postgres role
 * @param {string} options.dumpPath  host path of the schema-only dump
 * @param {string} [options.dockerCommand]
 * @returns {{dump: {program: string, args: string[]}, restore: {program: string, args: string[]}}}
 */
export function buildDumpRestoreCommands({ container, database, user, dumpPath, dockerCommand = 'docker' } = {}) {
    requireContainerName(container);
    requireIdentifier(database, 'database');
    requireIdentifier(user, 'role');
    if (typeof dumpPath !== 'string' || dumpPath.trim().length === 0) {
        throw new TypeError('buildDumpRestoreCommands: dumpPath must be a non-empty string');
    }
    return {
        dump: {
            program: dockerCommand,
            args: ['exec', container, 'pg_dump', '-U', user, '-d', database, '--schema-only', `--file=${dumpPath}`],
        },
        restore: {
            program: dockerCommand,
            args: ['exec', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', database, `-f`, dumpPath],
        },
    };
}

/** Conservative identifier guard: only names we are willing to quote and interpolate. */
function requireIdentifier(value, label) {
    if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
        throw new TypeError(
            `unsafe ${label} identifier ${JSON.stringify(value)}: expected /^[A-Za-z_][A-Za-z0-9_]*$/`,
        );
    }
    return value;
}

/**
 * Docker container names legitimately carry hyphens (`xihe-e2e-host-<runId>-postgres-1`). This
 * value is passed as a single argv element (no shell), so the guard only needs to reject
 * whitespace, quotes and shell metacharacters.
 */
function requireContainerName(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
        throw new TypeError(
            `unsafe container name ${JSON.stringify(value)}: expected /^[A-Za-z0-9][A-Za-z0-9_.-]*$/`,
        );
    }
    return value;
}

function quoteIdentifier(value) {
    return `"${value}"`;
}
