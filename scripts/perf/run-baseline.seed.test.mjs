#!/usr/bin/env node
/**
 * task-38 (PLAN-0682 T0.1 hook): the `seed-runs` facility must stay idempotent across all three
 * tiers (1k / 5k / 20k messages ⇒ 500 / 2,500 / 10,000 `chat_runs`), and every seeded message must
 * carry a `run_id` (100% coverage).
 *
 * Two layers of evidence:
 *
 *   1. **pure contract tests** (always run, no database): tier arithmetic, the deterministic
 *      md5-cast UUIDs, `ON CONFLICT ... DO NOTHING` on both inserts, the in-transaction count /
 *      coverage checks, and the dry-run invariance of the CLI.
 *   2. **live idempotency** (`XIHE_SEED_LIVE_PG=1`): boots an ephemeral pgvector/pgvector:pg17
 *      container (own name, removed in `finally`), loads the schema-only dump of an already
 *      migrated database, then applies `seed-fixtures` once and `seed-runs` twice per tier:
 *      the second apply must leave every count identical, and the measured wall clock per tier is
 *      printed for the evidence table. Nothing is written to the source database (pg_dump is
 *      read-only); the container carries no volume, so teardown is `docker rm -f <own-name>`.
 *
 * Usage:
 *   node --test scripts/perf/run-baseline.seed.test.mjs                       # pure tests
 *   XIHE_SEED_LIVE_PG=1 node --test scripts/perf/run-baseline.seed.test.mjs   # + real PG
 *   optional: XIHE_SEED_SOURCE_CONTAINER (default a03-xihe-postgres-1),
 *             XIHE_SEED_SOURCE_DB (default xihe_1), XIHE_SEED_TEST_IMAGE (default pgvector/pgvector:pg17)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { TIERS, tierPlan, seedRunsSql } from "./run-baseline.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "run-baseline.mjs");
const TIER_NAMES = ["1k", "5k", "20k"];

function runCli(args) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 300_000 });
    assert.equal(result.status, 0, `\`run-baseline ${args.join(" ")}\` failed: ${result.stderr}`);
    const lastLine = result.stdout.trim().split(/\r?\n/).at(-1);
    return JSON.parse(lastLine);
}

function runCliTimed(args) {
    const started = performance.now();
    const json = runCli(args);
    return { ms: Math.round(performance.now() - started), json };
}

// ---------------------------------------------------------------------------------------------
// 1. pure contract tests (no database)
// ---------------------------------------------------------------------------------------------

test("tier plan: 1k/5k/20k messages, one run per round", () => {
    for (const tier of TIER_NAMES) {
        const plan = tierPlan(tier);
        assert.equal(plan.messages, TIERS[tier]);
        assert.equal(plan.runs, TIERS[tier] / 2, `${tier}: runs must be messages/2`);
        assert.ok(Number.isInteger(plan.runs), `${tier}: runs must be an integer`);
    }
    assert.deepEqual(Object.keys(TIERS), TIER_NAMES, "the three tiers are the frozen vocabulary");
    assert.throws(() => tierPlan("10k"), /unknown tier 10k/);
});

test("seed-runs SQL is deterministic and idempotent by construction", () => {
    const sessionId = "33333333-3333-3333-3333-333333333333";
    for (const tier of TIER_NAMES) {
        const plan = tierPlan(tier);
        const sql = seedRunsSql({ tier, sessionId });
        // deterministic ids: re-running a tier must regenerate identical primary keys.
        assert.match(sql, /md5\('bl382:' \|\| sid \|\| ':run:' \|\| j\)::uuid/,
            "chat_runs ids must be md5-cast deterministic uuids");
        assert.match(sql, /md5\('bl382:' \|\| sid \|\| ':msg:' \|\| i\)::uuid/,
            "message ids must be md5-cast deterministic uuids");
        assert.match(sql, /\(\(i \+ 1\) \/ 2\)/, "message i maps to the deterministic run of round (i+1)/2");
        // idempotent writes.
        assert.match(sql, /ON CONFLICT \(user_id, session_id, idempotency_key\) DO NOTHING/);
        assert.match(sql, /ON CONFLICT \(id\) DO NOTHING/);
        // exact counts guarded inside the same transaction.
        assert.ok(sql.includes(`FROM generate_series(1, ${plan.runs}) AS j`), `${tier}: runs series`);
        assert.ok(sql.includes(`FROM generate_series(1, ${plan.messages}) AS i`), `${tier}: messages series`);
        assert.ok(sql.includes(`IF n <> ${plan.runs} THEN`), `${tier}: chat_runs count check`);
        assert.ok(sql.includes(`IF n <> ${plan.messages} THEN`), `${tier}: linked-message count check`);
        assert.match(sql, /FROM messages m JOIN chat_runs r ON m\.run_id = r\.id/,
            "the coverage check must count messages joined to cat_runs, not just run_id non-null");
        // same input ⇒ byte-identical plan (no random ids in the SQL).
        assert.equal(seedRunsSql({ tier, sessionId }), sql);
    }
});

test("dry-run prints the plan and writes nothing even on a repeated invocation", () => {
    const sessionId = "44444444-4444-4444-4444-444444444444";
    const args = ["seed-runs", "--tier", "5k", "--session", sessionId, "--container", "never-used",
        "--db", "never-used"];
    const first = runCli(args);
    const second = runCli(args);
    assert.deepEqual(first, second, "dry-run output must be deterministic");
    assert.equal(first.phase, "seed-runs");
    assert.equal(first.dryRun, true, "no --apply ⇒ dry-run (the container is deliberately bogus)");
    assert.equal(first.seeded, 5000);
    assert.equal(first.runs, 2500);
});

test("unknown tier is a usage error (exit 2), not a silent fallback", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "seed-runs", "--tier", "10k",
        "--container", "x", "--db", "x"], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown --tier 10k; expected one of 1k, 5k, 20k/);
});

// ---------------------------------------------------------------------------------------------
// 2. live idempotency against a real PostgreSQL (opt-in: XIHE_SEED_LIVE_PG=1)
// ---------------------------------------------------------------------------------------------

const LIVE = process.env.XIHE_SEED_LIVE_PG === "1";
const SOURCE_CONTAINER = process.env.XIHE_SEED_SOURCE_CONTAINER || "a03-xihe-postgres-1";
const SOURCE_DB = process.env.XIHE_SEED_SOURCE_DB || "xihe_1";
const IMAGE = process.env.XIHE_SEED_TEST_IMAGE || "pgvector/pgvector:pg17";

function docker(args, options = {}) {
    const result = spawnSync("docker", args, { encoding: "utf8", timeout: 300_000, ...options });
    assert.equal(result.status, 0, `docker ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    return result.stdout ?? "";
}

function psql(container, db, sql) {
    return docker(["exec", container, "psql", "-U", "xihe", "-d", db, "-t", "-A",
        "-v", "ON_ERROR_STOP=1", "-c", sql]).trim();
}

function waitForPostgres(container, db) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        const probe = spawnSync("docker", ["exec", container, "pg_isready", "-U", "xihe", "-d", db],
            { encoding: "utf8" });
        if (probe.status === 0) {
            return;
        }
        spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 500)"]);
    }
    throw new Error(`postgres in ${container} did not become ready in 90s`);
}

test("live: seed-runs stays idempotent per tier on real PostgreSQL (counts + wall clock)",
    { skip: LIVE ? false : "set XIHE_SEED_LIVE_PG=1 to boot an ephemeral pgvector container" },
    () => {
        const container = `xihe-seedtest-${randomUUID().slice(0, 8)}`;
        docker(["run", "-d", "--name", container,
            "-e", "POSTGRES_USER=xihe", "-e", "POSTGRES_PASSWORD=xihe", "-e", "POSTGRES_DB=xihe_seed",
            IMAGE]);
        try {
            waitForPostgres(container, "xihe_seed");
            // Read-only schema source: an already migrated database, dumped schema-only, so the
            // fixture runs against the real V1..V143 DDL without touching the source rows.
            const dump = execFileSync("docker", ["exec", SOURCE_CONTAINER, "pg_dump", "-U", "xihe",
                "-d", SOURCE_DB, "--schema-only", "--no-owner", "--no-privileges"],
            { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
            docker(["exec", "-i", container, "psql", "-U", "xihe", "-d", "xihe_seed", "-v",
                "ON_ERROR_STOP=1", "-q"], { input: dump });

            // seed-fixtures requires one user row to own the fixture; insert it ourselves
            // (the seeded tiers are the souce of truth for counts, the user is not).
            psql(container, "xihe_seed",
                "INSERT INTO users (id, email, password_hash, name, username) VALUES "
                + "('99999999-9999-9999-9999-999999999999', 'seed-test@example.test', 'x', "
                + "'Seed Test', 'seed-test') ON CONFLICT (id) DO NOTHING;");
            const workspace = randomUUID();
            const principal = randomUUID();
            const session = randomUUID();
            const branch = randomUUID();
            runCli(["seed-fixtures", "--container", container, "--db", "xihe_seed",
                "--workspace", workspace, "--principal", principal, "--session", session,
                "--branch", branch, "--apply"]);

            const timings = [];
            for (const tier of TIER_NAMES) {
                const plan = tierPlan(tier);
                // Tiers share one session and deterministic index-derived ids, so they are nested
                // prefixes: applying 5k onto a 1k-seeded session yields exactly 5,000 messages /
                // 2,500 runs, not the sum of both tiers. That is the idempotent "re-run is a
                // superset no-op" contract this test pins — not an accumulation.
                const expectedMessages = plan.messages;
                const expectedRuns = plan.runs;
                const args = ["seed-runs", "--container", container, "--db", "xihe_seed",
                    "--tier", tier, "--session", session, "--apply"];
                const firstApply = runCliTimed(args);
                const countsAfterFirst = {
                    messages: Number(psql(container, "xihe_seed",
                        `SELECT count(*) FROM messages WHERE session_id = '${session}'`)),
                    runs: Number(psql(container, "xihe_seed",
                        `SELECT count(*) FROM chat_runs WHERE session_id = '${session}'`)),
                    linked: Number(psql(container, "xihe_seed",
                        `SELECT count(*) FROM messages WHERE session_id = '${session}'
                           AND run_id IS NOT NULL`)),
                };
                assert.deepEqual(countsAfterFirst,
                    { messages: expectedMessages, runs: expectedRuns, linked: expectedMessages },
                    `${tier}: first apply must create exactly messages=${expectedMessages},`
                    + ` runs=${expectedRuns}, linked=${expectedMessages}`);

                const secondApply = runCliTimed(args); // idempotent re-run: same SQL, same counts.
                const countsAfterSecond = {
                    messages: Number(psql(container, "xihe_seed",
                        `SELECT count(*) FROM messages WHERE session_id = '${session}'`)),
                    runs: Number(psql(container, "xihe_seed",
                        `SELECT count(*) FROM chat_runs WHERE session_id = '${session}'`)),
                    linked: Number(psql(container, "xihe_seed",
                        `SELECT count(*) FROM messages WHERE session_id = '${session}'
                           AND run_id IS NOT NULL`)),
                };
                assert.deepEqual(countsAfterSecond, countsAfterFirst,
                    `${tier}: a repeated seed-runs must not change any row count`);
                timings.push({
                    tier,
                    messages: plan.messages,
                    runs: plan.runs,
                    firstApplyMs: firstApply.ms,
                    idempotentReRunMs: secondApply.ms,
                    counts: countsAfterSecond,
                });
            }
            console.log("[seed-runs-live] " + JSON.stringify({ ok: true, timings }));
        } finally {
            spawnSync("docker", ["rm", "-f", container], { encoding: "utf8" });
        }
    });
