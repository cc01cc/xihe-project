#!/usr/bin/env node
/**
 * PLAN-0670 M1 — long-session capacity baseline (Node 24, zero dependencies).
 *
 * Two modes, deliberately separate:
 *
 *   node scripts/perf/chat-load.mjs seed --tier 20k [--apply]
 *       Seeds one session with N messages **straight into PostgreSQL** (never through the API:
 *       otherwise the measurement describes write throughput, not the read path we are auditing).
 *       Default is a dry run that prints the SQL it would execute.
 *
 *   node scripts/perf/chat-load.mjs run --tier 20k [--base http://127.0.0.1:12631] [--token …]
 *       Reads `GET /api/v1/sessions/{id}/messages` n times and reports p50/p95/p99, response bytes
 *       and the CP process RSS delta. Requires an **isolated** stack (PLAN-0670 constraint 3:
 *       never stack-1/stack-2 — they carry real-stack acceptance work).
 *
 * Measurement discipline (D4, agreed with the Lead — the numbers are meaningless without it):
 *   - sample size n >= 200, first 20 requests discarded as warm-up
 *   - latency unit ms, p95 computed on the post-warm-up sample
 *   - response size = bytes actually read (`arrayBuffer().length`), not a header claim
 *   - RSS delta = process RSS before the first sampled request vs after the last one
 *
 * Everything is read-only except `seed --apply`, which inserts rows into the target database.
 */
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const TIERS = { "1k": 1_000, "5k": 5_000, "20k": 20_000 };

function arg(name, fallback = null) {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : process.argv[index + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

const tier = arg("tier", "20k");
if (!(tier in TIERS)) {
    console.error(`unknown --tier ${tier}; expected one of ${Object.keys(TIERS).join(", ")}`);
    process.exit(2);
}
const total = TIERS[tier];

// ---------------------------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------------------------

function seed() {
    const apply = flag("apply");
    const container = arg("container", process.env.XIHE_PERF_PG_CONTAINER);
    const db = arg("db", process.env.XIHE_PERF_PG_DB);
    const sessionId = arg("session", crypto.randomUUID());

    if (!container || !db) {
        console.error(
            "seed needs --container <pg container> and --db <database> (or " +
                "XIHE_PERF_PG_CONTAINER / XIHE_PERF_PG_DB). Point it at the ISOLATED perf stack.",
        );
        process.exit(2);
    }

    // generate_series keeps this a single round trip: 20k rows is a few hundred ms, while a
    // per-row loop over the wire would dominate the measurement set-up itself.
    const sql = `
DO $$
DECLARE sid uuid := '${sessionId}';
BEGIN
  -- 10% of the rows carry a tool-call payload, 5% are long text (>= 4KB): the two shapes whose
  -- serialization cost is worst, and the ones the read path must not choke on.
  INSERT INTO messages (id, session_id, role, content, created_at, run_id)
  SELECT gen_random_uuid(), sid,
         CASE WHEN i % 2 = 0 THEN 'human' ELSE 'assistant' END,
         CASE WHEN i % 20 = 0 THEN repeat('long-form text ', 320)
              WHEN i % 10 = 0 THEN '{"toolCallId":"t' || i || '","name":"search","result":"ok"}'
              ELSE 'message ' || i END,
         now() + (i || ' milliseconds')::interval,
         NULL
  FROM generate_series(1, ${total}) AS i;
END $$;
`;
    if (!apply) {
        console.log(`[dry-run] would seed ${total} messages into session ${sessionId} (db=${db})`);
        console.log(sql.trim());
        console.log(`[dry-run] session id: ${sessionId}`);
        return;
    }
    execFileSync("docker", ["exec", container, "psql", "-U", "xihe", "-d", db, "-v", "ON_ERROR_STOP=1",
        "-c", sql], { stdio: "inherit" });
    console.log(JSON.stringify({ seeded: total, sessionId, tier }));
}

// ---------------------------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------------------------

async function run() {
    const base = arg("base", process.env.XIHE_PERF_CP_BASE ?? "http://127.0.0.1:12631");
    const token = arg("token", process.env.XIHE_PERF_TOKEN);
    const sessionId = arg("session", process.env.XIHE_PERF_SESSION);
    const branchId = arg("branch", process.env.XIHE_PERF_BRANCH);
    const iterations = Number(arg("n", "200"));
    const warmup = Number(arg("warmup", "20"));

    if (!token || !sessionId) {
        console.error("run needs --token / --session (or XIHE_PERF_TOKEN / XIHE_PERF_SESSION)");
        process.exit(2);
    }
    const url = `${base}/api/v1/sessions/${sessionId}/messages${branchId ? `?branchId=${branchId}` : ""}`;
    const rssProbe = () => process.memoryUsage.rss();

    const rssBefore = rssProbe();
    const samples = [];
    const bytes = [];
    let failures = 0;

    for (let i = 0; i < iterations + warmup; i++) {
        const started = performance.now();
        let body;
        try {
            const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
            body = await response.arrayBuffer();
            if (!response.ok) {
                failures++;
            }
        } catch (error) {
            failures++;
            console.error(`request ${i} failed: ${error.message}`);
            continue;
        }
        const elapsed = performance.now() - started;
        if (i >= warmup) {
            samples.push(elapsed);
            bytes.push(body.length);
        }
    }
    const rssAfter = rssProbe();

    const pct = (p) => {
        if (samples.length === 0) return null;
        const sorted = [...samples].sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
    };
    const report = {
        tier,
        url,
        iterations,
        warmup,
        failures,
        latencyMs: {
            p50: round(pct(50)),
            p95: round(pct(95)),
            p99: round(pct(99)),
            max: round(samples.length ? Math.max(...samples) : null),
        },
        responseBytes: {
            min: bytes.length ? Math.min(...bytes) : null,
            max: bytes.length ? Math.max(...bytes) : null,
            mean: bytes.length ? Math.round(bytes.reduce((a, b) => a + b, 0) / bytes.length) : null,
        },
        rssDeltaMb: round((rssAfter - rssBefore) / (1024 * 1024)),
        decided: "record into evidence/m1-baseline.md; thresholds are backfilled from these numbers",
    };
    console.log(JSON.stringify(report, null, 2));
    if (failures > 0) process.exitCode = 1;
}

function round(value) {
    return value === null || value === undefined ? null : Math.round(value * 10) / 10;
}

const mode = process.argv[2];
if (mode === "seed") {
    seed();
} else if (mode === "run") {
    await run();
} else {
    console.error("usage: chat-load.mjs seed|run --tier 1k|5k|20k …");
    process.exit(2);
}
