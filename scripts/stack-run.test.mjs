import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { resolveHostRoot } from "./host-root.mjs";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(scriptsDir, "..");
const stackRun = resolve(scriptsDir, "stack-run.mjs");

test("resolveHostRoot resolves relative values against the project root", () => {
  const result = resolveHostRoot(projectRoot, ".xihe-workspaces");
  assert.equal(result.wasRelative, true);
  assert.equal(result.value, resolve(projectRoot, ".xihe-workspaces"));
  assert.equal(isAbsolute(result.value), true);
});

test("resolveHostRoot keeps absolute values and normalizes them", () => {
  const absolute = resolve(projectRoot, ".xihe-workspaces");
  const result = resolveHostRoot(projectRoot, absolute);
  assert.equal(result.wasRelative, false);
  assert.equal(result.value, absolute);
});

test("resolveHostRoot treats blank values as unconfigured", () => {
  assert.deepEqual(resolveHostRoot(projectRoot, "   "), { value: "", wasRelative: false });
  assert.deepEqual(resolveHostRoot(projectRoot, undefined), { value: "", wasRelative: false });
});

test("stack-run env-json exposes an absolute hostRootResolved", () => {
  const env = { ...process.env };
  delete env.XIHE_WORKSPACE_HOST_ROOT;
  const result = spawnSync(process.execPath, [stackRun, "env-json"], {
    cwd: projectRoot,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(isAbsolute(parsed.hostRootResolved), true);
  assert.equal(parsed.hostRootResolved, resolve(projectRoot, parsed.hostRoot));
  assert.equal(parsed.env.XIHE_WORKSPACE_HOST_ROOT, parsed.hostRootResolved);
});

test("stack-run env-json resolves a relative env override against the checkout", () => {
  const env = { ...process.env, XIHE_WORKSPACE_HOST_ROOT: ".custom-workspaces" };
  const result = spawnSync(process.execPath, [stackRun, "env-json"], {
    cwd: projectRoot,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hostRootResolved, resolve(projectRoot, ".custom-workspaces"));
});

// --- task-172 (D-1532 ④): dev lanes opt in to the seeded admin ----------------
// The product default is "no seeded admin" (application.properties ships
// cp.bootstrap.seed-admin=${XIHE_SEED_ADMIN:false} so a fresh install reaches /onboarding).
// The dev lanes keep the old convention (an empty database already has admin@xihe.local):
// scripts/dev-stack.mjs injects only XIHE_DEV_ADMIN_PASSWORD and expects DataSeeder to
// create the row, and reset-admin is UPDATE-only => without the opt-in the first stack
// start on an empty database leaves nobody able to log in.
// These three tests pin the wiring: one for each of the two spawn paths plus the
// "operator value wins" rule (a lane default must never override an explicit setting).

test("stack-run fills XIHE_SEED_ADMIN=true for dev lanes when the operator did not set it", () => {
  const env = { ...process.env };
  delete env.XIHE_SEED_ADMIN;
  const result = spawnSync(process.execPath, [stackRun, "env-json"], {
    cwd: projectRoot,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).env.XIHE_SEED_ADMIN, "true");
});

test("stack-run keeps an explicit XIHE_SEED_ADMIN (the lane default never overrides the operator)", () => {
  const result = spawnSync(process.execPath, [stackRun, "env-json"], {
    cwd: projectRoot,
    env: { ...process.env, XIHE_SEED_ADMIN: "false" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).env.XIHE_SEED_ADMIN, "false");
});

test("dev-stack puts XIHE_SEED_ADMIN into the frozen childEnv of the spawned services", () => {
  // Static wiring pin: dev-stack spawns CP through cellEnv built inline (it is a CLI, there
  // is no seam to call), so the guard reads the source and requires the key inside that same
  // frozen object literal as the dev-admin password. If someone drops the line the stack
  // silently goes back to "empty database => no account", which is exactly the failure this
  // test exists to prevent.
  const source = readFileSync(resolve(scriptsDir, "dev-stack.mjs"), "utf8");
  const block = source.match(/childEnv = Object\.freeze\(\{[\s\S]{0,400}?XIHE_SEED_ADMIN[\s\S]{0,200}?\}\)/);
  assert.notEqual(block, null, "dev-stack.mjs must set XIHE_SEED_ADMIN inside childEnv");
  assert.match(block[0], /XIHE_DEV_ADMIN_PASSWORD: devAdmin\.password/, "the seed switch belongs to the same env literal as the dev-admin password");
});

