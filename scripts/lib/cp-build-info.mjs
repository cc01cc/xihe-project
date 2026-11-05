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
 * `fresh` is the "may boot without rebuilding" answer: only an exact commit match **and a clean
 * build stamp** is fresh; a missing stamp and an unresolvable HEAD both default to **rebuild**
 * (fail-safe — the cost of one compile is far below the cost of debugging pre-fix code, which is
 * what BL-240 was). BL-325: a stamp whose commit matches HEAD but whose `dirty=true` gets its own
 * verdict (`dirty`) instead of `fresh`, because "commit right, tree dirty" is a real state that
 * must be nameable in the monitor rather than hidden behind `fresh`.
 *
 * @param {{targetDir: string, headCommit: string|null, read?: typeof readFileSync}} input
 * @returns {{
 *   status: 'fresh'|'stale'|'dirty'|'missing'|'unverified',
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
  const commitMatch = sameCommit(head, info.commit);
  const dirty = info.dirty === true;
  const fresh = commitMatch && !dirty;
  // BL-325: `dirty` is deliberately a separate verdict, not folded into `stale` — a dirty build is
  // from the right commit but not provably from the committed tree, and callers that only know
  // fresh/stale treat anything other than `fresh` as "not fresh".
  const status = !commitMatch ? 'stale' : dirty ? 'dirty' : 'fresh';
  return {
    status,
    fresh,
    file,
    fileCommit: info.commit,
    builtAt: info.builtAt,
    dirty: info.dirty,
    reason: !commitMatch
      ? 'stamped commit != HEAD'
      : dirty
        ? 'stamped commit == HEAD but the stamp says the tree was dirty at build time'
        : 'stamped commit == HEAD',
  };
}

/**
 * Commits between `from` and `to` (`git rev-list --count from..to`).
 * Null when either side is unknown or `from` is not a commit in this clone (e.g. a stamp
 * written on another checkout) — a number would be a guess, and status is read by scripts.
 *
 * @param {{cwd: string, from: string|null, to: string|null, run?: typeof spawnSync}} input
 * @returns {number|null}
 */
export function commitDistance({ cwd, from, to, run = spawnSync }) {
  const base = typeof from === 'string' ? from.trim() : '';
  const head = typeof to === 'string' ? to.trim() : '';
  if (!base || !head) return null;
  if (base === head) return 0;
  const result = run('git', ['rev-list', '--count', `${base}..${head}`], { cwd, encoding: 'utf8' });
  if (result.status !== 0) return null;
  const count = Number.parseInt(String(result.stdout ?? '').trim(), 10);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

/**
 * PLAN-0662 L4: the per-stack build-freshness row.
 *
 * **Field names are a contract** (`dev:host:status --json` / `ports.mjs status --json`);
 * lane scripts assert on them, so renaming is a breaking change:
 *
 * - `runningCommit` stamped commit of the classes the stack's CP uses (`null` = no stamp)
 * - `headCommit`    `git rev-parse HEAD` of this checkout (`null` = git unavailable)
 * - `behind`        `git rev-list --count runningCommit..headCommit` (`null` when unknown)
 * - `stale`         provably not from HEAD (`verdict` is `stale` or `missing`)
 * - `verdict`       `fresh` | `stale` | `missing` | `unverified` (same vocabulary as the gate)
 * - `targetDirSource` **additive (BL-253 L3)**: `pointer` | `newest` | `env` | `derived` — where
 *   `targetDir` came from. Existing fields keep their meaning unchanged.
 *
 * @param {{
 *   targetDir: string,
 *   headCommit: string|null,
 *   cwd: string,
 *   run?: typeof spawnSync,
 *   targetDirSource?: 'pointer'|'newest'|'env'|'derived',
 * }} input
 */
export function cpBuildStatus({ targetDir, headCommit, cwd, run = spawnSync, targetDirSource = 'derived' }) {
  const verdict = evaluateCpFreshness({ targetDir, headCommit });
  const head = typeof headCommit === 'string' && headCommit.trim() ? headCommit.trim() : null;
  return {
    targetDir,
    targetDirSource,
    file: verdict.file,
    runningCommit: verdict.fileCommit,
    headCommit: head,
    behind: commitDistance({ cwd, from: verdict.fileCommit, to: head, run }),
    // `stale` keeps its narrow documented meaning ("provably not from HEAD"); a `dirty` verdict
    // means "from the right commit, dirty tree" and is reported via `verdict` (BL-325). Consumers
    // that gate on freshness must require `verdict === 'fresh'`, never `!stale`.
    stale: verdict.status === 'stale' || verdict.status === 'missing',
    verdict: verdict.status,
    builtAt: verdict.builtAt,
    dirty: verdict.dirty,
  };
}

/**
 * PLAN-0662 L5: the external-server E2E gate. Running specs against a CP whose classes
 * predate the commit under test produces "product bugs" that are really stale-build
 * artefacts (BL-240), so the runner refuses to start instead of failing mysteriously later.
 *
 * Expected commit: `XIHE_E2E_EXPECT_CP_COMMIT` when the caller declares one, else HEAD.
 * A **missing stamp is a failure**, not a pass: an old CP without build-info would
 * otherwise slip through exactly the gate this plan adds.
 *
 * @param {{targetDir: string, expectedCommit?: string|null, headCommit?: string|null}} input
 * @returns {{ok: boolean, verdict: string, expectedCommit: string|null, runningCommit: string|null, message: string}}
 */
export function externalCpBuildCheck({ targetDir, expectedCommit, headCommit }) {
  const declared = typeof expectedCommit === 'string' ? expectedCommit.trim().toLowerCase() : '';
  const head = typeof headCommit === 'string' && headCommit.trim() ? headCommit.trim().toLowerCase() : '';
  const expected = declared || head || null;
  const { file, info } = readBuildInfo(targetDir);
  if (!expected) {
    return {
      ok: false,
      verdict: 'unverified',
      expectedCommit: null,
      runningCommit: info?.commit ?? null,
      message:
        'cannot determine the expected CP commit (no XIHE_E2E_EXPECT_CP_COMMIT and git HEAD is unknown)'
        + ` — build-info: ${file}`,
    };
  }
  if (!info) {
    return {
      ok: false,
      verdict: 'missing',
      expectedCommit: expected,
      runningCommit: null,
      message:
        `no CP build-info at ${file}; the running CP cannot prove it was built from ${shortSha(expected)}.`
        + ' Rebuild and restart CP first: `mise run dev:host:start:cp` (or `node scripts/stack-run.mjs cp`)',
    };
  }
  // BL-325: the E2E gate is a *verification* gate, so it must require fresh (clean tree), not just
  // a matching commit — a dirty build can contain uncommitted product code that is not the commit
  // under test. Dirty therefore fails with its own verdict/message.
  const commitMatch = sameCommit(expected, info.commit);
  const dirty = info.dirty === true;
  const ok = commitMatch && !dirty;
  return {
    ok,
    verdict: !commitMatch ? 'stale' : dirty ? 'dirty' : 'fresh',
    expectedCommit: expected,
    runningCommit: info.commit,
    message: ok
      ? `CP build commit ${shortSha(info.commit)} matches expected ${shortSha(expected)} (clean)`
      : dirty
        ? `CP build commit ${shortSha(info.commit)} matches expected ${shortSha(expected)} but the`
          + ' stamp says the tree was dirty at build time; the running CP may contain uncommitted code.'
          + ' Rebuild from a clean tree and restart CP first:'
          + ' `mise run dev:host:start:cp` (or `node scripts/stack-run.mjs cp`)'
          + ` — stamp: ${file}`
        : `CP build commit ${shortSha(info.commit)} does not match expected ${shortSha(expected)};`
          + ' the running CP was built from a different commit. Rebuild and restart CP first:'
          + ' `mise run dev:host:start:cp` (or `node scripts/stack-run.mjs cp`)'
          + ` — stamp: ${file}`,
  };
}

