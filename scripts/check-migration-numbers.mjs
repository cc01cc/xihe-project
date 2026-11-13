#!/usr/bin/env node
/**
 * Migration-number gate — turns "read the occupancy announcement before you take a number"
 * from a habit into a check.
 *
 * WHY
 *   On 2026-11-13 two cards computed the same Flyway number minutes apart. The announcement
 *   (plans/PLAN-0773-.../tasks.md:19) had ALREADY written that exact failure down: "parallel
 *   lanes may both compute V162 => Flyway duplicate version, the whole stack refuses to start".
 *   It did not help, because reading an announcement is voluntary and the only reader went
 *   back to it afterwards. What actually stopped the collision was a mechanism ("a gap is not
 *   executable": with outOfOrder disabled, applying V163 and later adding V162 makes every
 *   existing database fail at startup).
 *   => The judgement must not depend on somebody remembering to look. This script is that
 *   mechanism for the mechanical half: duplicates, registry parity, unregistered numbers.
 *
 * CHECKS
 *   1. DUPLICATE  two migration files with the same numeric version
 *                 => E_DUPLICATE_MIGRATION_NUMBER (Flyway: duplicate version, stack down).
 *   2. PARITY     the registry's three headline values must equal the measured ones:
 *                 section 1 "mainline upper bound" == measured max,
 *                 section 1 "migration file count" == measured file count,
 *                 section 1 "next free number"     == measured max + 1
 *                 => E_REGISTRY_STALE, printing "registry vs measured" per item.
 *   3. UNREGISTERED  a measured number with no registry row anywhere in the document
 *                 => E_MIGRATION_NOT_REGISTERED (only NEW numbers; the historical rows are not
 *                 required to be rewritten).
 *
 * NUMERIC, NEVER LEXICOGRAPHIC
 *   Versions are compared as integers. "V19" > "V100" and "V16" < "V160" under string order;
 *   a lexicographic max is a wrong max, and a wrong max makes the "next free number" wrong in
 *   the most expensive direction (it hands out a number that is already taken).
 *   Fixture 2 pins this: with V16/V19/V100/V160 present, max must be 160 and next 161 — a
 *   string-compare implementation reports max=19.
 *
 * EXIT CODES
 *   0  clean (no findings)
 *   1  at least one finding (each finding prints its code + the file/row that produced it)
 *   2  the script itself could not answer: migration dir missing, registry missing, or the
 *      registry's three headline values could not be parsed. "Could not check" is NOT "clean" —
 *      a gate that silently passes when its input is unreadable is worse than no gate.
 *
 * USAGE
 *   node scripts/check-migration-numbers.mjs                # real tree
 *   node scripts/check-migration-numbers.mjs --json         # machine-readable
 *   node scripts/check-migration-numbers.mjs --selftest     # 5 fixtures, each must fire
 *   node scripts/check-migration-numbers.mjs --dir <migration dir> --registry <registry.md>
 *
 * WIRING: not wired into mise/validate on purpose (task-164 = "prove the judgement fires before
 * hanging it on the pipeline"). Wiring is a separate card.
 */

import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = resolve(HERE, '..');
export const DEFAULT_MIGRATION_DIR = join(
  DEFAULT_REPO_ROOT,
  'packages/control-plane/src/main/resources/db/migration',
);
/** The registry lives in the workspace repo (one/), one level above the project repo. */
export const DEFAULT_REGISTRY = resolve(DEFAULT_REPO_ROOT, '../internal/A03-xihe/docs/migration-numbers.md');

export const CODES = {
  DUPLICATE: 'E_DUPLICATE_MIGRATION_NUMBER',
  STALE: 'E_REGISTRY_STALE',
  UNREGISTERED: 'E_MIGRATION_NOT_REGISTERED',
};

/** Filename -> numeric version. Returns null for anything that is not a V<number>__*.sql file. */
export function parseMigrationVersion(name) {
  const match = /^V(\d+)__.*\.sql$/.exec(name);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

/** Read the migration directory, compare versions as integers. */
export function collectMigrations(dir) {
  const names = readdirSync(dir).filter((name) => name.endsWith('.sql'));
  const byVersion = new Map();
  const files = [];
  for (const name of names) {
    const version = parseMigrationVersion(name);
    if (version === null) continue;
    files.push({ name, version });
    const bucket = byVersion.get(version);
    if (bucket) bucket.push(name);
    else byVersion.set(version, [name]);
  }
  const versions = [...byVersion.keys()].sort((a, b) => a - b); // numeric, not string
  return {
    files,
    byVersion,
    versions,
    fileCount: files.length,
    max: versions.length ? versions[versions.length - 1] : 0,
  };
}

const stripBold = (cell) => cell.replace(/\*\*/g, '').trim();

function splitRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  const cells = trimmed.slice(1, trimmed.endsWith('|') ? -1 : undefined).split('|');
  return cells.map((cell) => cell.trim());
}

/**
 * Parse the registry document.
 *
 * Headline values come from the section-1 table (label in cell 0, value in cell 1).
 * Registered numbers are collected from every "| V<n> |" row in the document rather than from
 * section 2.1 alone: the real registry splits "already used" across sections 2 (V1-V147), 2.1
 * (V135+) and 2.2 (V148-V159), so a 2.1-only membership test would report ~150 false positives
 * on a clean tree. See the evidence package for that reading.
 */
export function parseRegistry(text) {
  const upper = { bounds: null, fileCount: null, next: null };
  const registered = new Set();
  const rowVersions = [];

  for (const line of text.split(/\r?\n/)) {
    const cells = splitRow(line);
    if (!cells || cells.length < 2) continue;
    const label = stripBold(cells[0]);
    const value = stripBold(cells[1]);

    if (upper.bounds === null && label.includes('主干上界')) {
      const match = /V(\d+)/.exec(value);
      if (match) upper.bounds = Number.parseInt(match[1], 10);
    }
    if (upper.fileCount === null && label.includes('迁移文件数')) {
      // Avoid swallowing the upper bound inside "V1–V162": only plain integers count.
      const match = /(?<!V)(\d+)(?!\d)/.exec(value);
      if (match) upper.fileCount = Number.parseInt(match[1], 10);
    }
    if (upper.next === null && label.includes('下一条可用号')) {
      const match = /V(\d+)/.exec(value);
      if (match) upper.next = Number.parseInt(match[1], 10);
    }

    const rowMatch = /^V(\d+)$/.exec(label);
    if (rowMatch) {
      const version = Number.parseInt(rowMatch[1], 10);
      registered.add(version);
      rowVersions.push(version);
    }
  }

  return { upper, registered, rowVersions };
}

/** Pure judgement: measured migrations + parsed registry => findings. */
export function checkNumbers({ migrations, registry }) {
  const findings = [];
  const readings = {
    files: migrations.fileCount,
    max: migrations.max,
    next: migrations.max + 1,
    distinct: migrations.byVersion.size,
  };

  for (const version of migrations.versions) {
    const bucket = migrations.byVersion.get(version);
    if (bucket.length > 1) {
      findings.push({
        code: CODES.DUPLICATE,
        version,
        files: bucket,
        message: 'version ' + version + ' appears ' + bucket.length + ' times: ' + bucket.join(', '),
      });
    }
  }

  const parity = [
    { item: '主干上界', registered: registry.upper.bounds, measured: migrations.max },
    { item: '迁移文件数', registered: registry.upper.fileCount, measured: migrations.fileCount },
    { item: '下一条可用号', registered: registry.upper.next, measured: migrations.max + 1 },
  ];
  const stale = parity.filter((row) => row.registered !== row.measured);
  if (stale.length > 0) {
    findings.push({
      code: CODES.STALE,
      message:
        'registry is out of date: ' +
        stale.map((row) => row.item + ' 登记=' + row.registered + ' 实测=' + row.measured).join('; '),
      detail: parity,
    });
  }

  const unregistered = migrations.versions.filter((version) => !registry.registered.has(version));
  if (unregistered.length > 0) {
    findings.push({
      code: CODES.UNREGISTERED,
      message: 'measured but not in the registry: ' + unregistered.map((v) => 'V' + v).join(', '),
      versions: unregistered,
    });
  }

  return { findings, readings, parity };
}

function load(io) {
  const migrations = collectMigrations(io.migrationDir);
  const text = readFileSync(io.registryPath, 'utf8');
  const registry = parseRegistry(text);
  const missing = Object.entries(registry.upper)
    .filter(([, value]) => value === null)
    .map(([key]) => key);
  return { migrations, registry, missing };
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const json = argv.includes('--json');
  const argOf = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const io = {
    migrationDir: argOf('--dir') ?? DEFAULT_MIGRATION_DIR,
    registryPath: argOf('--registry') ?? DEFAULT_REGISTRY,
  };

  let loaded;
  try {
    loaded = load(io);
  } catch (error) {
    const message = 'cannot read inputs: ' + (error && error.message ? error.message : String(error));
    if (json) console.log(JSON.stringify({ ok: false, code: 'E_UNREADABLE_INPUT', message }));
    else console.log('[migration-numbers] E_UNREADABLE_INPUT ' + message);
    return 2;
  }

  if (loaded.missing.length > 0) {
    const message = 'registry headline values not parseable: ' + loaded.missing.join(', ');
    if (json) console.log(JSON.stringify({ ok: false, code: 'E_REGISTRY_UNREADABLE', message }));
    else console.log('[migration-numbers] E_REGISTRY_UNREADABLE ' + message);
    return 2;
  }

  const { findings, readings } = checkNumbers(loaded);
  const headline =
    'files=' + readings.files + ' max=V' + readings.max + ' next=V' + (readings.max + 1);

  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: findings.length === 0,
          headline,
          readings,
          findings,
          registryRows: loaded.registry.rowVersions.length,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      '[migration-numbers] ' + headline + ' registeredRows=' + loaded.registry.rowVersions.length,
    );
    for (const finding of findings) {
      console.log('[migration-numbers] ' + finding.code + ' ' + finding.message);
    }
    if (findings.length === 0) console.log('[migration-numbers] OK');
  }
  return findings.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// Self-test: every fixture must (a) fire the code it is about and (b) not fire the others.
// A fixture that only proves "clean input is clean" proves nothing about the judgement.
// ---------------------------------------------------------------------------------------------

function renderRegistry({ bounds, fileCount, next, rows }) {
  const lines = [
    '# fixture registry',
    '',
    '| 项 | 值 | 依据 |',
    '| --- | --- | --- |',
    '| 主干上界（develop） | **V' + bounds + '**（fixture） | fixture |',
    '| 迁移文件数 | **' + fileCount + '**（V1–V' + bounds + '，含 0 个空号） | fixture |',
    '| 下一条可用号 | **V' + next + '** | fixture |',
    '',
    '## 2. 已用',
    '',
    '| 号 | 文件 | 备注 |',
    '| --- | --- | --- |',
    ...rows.map((version) => '| V' + version + ' | V' + version + '__fixture.sql | fixture |'),
    '',
  ];
  return lines.join('\n');
}

const FIXTURES = [
  {
    name: 'duplicate version (V170 twice)',
    // A duplicate is the failure mode that takes the whole stack down at startup.
    files: [170, 170, 171],
    registry: { bounds: 171, fileCount: 3, next: 172, rows: [170, 171] },
    expect: [CODES.DUPLICATE],
    assert: (result) => result.findings[0].files.length === 2,
  },
  {
    name: 'numeric order: V16 < V19 < V100 < V160 (string order would answer 19)',
    // Guards the whole judgement: with a lexicographic max the parity check would ask for a
    // "next free number" of V20, i.e. hand out a number that is already used.
    files: [16, 19, 100, 160],
    registry: { bounds: 160, fileCount: 4, next: 161, rows: [16, 19, 100, 160] },
    expect: [],
    assert: (result) => result.readings.max === 160 && result.readings.next === 161,
  },
  {
    name: 'registry upper bound lags by one',
    files: [170, 171],
    registry: { bounds: 170, fileCount: 2, next: 172, rows: [170, 171] },
    expect: [CODES.STALE],
    assert: (result) => {
      const detail = result.findings.find((f) => f.code === CODES.STALE).detail;
      return detail.some(
        (row) => row.item === '主干上界' && row.registered === 170 && row.measured === 171,
      );
    },
  },
  {
    name: 'registry file count does not match',
    files: [170, 171, 172],
    registry: { bounds: 172, fileCount: 2, next: 173, rows: [170, 171, 172] },
    expect: [CODES.STALE],
    assert: (result) => {
      const detail = result.findings.find((f) => f.code === CODES.STALE).detail;
      return detail.some(
        (row) => row.item === '迁移文件数' && row.registered === 2 && row.measured === 3,
      );
    },
  },
  {
    name: 'new number not registered (V171 missing from the document)',
    files: [170, 171],
    registry: { bounds: 171, fileCount: 2, next: 172, rows: [170] },
    expect: [CODES.UNREGISTERED],
    assert: (result) =>
      result.findings[0].versions.length === 1 && result.findings[0].versions[0] === 171,
  },
];

function selftest() {
  let passed = 0;
  const failures = [];
  for (const fixture of FIXTURES) {
    const root = mkdtempSync(join(tmpdir(), 'mignum-'));
    try {
      const migrationDir = join(root, 'db/migration');
      mkdirSync(migrationDir, { recursive: true });
      // Distinct file names on purpose: a duplicate is two FILES with the same version, so
      // writing the same name twice would only overwrite and the fixture would prove nothing.
      fixture.files.forEach((version, index) => {
        writeFileSync(
          join(migrationDir, 'V' + version + '__fixture' + index + '.sql'),
          '-- fixture\n',
        );
      });
      const registryPath = join(root, 'migration-numbers.md');
      writeFileSync(registryPath, renderRegistry(fixture.registry));

      const loaded = load({ migrationDir, registryPath });
      const result = checkNumbers(loaded);
      const codes = result.findings.map((finding) => finding.code);
      const missingCodes = fixture.expect.filter((code) => !codes.includes(code));
      const unexpectedCodes = codes.filter((code) => !fixture.expect.includes(code));
      let assertOk = true;
      try {
        assertOk = fixture.assert ? fixture.assert(result) : true;
      } catch (error) {
        assertOk = 'threw: ' + (error && error.message ? error.message : String(error));
      }

      if (missingCodes.length === 0 && unexpectedCodes.length === 0 && assertOk) {
        passed += 1;
        const shown = fixture.expect.length
          ? fixture.expect.join('+')
          : 'no findings (readings correct)';
        console.log('[selftest] PASS ' + fixture.name + ' => ' + shown);
      } else {
        failures.push(fixture.name);
        console.log(
          '[selftest] FAIL ' +
            fixture.name +
            ' : missing=' +
            missingCodes.join(',') +
            ' unexpected=' +
            unexpectedCodes.join(',') +
            ' assert=' +
            assertOk,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  console.log(
    '[selftest] fixtures=' + FIXTURES.length + ' passed=' + passed + ' failed=' + failures.length,
  );
  return failures.length === 0 ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
