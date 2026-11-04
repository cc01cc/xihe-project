#!/usr/bin/env node
/**
 * BL-253 L3: per-stack CP build retention (`mise run dev:host:cp-build:clean`).
 *
 * Retention is **explicit only** — the start path never prunes (a build dir that a running stack
 * is still serving from must not vanish because someone restarted a sibling). Default is a
 * dry-run list; `--apply` removes the listed directories, one by one, and skips anything that
 * cannot be removed (locked file, no permission) with a warning instead of aborting.
 *
 * Rules (see `lib/cp-build-dir.mjs` §selectPrunable):
 * - only `<root>/<stack-N>/<sha12>[-dirty]` directories are candidates;
 * - keep the newest `--keep N` (default 3) **plus** the stack's `.current` pointer target;
 * - directories modified in the last 2 minutes are skipped (a build may be writing).
 *
 * Usage:
 *   node scripts/cp-build-clean.mjs [--stack N | --all] [--keep N] [--apply] [--json]
 *   (dry-run is the default; `--apply` performs the removals)
 */
import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_KEEP,
  cpBuildRoot,
  listStacksUnderRoot,
  readPointer,
  scanStackBuilds,
  selectPrunable,
} from './lib/cp-build-dir.mjs';

/** A dir touched this recently may be under an active `mvn` write. */
const RECENT_WRITE_MS = 2 * 60 * 1000;

function usage(exitCode = 2) {
  console.log('usage: node scripts/cp-build-clean.mjs [--stack N | --all] [--keep N] [--apply] [--json]');
  console.log('  --stack N    only this stack (default: --all)');
  console.log('  --all        every stack dir under the CP build root');
  console.log('  --keep N     keep the newest N build dirs per stack (default 3; pointer target always kept)');
  console.log('  --apply      actually remove; without it this is a dry-run');
  console.log('  --json       machine-readable plan/result');
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { stack: null, all: false, keep: DEFAULT_KEEP, apply: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') usage(0);
    else if (arg === '--all') args.all = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--stack') args.stack = argv[(index += 1)];
    else if (arg.startsWith('--stack=')) args.stack = arg.slice('--stack='.length);
    else if (arg === '--keep') args.keep = Number(argv[(index += 1)]);
    else if (arg.startsWith('--keep=')) args.keep = Number(arg.slice('--keep='.length));
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (!Number.isInteger(args.keep) || args.keep < 0) throw new Error('--keep must be a non-negative integer');
  if (args.stack && args.all) throw new Error('--stack and --all are mutually exclusive');
  if (!args.stack) args.all = true;
  return args;
}

function planForStack(root, stackId, keep) {
  const pointer = readPointer({ root, stackId });
  const keepPath = pointer?.targetDir ?? null;
  const entries = scanStackBuilds({ root, stackId });
  const selection = selectPrunable({ entries, keep, keepPath });
  return {
    stackId,
    dir: join(root, stackId),
    pointer: pointer ? { targetDir: pointer.targetDir, commit: pointer.commit ?? null, startedAt: pointer.startedAt ?? null } : null,
    kept: selection.kept,
    pruned: selection.pruned,
    prunedPaths: selection.prunedPaths,
    pointerTarget: keepPath,
  };
}

function isRecent(path) {
  try {
    return Date.now() - statSync(path).mtimeMs < RECENT_WRITE_MS;
  } catch {
    return false;
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[cp-build-clean] ERROR: ${error.message}`);
    process.exit(2);
  }

  const root = cpBuildRoot({ env: process.env });
  const stacks = args.all ? listStacksUnderRoot({ root }) : [args.stack];
  const plans = stacks.map((stackId) => planForStack(root, stackId, args.keep));
  const removals = [];
  const skipped = [];
  for (const plan of plans) {
    for (const path of plan.prunedPaths) {
      if (isRecent(path)) {
        skipped.push({ stackId: plan.stackId, path, reason: 'modified in the last 2 minutes (build in progress?)' });
        continue;
      }
      removals.push({ stackId: plan.stackId, path });
    }
  }

  if (args.apply) {
    for (const item of removals) {
      try {
        rmSync(item.path, { recursive: true, force: false });
        item.removed = true;
      } catch (error) {
        item.removed = false;
        item.error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          action: 'cp-build-clean',
          root,
          keep: args.keep,
          apply: args.apply,
          plans,
          removals,
          skipped,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`[cp-build-clean] root=${root} keep=${args.keep} mode=${args.apply ? 'APPLY' : 'dry-run'}`);
  for (const plan of plans) {
    const pointer = plan.pointer ? `pointer=${plan.pointer.targetDir}` : 'pointer=(none)';
    console.log(`  ${plan.stackId}: dirs=${plan.kept.length + plan.pruned.length} keep=${plan.kept.length} prune=${plan.pruned.length} ${pointer}`);
    for (const name of plan.kept) console.log(`    keep   ${name}`);
    for (const name of plan.pruned) console.log(`    prune  ${name}${isRecent(join(plan.dir, name)) ? '  (recent — will be skipped)' : ''}`);
  }
  if (removals.length === 0 && skipped.length === 0) {
    console.log('[cp-build-clean] nothing to prune');
    return;
  }
  if (!args.apply) {
    console.log('[cp-build-clean] dry-run: nothing deleted; re-run with --apply to remove the listed dirs');
    return;
  }
  for (const item of removals) {
    console.log(`  ${item.removed ? 'removed' : 'FAILED '} ${item.path}${item.error ? ` (${item.error})` : ''}`);
  }
  for (const item of skipped) console.log(`  skipped ${item.path} (${item.reason})`);
  const failed = removals.filter((item) => !item.removed).length;
  if (failed > 0) process.exitCode = 1;
}

main();
