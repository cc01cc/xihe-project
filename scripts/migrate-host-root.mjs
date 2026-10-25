#!/usr/bin/env node
/**
 * PLAN-0550: migrate the XH host workspace root from the legacy cwd-derived
 * location (`packages/runtime/.xihe-workspaces`) to the A03 checkout root
 * (`.xihe-workspaces`).
 *
 * Safety contract:
 *   - dry-run by default; `--apply` is required to write;
 *   - never deletes, renames or moves anything;
 *   - refuses same-path conflicts (same relative path, different SHA-256);
 *   - keeps the source directory intact as a rollback archive;
 *   - rewrites shadow config path values to the new root.
 *
 * Usage:
 *   node scripts/migrate-host-root.mjs [--apply] [--source <dir>] [--target <dir>]
 *                                      [--manifest-out <file>] [--json]
 *
 * Custom --source/--target paths skip the running-stack preflight (used for
 * rehearsal copies); the default real paths require the stack to be stopped.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readdir, lstat, readFile, readlink, symlink, copyFile, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const DEFAULT_SOURCE = join(projectRoot, "packages", "runtime", ".xihe-workspaces");
const DEFAULT_TARGET = join(projectRoot, ".xihe-workspaces");
const PROBE_NAME = "probe0427";
const RUNTIME_PORT = Number(process.env.XIHE_RUNTIME_PORT || 12633);

function argValue(name) {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const apply = process.argv.includes("--apply");
const json = process.argv.includes("--json");
const source = resolve(argValue("source") || DEFAULT_SOURCE);
const target = resolve(argValue("target") || DEFAULT_TARGET);
const manifestOut = argValue("manifest-out");
const customPaths = Boolean(argValue("source") || argValue("target"));

function log(message) {
  if (!json) console.log(`[migrate] ${message}`);
}

function fail(message) {
  console.error(`[migrate] ERROR: ${message}`);
  process.exit(1);
}

function normalizeForCompare(value) {
  return value.replace(/\\/g, "/").replace(/^\/\/\?\//, "").toLowerCase();
}

function toGitPath(value) {
  return value.replace(/\\/g, "/").replace(/^\/\/\?\//, "");
}

function toPosix(value) {
  return value.split(sep).join("/");
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function walk(root, skipTopLevel = new Set()) {
  const entries = [];
  async function visit(current, relParts) {
    const names = await readdir(current, { withFileTypes: true });
    names.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of names) {
      if (relParts.length === 0 && skipTopLevel.has(entry.name)) continue;
      const absolute = join(current, entry.name);
      const rel = [...relParts, entry.name].join("/");
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        entries.push({ type: "symlink", path: rel, target: await readlink(absolute) });
      } else if (stat.isDirectory()) {
        entries.push({ type: "dir", path: rel });
        await visit(absolute, [...relParts, entry.name]);
      } else if (stat.isFile()) {
        entries.push({ type: "file", path: rel, size: stat.size, sha256: await sha256File(absolute) });
      } else {
        fail(`unsupported file type at ${absolute}`);
      }
    }
  }
  await visit(root, []);
  return entries;
}

function manifestMap(entries) {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

async function copyEntry(entry) {
  const from = join(source, ...entry.path.split("/"));
  const to = join(target, ...entry.path.split("/"));
  if (entry.type === "dir") {
    const existed = await exists(to);
    await mkdir(to, { recursive: true });
    return existed ? "skipped-same" : "created-dir";
  }
  if (await exists(to)) {
    // Shadow configs are intentionally rewritten; a second apply must not
    // compare them against the source hash or try to overwrite them.
    if (entry.path.endsWith(".git/config")) return "skipped-config";
    const targetEntry = (await walkEntry(to));
    if (targetEntry.type !== entry.type) fail(`type conflict at ${entry.path}`);
    if (entry.type === "symlink") {
      if (targetEntry.target !== entry.target) fail(`symlink conflict at ${entry.path}`);
      return "skipped-same";
    }
    if (targetEntry.sha256 !== entry.sha256) fail(`content conflict at ${entry.path}`);
    return "skipped-same";
  }
  await mkdir(dirname(to), { recursive: true });
  if (entry.type === "symlink") {
    await symlink(entry.target, to);
    return "created-symlink";
  }
  await copyFile(from, to);
  return "created-file";
}

async function walkEntry(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) {
    return { type: "symlink", target: await readlink(path) };
  }
  if (stat.isDirectory()) return { type: "dir" };
  if (stat.isFile()) return { type: "file", size: stat.size, sha256: await sha256File(path) };
  fail(`unsupported target file type at ${path}`);
}

function readCoreConfig(text) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let inCore = false;
  const values = new Map();
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[core\]$/i.test(trimmed)) {
      inCore = true;
      continue;
    }
    if (/^\[/.test(trimmed)) inCore = false;
    if (inCore) {
      const match = trimmed.match(/^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/);
      if (match) values.set(match[1].toLowerCase(), match[2]);
    }
  }
  return { lines, newline, values };
}

function setCoreValues(text, replacements) {
  const { lines, newline } = readCoreConfig(text);
  const replacementByLower = new Map(
    Object.entries(replacements).map(([key, value]) => [key.toLowerCase(), value]),
  );
  let inCore = false;
  const seen = new Set();
  const output = lines.map((line) => {
    const trimmed = line.trim();
    if (/^\[core\]$/i.test(trimmed)) {
      inCore = true;
      return line;
    }
    if (/^\[/.test(trimmed)) inCore = false;
    if (!inCore) return line;
    const match = line.match(/^(\s*)([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/);
    if (!match) return line;
    const key = match[2].toLowerCase();
    if (!replacementByLower.has(key)) return line;
    seen.add(key);
    return `${match[1]}${match[2]} = ${replacementByLower.get(key)}`;
  });
  for (const [key, value] of replacementByLower) {
    if (seen.has(key)) continue;
    const coreIndex = output.findIndex((line) => /^\[core\]$/i.test(line.trim()));
    if (coreIndex < 0) {
      output.push("[core]", `\t${key} = ${value}`);
    } else {
      output.splice(coreIndex + 1, 0, `\t${key} = ${value}`);
    }
  }
  return output.join(newline);
}

function rewriteShadowConfig(configPath, wsId) {
  return readFile(configPath, "utf8").then(async (text) => {
    const oldWorktree = join(source, wsId);
    const newWorktree = join(target, wsId);
    const shadowDir = join(target, ".xihe-shadow", `${wsId}.git`);
    const replacements = {
      hooksPath: toGitPath(join(shadowDir, "empty-hooks")),
      excludesFile: toGitPath(join(shadowDir, "exclude")),
    };
    const current = readCoreConfig(text).values;
    const worktree = current.get("worktree");
    if (worktree && normalizeForCompare(worktree) === normalizeForCompare(oldWorktree)) {
      replacements.worktree = toGitPath(newWorktree);
    }
    const next = setCoreValues(text, replacements);
    if (next !== text) await writeFile(configPath, next, "utf8");
    return { wsId, worktreeRewritten: Boolean(replacements.worktree) };
  });
}

function git(gitDir, args) {
  const result = spawnSync("git", ["--git-dir", gitDir, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || "").trim() };
  }
  return { ok: true, stdout: (result.stdout || "").trim() };
}

function refsOf(gitDir) {
  const result = git(gitDir, ["for-each-ref", "--format=%(refname) %(objectname)"]);
  if (!result.ok) return { ok: false, error: result.error, refs: [] };
  return {
    ok: true,
    refs: result.stdout ? result.stdout.split(/\r?\n/).filter(Boolean).sort() : [],
  };
}

function configValue(gitDir, key) {
  const result = git(gitDir, ["config", "--get", key]);
  return result.ok ? result.stdout : null;
}

async function portListening(port) {
  return new Promise((resolvePromise) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (value) => {
      socket.destroy();
      resolvePromise(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(750, () => done(false));
  });
}

function workspaceContainers() {
  const result = spawnSync(
    "docker",
    ["ps", "--filter", "label=xihe.stack-id=stack-1", "--format", "{{.Names}}"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return [];
  return (result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("xihe-workspace-ws_"));
}

async function preflight() {
  if (!(await exists(source))) fail(`source does not exist: ${source}`);
  if (!(await exists(join(source, ".xihe-shadow")))) {
    log(`warning: source has no .xihe-shadow directory: ${source}`);
  }
  if (normalizeForCompare(source) === normalizeForCompare(target)) {
    fail("source and target are the same directory");
  }
  if (normalizeForCompare(target).startsWith(`${normalizeForCompare(source)}/`)) {
    fail("target must not be inside source");
  }
  if (!customPaths) {
    if (await portListening(RUNTIME_PORT)) {
      fail(`Runtime is listening on ${RUNTIME_PORT}; stop the stack before migrating (or use custom --source/--target for a rehearsal)`);
    }
    const containers = workspaceContainers();
    if (containers.length > 0) {
      fail(`workspace containers are running (${containers.join(", ")}); stop the stack before migrating`);
    }
  }
  await mkdir(target, { recursive: true });
}

async function main() {
  await preflight();

  const sourceEntries = await walk(source);
  const sourceMap = manifestMap(sourceEntries);
  const shadowNames = sourceEntries
    .filter((entry) => entry.path.startsWith(".xihe-shadow/") && entry.path.endsWith(".git"))
    .map((entry) => entry.path.slice(".xihe-shadow/".length, -".git".length));

  log(`source=${source}`);
  log(`target=${target}`);
  log(`entries=${sourceEntries.length} files=${sourceEntries.filter((e) => e.type === "file").length} shadows=${shadowNames.length} apply=${apply}`);

  const sourceProbe = sourceMap.get(PROBE_NAME);
  const targetProbeBefore = (await exists(join(target, PROBE_NAME)))
    ? await walkEntry(join(target, PROBE_NAME))
    : null;
  if (targetProbeBefore && sourceProbe && targetProbeBefore.sha256 !== sourceProbe.sha256) {
    fail(`${PROBE_NAME} differs between source and target; refusing to touch it`);
  }

  const copyCounts = new Map();
  if (apply) {
    for (const entry of sourceEntries) {
      const result = await copyEntry(entry);
      copyCounts.set(result, (copyCounts.get(result) || 0) + 1);
    }
  }

  const configResults = [];
  if (apply) {
    for (const wsId of shadowNames) {
      const configPath = join(target, ".xihe-shadow", `${wsId}.git`, "config");
      if (!(await exists(configPath))) {
        fail(`shadow config missing after copy: ${configPath}`);
      }
      configResults.push(await rewriteShadowConfig(configPath, wsId));
    }
  }

  const targetEntries = apply
    ? await walk(target, new Set([PROBE_NAME]))
    : [];
  const targetMap = manifestMap(targetEntries);
  const targetOnly = apply
    ? targetEntries.filter((entry) => !sourceMap.has(entry.path)).map((entry) => entry.path)
    : [];

  const refComparisons = [];
  if (apply) {
    for (const wsId of shadowNames) {
      const sourceShadow = join(source, ".xihe-shadow", `${wsId}.git`);
      const targetShadow = join(target, ".xihe-shadow", `${wsId}.git`);
      const sourceRefs = refsOf(sourceShadow);
      const targetRefs = refsOf(targetShadow);
      if (!sourceRefs.ok || !targetRefs.ok) {
        fail(`cannot compare refs for ${wsId}: source=${sourceRefs.error || "ok"} target=${targetRefs.error || "ok"}`);
      }
      const equal = sourceRefs.refs.join("\n") === targetRefs.refs.join("\n");
      if (!equal) fail(`shadow refs differ for ${wsId}`);
      const config = {
        worktree: configValue(targetShadow, "core.worktree"),
        hooksPath: configValue(targetShadow, "core.hooksPath"),
        excludesFile: configValue(targetShadow, "core.excludesFile"),
      };
      const expectedShadow = join(target, ".xihe-shadow", `${wsId}.git`);
      if (normalizeForCompare(config.hooksPath || "") !== normalizeForCompare(join(expectedShadow, "empty-hooks"))) {
        fail(`core.hooksPath was not rewritten for ${wsId}: ${config.hooksPath}`);
      }
      if (normalizeForCompare(config.excludesFile || "") !== normalizeForCompare(join(expectedShadow, "exclude"))) {
        fail(`core.excludesFile was not rewritten for ${wsId}: ${config.excludesFile}`);
      }
      const managedWorktree = normalizeForCompare(config.worktree || "") === normalizeForCompare(join(target, wsId));
      const externalWorktree = config.worktree && !normalizeForCompare(config.worktree).startsWith(normalizeForCompare(target));
      if (!managedWorktree && !externalWorktree) {
        fail(`core.worktree points outside the migrated tree for ${wsId}: ${config.worktree}`);
      }
      refComparisons.push({ wsId, refs: sourceRefs.refs.length, managedWorktree, externalWorktree });
    }
    for (const entry of sourceEntries) {
      const current = targetMap.get(entry.path);
      if (!current) fail(`missing target entry after copy: ${entry.path}`);
      // Shadow configs are intentionally rewritten (absolute hooks/excludes/worktree).
      if (entry.path.endsWith(".git/config")) continue;
      if (entry.type === "file" && current.sha256 !== entry.sha256) {
        fail(`hash mismatch after copy: ${entry.path}`);
      }
      if (entry.type === "symlink" && current.target !== entry.target) {
        fail(`symlink mismatch after copy: ${entry.path}`);
      }
    }
  }

  const targetProbeAfter = (await exists(join(target, PROBE_NAME)))
    ? await walkEntry(join(target, PROBE_NAME))
    : null;
  if (targetProbeBefore && (!targetProbeAfter || targetProbeAfter.sha256 !== targetProbeBefore.sha256)) {
    fail(`${PROBE_NAME} changed during migration`);
  }

  const report = {
    apply,
    source,
    target,
    sourceEntries: sourceEntries.length,
    sourceFiles: sourceEntries.filter((e) => e.type === "file").length,
    shadows: shadowNames.length,
    copyCounts: Object.fromEntries(copyCounts),
    targetOnly,
    configResults,
    refComparisons,
    probe: {
      source: sourceProbe?.sha256 ?? null,
      targetBefore: targetProbeBefore?.sha256 ?? null,
      targetAfter: targetProbeAfter?.sha256 ?? null,
    },
  };

  if (manifestOut) {
    await mkdir(dirname(resolve(manifestOut)), { recursive: true });
    await writeFile(resolve(manifestOut), `${JSON.stringify({ report, sourceEntries }, null, 2)}\n`, "utf8");
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const created = [...copyCounts.entries()]
      .filter(([key]) => key.startsWith("created-"))
      .reduce((sum, [, count]) => sum + count, 0);
    log(`copies=${JSON.stringify(Object.fromEntries(copyCounts))} targetOnly=${targetOnly.length}`);
    log(`shadow refs verified=${refComparisons.length}`);
    log(`probe sha256=${report.probe.targetAfter ?? "(none)"}`);
    if (apply && created === 0) log("already-migrated (no files written; target-only entries left untouched)");
    if (apply) {
      log("source kept intact; rollback = stop stack, set XIHE_WORKSPACE_HOST_ROOT to the source absolute path, start");
    } else {
      log("dry-run only; no files were written (pass --apply to migrate)");
    }
  }
}

main().catch((error) => fail(error?.stack || String(error)));
