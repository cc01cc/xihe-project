/**
 * BL-253 L3: per-stack / per-commit CP build directories.
 *
 * Why this module exists: PLAN-0662 can *detect* a stale CP build, but both stacks still compiled
 * into one directory (`C:/xihe-build/dev-host`, BL-253) — so "rebuild because this stack is stale"
 * overwrote the classes another stack was running. In practice lanes had already started working
 * around it by hand (`C:/xihe-build/bl240-cp` for stack-1, `C:/xihe-build/stack-2-6c31ef3e` for
 * stack-2, measured 2026-11-04). This module turns that workaround into a derivation:
 *
 * ```
 * <root>/<stackId>/<sha12>[-dirty]/        the CP Maven build directory (target dir)
 * <root>/<stackId>/.current                pointer: which dir this stack LAST STARTED with
 * ```
 *
 * Honesty note (same boundary as PLAN-0662): `.current` is a **launcher-written record of the last
 * start**, not an introspection of the running JVM. It makes `status`/E2E assertions follow the
 * stack's actual build dir instead of guessing from env, and nothing more.
 *
 * Escape hatch (never weakened): an explicit `XIHE_CP_TARGET_DIR` wins over everything — that is
 * the rollback channel for a lane that needs a one-off build location.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { shortSha } from './cp-build-info.mjs';

/** `<root>` when nothing overrides it: fast local volume, outside the checkout (H: is slow). */
export const DEFAULT_CP_BUILD_ROOT_WIN = 'C:/xihe-build/cp';
export const DEFAULT_CP_BUILD_ROOT_POSIX_NAME = 'xihe-cp-build';

/** Stack id → build dir mapping lives one level below the root; the pointer sits beside it. */
export const POINTER_FILE = '.current';

/** Dirty working trees cannot be identified by commit alone: one rebuild-in-place slot per stack. */
export const DIRTY_SUFFIX = '-dirty';

/** Retention default (per stack): keep the newest N commit dirs + the pointer target. */
export const DEFAULT_KEEP = 3;

/** Only these names are candidates for retention; nothing else under the stack dir is touched. */
const SLOT_PATTERN = /^[0-9a-f]{12}(-dirty)?$/iu;
const STACK_PATTERN = /^stack-\d+$/u;

function normalizePathForCompare(path) {
    return resolve(String(path)).replace(/\\/gu, '/').toLowerCase();
}

function trimmed(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Root that holds every stack's build dirs.
 *
 * @param {{env?: Record<string, string|undefined>, platform?: string}} [input]
 * @returns {string} absolute root
 */
export function cpBuildRoot({ env = process.env, platform = process.platform } = {}) {
    const override = trimmed(env.XIHE_CP_BUILD_ROOT);
    if (override) return resolve(override);
    return platform === 'win32'
        ? resolve(DEFAULT_CP_BUILD_ROOT_WIN)
        : join(tmpdir(), DEFAULT_CP_BUILD_ROOT_POSIX_NAME);
}

/**
 * Directory name for one build: `<sha12>` for a clean tree, `<sha12>-dirty` for a dirty one.
 *
 * @param {{commit?: string|null, dirty?: boolean}} input
 * @returns {string|null} null when the commit is unknown (caller then keeps the legacy layout)
 */
export function cpBuildSlot({ commit, dirty = false } = {}) {
    const sha = shortSha(trimmed(commit)).toLowerCase();
    // A slot must look like `SLOT_PATTERN`: a stamped dir that retention cannot recognise would
    // become an orphan, so anything shorter than an abbreviated sha (7) is "unknown".
    if (sha.length < 7) return null;
    return `${sha}${dirty ? DIRTY_SUFFIX : ''}`;
}

/**
 * Where this stack builds. Priority (contract):
 * 1. explicit `XIHE_CP_TARGET_DIR` — escape hatch / rollback, used verbatim;
 * 2. `<root>/<stackId>/<sha12>[-dirty]` — the per-stack isolation L3 adds;
 * 3. unresolved (no HEAD) — caller keeps the historical in-checkout `target/` and warns.
 *
 * @param {{
 *   stackId: string,
 *   env?: Record<string, string|undefined>,
 *   commit?: string|null,
 *   dirty?: boolean,
 *   platform?: string,
 * }} input
 * @returns {{targetDir: string|null, source: 'env'|'derived'|'unresolved', root: string|null, slot: string|null, reason?: string}}
 */
export function resolveCpTargetDir({ stackId, env = process.env, commit, dirty = false, platform }) {
    const override = trimmed(env.XIHE_CP_TARGET_DIR);
    const root = cpBuildRoot({ env, platform });
    if (override) {
        return { targetDir: resolve(override), source: 'env', root, slot: null, reason: 'XIHE_CP_TARGET_DIR override' };
    }
    const slot = cpBuildSlot({ commit, dirty });
    if (!slot) {
        return {
            targetDir: null,
            source: 'unresolved',
            root,
            slot: null,
            reason: 'cannot derive a build slot without a HEAD commit (not a git checkout?)',
        };
    }
    return { targetDir: join(root, stackId, slot), source: 'derived', root, slot };
}

/** @param {{root: string, stackId: string}} input */
export function pointerPath({ root, stackId }) {
    return join(root, stackId, POINTER_FILE);
}

/**
 * Read the last-start record. Missing/corrupt ⇒ null (status then falls back to "newest dir").
 *
 * @param {{root: string, stackId: string}} input
 * @param {(file: string, encoding: 'utf8') => string} [read]
 * @returns {{stackId?: string, targetDir: string, commit?: string|null, dirty?: boolean|null, verdict?: string, builtAt?: string|null, startedAt?: string, source?: string}|null}
 */
export function readPointer({ root, stackId }, read = readFileSync) {
    const file = pointerPath({ root, stackId });
    try {
        const parsed = JSON.parse(read(file, 'utf8'));
        return parsed && typeof parsed.targetDir === 'string' && parsed.targetDir ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Record which build dir this stack is being started with (called by the launcher right before
 * `mvn`). Written even for an `XIHE_CP_TARGET_DIR` override so status never has to guess.
 *
 * @param {{root: string, stackId: string, pointer: Record<string, unknown>}} input
 * @returns {string} the pointer file path
 */
export function writePointer({ root, stackId, pointer }) {
    const file = pointerPath({ root, stackId });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ stackId, ...pointer }, null, 2)}\n`, 'utf8');
    return file;
}

/** @param {string} candidate @param {string} target */
export function sameTargetDir(candidate, target) {
    if (!trimmed(candidate) || !trimmed(target)) return false;
    return normalizePathForCompare(candidate) === normalizePathForCompare(target);
}

/**
 * Enumerate this stack's build dirs (newest first by mtime).
 *
 * @param {{root: string, stackId: string}} input
 * @param {{readdir?: typeof readdirSync, stat?: typeof statSync}} [io]
 * @returns {Array<{name: string, path: string, mtimeMs: number}>}
 */
export function scanStackBuilds({ root, stackId }, io = {}) {
    const readdir = io.readdir ?? readdirSync;
    const stat = io.stat ?? statSync;
    const dir = join(root, stackId);
    let names;
    try {
        names = readdir(dir);
    } catch {
        return [];
    }
    const entries = [];
    for (const name of names) {
        if (!SLOT_PATTERN.test(name)) continue;
        const path = join(dir, name);
        try {
            if (!stat(path).isDirectory()) continue;
            entries.push({ name, path, mtimeMs: stat(path).mtimeMs });
        } catch {
            // A dir deleted mid-scan is not a retention decision.
        }
    }
    return entries.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

/**
 * Retention decision, as a pure function.
 *
 * Rules (BL-253 L3 §2): keep the newest `keep` slot dirs **plus** the pointer target; everything
 * older is a prune candidate. Names outside the slot pattern are never returned — legacy roots
 * (`dev-host`, `bl240-cp`, `stack-2-<sha>`, E2E `e2e/`, rust targets) are not under this root.
 *
 * @param {{entries?: Array<{name: string, path?: string, mtimeMs?: number}>, keep?: number, keepPath?: string|null}} input
 * @returns {{kept: string[], pruned: string[], prunedPaths: string[]}}
 */
export function selectPrunable({ entries = [], keep = DEFAULT_KEEP, keepPath = null } = {}) {
    const keepCount = Number.isInteger(keep) && keep >= 0 ? keep : DEFAULT_KEEP;
    const pinned = trimmed(keepPath) ? normalizePathForCompare(keepPath) : null;
    const candidates = entries
        .filter((entry) => entry && typeof entry.name === 'string' && SLOT_PATTERN.test(entry.name))
        .filter((entry) => !pinned || !entry.path || normalizePathForCompare(entry.path) !== pinned)
        .sort((left, right) => (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0));
    const kept = candidates.slice(0, keepCount);
    const pruned = candidates.slice(keepCount);
    return {
        kept: kept.map((entry) => entry.name),
        pruned: pruned.map((entry) => entry.name),
        prunedPaths: pruned.map((entry) => entry.path ?? entry.name),
    };
}

/**
 * Every stack dir under the root that has build slots (used by the clean task's `--all`).
 *
 * @param {{root: string}} input
 * @param {{readdir?: typeof readdirSync}} [io]
 * @returns {string[]}
 */
export function listStacksUnderRoot({ root }, io = {}) {
    const readdir = io.readdir ?? readdirSync;
    let names;
    try {
        names = readdir(root);
    } catch {
        return [];
    }
    return names.filter((name) => STACK_PATTERN.test(name)).sort();
}

/**
 * Which build dir a stack's CP is using — for **read-only** consumers (`dev:host:status`, the
 * external-E2E assertion). Resolution order:
 *
 * 1. `.current` — the launcher's record of this stack's **last start** → `source: 'pointer'`
 * 2. newest `<sha12>[-dirty]` dir on disk → `source: 'newest'` (first start after L3, or a stack
 *    whose pointer was removed)
 * 3. computed target: explicit `XIHE_CP_TARGET_DIR` → `source: 'env'`, else derived from HEAD →
 *    `source: 'derived'` (nothing built yet; the freshness row then reads `missing`)
 *
 * Still **not** JVM introspection: pointer and newest are records on disk. If a CP was hand-started
 * with its own `XIHE_CP_TARGET_DIR`, `status` shows the pointer and the operator compares — that
 * is the documented limit of this mechanism.
 *
 * @param {{
 *   root: string,
 *   stackId: string,
 *   env?: Record<string, string|undefined>,
 *   commit?: string|null,
 *   dirty?: boolean,
 *   platform?: string,
 * }} input
 * @returns {{targetDir: string|null, source: 'pointer'|'newest'|'env'|'derived', root: string, pointer: Record<string, unknown>|null}}
 */
export function resolveBuildTargetForStack({
    root,
    stackId,
    env = process.env,
    commit,
    dirty = false,
}) {
    const pointer = readPointer({ root, stackId });
    if (pointer && typeof pointer.targetDir === 'string' && pointer.targetDir) {
        return { targetDir: pointer.targetDir, source: 'pointer', root, pointer };
    }
    const entries = scanStackBuilds({ root, stackId });
    if (entries.length > 0) {
        return { targetDir: entries[0].path, source: 'newest', root, pointer: null };
    }
    // Nothing on disk: report what a start *would* use. Keep the caller's `root` (a status call
    // may be pointed at another root for verification), only the explicit env escapes it.
    const override = trimmed(env.XIHE_CP_TARGET_DIR);
    if (override) {
        return { targetDir: resolve(override), source: 'env', root, pointer: null };
    }
    const slot = cpBuildSlot({ commit, dirty });
    return {
        targetDir: slot ? join(root, stackId, slot) : null,
        source: 'derived',
        root,
        pointer: null,
    };
}
