/**
 * PLAN-0662 L1/L2: CP build identity (`build-info.properties`) + the dev-stack freshness verdict.
 *
 * Why this module exists: the resident dev stack had no way to say **which commit** its classes
 * came from. `health UP` says nothing about code version, so on 2026-11-04 a walkthrough read a
 * 20:01 build as `develop` and filed BL-240 against code that had already been fixed 11 merges ago.
 *
 * The stamp is written by the launcher (`scripts/stack-run.mjs`) right after it has compiled the
 * tree, not by the Spring build: no new Maven plugin, no placeholder plumbing for a git sha, and
 * `git diff --stat` for this plan stays inside pom/scripts/docs.
 *
 * Hash discipline (V1): `commit` is stored as the **full 40-char** `git rev-parse HEAD` value and
 * compared against HEAD; `shortSha()` (12 chars) is display-only. A stamp carrying a historical
 * short sha still verifies by prefix, so an old marker is not silently read as "different commit".
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

/** Relative to the Maven build directory (`target/` or `-Dxihe.target.dir`). */
export const BUILD_INFO_RELATIVE_PATH = join('classes', 'META-INF', 'build-info.properties');

/** The three fields the gate reads; anything else in the file is preserved as-is on rewrite. */
export const BUILD_INFO_KEYS = Object.freeze(['commit', 'builtAt', 'dirty']);

/**
 * Resolve CP's Maven build directory exactly like the pom does: `XIHE_CP_TARGET_DIR` wins (the
 * launcher forwards it as `-Dxihe.target.dir`), otherwise `packages/control-plane/target`.
 *
 * @param {{projectRoot: string, env?: Record<string, string|undefined>}} input
 * @returns {string} absolute directory
 */
export function cpTargetDir({ projectRoot, env = process.env }) {
  const raw = typeof env.XIHE_CP_TARGET_DIR === 'string' ? env.XIHE_CP_TARGET_DIR.trim() : '';
  return raw ? resolve(projectRoot, raw) : join(projectRoot, 'packages', 'control-plane', 'target');
}

/** @param {string} targetDir @returns {string} absolute path of the stamp file */
export function buildInfoPath(targetDir) {
  return join(targetDir, BUILD_INFO_RELATIVE_PATH);
}

/**
 * Minimal Java-properties reader: `key=value` lines, `#`/`!` comments, blank lines ignored.
 * Only `commit` is required; a file without it is not a stamp (returns null).
 *
 * @param {string} text
 * @returns {{commit: string, builtAt: string, dirty: boolean}|null}
 */
export function parseBuildInfo(text) {
  const values = new Map();
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const commit = values.get('commit');
  if (!commit) return null;
  return {
    commit,
    builtAt: values.get('builtAt') ?? '',
    dirty: values.get('dirty') === 'true',
  };
}

/** @param {{commit: string, builtAt: string, dirty: boolean}} input @returns {string} */
export function formatBuildInfo({ commit, builtAt, dirty }) {
  return (
    [
      '# PLAN-0662 L1: written by scripts/stack-run.mjs after compiling the CP tree.',
      `commit=${commit}`,
      `builtAt=${builtAt}`,
      `dirty=${dirty ? 'true' : 'false'}`,
    ].join('\n') + '\n'
  );
}

/**
 * @param {string} targetDir
 * @param {(file: string, encoding: 'utf8') => string} [read]
 * @returns {{file: string, info: ReturnType<typeof parseBuildInfo>}}
 */
export function readBuildInfo(targetDir, read = readFileSync) {
  const file = buildInfoPath(targetDir);
  try {
    return { file, info: parseBuildInfo(read(file, 'utf8')) };
  } catch {
    // No stamp yet (first start) or unreadable file — both mean "cannot prove freshness".
    return { file, info: null };
  }
}

/**
 * Stamp the build. Called only after a successful compile, so a failed build leaves the old
 * stamp in place (the next start still sees stale classes instead of a false "fresh").
 *
 * @param {{targetDir: string, commit: string, builtAt?: string, dirty?: boolean}} input
 * @returns {string} the written file
 */
export function writeBuildInfo({ targetDir, commit, builtAt = new Date().toISOString(), dirty = false }) {
  const file = buildInfoPath(targetDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, formatBuildInfo({ commit, builtAt, dirty }), 'utf8');
  return file;
}

/** Display form of a sha (full hashes stay full in the stamp; logs are shortened). */
export function shortSha(sha, length = 12) {
  const text = typeof sha === 'string' ? sha.trim() : '';
  return text.length > length ? text.slice(0, length) : text;
}

/**
 * HEAD as the gate sees it. `dirty` is scoped to the CP sources: an edit under `packages/ui`
 * does not change what CP compiles, so it must not force a CP rebuild.
 *
 * @param {{cwd: string, run?: typeof spawnSync}} input
 * @returns {{commit: string|null, dirty: boolean, error: string|null}}
 */
export function gitHead({ cwd, run = spawnSync }) {
  const rev = run('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  const commit = rev.status === 0 ? String(rev.stdout ?? '').trim() : '';
  if (!commit) {
    return { commit: null, dirty: false, error: String(rev.stderr ?? '').trim() || 'git rev-parse HEAD failed' };
  }
  const status = run('git', ['status', '--porcelain', '--', 'packages/control-plane'], {
    cwd,
    encoding: 'utf8',
  });
  return { commit, dirty: status.status === 0 && String(status.stdout ?? '').trim() !== '', error: null };
}

/**
 * A stored stamp may be full (current writer) or a historical short sha. Prefix-compare both
 * ways so a short marker is not misread as a different commit.
 *
 * @param {string|null} head
 * @param {string|null} recorded
 * @returns {boolean}
 */
export function sameCommit(head, recorded) {
  const left = typeof head === 'string' ? head.trim().toLowerCase() : '';
  const right = typeof recorded === 'string' ? recorded.trim().toLowerCase() : '';
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  return shorter.length >= 7 && longer.startsWith(shorter);
}

/**
 * The gate's whole decision, as a pure function (the launcher only logs and acts on it).
 *
 * `fresh` is the "may boot without rebuilding" answer: only an exact commit match is fresh;
 * a missing stamp and an unresolvable HEAD both default to **rebuild** (fail-safe — the cost of
 * one compile is far below the cost of debugging pre-fix code, which is what BL-240 was).
 *
 * @param {{targetDir: string, headCommit: string|null, read?: typeof readFileSync}} input
 * @returns {{
 *   status: 'fresh'|'stale'|'missing'|'unverified',
 *   fresh: boolean,
 *   file: string,
 *   fileCommit: string|null,
 *   builtAt: string|null,
 *   dirty: boolean|null,
 *   reason: string,
 * }}
 */
export function evaluateCpFreshness({ targetDir, headCommit, read = readFileSync }) {
  const { file, info } = readBuildInfo(targetDir, read);
  const head = typeof headCommit === 'string' && headCommit.trim() ? headCommit.trim() : null;
  if (!info) {
    return {
      status: 'missing',
      fresh: false,
      file,
      fileCommit: null,
      builtAt: null,
      dirty: null,
      reason: 'no build-info stamp (classes were not built by the freshness-aware launcher)',
    };
  }
  if (!head) {
    return {
      status: 'unverified',
      fresh: false,
      file,
      fileCommit: info.commit,
      builtAt: info.builtAt,
      dirty: info.dirty,
      reason: 'HEAD is unknown (git rev-parse failed); cannot prove freshness',
    };
  }
  const fresh = sameCommit(head, info.commit);
  return {
    status: fresh ? 'fresh' : 'stale',
    fresh,
    file,
    fileCommit: info.commit,
    builtAt: info.builtAt,
    dirty: info.dirty,
    reason: fresh ? 'stamped commit == HEAD' : `stamped commit != HEAD`,
  };
}
