#!/usr/bin/env node
/**
 * Migration-immutability gate — turns "a published migration is read-only, byte for byte"
 * from prose into a check.
 *
 * WHY
 *   `packages/control-plane/AGENTS.md:124` says it plainly: once a migration is merged into
 *   `develop` it must not change by a single byte — not a comment, not formatting, not the
 *   file name. Flyway hashes the whole file, comments included, so an already-migrated
 *   database fails at startup with `Migration checksum mismatch` and Flyway stops before that
 *   version. The cost is not one red test, it is every migrated database refusing to start.
 *   The rule existed only in prose; `check-migration-numbers.mjs` checks duplicates, registry
 *   parity and unregistered numbers, never "a merged migration was edited".
 *
 * WHAT "PUBLISHED" MEANS (authority, not heuristics)
 *   The published set is exactly the `** /db/migration/V*.sql` files present in the tree of
 *   `git merge-base <base> HEAD` (base defaults to `develop`). Never mtime, never author,
 *   never "the filename looked older". A number that only exists in HEAD after the merge-base
 *   is NOT published and may still be edited — that is the normal in-flight case.
 *
 * WHAT COUNTS AS A CHANGE
 *   1. `git diff --name-status -M <merge-base>` over the working tree (staged + unstaged, and
 *      committed-on-branch) restricted to the published paths:
 *        M/T  content change (comment/whitespace included)  => E_PUBLISHED_MIGRATION_MODIFIED
 *        D    deletion                                      => E_PUBLISHED_MIGRATION_DELETED
 *        R    rename (old path is published)                => E_PUBLISHED_MIGRATION_RENAMED
 *      `A` (added) and `C` (copy) cannot modify a published file and are ignored.
 *   2. A raw-byte blob-hash comparison per published path, independent of git's diff: the
 *      repository is `core.autocrlf=false` / `core.eol=lf` with no `*.sql` filter, so raw
 *      bytes and the stored blob must be identical. This catches a byte that a filter or a
 *      future diff option would hide => E_PUBLISHED_MIGRATION_BYTE_DRIFT.
 *
 * EXIT CODES
 *   0  clean, or findings downgraded by `--report-only`, or all findings allow-listed
 *   1  at least one published migration changed (each finding names `V<number>` + file)
 *   2  the script could not answer: git unavailable, not a git repo, merge-base/base ref
 *      unresolvable, bad arguments, or a malformed `--allow-published-edit` pair.
 *      "Could not check" is NOT "clean" — this gate never turns a broken environment green.
 *
 * ESCAPE HATCH (deliberate, loggable, never an env var)
 *   `--allow-published-edit <V号> --reason <text>`  (repeatable; the two flags must be
 *   adjacent and in that order). A matching finding is printed as WARN with the reason and
 *   does not block. There is no environment variable that switches this gate off: turning off
 *   a gate must leave a trace in the command line and in the output.
 *
 * USAGE
 *   node scripts/check-migration-immutability.mjs
 *   node scripts/check-migration-immutability.mjs --json
 *   node scripts/check-migration-immutability.mjs --repo <path> --base <ref>
 *   node scripts/check-migration-immutability.mjs --report-only
 *   node scripts/check-migration-immutability.mjs --selftest
 *
 * WIRING: not wired into mise/validate/xh-commit on purpose (task-134 = prove the judgement
 * fires before hanging it on the pipeline). Wiring is a separate ruling.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO = resolve(HERE, '..');
export const DEFAULT_BASE = 'develop';

/** `packages/<pkg>/src/main/resources/db/migration/V<n>__<slug>.sql` (any `** /db/migration/`). */
const MIGRATION_PATH = /(?:^|\/)db\/migration\/V(\d+)__[^/]*\.sql$/;

export const CODES = Object.freeze({
  MODIFIED: 'E_PUBLISHED_MIGRATION_MODIFIED',
  DELETED: 'E_PUBLISHED_MIGRATION_DELETED',
  RENAMED: 'E_PUBLISHED_MIGRATION_RENAMED',
  BYTE_DRIFT: 'E_PUBLISHED_MIGRATION_BYTE_DRIFT',
});

export const EXIT = Object.freeze({ OK: 0, FOUND: 1, USAGE: 2 });

export class UsageError extends Error {}

/** Run git; `{ ok, stdout, stderr }`. Never throws for a non-zero exit or a missing binary. */
function gitMaybe(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    return { ok: false, stdout: '', stderr: 'git 无法执行: ' + result.error.message };
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: (result.stderr ?? '').trim(),
  };
}

function gitOrThrow(repo, args) {
  const result = gitMaybe(repo, args);
  if (!result.ok) {
    throw new UsageError('git ' + args.join(' ') + ' 失败 (exit ' + result.status + '): ' + result.stderr);
  }
  return result.stdout;
}

/** Git's blob object id for raw bytes (sha1 of `blob <len>\0<payload>`). */
export function blobOid(buffer) {
  return createHash('sha1')
    .update('blob ' + buffer.length + '\0')
    .update(buffer)
    .digest('hex');
}

export function isMigrationPath(path) {
  return MIGRATION_PATH.test(path);
}

export function parseMigrationPath(path) {
  const match = MIGRATION_PATH.exec(path);
  return match ? Number.parseInt(match[1], 10) : null;
}

/** `V162` / `v162` / `162` -> 162; anything else is a usage error. */
export function parseVersionArg(value) {
  const match = /^[Vv]?(\d+)$/.exec(String(value ?? '').trim());
  if (!match) throw new UsageError('--allow-published-edit 需要迁移号（V162 或 162），收到: ' + value);
  return Number.parseInt(match[1], 10);
}

export function resolveRepo(repo) {
  const result = gitMaybe(repo, ['rev-parse', '--show-toplevel']);
  if (!result.ok || !result.stdout.trim()) {
    throw new UsageError(
      '不是可用的 git 仓库: ' + repo + '（' + (result.stderr || 'rev-parse 无输出') + '）',
    );
  }
  return result.stdout.trim();
}

/**
 * Published set: path -> { version, blob } for every migration in the merge-base tree.
 * Fails hard (UsageError => exit 2) when merge-base is unavailable.
 */
export function publishedMigrations(top, base) {
  const mergeBaseResult = gitMaybe(top, ['merge-base', base, 'HEAD']);
  if (!mergeBaseResult.ok || !mergeBaseResult.stdout.trim()) {
    throw new UsageError(
      '取不到 merge-base ' +
        base +
        ' HEAD（' +
        (mergeBaseResult.stderr || '空输出') +
        '）：已发布集合无法确定，判不了 ≠ 通过',
    );
  }
  const mergeBase = mergeBaseResult.stdout.trim();
  const listing = gitOrThrow(top, ['ls-tree', '-r', '-z', mergeBase]);
  const published = new Map();
  for (const record of listing.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (meta[1] !== 'blob') continue;
    if (!isMigrationPath(path)) continue;
    published.set(path, { version: parseMigrationPath(path), blob: meta[2] });
  }
  return { mergeBase, published };
}

/**
 * Pure judgement over one repo. Returns findings (violations + allow-listed warnings), the
 * published count and the merge-base, so callers/tests can assert on the reading, not only
 * on the exit code.
 */
export function evaluate({ repo = DEFAULT_REPO, base = DEFAULT_BASE, allows = [] } = {}) {
  const top = resolveRepo(repo);
  const { mergeBase, published } = publishedMigrations(top, base);

  /** path -> finding, so the diff pass and the byte pass cannot double-report one file. */
  const byPath = new Map();
  const record = (path, code, detail) => {
    if (byPath.has(path)) return;
    byPath.set(path, { code, path, version: parseMigrationPath(path), detail });
  };

  const diff = gitMaybe(top, [
    '-c',
    'core.quotepath=false',
    'diff',
    '--name-status',
    '-M',
    '--no-color',
    '--no-ext-diff',
    mergeBase,
  ]);
  if (!diff.ok) {
    throw new UsageError('git diff ' + mergeBase + ' 失败: ' + diff.stderr);
  }
  for (const line of diff.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split('\t');
    const status = fields[0][0];
    if (status === 'M' || status === 'T') {
      const path = fields[1];
      if (published.has(path)) record(path, CODES.MODIFIED, '内容被改动（含注释/格式）');
    } else if (status === 'D') {
      const path = fields[1];
      if (published.has(path)) record(path, CODES.DELETED, '已发布文件被删除');
    } else if (status === 'R') {
      const oldPath = fields[1];
      const newPath = fields[2];
      if (published.has(oldPath)) {
        record(oldPath, CODES.RENAMED, '已发布文件被改名 -> ' + newPath);
      }
    }
    // A (added) and C (copy) cannot mutate a published file.
  }

  // Independent byte-exact pass: no diff option or filter can hide a single byte here.
  for (const [path, info] of published) {
    if (byPath.has(path)) continue;
    const absolute = join(top, path);
    if (!existsSync(absolute)) {
      record(path, CODES.DELETED, '工作树中不存在（已删除/已改名）');
      continue;
    }
    const oid = blobOid(readFileSync(absolute));
    if (oid !== info.blob) {
      record(path, CODES.BYTE_DRIFT, '原始字节与已发布 blob 不一致（' + oid.slice(0, 12) + ' != ' + info.blob.slice(0, 12) + '）');
    }
  }

  const allowByVersion = new Map(allows.map((item) => [item.version, item.reason]));
  const violations = [];
  const warned = [];
  for (const finding of byPath.values()) {
    const reason = allowByVersion.get(finding.version);
    if (reason) warned.push({ ...finding, reason });
    else violations.push(finding);
  }
  violations.sort((a, b) => a.path.localeCompare(b.path));
  warned.sort((a, b) => a.path.localeCompare(b.path));

  return {
    top,
    base,
    mergeBase,
    publishedCount: published.size,
    violations,
    warned,
  };
}

// ---------------------------------------------------------------------------------------------
// Argument parsing. Unknown flags are a usage error, never silently ignored: a typo in an
// off-switch must not look like a clean run (same failure family as task-128/BL-477).
// ---------------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = {
    repo: DEFAULT_REPO,
    base: DEFAULT_BASE,
    json: false,
    reportOnly: false,
    selftest: false,
    allows: [],
  };
  const valueOf = (index, flag) => {
    const value = argv[index];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(flag + ' 需要取值');
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--selftest') options.selftest = true;
    else if (flag === '--json') options.json = true;
    else if (flag === '--report-only') options.reportOnly = true;
    else if (flag === '--repo') options.repo = valueOf(++i, flag);
    else if (flag === '--base') options.base = valueOf(++i, flag);
    else if (flag === '--allow-published-edit') {
      const version = parseVersionArg(valueOf(++i, flag));
      if (argv[i + 1] !== '--reason') {
        throw new UsageError('--allow-published-edit 必须紧跟 --reason <text>（成对必填，禁止只写一半）');
      }
      const reason = valueOf(i + 2, '--reason');
      if (!reason.trim()) throw new UsageError('--reason 需要非空文本');
      i += 2;
      options.allows.push({ version, reason });
    } else if (flag === '--reason') {
      throw new UsageError('--reason 只能作为 --allow-published-edit 的成对参数出现');
    } else if (flag === '--help' || flag === '-h') {
      options.help = true;
    } else {
      throw new UsageError('未知参数: ' + flag);
    }
  }
  return options;
}

const USAGE = [
  '用法: node scripts/check-migration-immutability.mjs [选项]',
  '  --repo <path>            仓库根（默认本脚本的上级目录）',
  '  --base <ref>             已发布基线分支（默认 develop）',
  '  --json                   机读输出',
  '  --report-only            命中只报告、仍 exit 0（默认命中 exit 1）',
  '  --allow-published-edit <V号> --reason <text>   成对必填，打 WARN 不阻断',
  '  --selftest               跑内置夹具（含 exit 2 夹具）',
].join('\n');

function printHuman(result, options) {
  console.log(
    '[migration-immutability] published=' +
      result.publishedCount +
      ' base=' +
      result.base +
      ' mergeBase=' +
      result.mergeBase.slice(0, 12),
  );
  for (const finding of result.warned) {
    console.log(
      '[migration-immutability] WARN allow-published-edit V' +
        finding.version +
        ' reason=' +
        finding.reason +
        ' ' +
        finding.path +
        ' (' +
        finding.code +
        ': ' +
        finding.detail +
        ')',
    );
  }
  for (const finding of result.violations) {
    console.log(
      '[migration-immutability] ' +
        finding.code +
        ' V' +
        finding.version +
        ' ' +
        finding.path +
        ' — ' +
        finding.detail,
    );
  }
  if (result.violations.length === 0) {
    console.log(
      '[migration-immutability] OK 已发布迁移未改动' +
        (result.warned.length ? '（' + result.warned.length + ' 条已按逃生口放行）' : ''),
    );
  } else if (options.reportOnly) {
    console.log(
      '[migration-immutability] REPORT-ONLY 命中 ' +
        result.violations.length +
        ' 条（本次不阻断；去掉 --report-only 即 exit 1）',
    );
  } else {
    console.log(
      '[migration-immutability] FAIL 命中 ' + result.violations.length + ' 条已发布迁移改动',
    );
  }
}

export function run(options) {
  try {
    const result = evaluate(options);
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ok: result.violations.length === 0,
            reportOnly: options.reportOnly,
            base: result.base,
            mergeBase: result.mergeBase,
            published: result.publishedCount,
            violations: result.violations,
            allowed: result.warned,
          },
          null,
          2,
        ),
      );
    } else {
      printHuman(result, options);
    }
    if (result.violations.length > 0 && !options.reportOnly) return EXIT.FOUND;
    return EXIT.OK;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (options.json) {
      console.log(JSON.stringify({ ok: false, code: 'E_CANNOT_EVALUATE', message }));
    } else {
      console.log('[migration-immutability] E_CANNOT_EVALUATE ' + message);
      console.log('[migration-immutability] exit 2 = 判不了 ≠ 通过');
    }
    return EXIT.USAGE;
  }
}

// ---------------------------------------------------------------------------------------------
// Fixtures: a throwaway repo per case. Built with plumbing (update-ref + symbolic-ref) instead
// of checkout, so the self-test never touches the caller's working tree.
// ---------------------------------------------------------------------------------------------

export function buildFixture(kind) {
  const root = mkdtempSync(join(tmpdir(), 'mig-immut-'));
  const migrationDir = join(root, 'packages/control-plane/src/main/resources/db/migration');
  mkdirSync(migrationDir, { recursive: true });
  const git = (...args) => {
    const result = gitMaybe(root, args);
    if (!result.ok) throw new Error('fixture git ' + args.join(' ') + ' 失败: ' + result.stderr);
    return result.stdout;
  };
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/develop');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'fixture');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');

  const relative = (version) =>
    'packages/control-plane/src/main/resources/db/migration/V' + version + '__fixture.sql';
  const file = (version) => join(root, relative(version));
  writeFileSync(file(1), '-- alpha\nCREATE TABLE alpha (id int);\n');
  git('add', '-A');
  git('commit', '-qm', 'baseline');
  const baseline = git('rev-parse', 'HEAD').trim();

  // A branch at the baseline without checkout: HEAD moves, index/worktree already match it.
  git('update-ref', 'refs/heads/feature', baseline);
  git('symbolic-ref', 'HEAD', 'refs/heads/feature');

  if (kind === 'modified-published') {
    writeFileSync(file(1), '-- alpha (edited comment)\nCREATE TABLE alpha (id int);\n');
  } else if (kind === 'new-higher-number') {
    writeFileSync(file(2), '-- beta\nCREATE TABLE beta (id int);\n');
    git('add', '-A');
    git('commit', '-qm', 'add V2');
  } else if (kind === 'modified-unpublished') {
    writeFileSync(file(2), '-- beta\nCREATE TABLE beta (id int);\n');
    git('add', '-A');
    git('commit', '-qm', 'add V2');
    writeFileSync(file(2), '-- beta (still unpublished, edited)\nCREATE TABLE beta (id int);\n');
  } else if (kind === 'renamed-published') {
    git('mv', relative(1), relative(9));
    git('commit', '-qm', 'rename V1 -> V9');
  } else if (kind === 'no-merge-base') {
    // A repo with no `develop` ref at all: merge-base cannot resolve.
    git('update-ref', '-d', 'refs/heads/develop');
  } else {
    throw new Error('未知夹具: ' + kind);
  }
  return { root, migrationDir };
}

const FIXTURES = [
  {
    kind: 'modified-published',
    name: '改已发布 V1（只改注释）',
    base: 'develop',
    expectExit: EXIT.FOUND,
    expectCode: CODES.MODIFIED,
    expectVersion: 1,
  },
  {
    kind: 'new-higher-number',
    name: '新增更高号 V2（未发布）',
    base: 'develop',
    expectExit: EXIT.OK,
    expectCode: null,
  },
  {
    kind: 'modified-unpublished',
    name: '改未发布号 V2（只在 HEAD 之后新增）',
    base: 'develop',
    expectExit: EXIT.OK,
    expectCode: null,
  },
  {
    kind: 'renamed-published',
    name: '改已发布文件名 V1 -> V9',
    base: 'develop',
    expectExit: EXIT.FOUND,
    expectCode: CODES.RENAMED,
    expectVersion: 1,
  },
  {
    kind: 'no-merge-base',
    name: '取不到 merge-base',
    base: 'develop',
    expectExit: EXIT.USAGE,
    expectCode: 'E_CANNOT_EVALUATE',
  },
];

export function selftest() {
  let failed = 0;
  for (const fixture of FIXTURES) {
    let fixtureRoot = null;
    try {
      const built = buildFixture(fixture.kind);
      fixtureRoot = built.root;
      const options = { repo: built.root, base: fixture.base, json: false, reportOnly: false, allows: [] };
      let exitCode;
      let findings = [];
      if (fixture.expectExit === EXIT.USAGE) {
        exitCode = run(options);
      } else {
        const result = evaluate(options);
        findings = result.violations;
        exitCode = run(options);
      }
      const codeOk =
        fixture.expectCode === null
          ? true
          : fixture.expectExit === EXIT.USAGE
            ? true
            : findings.some((finding) => finding.code === fixture.expectCode);
      const versionOk =
        fixture.expectVersion === undefined
          ? true
          : findings.some((finding) => finding.version === fixture.expectVersion);
      const namedOk =
        fixture.expectExit !== EXIT.FOUND ||
        findings.some((finding) => /V\d+__[^/]*\.sql$/.test(finding.path));
      const ok = exitCode === fixture.expectExit && codeOk && versionOk && namedOk;
      if (!ok) failed += 1;
      const observed = findings.length ? findings.map((f) => f.code + ' V' + f.version).join(',') : 'none';
      console.log(
        '[selftest] ' +
          (ok ? 'PASS' : 'FAIL') +
          ' ' +
          fixture.name +
          ' => exit=' +
          exitCode +
          ' (expected ' +
          fixture.expectExit +
          ') findings=' +
          observed,
      );
    } catch (error) {
      failed += 1;
      console.log(
        '[selftest] FAIL ' +
          fixture.name +
          ' => threw: ' +
          (error && error.message ? error.message : String(error)),
      );
    } finally {
      if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }
  console.log('[selftest] fixtures=' + FIXTURES.length + ' failed=' + failed);
  return failed === 0 ? EXIT.OK : EXIT.FOUND;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return EXIT.OK;
  }
  if (options.selftest) return selftest();
  return run(options);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    // parseArgs throws before run() can shape the exit code; keep the 0/1/2 contract.
    console.log('[migration-immutability] E_USAGE ' + (error && error.message ? error.message : String(error)));
    console.log(USAGE);
    process.exit(EXIT.USAGE);
  }
}
