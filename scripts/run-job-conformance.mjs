#!/usr/bin/env node
// PLAN-0390 fixture conformance runner (PLAN-0393/0394/0395 M2).
//
// Drives the fixture-driven Runtime conformance tests for one backend adapter.
// The assertions live in the crate (they need the handler harness and the real
// job engine); this wrapper is the documented entry point and pins the
// fixture + backend for them.
//
// Usage:
//   node scripts/run-job-conformance.mjs --backend windows-host
//   node scripts/run-job-conformance.mjs --backend windows-mxc
//
// XIHE_MXC_EXECUTABLE must point at wxc-exec.exe for the windows-mxc run.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeDir = resolve(here, "..", "packages", "runtime");
const fixture = resolve(
  here,
  "..",
  "..",
  "plans",
  "PLAN-0390-XH-execution-job-backends",
  "fixture",
  "job-handle-conformance.json",
);

const backend = (() => {
  const index = process.argv.indexOf("--backend");
  return index >= 0 ? process.argv[index + 1] : "windows-host";
})();

const knownBackends = ["windows-host", "windows-mxc"];
if (!knownBackends.includes(backend)) {
  console.error(`unknown backend ${backend}; expected one of ${knownBackends.join(", ")}`);
  process.exit(2);
}
if (!existsSync(fixture)) {
  console.error(`conformance fixture not found: ${fixture}`);
  process.exit(2);
}
if (backend === "windows-mxc") {
  const executable = process.env.XIHE_MXC_EXECUTABLE ?? "";
  if (!executable || !existsSync(executable)) {
    console.error(
      "XIHE_MXC_EXECUTABLE must point at wxc-exec.exe for the windows-mxc run",
    );
    process.exit(2);
  }
}

const env = {
  ...process.env,
  XIHE_JOB_CONFORMANCE_BACKEND: backend,
  XIHE_JOB_CONFORMANCE_FIXTURE: fixture,
};

console.log(`job-handle-conformance: backend=${backend}`);
console.log(`fixture: ${fixture}`);

const result = spawnSync(
  "cargo",
  ["test", "--bin", "xihe-runtime", "conf_", "--", "--test-threads=1"],
  { cwd: runtimeDir, env, stdio: "inherit", shell: process.platform === "win32" },
);

if (result.error) {
  console.error(`runner failed to start: ${result.error.message}`);
  process.exit(2);
}
process.exit(result.status ?? 1);
