/**
 * PLAN-0650 B-2: which CP artifact should host E2E boot, decided by a pure function.
 *
 * Why this module exists: `resolveCpBootPlan()` in `e2e-host.mjs` already had the right
 * *ingredients* — `--jar-mode`, a source-vs-jar freshness comparison and a rebuild branch — but
 * one case was wrong in a way that cost real time. With `--jar-mode=auto` (the default) and no
 * jar in `target/`, it returned `run` (`mvn spring-boot:run`), and `run` never produces a jar, so
 * the next round went down the same path: **every** run paid the 1.5–2 min compile (BL-205 ②,
 * measured 2026-11-03: eight rounds = 12–16 min of pure recompilation).
 *
 * The fix is one decision, so it lives here and is unit-tested: missing jar under `auto` means
 * **build once, then reuse** (`build-then-use`) instead of `run`. The runner still performs the
 * build, still falls back to `spring-boot:run` when the build fails, and still refuses to boot a
 * silently stale jar.
 *
 * Action vocabulary (the runner maps them to boot commands):
 * - `native`          boot the native executable (existence/staleness checks stay in the runner)
 * - `run`             `mvn spring-boot:run` (no jar involved)
 * - `use`             boot the existing jar as-is
 * - `build-then-use`  run `mvn -q -DskipTests package`, then boot the produced jar
 */

/** The `--jar-mode` values the runner accepts (its flag parser rejects anything else first). */
export const JAR_MODES = Object.freeze(['auto', 'use', 'rebuild', 'run', 'native']);

/**
 * @param {object} state
 * @param {string} [state.jarMode] `auto` (default) | `use` | `rebuild` | `run` | `native`
 * @param {boolean} [state.hasJar] whether `packages/control-plane/target/` holds a bootable jar
 * @param {boolean} [state.stale]  whether a source file is newer than that jar
 * @returns {{action: 'native'|'run'|'use'|'build-then-use', reason: string, stale: boolean}}
 */
export function decideCpBoot({ jarMode = 'auto', hasJar = false, stale = false } = {}) {
    if (!JAR_MODES.includes(jarMode)) {
        throw new TypeError(
            `decideCpBoot: unknown jarMode ${JSON.stringify(jarMode)} (expected one of ${JAR_MODES.join('|')})`,
        );
    }
    if (jarMode === 'native') {
        return { action: 'native', reason: 'forced native executable', stale };
    }
    if (jarMode === 'run') {
        return { action: 'run', reason: '--jar-mode=run', stale };
    }
    if (jarMode === 'use') {
        // Forced use, but there is nothing to use: keep today's fallback to `spring-boot:run`.
        if (!hasJar) {
            return { action: 'run', reason: 'no CP jar in target/ (--jar-mode=use)', stale };
        }
        return {
            action: 'use',
            reason: stale ? 'stale, forced by --jar-mode=use' : 'fresh (forced use)',
            stale,
        };
    }
    if (jarMode === 'rebuild') {
        return { action: 'build-then-use', reason: '--jar-mode=rebuild', stale };
    }
    // auto: the only mode whose default behaviour changes in PLAN-0650.
    if (!hasJar) {
        return {
            action: 'build-then-use',
            reason: 'no CP jar in target/ (build once, then reuse)',
            stale,
        };
    }
    if (stale) {
        return { action: 'build-then-use', reason: 'stale vs sources', stale };
    }
    return { action: 'use', reason: 'fresh', stale };
}
