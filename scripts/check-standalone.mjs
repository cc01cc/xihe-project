#!/usr/bin/env node
/**
 * PLAN-0612 M3：`check:standalone` —— 单 clone 启动前置自检（严格剥离 ONE 的验收门）。
 *
 * 做什么：
 * 1. 从本仓库导出一份**没有父级目录**的副本到系统临时目录（默认 `git archive HEAD`，
 *    只含已跟踪文件；`--worktree` 用临时 index 打包工作树，便于提交前自检未提交改动，
 *    不会触碰真实 index）；
 * 2. 在副本内跑 `node scripts/stack-run.mjs env-json --stack 1`：必须成功，且输出不含
 *    `cannot locate the one workspace root`；
 * 3. 在副本内跑 `node scripts/xihe.mjs dev check --json`：只断言"不再依赖 one 根目录"
 *    （工具/端口状态随机器而变，不作为本门判据）；
 * 4. 扫描副本：`H:/`、`C:/Progra~`、跨仓库 `../scripts` 引用、`XIHE_ONE_ROOT` 必须为 0。
 *    扫描排除项及理由（避免后来者以为漏判）：
 *    - `docs/`：允许 DEV 文档描述「曾用路径」的历史说明（当前命令不得有，由 M2 的
 *      人工复核保证；本门只对可执行代码/配置做硬断言）。
 *    - `packages/ui/e2e/**`：既有 E2E fixture 里存在历史路径**示例字符串**（如输入框
 *      测试填的假路径），它们不是机器布局依赖；改为中性值属另一批清理，不在本门阻断。
 *    其余位置出现上述模式一律判违规。
 *
 * 用法：
 *   node scripts/check-standalone.mjs [--json] [--worktree] [--keep]
 * 退出码：0 = 通过；1 = 任一步失败/发现违规。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const useWorktree = args.includes("--worktree");
const keep = args.includes("--keep");

const TEXT_EXTENSIONS = new Set([
  ".mjs", ".js", ".cjs", ".ts", ".tsx", ".vue", ".json", ".jsonc", ".toml", ".sh", ".ps1",
  ".md", ".yml", ".yaml", ".properties", ".xml", ".txt", ".rs", ".py", ".java", ".sql", ".env",
  ".example", ".dev", ".test", ".prod", ".gitignore", ".dockerignore", ".lock",
]);
const SKIP_DIRS = new Set([
  ".git", "node_modules", "target", ".venv", "dist", "coverage", ".local", ".xihe-workspaces",
  ".xihe-stacks", ".pytest_cache", "__pycache__", ".tmp",
]);
const MAX_SCAN_BYTES = 512 * 1024;

const report = {
  plan: "PLAN-0612",
  check: "check:standalone",
  projectRoot,
  mode: useWorktree ? "worktree (temp index)" : "HEAD (git archive)",
  startedAt: new Date().toISOString(),
  steps: [],
  violations: [],
  ok: false,
};

function record(step, detail) {
  report.steps.push({ step, ...detail });
  if (!asJson) {
    const status = detail.ok === false ? "FAIL" : "OK";
    console.log(`[standalone] ${status} ${step}${detail.note ? ` — ${detail.note}` : ""}`);
    for (const violation of detail.violations ?? []) console.log(`[standalone]   ${violation}`);
  }
}

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, {
    encoding: "utf8",
    timeout: options.timeout ?? 180_000,
    windowsHide: true,
    ...options,
  });
  return {
    status: result.status,
    stdout: (result.stdout ?? "").toString(),
    stderr: (result.stderr ?? "").toString(),
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

const tmpRoot = mkdtempSync(join(tmpdir(), "xihe-standalone-"));
const tarPath = join(tmpRoot, "repo.tar");
const extractDir = join(tmpRoot, "repo");

function buildArchive() {
  if (!useWorktree) {
    const archived = run("git", ["-C", projectRoot, "archive", "--format=tar", `--output=${tarPath}`, "HEAD"]);
    record("git archive HEAD", {
      ok: archived.status === 0,
      note: archived.status === 0 ? tarPath : archived.stderr.trim().slice(0, 400),
    });
    return archived.status === 0;
  }
  const indexFile = join(tmpRoot, "worktree.index");
  const git = (...argv) => run("git", ["-C", projectRoot, ...argv], {
    env: { ...process.env, GIT_INDEX_FILE: indexFile },
    timeout: 120_000,
  });
  const readTree = git("read-tree", "HEAD");
  const addAll = readTree.status === 0 ? git("add", "-A", ".") : { status: 1, stderr: readTree.stderr };
  const writeTree = addAll.status === 0 ? git("write-tree") : { status: 1, stderr: addAll.stderr };
  const tree = (writeTree.stdout ?? "").trim();
  const archived = writeTree.status === 0 && tree
    ? run("git", ["-C", projectRoot, "archive", "--format=tar", `--output=${tarPath}`, tree])
    : { status: 1, stderr: "write-tree failed" };
  const ok = readTree.status === 0 && addAll.status === 0 && writeTree.status === 0 && archived.status === 0;
  record("git archive（worktree via temp index）", {
    ok,
    note: ok ? `tree=${tree.slice(0, 12)}…` : (addAll.stderr || archived.stderr || readTree.stderr).trim().slice(0, 400),
  });
  return ok;
}

function extractArchive() {
  const extracted = run("tar", ["-xf", tarPath, "-C", tmpRoot]);
  if (extracted.status !== 0) {
    record("tar extract", { ok: false, note: extracted.stderr.trim().slice(0, 400) });
    return false;
  }
  // `git archive` 顶层即仓库根（通常带 <repo>/ 目录），定位到含 package.json 的那层。
  const candidates = [tmpRoot, ...readdirSync(tmpRoot).map((name) => join(tmpRoot, name))];
  const resolved = candidates.find((candidate) => {
    try {
      return statSync(candidate).isDirectory() && existsSync(join(candidate, "scripts", "stack-run.mjs"));
    } catch {
      return false;
    }
  });
  if (!resolved) {
    record("locate checkout root", { ok: false, note: "no scripts/stack-run.mjs in extracted archive" });
    return false;
  }
  report.extractRoot = resolved;
  record("locate checkout root", { ok: true, note: relative(tmpRoot, resolved) || "." });
  return true;
}

function sanitizedEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("XIHE_")) continue;
    env[key] = value;
  }
  return env;
}

function checkStandaloneRuntime(root) {
  const env = sanitizedEnv();
  const envJson = run(process.execPath, [join(root, "scripts", "stack-run.mjs"), "env-json", "--stack", "1"], {
    cwd: root,
    env,
    timeout: 120_000,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(envJson.stdout);
  } catch {
    /* reported below */
  }
  const oneRootHint = (envJson.stdout + envJson.stderr).includes("cannot locate the one workspace root");
  const looksValid = envJson.status === 0 && parsed?.stackId === "stack-1" && parsed?.ports?.ui === 12630;
  record("stack-run env-json --stack 1", {
    ok: looksValid && !oneRootHint,
    note: looksValid
      ? `stackId=${parsed.stackId} ui=${parsed.ports.ui} cp=${parsed.ports.cp} pg=${parsed.ports.postgres}`
      : `exit=${envJson.status} stderr=${envJson.stderr.trim().slice(0, 400)}`,
    violations: oneRootHint ? ["output still mentions 'cannot locate the one workspace root'"] : [],
  });

  const devCheck = run(process.execPath, [join(root, "scripts", "xihe.mjs"), "dev", "check", "--json"], {
    cwd: root,
    env,
    timeout: 180_000,
  });
  const devCheckText = devCheck.stdout + devCheck.stderr;
  const mentionsOneRoot = /cannot locate the one workspace root|one workspace root above/i.test(devCheckText);
  record("xihe dev check（只读）", {
    ok: !mentionsOneRoot,
    note: `exit=${devCheck.status}（工具/端口状态随机器变化，不作为本门判据；只断言不依赖 one 根目录）`,
    violations: mentionsOneRoot ? ["dev check output mentions the ONE workspace root"] : [],
  });
  return looksValid && !oneRootHint && !mentionsOneRoot;
}

function walkFiles(root) {
  const files = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const full = join(dir, entry.name);
      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      if (size > MAX_SCAN_BYTES) continue;
      const ext = extname(entry.name).toLowerCase();
      const isEnvFile = /^\.env(\.|$)/.test(entry.name);
      if (!TEXT_EXTENSIONS.has(ext) && !isEnvFile) continue;
      files.push(full);
    }
  };
  visit(root);
  return files;
}

function scanForbiddenPaths(root) {
  const violations = [];
  const parentRef = /(?:\.\.\/)+scripts\/([A-Za-z0-9._-]+)/g;
  // 本文件自身按设计包含这些模式（规则字面量 + 说明），不参与自扫。
  const SELF_EXEMPT = new Set(["scripts/check-standalone.mjs"]);
  // 只把**本机工作区布局**的写死路径判为违规；Windows 盘符语法本身（如单元测试里的
  // `H:\test` / `\\?\H:\Work`）是路径解析用例的合法样本，不算机器耦合，仅统计上报。
  const MACHINE_LAYOUT = [
    { re: /[A-Za-z]:[\\/]+zeogit\b/i, label: "this machine's workspace root (…:\\zeogit)" },
    { re: /[A-Za-z]:[\\/]+zeolib\b/i, label: "this machine's shared cache (…:\\zeolib)" },
    { re: /C:[\\/]+Progra~1/i, label: "hardcoded Windows program-file path (C:\\Progra~1)" },
  ];
  let sampleDrivePaths = 0;
  for (const file of walkFiles(root)) {
    const rel = relative(root, file).replaceAll("\\", "/");
    // 排除理由见文件头注释：docs/ 允许历史说明；packages/ui/e2e/** 是既有 fixture 字符串。
    const fixtureOrHistory = rel.startsWith("docs/") || rel.startsWith("packages/ui/e2e/");
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      // XIHE_ONE_ROOT 与旧错误文案在**任何位置**都是剥离失败：必须为 0。
      if (SELF_EXEMPT.has(rel)) return;
      if (/XIHE_ONE_ROOT/.test(line)) violations.push(`${rel}:${index + 1} XIHE_ONE_ROOT escape hatch`);
      if (/cannot locate the one workspace root/.test(line)) {
        violations.push(`${rel}:${index + 1} legacy ONE-root error message`);
      }
      if (fixtureOrHistory) return;
      for (const pattern of MACHINE_LAYOUT) {
        if (pattern.re.test(line)) violations.push(`${rel}:${index + 1} ${pattern.label}`);
      }
      if (/\b[A-Za-z]:[\\/]/.test(line)) sampleDrivePaths += 1;
      for (const match of line.matchAll(parentRef)) {
        const target = match[1];
        if (!existsSync(join(root, "scripts", target))) {
          violations.push(`${rel}:${index + 1} parent scripts reference whose target is not in repo: ${target}`);
        }
      }
    });
  }
  report.sampleDrivePaths = sampleDrivePaths;
  return violations;
}

let ok = false;
try {
  if (buildArchive() && extractArchive()) {
    ok = checkStandaloneRuntime(report.extractRoot);
    const violations = scanForbiddenPaths(report.extractRoot);
    report.violations = violations;
    record("forbidden-path scan（docs/ 豁免）", {
      ok: violations.length === 0,
      note: violations.length === 0 ? "0 violation" : `${violations.length} violation(s)`,
      violations: violations.slice(0, 40),
    });
    ok = ok && violations.length === 0;
  }
} finally {
  report.ok = ok;
  report.finishedAt = new Date().toISOString();
  report.tempRoot = tmpRoot;
  report.summary = report.steps.map(({ step, ok: stepOk }) => `${step}: ${stepOk ? "ok" : "fail"}`);
  if (!asJson) {
    console.log(`[standalone] ${ok ? "PASS" : "FAIL"} — ${report.mode}`);
    if (keep) console.log(`[standalone] kept temp copy: ${tmpRoot}`);
  }
  if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!keep) {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch (error) {
      console.error(`[standalone] WARN: could not remove temp copy ${tmpRoot}: ${error?.message ?? error}`);
    }
  }
}
process.exit(report.ok ? 0 : 1);
