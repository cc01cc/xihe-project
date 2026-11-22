#!/usr/bin/env node
/**
 * task-710：CP 禁吞 Error —— `catch (Throwable)` 固化成门。
 *
 * 背景（task-18）：`FirstRunContentSeedTrigger` / `FirstRunContentSeedRequestFilter` 曾写
 * `catch (Throwable …)`，把 `OutOfMemoryError` / `StackOverflowError` 一起吞掉，JVM 带病继续服务。
 * 那两处已收窄为 `Exception`；本门防的是**复犯**：新代码再出现同类捕获时直接红。
 *
 * 规则（只看 production 源码）：
 *   - Java  `catch (Throwable | Error | java.lang.Throwable)`（含 multi-catch）
 *   - Python `except:`（裸 except）/ `except BaseException`（含 `except*`、分组形式）
 *   - TS/JS/Vue `catch {}` 空吞（catch 体去掉注释后只剩空白）
 *
 * 豁免通道：基线 ratchet（config/swallowed-error-baseline.json，按「文件 → 规则 → 计数」，
 * 只许降不许升）+ 同行 `// OK: <理由>`（Python 用 `# OK: <理由>`）。被否决的更简方案见证据 README。
 *
 * 用法：
 *   node scripts/check-swallowed-error.mjs                    # 检查（真实树）
 *   node scripts/check-swallowed-error.mjs --write-baseline   # 按当前命中重建基线
 *   node scripts/check-swallowed-error.mjs --root <dir>       # 单树模式（测试/临时树；不要求 git 面）
 *   node scripts/check-swallowed-error.mjs --baseline <file>
 *   node scripts/check-swallowed-error.mjs --json
 *   node scripts/check-swallowed-error.mjs --selftest         # 内置四类反例夹具
 *
 * 退出码（task-156/157 同口径）：
 *   0 = 干净 / 命中已在基线内
 *   1 = 未登记命中或超基线
 *   2 = 结构性判不了（缺扫描根、非 git 工作树、读文件失败、基线缺失/损坏、参数错）
 *       unknown 一律不按安全处理。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DEFAULT_BASELINE = path.join(REPO_ROOT, 'config', 'swallowed-error-baseline.json');
const LF = '\n';
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'dist',
  'build',
  '.venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.turbo',
]);

export const RULES = Object.freeze({
  JAVA: 'java-catch-throwable',
  PY_BARE: 'python-bare-except',
  PY_BASE: 'python-except-baseexception',
  TS_EMPTY: 'ts-empty-catch',
});
const RULE_IDS = Object.freeze(Object.values(RULES));

const NEEDLE = Object.freeze({
  java: /\bcatch\b/u,
  python: /\bexcept\b/u,
  ts: /\bcatch\b/u,
});

export class GateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GateError';
    this.code = code;
  }
}

function isDir(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

export function languageOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.java') return 'java';
  if (ext === '.py') return 'python';
  if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue'].includes(ext)) return 'ts';
  if (ext === '.rs') return 'rust';
  return null;
}

/** 测试源不算 production：UI 的 `__tests__/**`、`*.spec.ts`、`*.test.ts`。 */
export function isTestSource(relativeFile) {
  const parts = toPosix(relativeFile).toLowerCase().split('/');
  if (parts.includes('__tests__') || parts.includes('__mocks__') || parts.includes('tests')) return true;
  const name = parts[parts.length - 1] ?? '';
  return /\.(spec|test)\.[cm]?[jt]sx?$/u.test(name);
}

/**
 * 默认扫描面：`packages/*\/src/main/java` + agent/src + ui/src + runtime。
 * 缺任一必需根 ⇒ 结构性失败（不把「没扫到」当绿）。
 */
export function defaultRoots(repoRoot = REPO_ROOT) {
  const roots = [];
  const missing = [];
  const packagesDir = path.join(repoRoot, 'packages');
  let javaRoots = 0;
  if (isDir(packagesDir)) {
    for (const name of fs.readdirSync(packagesDir).sort()) {
      const dir = path.join(packagesDir, name, 'src', 'main', 'java');
      if (isDir(dir)) {
        roots.push(dir);
        javaRoots += 1;
      }
    }
  }
  if (javaRoots === 0) missing.push('packages/*/src/main/java');
  for (const rel of ['packages/agent/src', 'packages/ui/src', 'packages/runtime']) {
    const dir = path.join(repoRoot, rel);
    if (isDir(dir)) roots.push(dir);
    else missing.push(rel);
  }
  return { roots, missing };
}

export function walkSources(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      throw new GateError('E_READ_FAILED', 'readdir failed: ' + dir + ' — ' + error.message);
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      if (entry.isFile()) files.push(full);
    }
  }
  return files.sort();
}

/**
 * 把注释与字符串字面量替换成空格（保留换行与字符偏移），供正则匹配。
 * 返回 `masked` 与注释清单（`line` 为起始行，用于同行 `OK:` 豁免）。
 *
 * 已知盲区：不解析 JS/TS 正则字面量，正则里出现 `//`、`catch` 或未转义括号时可能扰动掩码；
 * 这类扰动至多造成漏报/误报，不会让已命中项消失成「安全」。
 */
export function maskSource(source, language) {
  const chars = source.split('');
  const comments = [];
  const length = source.length;
  let index = 0;
  let line = 1;

  const blank = (from, to) => {
    for (let cursor = from; cursor < to; cursor += 1) {
      if (chars[cursor] !== '\n' && chars[cursor] !== '\r') chars[cursor] = ' ';
    }
  };

  if (language === 'python') {
    while (index < length) {
      const current = source[index];
      if (current === '\n') {
        line += 1;
        index += 1;
        continue;
      }
      if (current === '#') {
        const start = index;
        const startLine = line;
        while (index < length && source[index] !== '\n') index += 1;
        comments.push({ line: startLine, text: source.slice(start, index) });
        blank(start, index);
        continue;
      }
      const triple = source.startsWith('"""', index)
        ? '"""'
        : source.startsWith("'''", index)
          ? "'''"
          : null;
      if (triple) {
        const start = index;
        index += 3;
        while (index < length && !source.startsWith(triple, index)) {
          if (source[index] === '\n') line += 1;
          index += 1;
        }
        index = Math.min(length, index + 3);
        blank(start, index);
        continue;
      }
      if (current === '"' || current === "'") {
        const quote = current;
        const start = index;
        index += 1;
        while (index < length) {
          if (source[index] === '\\') {
            if (source[index + 1] === '\n') line += 1;
            index += 2;
            continue;
          }
          if (source[index] === quote) {
            index += 1;
            break;
          }
          if (source[index] === '\n') break;
          index += 1;
        }
        blank(start, index);
        continue;
      }
      index += 1;
    }
    return { masked: chars.join(''), comments };
  }

  // C 系（Java / TS / JS / Vue script / Rust）
  while (index < length) {
    const current = source[index];
    if (current === '\n') {
      line += 1;
      index += 1;
      continue;
    }
    if (current === '/' && source[index + 1] === '/') {
      const start = index;
      const startLine = line;
      while (index < length && source[index] !== '\n') index += 1;
      comments.push({ line: startLine, text: source.slice(start, index) });
      blank(start, index);
      continue;
    }
    if (current === '/' && source[index + 1] === '*') {
      const start = index;
      const startLine = line;
      index += 2;
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') line += 1;
        index += 1;
      }
      index = Math.min(length, index + 2);
      comments.push({ line: startLine, text: source.slice(start, index) });
      blank(start, index);
      continue;
    }
    if (language === 'java' && source.startsWith('"""', index)) {
      const start = index;
      index += 3;
      while (index < length && !source.startsWith('"""', index)) {
        if (source[index] === '\n') line += 1;
        index += 1;
      }
      index = Math.min(length, index + 3);
      blank(start, index);
      continue;
    }
    if (current === '"' || current === "'" || (language === 'ts' && current === '`')) {
      const quote = current;
      const start = index;
      index += 1;
      while (index < length) {
        if (source[index] === '\\') {
          if (source[index + 1] === '\n') line += 1;
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          break;
        }
        if (source[index] === '\n') {
          // Java/JS 的普通字符串不跨行；模板字符串可以，继续计数。
          if (quote !== '`') {
            index += 1;
            break;
          }
          line += 1;
        }
        index += 1;
      }
      blank(start, index);
      continue;
    }
    index += 1;
  }
  return { masked: chars.join(''), comments };
}

export function isExempt(comments, line) {
  return comments.some((comment) => comment.line === line && /OK:\s*\S/u.test(comment.text));
}

function lineStartsOf(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  return high + 1;
}

/**
 * 扫一段源码，返回 `{ hits, exempt, comments }`。
 * `hits` 每条只带 `rule` + 行号（供定位），不含行号断言语义。
 */
export function scanText(source, language) {
  const { masked, comments } = maskSource(source, language);
  const starts = lineStartsOf(masked);
  const raw = [];
  const push = (rule, offset) => {
    const line = lineAt(starts, offset);
    raw.push({ rule, line });
  };

  if (language === 'java') {
    const pattern = /\bcatch\s*\(([^)]*)\)/gu;
    for (const match of masked.matchAll(pattern)) {
      const header = match[1] ?? '';
      const hit = /\b(?:java\.lang\.)?(Throwable|Error)\b/u.exec(header);
      if (hit) push(RULES.JAVA, match.index);
    }
  } else if (language === 'python') {
    const pattern = /\bexcept\*?\s*([^:\n]*):/gu;
    for (const match of masked.matchAll(pattern)) {
      const header = (match[1] ?? '').trim();
      if (header === '') push(RULES.PY_BARE, match.index);
      else if (/\bBaseException(?:Group)?\b/u.test(header)) push(RULES.PY_BASE, match.index);
    }
  } else if (language === 'ts') {
    const pattern = /\bcatch\b\s*(?:\([^)]*\))?\s*\{\s*\}/gu;
    for (const match of masked.matchAll(pattern)) push(RULES.TS_EMPTY, match.index);
  }

  const hits = [];
  const exempt = [];
  for (const hit of raw) {
    if (isExempt(comments, hit.line)) exempt.push(hit);
    else hits.push(hit);
  }
  return { hits, exempt, comments };
}

function tallyPush(tally, file, rule) {
  if (!tally.has(file)) tally.set(file, new Map());
  const rules = tally.get(file);
  rules.set(rule, (rules.get(rule) ?? 0) + 1);
}

/** 返回 `{ files, scanned, hits, exempt, tally }`；`displayBase` 决定报告里的相对路径。 */
export function scanTree(rootDirs, { displayBase }) {
  const files = [];
  const hits = [];
  const exempt = [];
  const tally = new Map();
  let scanned = 0;
  for (const dir of rootDirs) {
    for (const file of walkSources(dir)) {
      const language = languageOf(file);
      if (!language) continue;
      const relative = toPosix(path.relative(displayBase, file));
      if (language === 'ts' && isTestSource(relative)) continue;
      if (language === 'java' && isTestSource(relative)) continue;
      if (language === 'python' && isTestSource(relative)) continue;
      files.push(relative);
      scanned += 1;
      if (language === 'rust' || !NEEDLE[language]) continue;
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (error) {
        throw new GateError('E_READ_FAILED', 'read failed: ' + relative + ' — ' + error.message);
      }
      if (!NEEDLE[language].test(text)) continue;
      const result = scanText(text, language);
      for (const hit of result.hits) {
        hits.push({ file: relative, rule: hit.rule, line: hit.line });
        tallyPush(tally, relative, hit.rule);
      }
      for (const hit of result.exempt) exempt.push({ file: relative, rule: hit.rule, line: hit.line });
    }
  }
  return { files, scanned, hits, exempt, tally };
}

export function baselineFromTally(tally) {
  const files = {};
  for (const file of [...tally.keys()].sort()) {
    const rules = tally.get(file);
    const entry = {};
    for (const rule of [...rules.keys()].sort()) entry[rule] = rules.get(rule);
    files[file] = entry;
  }
  const total = [...tally.values()].reduce(
    (sum, rules) => sum + [...rules.values()].reduce((inner, count) => inner + count, 0),
    0,
  );
  return { files, total };
}

export function compareBaseline(tally, baselineFiles) {
  const increased = [];
  const stale = [];
  for (const [file, rules] of tally) {
    for (const [rule, count] of rules) {
      const allowed = baselineFiles[file]?.[rule] ?? 0;
      if (count > allowed) increased.push({ file, rule, before: allowed, after: count });
      else if (count < allowed) stale.push({ file, rule, before: allowed, after: count });
    }
  }
  for (const [file, rules] of Object.entries(baselineFiles)) {
    for (const [rule, allowed] of Object.entries(rules)) {
      if (!tally.get(file)?.has(rule)) stale.push({ file, rule, before: allowed, after: 0 });
    }
  }
  return { increased, stale };
}

function shortCommit(repoRoot) {
  const result = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function assertGitFace(repoRoot) {
  const result = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || result.stdout.trim() !== 'true') {
    throw new GateError(
      'E_NOT_A_GIT_TREE',
      '扫描根不在 git 工作树内：' + repoRoot +
        '（缺 git 面时无法确认扫的是哪棵树；unknown 不按安全处理）',
    );
  }
}

function loadBaseline(file) {
  if (!fs.existsSync(file)) {
    throw new GateError(
      'E_NO_BASELINE',
      '基线不存在：' + file + '（先跑 --write-baseline，再 review 差异）',
    );
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new GateError('E_BAD_BASELINE', file + ' 不是合法 JSON：' + error.message);
  }
  if (!doc || typeof doc !== 'object' || !doc.files || typeof doc.files !== 'object') {
    throw new GateError('E_BAD_BASELINE', file + ' 缺对象字段 files');
  }
  const files = {};
  let sum = 0;
  for (const [entryFile, rules] of Object.entries(doc.files)) {
    if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
      throw new GateError('E_BAD_BASELINE', file + ' 的 ' + entryFile + ' 不是 {rule: count} 对象');
    }
    files[entryFile] = {};
    for (const [rule, count] of Object.entries(rules)) {
      if (!RULE_IDS.includes(rule)) {
        throw new GateError('E_BAD_BASELINE', file + ' 含未知规则 ' + rule + '（' + entryFile + '）');
      }
      if (!Number.isInteger(count) || count < 0) {
        throw new GateError('E_BAD_BASELINE', file + ' 的 ' + entryFile + '/' + rule + ' 计数非法：' + count);
      }
      files[entryFile][rule] = count;
      sum += count;
    }
  }
  if (!Number.isInteger(doc.total) || doc.total !== sum) {
    throw new GateError(
      'E_BAD_BASELINE',
      file + ' 自相矛盾：total=' + doc.total + ' 但 sum(files)=' + sum,
    );
  }
  return { doc, files };
}

function renderBaseline(scan, roots, repoRoot) {
  const { files, total } = baselineFromTally(scan.tally);
  return {
    _note:
      'task-710 ratchet 基线（grandfather）。登记「production 源码里吞 Throwable/Error/' +
      'BaseException、裸 except、TS 空 catch」的存量，按「文件 → 规则 → 计数」。' +
      '只许降不许升：任一计数升高 ⇒ check-swallowed-error.mjs exit 1。' +
      '降低后跑 --write-baseline 收紧并 review 差异。本基线不代表这些命中都合规——逐条定性与盲区见 ' +
      'internal/A03-xihe/evidence/2026-11-22-swallowed-error-gate/README.md。',
    generatedAt: new Date().toISOString(),
    a03Commit: shortCommit(repoRoot),
    scanRoots: roots.map((dir) => toPosix(path.relative(repoRoot, dir)) || '.'),
    total,
    files,
  };
}

function printFindings(scan, overKeys) {
  for (const hit of scan.hits) {
    if (!overKeys.has(hit.file + '\t' + hit.rule)) continue;
    console.log(
      '[check-swallowed-error] E_SWALLOWED_ERROR: ' + hit.file + ':' + hit.line +
        '  [' + hit.rule + ']',
    );
  }
}

export function parseArgs(argv) {
  const options = {
    root: null,
    baseline: DEFAULT_BASELINE,
    json: false,
    writeBaseline: false,
    selftest: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      const value = argv[++index];
      if (!value) throw new GateError('E_BAD_ARGS', '--root 需要目录');
      options.root = path.resolve(value);
    } else if (arg === '--baseline') {
      const value = argv[++index];
      if (!value) throw new GateError('E_BAD_ARGS', '--baseline 需要文件');
      options.baseline = path.resolve(value);
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--write-baseline') {
      options.writeBaseline = true;
    } else if (arg === '--selftest') {
      options.selftest = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new GateError('E_BAD_ARGS', '未知参数：' + arg);
    }
  }
  return options;
}

export function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('usage: node scripts/check-swallowed-error.mjs [--root <dir>] [--baseline <file>]');
    console.log('       [--write-baseline] [--json] [--selftest]');
    return 0;
  }
  if (options.selftest) return selftest();

  let roots;
  let displayBase;
  if (options.root) {
    if (!isDir(options.root)) {
      throw new GateError('E_SCAN_ROOT_MISSING', '扫描根不存在或不是目录：' + options.root);
    }
    roots = [options.root];
    displayBase = options.root;
  } else {
    assertGitFace(REPO_ROOT);
    const resolved = defaultRoots(REPO_ROOT);
    if (resolved.missing.length > 0) {
      throw new GateError(
        'E_SCAN_ROOT_MISSING',
        '缺扫描根：' + resolved.missing.join(', '),
      );
    }
    roots = resolved.roots;
    displayBase = REPO_ROOT;
  }

  const scan = scanTree(roots, { displayBase });
  if (scan.scanned === 0) {
    throw new GateError(
      'E_NO_SOURCE_FILES',
      '扫描了 0 个可判定源文件（' + roots.join(', ') + '）——「什么也没扫到」不是安全',
    );
  }

  if (options.writeBaseline) {
    const doc = renderBaseline(scan, roots, options.root ? options.root : REPO_ROOT);
    fs.writeFileSync(options.baseline, JSON.stringify(doc, null, 2) + LF, 'utf8');
    if (options.json) {
      console.log(JSON.stringify({ ok: true, mode: 'write-baseline', path: options.baseline, total: doc.total }));
    } else {
      console.log(
        '[check-swallowed-error] wrote baseline: total=' + doc.total + ' files=' +
          Object.keys(doc.files).length + ' -> ' + options.baseline,
      );
    }
    return 0;
  }

  const baseline = loadBaseline(options.baseline);
  const { increased, stale } = compareBaseline(scan.tally, baseline.files);
  const ok = increased.length === 0;
  const overKeys = new Set(increased.map((item) => item.file + '\t' + item.rule));
  const summary =
    'files=' + scan.scanned +
    ' hits=' + scan.hits.length +
    ' exempt=' + scan.exempt.length +
    ' baseline=' + baseline.doc.total +
    ' over=' + increased.length +
    ' stale=' + stale.length;

  if (options.json) {
    console.log(JSON.stringify({
      ok,
      mode: 'check',
      scanned: scan.scanned,
      hits: scan.hits,
      exempt: scan.exempt,
      baselineTotal: baseline.doc.total,
      increased,
      stale,
    }, null, 2));
  } else {
    console.log('[check-swallowed-error] ' + summary);
    printFindings(scan, overKeys);
    for (const item of increased) {
      console.log(
        '  OVER  ' + item.file + '  [' + item.rule + ']  ' + item.before + ' -> ' + item.after,
      );
    }
    for (const item of stale) {
      console.log(
        '  STALE ' + item.file + '  [' + item.rule + ']  ' + item.before + ' -> ' + item.after +
          '（基线可收紧：跑 --write-baseline）',
      );
    }
    if (!ok) {
      console.log(
        '[check-swallowed-error] FAIL 未登记命中或超基线。' +
          '确属有意为之请用同行 `// OK: <理由>`（Python `# OK:`）豁免；' +
          '不要放宽规则或把额度调高。',
      );
    }
  }
  return ok ? 0 : 1;
}

function runChild(args) {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  return { status: result.status, output };
}

/**
 * 四类反例夹具：命中 / 同行豁免 / 超基线 / 结构性失败。
 * 断言只钉意图（规则名、计数、退出码），不钉行号。
 */
export function selftest() {
  const checks = [];
  const record = (name, passed, detail = '') => checks.push({ name, passed, detail });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xh-swallowed-error-'));
  try {
    const javaHit = scanText(
      'class ProbeA { void run() { try { work(); } catch (Throwable boom) { } } }\n',
      'java',
    );
    record(
      '命中：catch (Throwable) ⇒ 1 条 java-catch-throwable',
      javaHit.hits.length === 1 && javaHit.hits[0].rule === RULES.JAVA,
      JSON.stringify(javaHit.hits),
    );

    const javaOk = scanText(
      'class ProbeB { void run() { try { work(); } catch (Throwable boom) { throw boom; } } } // OK: 只做观测后原样 re-raise\n',
      'java',
    );
    record(
      '豁免：同行 `// OK: <理由>` ⇒ 0 条未豁免命中',
      javaOk.hits.length === 0 && javaOk.exempt.length === 1,
      JSON.stringify({ hits: javaOk.hits, exempt: javaOk.exempt }),
    );

    const tree = path.join(temp, 'tree');
    fs.mkdirSync(tree, { recursive: true });
    fs.writeFileSync(
      path.join(tree, 'Probe.java'),
      'class ProbeC { void run() { try { work(); } catch (Error boom) { } } }\n',
      'utf8',
    );
    const baselineFile = path.join(temp, 'baseline.json');
    fs.writeFileSync(
      baselineFile,
      JSON.stringify({
        total: 0,
        files: {},
      }),
      'utf8',
    );
    const over = runChild(['--root', tree, '--baseline', baselineFile]);
    record(
      '超基线：空基线 + 真实命中 ⇒ exit 1 且点名 E_SWALLOWED_ERROR',
      over.status === 1 && over.output.includes('E_SWALLOWED_ERROR'),
      'exit=' + over.status + LF + over.output.trim(),
    );

    const missing = runChild(['--root', path.join(temp, 'nope'), '--baseline', baselineFile]);
    record(
      '结构性失败：扫描根不存在 ⇒ exit 2 且点名 E_SCAN_ROOT_MISSING',
      missing.status === 2 && missing.output.includes('E_SCAN_ROOT_MISSING'),
      'exit=' + missing.status + LF + missing.output.trim(),
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  for (const check of checks) {
    console.log((check.passed ? '[selftest] OK   ' : '[selftest] FAIL ') + check.name);
    if (!check.passed && check.detail) console.log(check.detail);
  }
  const failed = checks.filter((check) => !check.passed).length;
  console.log('[selftest] ' + (checks.length - failed) + '/' + checks.length + ' passed');
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof GateError) {
      console.error('[check-swallowed-error] ' + error.code + ': ' + error.message);
    } else {
      console.error('[check-swallowed-error] E_UNEXPECTED: ' + (error?.stack ?? error));
    }
    process.exitCode = 2;
  }
}
