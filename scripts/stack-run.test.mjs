import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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
