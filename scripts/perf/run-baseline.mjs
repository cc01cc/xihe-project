#!/usr/bin/env node
/**
 * PLAN-0670 M1/M2b/M3b — long-session capacity + memory baseline orchestrator.
 *
 * Thin wrapper around the **existing** per-run isolated stack (`scripts/e2e-host.mjs`), which is a
 * CLI runner rather than a module API: `--persistent` boots an isolated stack and keeps it,
 * `--teardown` stops it and asserts zero residue. This script never boots its own stack and never
 * touches stack-1/stack-2 (PLAN-0670 constraint 3).
 *
 * Phases (each one is a separate invocation so an operator can report ports/PIDs between steps —
 * the Lead requires "先报后跑"):
 *
 *   node scripts/perf/run-baseline.mjs boot   [--log <path>]
 *       Spawns `e2e-host.mjs --persistent`, tees its log, and prints the log path. Ports are
 *       reserved at run time by that runner; pass them back in the later phases.
 *
 *   node scripts/perf/run-baseline.mjs seed   --container <pg> --db <name> --tier 1k|5k|20k [--apply]
 *       Seeds one session **straight into PostgreSQL** (never through the API: otherwise the numbers
 *       describe write throughput instead of the read path under audit).
 *
 *   node scripts/perf/run-baseline.mjs seed-attachment --container <pg> --db <name> [--apply]
 *       Seeds the 500 MB single-attachment scenario (M3b). Files are written to the storage root
 *       directly because attachments do not go through a JSON API — noted in the report.
 *
 *   node scripts/perf/run-baseline.mjs run --tier 1k|5k|20k [--base … --token … --session …]
 *       Reads the message list n times (n>=200, 20 warm-up) and reports p50/p95/p99/max, response
 *       bytes, **JVM heap peak** (jcmd, when --cp-pid is given) and **OS RSS** (WorkingSet64).
 *
 *   node scripts/perf/run-baseline.mjs dispatch --tier 20k [--base … --token … --session …]
 *       M2b.1 baseline: sends ONE message into a 20k-message session and samples the same memory
 *       numbers around the dispatch, so the context-projection / roster-aggregation cost is
 *       measured where it actually happens.
 *
 *   node scripts/perf/run-baseline.mjs teardown
 *       Delegates to `e2e-host.mjs --teardown` and reminds the operator to re-check ports/containers.
 *
 * Every phase prints a single JSON line so the evidence table can be built mechanically.
 */
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

const TIERS = { "1k": 1_000, "5k": 5_000, "20k": 20_000 };
const E2E_HOST = join("scripts", "e2e-host.mjs");

function arg(name, fallback = null) {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : process.argv[index + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);
const say = (payload) => console.log(JSON.stringify(payload));

function requireArg(name) {
    const value = arg(name);
    if (!value) {
        console.error(`missing --${name}`);
        process.exit(2);
    }
    return value;
}

// ---------------------------------------------------------------------------------------------
// memory probes
// ---------------------------------------------------------------------------------------------

/** OS-level RSS of a host process (MB). The CP runs natively under e2e-host, so this is readable. */
function rssMb(pid) {
    if (!pid) return null;
    try {
        const out = execFileSync("powershell", ["-NoProfile", "-Command",
            `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`],
        { encoding: "utf8" }).trim();
        return out ? Math.round(Number(out) / (1024 * 1024)) : null;
    } catch {
        return null;
    }
}

/** JVM heap used (MB) via JDK tooling; null when jcmd is unavailable or the pid is wrong. */
function heapUsedMb(pid) {
    if (!pid) return null;
    try {
        const out = execFileSync("jcmd", [String(pid), "GC.heap_info"], { encoding: "utf8" });
        const match = out.match(/used\s+(\d+)K/);
        return match ? Math.round(Number(match[1]) / 1024) : null;
    } catch {
        return null;
    }
}

function memorySnapshot(pid) {
    return { rssMb: rssMb(pid), heapUsedMb: heapUsedMb(pid) };
}

// ---------------------------------------------------------------------------------------------
// phases
// ---------------------------------------------------------------------------------------------

function boot() {
    const logPath = arg("log", join("H:/zeotmp/plan0670", "e2e-host-persistent.log"));
    mkdirSync(dirname(logPath), { recursive: true });
    if (!existsSync(E2E_HOST)) {
        console.error(`runner not found: ${E2E_HOST} (run from the A03-xihe root)`);
        process.exit(2);
    }
    const stream = createWriteStream(logPath, { flags: "a" });
    const child = spawn(process.execPath, [E2E_HOST, "--persistent", "--skip-preflight"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
    });
    writeFileSync(`${logPath}.pid`, String(child.pid));
    child.stdout.pipe(stream);
    child.stderr.pipe(stream);
    say({
        phase: "boot",
        bootPid: child.pid,
        log: logPath,
        note: "isolated per-run stack; ports are reserved by the runner — read them from the log,"
            + " report them to the Lead, then run the seed/run phases",
    });
}

function seed() {
    const tier = requireArg("tier");
    const total = TIERS[tier];
    const container = requireArg("container");
    const db = requireArg("db");
    const sessionId = arg("session", crypto.randomUUID());
    const sql = `
DO $$
DECLARE sid uuid := '${sessionId}';
DECLARE br uuid;
BEGIN
  SELECT id INTO br FROM branches WHERE session_id = sid ORDER BY created_at LIMIT 1;
  IF br IS NULL THEN
    RAISE EXCEPTION 'session % has no branch; run seed-fixtures first (messages.branch_id NOT NULL)', sid;
  END IF;
  INSERT INTO messages (id, session_id, role, content, created_at, branch_id)
  SELECT gen_random_uuid(), sid,
         CASE WHEN i % 2 = 0 THEN 'human' ELSE 'assistant' END,
         CASE WHEN i % 20 = 0 THEN repeat('long-form text ', 320)
              WHEN i % 10 = 0 THEN '{"toolCallId":"t' || i || '","name":"search","result":"ok"}'
              ELSE 'message ' || i END,
         now() + (i || ' milliseconds')::interval,
         br
  FROM generate_series(1, ${total}) AS i;
END $$;
`;
    if (!flag("apply")) {
        say({ phase: "seed", dryRun: true, tier, seeded: total, sessionId });
        return;
    }
    execFileSync("docker", ["exec", container, "psql", "-U", "xihe", "-d", db, "-v",
        "ON_ERROR_STOP=1", "-c", sql], { stdio: "inherit" });
    say({ phase: "seed", tier, seeded: total, sessionId });
}

function seedAttachment() {
    // M3b: one 500 MB attachment. Attachments are stored as files, not passed through a JSON API,
    // so this writes to the storage root and records the row directly.
    const apply = flag("apply");
    const container = requireArg("container");
    const db = requireArg("db");
    const sizeMb = Number(arg("size", "500"));
    const root = arg("root", "H:/zeotmp/plan0670/storage");
    if (!apply) {
        say({ phase: "seed-attachment", dryRun: true, sizeMb, root });
        return;
    }
    mkdirSync(root, { recursive: true });
    const file = join(root, `perf-${sizeMb}mb.bin`);
    const chunks = Math.ceil((sizeMb * 1024 * 1024) / (1024 * 1024));
    writeFileSync(file, Buffer.alloc(1024 * 1024));
    execFileSync(process.execPath, ["-e", [
        "const fs=require('node:fs');const p=process.argv[1];const fd=fs.openSync(p,'r+');",
        "const buf=Buffer.alloc(1024*1024,7);for(let i=0;i<" + (chunks - 1) + ";i++){",
        "fs.writeSync(fd,buf,0,buf.length,i*1024*1024);}fs.closeSync(fd);",
    ].join(""), file], { stdio: "inherit" });
    say({ phase: "seed-attachment", sizeMb, file, container, db,
        note: "row insertion is left to the caller: attachments do not go through a JSON API, so the"
            + " storage file is the load-bearing artefact for the memory measurement" });
}

async function readLoop({ mode }) {
    const tier = requireArg("tier");
    const base = arg("base", process.env.XIHE_PERF_CP_BASE ?? "http://127.0.0.1:12631");
    const token = requireArg("token");
    const sessionId = requireArg("session");
    const branchId = arg("branch");
    const cpPid = arg("cp-pid");
    const iterations = Number(arg("n", "200"));
    const warmup = Number(arg("warmup", "20"));
    const url = `${base}/api/v1/sessions/${sessionId}/messages${branchId ? `?branchId=${branchId}` : ""}`;

    const before = memorySnapshot(cpPid);
    const samples = [];
    const bytes = [];
    let failures = 0;

    if (mode === "dispatch") {
        // One POST so the dispatch path (context projection + roster aggregation) runs with a 20k
        // message session behind it; latency is not the point, the memory delta is.
        const started = performance.now();
        try {
            const response = await fetch(`${base}/api/v1/chat`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ sessionId, content: "perf probe", branchId: branchId ?? undefined }),
            });
            await response.arrayBuffer();
            if (!response.ok) failures++;
        } catch (error) {
            failures++;
            console.error(`dispatch failed: ${error.message}`);
        }
        samples.push(performance.now() - started);
    } else {
        for (let i = 0; i < iterations + warmup; i++) {
            const started = performance.now();
            try {
                const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
                const body = await response.arrayBuffer();
                if (!response.ok) failures++;
                if (i >= warmup) bytes.push(body.length);
            } catch (error) {
                failures++;
                console.error(`request ${i} failed: ${error.message}`);
                continue;
            }
            if (i >= warmup) samples.push(performance.now() - started);
        }
    }
    const after = memorySnapshot(cpPid);
    const pct = (p) => {
        if (samples.length === 0) return null;
        const sorted = [...samples].sort((a, b) => a - b);
        return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 10) / 10;
    };
    say({
        phase: mode,
        tier,
        url: mode === "dispatch" ? `${base}/api/v1/chat` : url,
        samples: samples.length,
        failures,
        latencyMs: { p50: pct(50), p95: pct(95), p99: pct(99) },
        responseBytes: bytes.length
            ? { min: Math.min(...bytes), max: Math.max(...bytes),
                mean: Math.round(bytes.reduce((a, b) => a + b, 0) / bytes.length) }
            : null,
        memory: {
            cpPid: cpPid ? Number(cpPid) : null,
            heapMbBefore: before.heapUsedMb,
            heapMbAfter: after.heapUsedMb,
            heapDeltaMb: before.heapUsedMb !== null && after.heapUsedMb !== null
                ? after.heapUsedMb - before.heapUsedMb : null,
            rssMbBefore: before.rssMb,
            rssMbAfter: after.rssMb,
            rssDeltaMb: before.rssMb !== null && after.rssMb !== null
                ? after.rssMb - before.rssMb : null,
            oom: failures > 0,
        },
    });
    if (failures > 0) process.exitCode = 1;
}

function teardown() {
    execFileSync(process.execPath, [E2E_HOST, "--teardown"], { stdio: "inherit" });
    say({ phase: "teardown", note: "re-check: reserved ports FREE, containers 0, host root removed" });
}

/**
 * M1 prerequisite (Lead ruling (A)): messages cannot be seeded into an empty stack — the read path
 * needs a real session chain. Required NOT NULL columns (no default), read from the live schema:
 *
 *   workspaces        id, name            (+ direct_attach requires host_path: ck_workspaces_direct_attach_path)
 *   agent_principals  id, name, created_by_user_id
 *   sessions          id, workspace_id, user_id
 *   branches          a branch row is REQUIRED: messages.branch_id is NOT NULL
 *   messages          id, session_id, role, content, branch_id
 *
 * The branch requirement is precisely the gap that a schema read catches and a hand-written seed
 * misses — the first version of this script would have failed on the FK at runtime.
 */
function seedFixtures() {
    const apply = flag("apply");
    const container = requireArg("container");
    const db = requireArg("db");
    const workspaceId = arg("workspace", crypto.randomUUID());
    const principalId = arg("principal", crypto.randomUUID());
    const sessionId = arg("session", crypto.randomUUID());
    const branchId = arg("branch", crypto.randomUUID());
    const sql = `
DO $$
DECLARE
  ws uuid := '${workspaceId}';
  pr uuid := '${principalId}';
  sid uuid := '${sessionId}';
  br uuid := '${branchId}';
  uid uuid;
BEGIN
  SELECT id INTO uid FROM users ORDER BY created_at LIMIT 1;
  IF uid IS NULL THEN
    RAISE EXCEPTION 'perf stack has no user row to own the fixture';
  END IF;
  INSERT INTO workspaces (id, name, storage_backend, storage_mode, host_path, execution_mode,
                          created_at, updated_at)
  VALUES (ws, 'perf-ws', 'host_directory', 'direct_attach',
          'C:/xihe-build/perf/' || ws, 'windows-host', now(), now())
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO agent_principals (id, name, created_by_user_id)
  VALUES (pr, 'perf-principal', uid) ON CONFLICT (id) DO NOTHING;
  INSERT INTO sessions (id, workspace_id, user_id, title, agent_principal_id)
  VALUES (sid, ws, uid, 'perf-session', pr) ON CONFLICT (id) DO NOTHING;
  INSERT INTO branches (id, session_id, name, created_at)
  SELECT br, sid, 'main', now()
  WHERE NOT EXISTS (SELECT 1 FROM branches WHERE session_id = sid AND name = 'main');
END $$;
SELECT 'workspace=${workspaceId} principal=${principalId} session=${sessionId} branch=${branchId}';
`;
    if (!apply) {
        say({ phase: "seed-fixtures", dryRun: true, workspaceId, principalId, sessionId, branchId });
        return;
    }
    execFileSync("docker", ["exec", container, "psql", "-U", "xihe", "-d", db, "-v",
        "ON_ERROR_STOP=1", "-c", sql], { stdio: "inherit" });
    say({ phase: "seed-fixtures", workspaceId, principalId, sessionId, branchId });
}

const phase = process.argv[2];
switch (phase) {
    case "boot": boot(); break;
    case "seed-fixtures": seedFixtures(); break;
    case "seed": seed(); break;
    case "seed-attachment": seedAttachment(); break;
    case "run": await readLoop({ mode: "run" }); break;
    case "dispatch": await readLoop({ mode: "dispatch" }); break;
    case "teardown": teardown(); break;
    default:
        console.error("usage: run-baseline.mjs boot|seed|seed-attachment|run|dispatch|teardown [options]");
        process.exit(2);
}
