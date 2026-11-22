#!/usr/bin/env node
/**
 * task-720：已知踩坑注释转可失败门（第一批）—— 「多构造器 + 无 @Autowired」固化成门。
 *
 * 源事故：`cp/chat/UserQuestionService.java:118-128` 的注释写着「双构造器必须显式 @Autowired」，
 * 因为 Spring 在候选构造器 >1 时回退到「no-arg or explicit annotation」，两个普通构造器会让
 * bean 无法实例化（task-5 踩过）。这类坑此前只靠注释传递，没有任何会红的机制。
 *
 * 规则（只看 production 源码 `packages/*\/src/main/java/**\/*.java`）：
 *   同一个类/枚举/记录内声明的构造器数 >= 2 且**没有任何一个**构造器带 `@Autowired`
 *   ⇒ 命中 `spring-multi-ctor-no-autowired`。
 *
 * 判据按语义（类体 → 构造器集合 → 注解归属），不按行号：
 *   - 只在类体直接层级找 `ClassName(`，且其后必须跟参数表与 `{`（`throws …` 允许）；
 *     `new ClassName(...)`、普通方法调用、注释/字符串里提到的同名文本都不算构造器。
 *   - `@Autowired` 取构造器声明前紧邻的注解行（含同一行前缀、含 FQN 写法）。
 *   - record 的紧凑构造器（`Name {`）也计入构造器数。
 *
 * 豁免通道（与 check-swallowed-error.mjs 同口径）：
 *   - 基线棘轮 `config/spring-ctor-baseline.json`，结构为「文件 → 命中计数」，只许降不许升；
 *   - 同行 `// OK: <理由>`：写在类声明行或任一构造器声明行，豁免整个类（理由不能为空）。
 *
 * 已知盲区（不隐藏）：
 *   - 判据是结构性的，不判定「这个类是不是 Spring bean」。JPA 实体/DTO/异常的
 *     「全参 + 无参」双构造器同样命中，只能进基线；缩小到 stereotype 闭包是下一批的候选。
 *   - 自定义 stereotype（元标注 `@Component` 的自造注解）与 `@Inject` / `@Qualifier`
 *     不在本批判据内（卡面只写 `@Autowired`）。
 *   - 方法与构造器同名的极少数写法会被当成构造器（Java 允许 `void Foo()`）。
 *
 * 用法：
 *   node scripts/check-spring-ctor-injection.mjs                    # 检查（真实树）
 *   node scripts/check-spring-ctor-injection.mjs --write-baseline   # 按当前命中重建基线
 *   node scripts/check-spring-ctor-injection.mjs --root <dir>       # 单树模式（测试/临时树）
 *   node scripts/check-spring-ctor-injection.mjs --baseline <file>
 *   node scripts/check-spring-ctor-injection.mjs --json
 *   node scripts/check-spring-ctor-injection.mjs --selftest
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
const DEFAULT_BASELINE = path.join(REPO_ROOT, 'config', 'spring-ctor-baseline.json');
const LF = '\n';
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'dist',
  'build',
  '.venv',
  '__pycache__',
  '.turbo',
]);

export const RULES = Object.freeze({
  MULTI_CTOR_NO_AUTOWIRED: 'spring-multi-ctor-no-autowired',
});

const AUTOWIRED_RE = /@(?:[\w.]+\.)?Autowired\b/u;
const STEREOTYPE_RE =
  /@(?:[\w.]+\.)?(?:Component|Service|Repository|Controller|RestController|Configuration|SpringBootApplication)\b/u;

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

/**
 * 默认扫描面：`packages/*\/src/main/java`（只看 production 源码）。
 * 一个 Java 根都没找到 ⇒ 结构性失败（不把「没扫到」当绿）。
 */
export function defaultRoots(repoRoot = REPO_ROOT) {
  const roots = [];
  const packagesDir = path.join(repoRoot, 'packages');
  if (isDir(packagesDir)) {
    for (const name of fs.readdirSync(packagesDir).sort()) {
      const dir = path.join(packagesDir, name, 'src', 'main', 'java');
      if (isDir(dir)) roots.push(dir);
    }
  }
  return { roots, missing: roots.length === 0 ? ['packages/*/src/main/java'] : [] };
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
      if (entry.isFile() && entry.name.endsWith('.java')) files.push(full);
    }
  }
  return files.sort();
}

/**
 * 把注释与字符串/字符字面量替换成空格（保留换行与字符偏移），供结构化匹配。
 * 返回 `masked` 与注释清单（`line` 为起始行，用于同行 `OK:` 豁免）。
 */
export function maskSource(source) {
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
    if (source.startsWith('"""', index)) {
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

export function isExempt(comments, lines) {
  return comments.some(
    (comment) => lines.includes(comment.line) && /OK:\s*\S/u.test(comment.text),
  );
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

function braceDepths(masked) {
  const depths = new Int32Array(masked.length + 1);
  let depth = 0;
  for (let index = 0; index < masked.length; index += 1) {
    depths[index] = depth;
    if (masked[index] === '{') depth += 1;
    else if (masked[index] === '}') depth -= 1;
  }
  depths[masked.length] = depth;
  return depths;
}

/** 从 `openParen` 之后找配对的 `)`；找不到返回 -1。 */
function matchParen(masked, openParen) {
  let depth = 0;
  for (let index = openParen; index < masked.length; index += 1) {
    if (masked[index] === '(') depth += 1;
    else if (masked[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** 声明头（上一处 `;` / `}` 之后到声明名之前）里的注解是否含 `@Autowired`。 */
function isAutowiredDeclaration(masked, nameIndex, bodyStart) {
  const from = Math.max(bodyStart + 1, Math.max(masked.lastIndexOf(';', nameIndex), masked.lastIndexOf('}', nameIndex)) + 1);
  return AUTOWIRED_RE.test(masked.slice(from, nameIndex));
}

/**
 * 扫一个 Java 源文件，返回 `{ types, hits, exempt }`。
 * 每条 hit 只带 `rule` / `line` / `type` / `constructors`，不含行号断言语义。
 */
export function scanJavaText(source) {
  const { masked, comments } = maskSource(source);
  const starts = lineStartsOf(masked);
  const depths = braceDepths(masked);
  const types = [];
  const hits = [];
  const exempt = [];
  const declaration = /\b(class|enum|record)\s+([A-Za-z_$][\w$]*)/gu;

  for (const typeMatch of masked.matchAll(declaration)) {
    const keyword = typeMatch[1];
    const name = typeMatch[2];
    const nameIndex = typeMatch.index + typeMatch[0].indexOf(name);
    const bodyStart = masked.indexOf('{', typeMatch.index);
    if (bodyStart < 0) continue;
    const baseDepth = depths[bodyStart] + 1;
    let bodyEnd = bodyStart + 1;
    for (; bodyEnd < masked.length; bodyEnd += 1) {
      if (masked[bodyEnd] === '}' && depths[bodyEnd] === baseDepth) break;
    }

    const constructorLines = [];
    let constructors = 0;
    let autowired = 0;
    const constructorPattern = new RegExp('\\b' + name + '\\s*\\(', 'gu');
    constructorPattern.lastIndex = bodyStart + 1;
    for (let match = constructorPattern.exec(masked); match; match = constructorPattern.exec(masked)) {
      const nameStart = match.index;
      if (nameStart >= bodyEnd) break;
      if (depths[nameStart] !== baseDepth) continue;
      const openParen = masked.indexOf('(', nameStart);
      const closeParen = matchParen(masked, openParen);
      if (closeParen < 0 || closeParen >= bodyEnd) continue;
      let cursor = closeParen + 1;
      while (cursor < bodyEnd && /\s/u.test(masked[cursor])) cursor += 1;
      if (masked.startsWith('throws', cursor)) {
        const brace = masked.indexOf('{', cursor);
        if (brace < 0 || brace > bodyEnd) continue;
        cursor = brace;
      }
      if (masked[cursor] !== '{') continue;
      const before = masked.slice(Math.max(bodyStart + 1, nameStart - 120), nameStart);
      if (/\bnew\s*$/u.test(before)) continue;
      if (keyword === 'record' && masked.slice(nameStart, openParen).includes('=')) continue;
      constructors += 1;
      constructorLines.push(lineAt(starts, nameStart));
      if (isAutowiredDeclaration(masked, nameStart, bodyStart)) autowired += 1;
    }

    if (keyword === 'record') {
      const compact = new RegExp('\\b' + name + '\\s*\\{', 'gu');
      compact.lastIndex = bodyStart + 1;
      for (let match = compact.exec(masked); match; match = compact.exec(masked)) {
        if (match.index >= bodyEnd) break;
        if (depths[match.index] !== baseDepth) continue;
        constructors += 1;
        constructorLines.push(lineAt(starts, match.index));
        if (isAutowiredDeclaration(masked, match.index, bodyStart)) autowired += 1;
        break;
      }
    }

    const headerFrom = Math.max(
      0,
      Math.max(masked.lastIndexOf(';', nameIndex), masked.lastIndexOf('}', nameIndex)) + 1,
    );
    const stereotype = STEREOTYPE_RE.test(masked.slice(headerFrom, nameIndex));
    const typeLine = lineAt(starts, nameIndex);
    const type = { type: name, keyword, line: typeLine, constructors, autowired, stereotype };
    types.push(type);

    if (constructors < 2 || autowired > 0) continue;
    const entry = {
      rule: RULES.MULTI_CTOR_NO_AUTOWIRED,
      line: typeLine,
      type: name,
      constructors,
      stereotype,
    };
    if (isExempt(comments, [typeLine, ...constructorLines])) exempt.push(entry);
    else hits.push(entry);
  }
  return { types, hits, exempt };
}

function tallyPush(tally, file) {
  tally.set(file, (tally.get(file) ?? 0) + 1);
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
      const relative = toPosix(path.relative(displayBase, file));
      files.push(relative);
      scanned += 1;
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (error) {
        throw new GateError('E_READ_FAILED', 'read failed: ' + relative + ' — ' + error.message);
      }
      const result = scanJavaText(text);
      for (const hit of result.hits) {
        hits.push({ file: relative, ...hit });
        tallyPush(tally, relative);
      }
      for (const hit of result.exempt) exempt.push({ file: relative, ...hit });
    }
  }
  return { files, scanned, hits, exempt, tally };
}

export function baselineFromTally(tally) {
  const files = {};
  let total = 0;
  for (const file of [...tally.keys()].sort()) {
    const count = tally.get(file);
    files[file] = count;
    total += count;
  }
  return { files, total };
}

export function compareBaseline(tally, baselineFiles) {
  const increased = [];
  const stale = [];
  for (const [file, count] of tally) {
    const allowed = baselineFiles[file] ?? 0;
    if (count > allowed) increased.push({ file, before: allowed, after: count });
    else if (count < allowed) stale.push({ file, before: allowed, after: count });
  }
  for (const [file, allowed] of Object.entries(baselineFiles)) {
    if (!tally.has(file)) stale.push({ file, before: allowed, after: 0 });
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
  for (const [entryFile, count] of Object.entries(doc.files)) {
    if (!Number.isInteger(count) || count < 0) {
      throw new GateError('E_BAD_BASELINE', file + ' 的 ' + entryFile + ' 计数非法：' + count);
    }
    files[entryFile] = count;
    sum += count;
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
      'task-720 ratchet 基线（grandfather）。登记「同一类型内构造器 >= 2 且无任何构造器带 ' +
      '@Autowired」的存量，按「文件 → 命中计数」。只许降不许升：任一计数升高 ⇒ ' +
      'check-spring-ctor-injection.mjs exit 1。判据是结构性的（不判定类是不是 Spring bean），' +
      'JPA 实体/DTO/异常的双构造器同样计入；逐条处置与待修清单见 ' +
      'internal/A03-xihe/evidence/2026-11-22-pitfall-gates/README.md。',
    generatedAt: new Date().toISOString(),
    a03Commit: shortCommit(repoRoot),
    scanRoots: roots.map((dir) => toPosix(path.relative(repoRoot, dir)) || '.'),
    total,
    files,
  };
}

function printFindings(scan, overFiles) {
  for (const hit of scan.hits) {
    if (!overFiles.has(hit.file)) continue;
    console.log(
      '[check-spring-ctor-injection] E_SPRING_CTOR_INJECTION: ' + hit.file + ':' + hit.line +
        '  [' + hit.rule + '] type=' + hit.type + ' constructors=' + hit.constructors,
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
    console.log('usage: node scripts/check-spring-ctor-injection.mjs [--root <dir>] [--baseline <file>]');
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
      throw new GateError('E_SCAN_ROOT_MISSING', '缺扫描根：' + resolved.missing.join(', '));
    }
    roots = resolved.roots;
    displayBase = REPO_ROOT;
  }

  const scan = scanTree(roots, { displayBase });
  if (scan.scanned === 0) {
    throw new GateError(
      'E_NO_SOURCE_FILES',
      '扫描了 0 个 Java 源文件（' + roots.join(', ') + '）——「什么也没扫到」不是安全',
    );
  }

  if (options.writeBaseline) {
    const doc = renderBaseline(scan, roots, options.root ? options.root : REPO_ROOT);
    fs.writeFileSync(options.baseline, JSON.stringify(doc, null, 2) + LF, 'utf8');
    if (options.json) {
      console.log(JSON.stringify({ ok: true, mode: 'write-baseline', path: options.baseline, total: doc.total }));
    } else {
      console.log(
        '[check-spring-ctor-injection] wrote baseline: total=' + doc.total + ' files=' +
          Object.keys(doc.files).length + ' -> ' + options.baseline,
      );
    }
    return 0;
  }

  const baseline = loadBaseline(options.baseline);
  const { increased, stale } = compareBaseline(scan.tally, baseline.files);
  const ok = increased.length === 0;
  const overFiles = new Set(increased.map((item) => item.file));
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
    console.log('[check-spring-ctor-injection] ' + summary);
    printFindings(scan, overFiles);
    for (const item of increased) {
      console.log('  OVER  ' + item.file + '  ' + item.before + ' -> ' + item.after);
    }
    for (const item of stale) {
      console.log(
        '  STALE ' + item.file + '  ' + item.before + ' -> ' + item.after +
          '（基线可收紧：跑 --write-baseline）',
      );
    }
    if (!ok) {
      console.log(
        '[check-spring-ctor-injection] FAIL 未登记命中或超基线。' +
          '确属有意为之请用同行 `// OK: <理由>` 豁免；不要放宽规则或把额度调高。',
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
 * 内置夹具：正例 / 三类反例 / 超基线 / 结构性失败。
 * 断言只钉意图（规则名、计数、退出码），不钉行号。
 */
export function selftest() {
  const checks = [];
  const record = (name, passed, detail = '') => checks.push({ name, passed, detail });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xh-spring-ctor-'));
  try {
    const positive = scanJavaText([
      'class ProbeMulti {',
      '  ProbeMulti(int a) { }',
      '  ProbeMulti(String b) { }',
      '}',
    ].join(LF));
    record(
      '正例：双构造器无 @Autowired ⇒ 1 条 spring-multi-ctor-no-autowired',
      positive.hits.length === 1 &&
        positive.hits[0].rule === RULES.MULTI_CTOR_NO_AUTOWIRED &&
        positive.hits[0].constructors === 2,
      JSON.stringify(positive.hits),
    );

    const single = scanJavaText([
      'class ProbeSingle {',
      '  ProbeSingle(int a) { }',
      '}',
    ].join(LF));
    record('反例：单构造器 ⇒ 0 条', single.hits.length === 0, JSON.stringify(single.hits));

    const annotated = scanJavaText([
      'import org.springframework.beans.factory.annotation.Autowired;',
      'class ProbeAutowired {',
      '  ProbeAutowired() { }',
      '  @Autowired',
      '  ProbeAutowired(int a) { }',
      '}',
    ].join(LF));
    record(
      '反例：双构造器但恰有一个 @Autowired（前一行注解）⇒ 0 条',
      annotated.hits.length === 0 && annotated.types[0].autowired === 1,
      JSON.stringify({ hits: annotated.hits, types: annotated.types }),
    );

    const fqn = scanJavaText([
      'class ProbeFqn {',
      '  ProbeFqn() { }',
      '  @org.springframework.beans.factory.annotation.Autowired ProbeFqn(int a) { }',
      '}',
    ].join(LF));
    record('反例：@Autowired 同行 FQN 写法 ⇒ 0 条', fqn.hits.length === 0, JSON.stringify(fqn.hits));

    const exempt = scanJavaText([
      'class ProbeExempt { // OK: 仅测试装配，Spring 不实例化',
      '  ProbeExempt(int a) { }',
      '  ProbeExempt(String b) { }',
      '}',
    ].join(LF));
    record(
      '反例：类声明行同行 `// OK: <理由>` ⇒ 0 条未豁免命中 + 1 条 exempt',
      exempt.hits.length === 0 && exempt.exempt.length === 1,
      JSON.stringify({ hits: exempt.hits, exempt: exempt.exempt }),
    );

    const notConstructors = scanJavaText([
      'class ProbeMasked {',
      '  // ProbeMasked(1, 2) in a comment is not a constructor',
      '  String note = "ProbeMasked(3, 4) in a string is not a constructor";',
      '  Object made = new ProbeMasked();',
      '  void call() { helper(ProbeMasked.class); }',
      '  ProbeMasked() { }',
      '}',
    ].join(LF));
    record(
      '反例：注释/字符串/new/类字面量里的同名文本不计入构造器 ⇒ 单构造器 0 条',
      notConstructors.hits.length === 0 && notConstructors.types[0].constructors === 1,
      JSON.stringify(notConstructors.types),
    );

    const nested = scanJavaText([
      'class ProbeOuter {',
      '  ProbeOuter() { }',
      '  static class Inner {',
      '    Inner() { }',
      '    Inner(int a) { }',
      '  }',
      '}',
    ].join(LF));
    record(
      '边界：嵌套类的构造器不借给外层类 ⇒ 只有 Inner 命中',
      nested.hits.length === 1 && nested.hits[0].type === 'Inner',
      JSON.stringify(nested.hits),
    );

    const tree = path.join(temp, 'tree');
    fs.mkdirSync(tree, { recursive: true });
    fs.writeFileSync(
      path.join(tree, 'Probe.java'),
      [
        'class Probe {',
        '  Probe(int a) { }',
        '  Probe(String b) { }',
        '}',
      ].join(LF) + LF,
      'utf8',
    );
    const baselineFile = path.join(temp, 'baseline.json');
    fs.writeFileSync(baselineFile, JSON.stringify({ total: 0, files: {} }), 'utf8');
    const over = runChild(['--root', tree, '--baseline', baselineFile]);
    record(
      '超基线：空基线 + 真实命中 ⇒ exit 1 且点名 E_SPRING_CTOR_INJECTION',
      over.status === 1 && over.output.includes('E_SPRING_CTOR_INJECTION'),
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
      console.error('[check-spring-ctor-injection] ' + error.code + ': ' + error.message);
    } else {
      console.error('[check-spring-ctor-injection] E_UNEXPECTED: ' + (error?.stack ?? error));
    }
    process.exitCode = 2;
  }
}
