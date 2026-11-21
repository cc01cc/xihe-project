/**
 * task-180: write the CP jar's **two identities as one pair**.
 *
 * The jar carries two independent marks:
 * - `classes/META-INF/build-info.properties` (PLAN-0662) — the commit the classes claim to be from;
 * - `<jar>.buildinfo.json` (BL-477 / task-90) — sha256 of the jar's own bytes + the CP source tree.
 *
 * e2e-host has two places that produce a jar: the `build-then-use` branch of `resolveCpBootPlan()`
 * and the preflight self-heal branch (task-237 pan 7). Both used to be hand-written; the self-heal
 * branch refreshed only the in-jar stamp, so the next preflight compared the **new** jar against the
 * **old** sidecar and reported `artifact-truth` (non-deferrable identity mismatch) on every run —
 * one build behind, forever (task-141 run1: exit 1, Playwright never started).
 *
 * The fix is not "also write the sidecar in that branch" (a third copy of the order would drift the
 * same way). It is this module: one call that stamps and fingerprints, with the ordering pinned in
 * one place — the stamp first (it is the cheaper, in-jar read), the sidecar second and only after the
 * jar exists. **This ordering is not a safety property on its own** (task-703): it only means the
 * fingerprint is computed over bytes that are already on disk. Whether those bytes came from *this*
 * build is a separate question, answered by `verifyJarRepackaged()` in `cp-jar-sidecar.mjs`, which
 * both producers must call before stamping.
 *
 * Both producers in `scripts/e2e-host.mjs` call this and nothing else: `e2e-host-readiness.test.mjs`
 * asserts there are no direct `writeBuildInfo` / `writeSidecarForJar` call sites left, so a future
 * branch cannot write half a pair.
 */
import { spawnSync } from 'node:child_process'

import { gitHead, writeBuildInfo } from './cp-build-info.mjs'
import { writeSidecarForJar } from './cp-jar-sidecar.mjs'

/**
 * Stamp `build-info.properties` and fingerprint the jar that was just produced.
 *
 * @param {{
 *   projectDir: string,
 *   targetDir: string,
 *   jarPath: string,
 *   writtenBy: string,
 *   run?: typeof spawnSync,
 *   now?: () => number,
 *   maxWriteLagMs?: number,
 *   readFile?: (file: string, encoding: 'utf8') => string | Buffer,
 *   stat?: (file: string) => { mtimeMs: number },
 * }} input
 * @returns {{
 *   head: ReturnType<typeof gitHead>,
 *   buildInfo: {ok: boolean, file: string|null, commit: string|null, dirty: boolean|null, error: string|null},
 *   sidecar: {ok: boolean, file: string, data: object|null, error: string|null, clockSkewMs?: number},
 *   paired: boolean,
 * }}
 */
export function stampCpArtifact({ projectDir, targetDir, jarPath, writtenBy, run = spawnSync, ...sidecarDeps }) {
  const head = gitHead({ cwd: projectDir, run })
  const buildInfo = head.commit
    ? {
        ok: true,
        file: writeBuildInfo({ targetDir, commit: head.commit, dirty: head.dirty }),
        commit: head.commit,
        dirty: head.dirty,
        error: null,
      }
    : { ok: false, file: null, commit: null, dirty: null, error: `git HEAD is unavailable (${head.error})` }
  // The sidecar is written **after** the stamp and only after the jar exists (this function is only
  // ever called post-packaging). This ordering is NOT a forge-proof: `buildSidecar` only bounds how
  // far the jar's mtime may lag (and, since task-703, run ahead by `DEFAULT_MAX_FUTURE_MTIME_MS`), so
  // a manifest can still be stamped onto bytes that were never rebuilt whenever the *build tool*
  // skipped packaging — which `maven-jar-plugin` does silently when the jar is newer than the classes.
  // That is exactly what happened in task-42 Run A. The content-level defence lives in
  // `verifyJarRepackaged()` (in `cp-jar-sidecar.mjs`, the module that owns the jar's byte identity),
  // and both producers in `scripts/e2e-host.mjs` must call it.
  const sidecar = writeSidecarForJar({ projectDir, jarPath, writtenBy, run, ...sidecarDeps })
  return { head, buildInfo, sidecar, paired: buildInfo.ok && sidecar.ok === true }
}

/**
 * One-line-per-identity log for the runner. A failed sidecar write stays a WARN (the run still has
 * the task-84 content evidence and must not be aborted from here); a failed stamp is a WARN too —
 * what must never happen silently is *half* a pair being treated as complete.
 *
 * @param {{buildInfo: object, sidecar: object, label: string}} input
 * @returns {string[]} the lines (also printed by the caller, so tests can assert their text)
 */
export function describeStamp({ buildInfo, sidecar, label }) {
  const lines = []
  if (buildInfo.ok) {
    lines.push(`[e2e-host] ${label}: CP build-info stamped for ${String(buildInfo.commit).slice(0, 12)} (dirty=${buildInfo.dirty})`)
  } else {
    lines.push(`[e2e-host] WARN: ${label}: CP jar rebuilt but its build-info was NOT stamped (${buildInfo.error}); freshness cannot be proven`)
  }
  if (sidecar.ok) {
    const data = sidecar.data
    lines.push(
      `[e2e-host] ${label}: CP jar sidecar written: ${sidecar.file} (jar sha256 ${String(data.jarSha256).slice(0, 12)}…,`
        + ` CP tree ${String(data.sourceTreeSha256).slice(0, 12)}…, commit ${String(data.commit).slice(0, 12)}, dirty=${data.dirty})`,
    )
    if (sidecar.clockSkewMs > 0) {
      // task-703: `builtAt` is no longer clamped upward, so this must not claim a clamp. The skew is
      // reported as what it is — the jar's mtime is ahead of the writer's clock, inside tolerance.
      lines.push(
        `[e2e-host] WARN: ${label}: the jar mtime is ${sidecar.clockSkewMs} ms ahead of the clock that wrote the sidecar`
          + ' (inside the future-mtime tolerance; `builtAt` is the writer clock, not the jar mtime)',
      )
    }
  } else {
    lines.push(
      `[e2e-host] WARN: ${label}: CP jar rebuilt but its sidecar was NOT written (${sidecar.error});`
        + ' the next preflight will read the OLD sidecar and judge artifact-truth (identity mismatch)',
    )
  }
  return lines
}
