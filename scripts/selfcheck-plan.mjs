#!/usr/bin/env node
/**
 * 模块自检 planner（`task-45`）：**只打印命令清单，不执行任何命令**。
 *
 * 为什么只打印：进 L2 窗口前的自检必须由改动者在本机自己的 worktree 跑（有上下文、能看红点、
 * 能当场分类）；把"跑测试"塞进 planner 只会造出第二个没人看的日志。判据是「谁在用 + 能否重建」：
 * 命令清单需要**单一可读的单源**（能重建、能被文档引用），跑的动作留在人/lane 手里。
 *
 * 所以本文件**不 import `node:child_process`**、不产生子进程、不读被测仓库状态；唯一的副作用是 stdout。
 * 闸：`git grep -n "spawn\|execFile\|exec(" -- scripts/selfcheck-plan.mjs` 必须 0 命中。
 *
 * 用法：
 *   node scripts/selfcheck-plan.mjs --list             # 所有 scope（人读）
 *   node scripts/selfcheck-plan.mjs --check-anchors    # 校验全部 evidence 指针（锚点自检，task-593）
 *   node scripts/selfcheck-plan.mjs --selftest         # 锚点自检自身的自测（含「插一行后行号锚点必错」负例）
 *   node scripts/selfcheck-plan.mjs --scope=ui,cp      # 只看这些 scope（逗号或空格分隔，按给出顺序打印）
 *   node scripts/selfcheck-plan.mjs --scope=ui --json  # 机读：单行 JSON（供 pipeline/门禁消费）
 *   node scripts/selfcheck-plan.mjs --help
 * 退出码：0 = 打印成功（**不代表自检通过**）；2 = 参数错误（未知 scope / 缺参数），并列出合法 scope。
 *
 * 与文档的关系：`internal/A03-xihe/docs/module-selfcheck-matrix.md` §4 是人读副本，本文件的 SCOPES
 * 是命令单源；两者不一致时以本文件为准，并同批把文档改回来。
 */

/**
 * 每条命令三个字段：
 * - dir：进哪个目录再跑；
 * - cmd：命令原文（PowerShell 可直接粘贴，占位符用 <…>）；
 * - verdict：**通过判据**（可判定句，写明看退出码还是看哪一行输出）；
 * - evidence：存在性证据（文件:行号 / 脚本路径 / mise task 行号）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCOPES = {
  ui: {
    label: "UI（Vue 3 + Vite）",
    triggers: ["packages/ui/src/**", "packages/ui/e2e/**", "packages/ui/package.json"],
    upgrade: "需要真实浏览器证据、或跨服务契约证据 ⇒ 升 L2",
    steps: [
      {
        level: "S0",
        title: "单 spec（改哪个跑哪个）",
        dir: "packages/ui",
        cmd: "pnpm run test:unit -- <spec 路径>",
        verdict: '输出含 "Test Files  1 passed (1)" 且 exit 0（有红即 exit 1）',
        evidence:
          "packages/ui/package.json scripts.test:unit=vitest run；packages/ui/AGENTS.md:25；mise.toml [tasks.\"test:ui\"]",
      },
      {
        level: "S0",
        title: "类型门",
        dir: "packages/ui",
        cmd: "pnpm run typecheck",
        verdict: "vue-tsc --noEmit 静默无输出 + exit 0（报 TS#### 即失败）",
        evidence:
          "packages/ui/package.json scripts.typecheck=vue-tsc --noEmit；mise.toml [tasks.\"typecheck:ui\"]；packages/ui/AGENTS.md:26",
      },
      {
        level: "S0",
        title: "lint（oxfmt 格式 + oxlint 规则）",
        dir: "packages/ui",
        cmd: "pnpm run lint",
        verdict: "oxfmt 全绿 + oxlint 报 0 error（warnings 允许）；exit 0",
        evidence: "packages/ui/package.json scripts.lint；mise.toml [tasks.\"lint:ui\"] !oxlint；判据 packages/ui/AGENTS.md:34",
      },
      {
        level: "S0",
        title: "E2E 类型门（改 e2e/** 或 DOM 合同时；只拦新增类型错误，不执行 E2E）",
        dir: "packages/ui",
        cmd: "pnpm run typecheck:e2e",
        verdict: "与 e2e-typecheck-baseline.json 比对后无新增错误 + exit 0",
        evidence: "packages/ui/package.json scripts.typecheck:e2e；packages/ui/AGENTS.md:32",
      },
      {
        level: "S1",
        title: "全量单测（硬规矩 R2：申请窗口前必跑，回执须贴 Test Files 汇总行）",
        dir: "packages/ui",
        cmd: "pnpm exec vitest run",
        verdict: '末段 "Test Files  <N> passed (<N>)" + "Tests  <N> passed"；有红即 exit 1',
        evidence: "AGENTS.md:133（全量 ~150s）；mise run test:ui = mise.toml [tasks.\"test:ui\"]",
      },
      {
        level: "S1",
        title: "e2e 夹具自测（改 e2e/fixtures/** 必跑，秒级、不起栈）",
        dir: "A03-xihe 根",
        cmd: "mise run test:e2e:fixtures",
        verdict: 'node --test 汇总 "# fail 0" + exit 0',
        evidence: "mise.toml [tasks.\"test:e2e:fixtures\"]；并入 validate 见 mise.toml [tasks.validate]",
      },
      {
        level: "S1",
        title: "mock lane（改 mock lane 或组件交互时；需 chrome-beta + --workers=4）",
        dir: "A03-xihe 根",
        cmd: "mise run test:mock",
        verdict: 'playwright 汇总行 "N passed"（flaky 由 retries 吸收）+ exit 0',
        evidence: "mise.toml [tasks.\"test:mock\"] !XIHE_E2E_PROFILE （两个 load-bearing env pin 在该 block 内）",
      },
    ],
  },

  cp: {
    label: "Control Plane（Java 25 / Spring Boot 4）",
    triggers: ["packages/control-plane/src/**", "packages/control-plane/pom.xml"],
    upgrade: "全量 mvn test / 契约或迁移变更 / 需要真栈证据 ⇒ 升 L2",
    steps: [
      {
        level: "S0",
        title: "冷编（硬规矩 R1：含 clean，增量会假 SUCCESS；同输出目录只允许一个写者）",
        dir: "packages/control-plane",
        cmd: "mvn -o -q clean test-compile",
        verdict: "exit 0（-q 下成功几乎无输出，BUILD SUCCESS 被抑制 ⇒ 只看退出码；有编译错即非 0）",
        evidence:
          "packages/control-plane/AGENTS.md:34；并发边界 :45-52、:62-66；依据 one/AGENTS.md §工程与验证",
      },
      {
        level: "S0",
        title: "定向测试（类名，必要时 #方法）",
        dir: "packages/control-plane",
        cmd: "mvn -o test -Dtest=<TestClass>[#method]",
        verdict: '末行 "Tests run: X, Failures: 0, Errors: 0, Skipped: Y" + exit 0',
        evidence: "packages/control-plane/AGENTS.md:35 !ApprovalServiceTest；packages/control-plane/AGENTS.md:41 !mvn",
      },
      {
        level: "S0",
        title: "Checkstyle（severity=error 全规则阻断，基线 0 违规）",
        dir: "packages/control-plane",
        cmd: "mvn -o -q checkstyle:check",
        verdict: "exit 0（-q 下静默；任何新增违规即非 0，不做 warning 降级）；task-583 起同一门也钉在 Maven 的 validate 相位（pom.xml execution=checkstyle-check-early）⇒ mvn -o -q test-compile / mvn -o test -Dtest=X 同样先红，不再依赖「记得单独跑」",
        evidence: "packages/control-plane/AGENTS.md:36（命令清单）、:43（task-583 绑相位）、:101（规则与阻断口径）；mise.toml [tasks.\"lint:cp\"] !checkstyle",
      },
      {
        level: "S0",
        title: "契约门（改 route/SSE/OpenAPI/Flyway 时；也是 test:cp 的依赖）",
        dir: "A03-xihe 根",
        cmd: "mise run check:openapi",
        verdict: "打印结构 + 冻结切片校验摘要 + exit 0（漂移即非 0）",
        evidence: "mise.toml [tasks.\"check:openapi\"]（BL-162）；test:cp 依赖见 mise.toml [tasks.\"test:cp\"]",
      },
      {
        level: "S0",
        title: "迁移号（改 src/main/resources/db/migration/V*.sql 时；另按 AGENTS.md:112 定号三查）",
        dir: "packages/control-plane",
        cmd: "mvn -o -q test -Dtest=DomainSchemaMigrationTest",
        verdict: '末行 "Tests run: X, Failures: 0, Errors: 0" + exit 0（+ 人工核「最高号 +1」）',
        evidence:
          "测试类 src/test/java/com/cc01cc/p/xihe/cp/migration/DomainSchemaMigrationTest.java；定号规则 packages/control-plane/AGENTS.md:114 !迁移号",
      },
      {
        level: "S1",
        title: "CP 全量 + 已知基线判定（申请窗口前自证；先跑全量再判基线）",
        dir: "A03-xihe 根",
        cmd: "mise run test:cp && mise run test:cp:baseline",
        verdict:
          "test:cp 允许红 = BL-368 已登记条；紧随的 test:cp:baseline exit 0 才表示「失败 ⊆ 基线」",
        evidence:
          "mise.toml [tasks.\"test:cp:baseline\"]、:182（BL-368：基线只许缩小、reviewBy 过期即失败、报告早于 HEAD ⇒ exit 2）",
      },
    ],
  },

  agent: {
    label: "Agent（Python 3.12）",
    triggers: ["packages/agent/src/**", "packages/agent/tests/**", "packages/agent/pyproject.toml"],
    upgrade: "需要真实 PG 集成（-m integration）⇒ 升 L2",
    steps: [
      {
        level: "S0",
        title: "定向单测",
        dir: "packages/agent",
        cmd: 'uv run pytest tests/unit/<file>.py -k "<test_name>" -v',
        verdict: '末行含 "1 passed"（或 N passed）且无 failed/error；exit 0',
        evidence: "packages/agent/AGENTS.md:25 !pytest；packages/agent/AGENTS.md:68 !必须",
      },
      {
        level: "S0",
        title: "lint",
        dir: "packages/agent",
        cmd: "uv run ruff check src/",
        verdict: '输出 "All checks passed!" + exit 0',
        evidence: "packages/agent/AGENTS.md:30；mise.toml [tasks.\"lint:agent\"] !ruff",
      },
      {
        level: "S0",
        title: "类型门（真实阻断门，禁止恢复全局吞错）",
        dir: "packages/agent",
        cmd: "uv run mypy src/",
        verdict: '输出 "Success: no issues found" + exit 0',
        evidence: "packages/agent/AGENTS.md:31",
      },
      {
        level: "S1",
        title: '全量单测（默认 -m "not integration"）',
        dir: "A03-xihe 根",
        cmd: "mise run test:agent",
        verdict: 'pytest 汇总 "… passed, … deselected" 且无 failed；exit 0',
        evidence: "mise.toml [tasks.\"test:agent\"]；默认 deselect 见 packages/agent/AGENTS.md:29",
      },
      {
        level: "S1",
        title: "质量回归门（改评测/行为面时）",
        dir: "A03-xihe 根",
        cmd: "mise run gate:agent-quality -- --report <invariant.json> --report <behavior.json> --baseline <baseline.json>",
        verdict: "退出码语义：0=PASS / 1=FAIL / 2=NOT_EVALUATED / 3=GATE_ERROR，**只有 0 算过**",
        evidence: "mise.toml [tasks.\"gate:agent-quality\"]",
      },
    ],
  },

  runtime: {
    label: "Runtime（Rust 1.97）",
    triggers: ["packages/runtime/src/**", "packages/runtime/Cargo.toml", "A03-xihe/.cargo/config.toml"],
    upgrade: "需要 Docker/host 沙盒或 E2E ⇒ 升 L2（cargo test --locked 全量含沙盒）",
    steps: [
      {
        level: "S0",
        title: "定向单测（lib）",
        dir: "packages/runtime",
        cmd: "cargo test --locked --lib <test_name>",
        verdict: '末行 "test result: ok." + exit 0',
        evidence: "packages/runtime/AGENTS.md:19；mise.toml [tasks.\"test:runtime:lib\"]",
      },
      {
        level: "S0",
        title: "格式检查",
        dir: "packages/runtime",
        cmd: "cargo fmt --check",
        verdict: "无输出 + exit 0（列出 diff 即失败）",
        evidence: "packages/runtime/AGENTS.md:26；mise.toml [tasks.\"lint:runtime\"] !fmt",
      },
      {
        level: "S0",
        title: "lint（门禁口径 = -D warnings）",
        dir: "packages/runtime",
        cmd: "cargo clippy --locked --all-targets -- -D warnings",
        verdict: "无 warning/error + exit 0（瞬态抖动时单独重跑本条复判）",
        evidence: "packages/runtime/AGENTS.md:25；mise.toml [tasks.\"lint:runtime\"] !clippy",
      },
      {
        level: "S1",
        title: "竞态复验门（改并发/进程级全局状态后；串行 1 + 并行 3）",
        dir: "A03-xihe 根",
        cmd: "mise run test:runtime:lib:gate",
        verdict: '4 次运行全部 "test result: ok." + exit 0',
        evidence: "mise.toml [tasks.\"test:runtime:lib:gate\"]（BL-262；故意不进 validate）",
      },
    ],
  },

  cli: {
    label: "A03 脚本层（scripts/**）",
    triggers: ["A03-xihe/scripts/**"],
    upgrade: "一般不升 L2",
    steps: [
      {
        level: "S0",
        title: "单文件单测",
        dir: "A03-xihe 根",
        cmd: "node --test scripts/<改的>.test.mjs",
        verdict: '汇总 "# fail 0" + exit 0',
        evidence: "mise.toml [tasks.\"test:cli\"] !node --test",
      },
      {
        level: "S0",
        title: "清单接线门（新增/改名 *.test.mjs 后必跑）",
        dir: "A03-xihe 根",
        cmd: "node --test scripts/test-wiring.test.mjs",
        verdict: '汇总 "# fail 0" + exit 0（它会点出漏登记的文件）',
        evidence: "scripts/test-wiring.test.mjs（钉住 test:cli 的显式清单）",
      },
      {
        level: "S1",
        title: "全量脚本单测",
        dir: "A03-xihe 根",
        cmd: "mise run test:cli",
        verdict: '显式清单跑完 "# fail 0"，且尾部 check-test-global-state 不报违规 + exit 0',
        evidence: "mise.toml [tasks.\"test:cli\"]",
      },
    ],
  },

  contract: {
    label: "契约面（OpenAPI / 端口 / 启动链路）",
    triggers: [
      "A03-xihe/docs/api/openapi.yaml",
      "A03-xihe/scripts/lib/stack-ports.mjs",
      "one/config/ports.mjs",
    ],
    upgrade: "跨模块契约漂移、SSE/AgentEvent/durable record ⇒ 升 L2 + 按 xc-cross-cutting-checklist",
    steps: [
      {
        level: "S0",
        title: "OpenAPI 契约门（改 route/DTO/契约切片）",
        dir: "A03-xihe 根",
        cmd: "mise run check:openapi",
        verdict: "打印校验摘要 + exit 0（结构/冻结切片漂移即非 0）",
        evidence: "mise.toml [tasks.\"check:openapi\"]；依赖关系 mise.toml [tasks.\"test:cp\"]",
      },
      {
        level: "S0",
        title: "端口双单源 parity（改端口表任一侧）",
        dir: "A03-xihe 根",
        cmd: "mise run check:ports",
        verdict: "打印逐项比对结果 + exit 0（无 ONE 时显式 standalone OK，不 skip）",
        evidence: "mise.toml [tasks.\"check:ports\"]",
      },
      {
        level: "S0",
        title: "严格剥离门（改启动链路/依赖 ONE 的路径时）",
        dir: "A03-xihe 根",
        cmd: "mise run check:standalone",
        verdict: "打印导出 + 无 ONE 启动验证结果 + exit 0",
        evidence: "mise.toml [tasks.\"check:standalone\"] !PLAN-0612",
      },
    ],
  },

  docs: {
    label: "文档面 / 提交门",
    triggers: ["A03-xihe/docs/**", "**/AGENTS.md", "A03-xihe/README.md"],
    upgrade: "无（不进 L2）",
    steps: [
      {
        level: "S0",
        title: "文档链接（ONE 主检出缺席时显式 skip 并 exit 0）",
        dir: "A03-xihe 根",
        cmd: "mise run lint:links",
        verdict: "exit 0（死链即非 0；skip 也 exit 0，注意看输出里的 skip 理由）",
        evidence: "mise.toml [tasks.\"lint:links\"]",
      },
      {
        level: "S0",
        title: "提交信息机读门（a632de77..HEAD，已 --enforce 阻断）",
        dir: "A03-xihe 根",
        cmd: "mise run check:commit-msg",
        verdict: "exit 0（超宽/缺 PLAN-#### 引用/首行类型不符即非 0）",
        evidence: "mise.toml [tasks.\"check:commit-msg\"]",
      },
      {
        level: "S0",
        title: "凭证泄露扫描（改了 logs/证据目录时）",
        dir: "A03-xihe 根",
        cmd: "mise run lint:log-secrets",
        verdict: "exit 0（命中疑似凭证即非 0）",
        evidence: "mise.toml [tasks.\"lint:log-secrets\"]",
      },
    ],
  },

  e2e: {
    label: "E2E 面（packages/ui/e2e/**）",
    triggers: ["packages/ui/e2e/**", "packages/ui/src/components/**（DOM 合同变更）"],
    upgrade: "改真链路或跨服务 ⇒ mise run test:e2e:host 属 L2，不许在自检里跑",
    steps: [
      {
        level: "S0",
        title: "类型门",
        dir: "packages/ui",
        cmd: "pnpm run typecheck:e2e",
        verdict: "与基线比对后无新增错误 + exit 0",
        evidence: "packages/ui/package.json scripts.typecheck:e2e；packages/ui/AGENTS.md:32",
      },
      {
        level: "S0",
        title: "夹具自测（改 e2e/fixtures/** 必跑）",
        dir: "A03-xihe 根",
        cmd: "mise run test:e2e:fixtures",
        verdict: '汇总 "# fail 0" + exit 0',
        evidence: "mise.toml [tasks.\"test:e2e:fixtures\"]",
      },
      {
        level: "S0",
        title: "DOM 合同清扫：原生 select / option 依赖（DOM/role/aria/testid/文案变更必跑）",
        dir: "A03-xihe 根",
        cmd: `rg -n 'selectOption\\(|locator\\(["''](select|option)' packages/ui/e2e`,
        verdict:
          "**不看退出码**（rg 有命中=0、无命中=1）；按本 PLAN 契约面过滤后须 0 行，或每行在回执里写明已同批改/为何不受影响",
        evidence:
          "internal/A03-xihe/docs/module-selfcheck-matrix.md §5（本仓基线 2026-11-08 实测 75 行/33 文件）",
      },
      {
        level: "S0",
        title: "DOM 合同清扫：文案断言（与本 PLAN 改动的组件相关时逐条确认）",
        dir: "A03-xihe 根",
        cmd: 'rg -n "getByText\\(|toContainText\\(" packages/ui/e2e',
        verdict: "**不看退出码**；命中处须逐条确认是否写的是本 PLAN 改动过的文案/控件",
        evidence: "internal/A03-xihe/docs/module-selfcheck-matrix.md §5（本仓 2026-11-08 实测 552 行存量）",
      },
      {
        level: "S0",
        title: "单 spec（mock lane；两个 env pin 别丢）",
        dir: "packages/ui",
        cmd: "pnpm exec playwright test --config e2e/playwright.config.ts e2e/mock/<spec> --reporter=list --workers=4",
        verdict: '汇总 "1 passed"（或 N passed）+ exit 0',
        evidence: "mise.toml [tasks.\"test:mock\"] !chrome-beta",
      },
    ],
  },
};

const USAGE = [
  "模块自检 planner —— 只打印命令，不执行",
  "",
  "  node scripts/selfcheck-plan.mjs --list            所有 scope（人读）",
  "  node scripts/selfcheck-plan.mjs --scope=ui,cp     只看这些 scope（按给出顺序）",
  "  node scripts/selfcheck-plan.mjs --scope=ui --json 机读单行 JSON",
  "  node scripts/selfcheck-plan.mjs --help",
  "",
  "退出码：0 = 打印成功（不代表自检通过）；2 = 参数错误",
  "回执格式：internal/A03-xihe/docs/module-selfcheck-matrix.md §6",
].join("\n");

function pad(s, n) {
  // 中文按 2 列估算，仅用于对齐输出
  const width = [...s].reduce((w, ch) => w + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + " ".repeat(Math.max(0, n - width));
}

/* ────────────────────────── 指针锚点自检（task-593） ──────────────────────────
 * 为什么要有这个：evidence 原先全是 `file:LINE` 行号锚点。2026-11-14 task-583 往
 * packages/control-plane/AGENTS.md 插了 2 行，同文件 3 处指针当场错位；抽样 34 条里 10 条
 * 指向了无关内容（其中 1 条指向空行）。**行号锚点必然漂** ⇒ 首选键名/符号锚点，行号只作兜底，
 * 两种形态都由本自检覆盖。
 *
 * 支持的指针形态（`!kw` 可选 = 该处必须出现关键词，专挡「行号对、内容换了」）：
 *   mise.toml [tasks."lint:cp"] !checkstyle   键名锚点：该任务 block 内必须含关键词
 *   AGENTS.md:133 !150                        兜底行锚点：该行必须非空且含关键词
 *   module-selfcheck-matrix.md §5             章节锚点：文件内必须有该节标题
 */
const ANCHOR_RE =
  /((?:[\w.-]+\/)*[\w.-]+\.(?:toml|mjs|json|md|ya?ml))(?::(\d+)(?:-\d+)?|\s*\[([^\]]+)\]|\s*§([^\s（(]+))(?:\s*!([^\s；、，。)）]+))?/g;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseAnchors(text) {
  const out = [];
  ANCHOR_RE.lastIndex = 0;
  let m;
  while ((m = ANCHOR_RE.exec(text)) !== null) {
    out.push({
      file: m[1],
      line: m[2] ? Number(m[2]) : null,
      symbol: m[3] ?? null,
      section: m[4] ?? null,
      keyword: m[5] ?? null,
    });
  }
  return out;
}

function readRepoFile(rel, root = REPO_ROOT) {
  const candidates = [rel, ...["control-plane", "agent", "runtime", "ui"].map((p) => `packages/${p}/${rel}`)];
  // A03-xihe 仓内指针以本仓根为基准；跨仓指针（one 工作区根下的 internal/ …）与 one/ 前缀单独兜
  const up = path.resolve(root, "..");
  if (rel.startsWith("one/")) candidates.push(path.join(up, rel.slice(4)));
  if (/^(internal|spec|docs|plans|scripts)\//.test(rel)) candidates.push(path.join(up, rel));
  for (const c of candidates) {
    try {
      return { rel: c, lines: fs.readFileSync(path.resolve(root, c), "utf8").split(/\r?\n/) };
    } catch {
      // 试下一个候选路径；全部失败由调用方报 E_FILE_NOT_FOUND
    }
  }
  return null;
}

function checkAnchor(anchor, root = REPO_ROOT) {
  const target = readRepoFile(anchor.file, root);
  if (!target) return { ok: false, why: `E_FILE_NOT_FOUND ${anchor.file}` };
  const body = target.lines;
  if (anchor.symbol) {
    const at = body.findIndex((l) => l.includes(anchor.symbol));
    if (at < 0) return { ok: false, why: `E_SYMBOL_MISSING ${anchor.file} 里没有 ${anchor.symbol}` };
    if (anchor.keyword) {
      let end = body.length;
      for (let i = at + 1; i < body.length; i++) {
        if (/^\[tasks\./.test(body[i])) { end = i; break; }
      }
      if (!body.slice(at, end).join("\n").includes(anchor.keyword)) {
        return { ok: false, why: `E_KEYWORD_MISSING ${anchor.file} ${anchor.symbol} 内无「${anchor.keyword}」` };
      }
    }
    return { ok: true, where: `${target.rel}:${at + 1}（${anchor.symbol}）` };
  }
  if (anchor.section) {
    const esc = anchor.section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const at = body.findIndex((l) => new RegExp(`^#+\\s*${esc}(\\D|$)`).test(l) || l.includes(`§${anchor.section}`));
    if (at < 0) return { ok: false, why: `E_SECTION_MISSING ${anchor.file} 无「${anchor.section}」节` };
    return { ok: true, where: `${target.rel}:${at + 1}（§${anchor.section}）` };
  }
  const idx = (anchor.line ?? 0) - 1;
  const text = (body[idx] ?? "").trim();
  if (!text) return { ok: false, why: `E_EMPTY_LINE ${anchor.file}:${anchor.line} 是空行——指针指向空行等于没指` };
  if (anchor.keyword && !text.includes(anchor.keyword)) {
    return { ok: false, why: `E_KEYWORD_MISSING ${anchor.file}:${anchor.line} 无「${anchor.keyword}」（实际：${text.slice(0, 60)}）` };
  }
  return { ok: true, where: `${target.rel}:${anchor.line}（${text.slice(0, 46)}）` };
}

function runAnchorChecks() {
  const rows = [];
  const problems = [];
  for (const [scopeName, scope] of Object.entries(SCOPES)) {
    for (const step of scope.steps) {
      for (const anchor of parseAnchors(step.evidence ?? "")) {
        const r = checkAnchor(anchor);
        rows.push({ scopeName, title: step.title, anchor, result: r });
        if (!r.ok) problems.push(`${scopeName} ｜ ${step.title}：${r.why}`);
      }
    }
  }
  return { rows, problems };
}

function runSelftest() {
  // 卡面判据③的负例：往被指文件顶部插一行 ⇒ 键名锚点仍解析，行号锚点必错位。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selfcheck-plan-anchors-"));
  const tomlPath = path.join(dir, "mise.toml");
  const toml = ['[tasks."lint:cp"]', 'run = "mvn checkstyle:check"', "", "[tasks.validate]", 'depends = ["lint"]', ""].join("\n");
  fs.writeFileSync(tomlPath, toml, "utf8");
  const cases = [];
  const run = (name, anchorText, expectOk) => {
    const anchor = parseAnchors(anchorText)[0];
    const r = anchor ? checkAnchor(anchor, dir) : { ok: false, why: "E_ANCHOR_UNPARSED" };
    cases.push({ name, expectOk, got: r.ok, detail: r.ok ? r.where : r.why });
  };
  run("键名锚点命中", 'mise.toml [tasks."lint:cp"] !checkstyle', true);
  run("行号锚点命中", "mise.toml:2 !checkstyle", true);
  run("空行锚点必须报错", "mise.toml:3", false);
  run("符号不存在必须报错", 'mise.toml [tasks."no-such-task"]', false);
  run("关键词不符必须报错", 'mise.toml [tasks."lint:cp"] !ruff', false);
  fs.writeFileSync(tomlPath, "# 人为插入的一行\n" + toml, "utf8");
  run("插入一行后：键名锚点仍解析（这条是判据③的负例）", 'mise.toml [tasks."lint:cp"] !checkstyle', true);
  run("插入一行后：行号锚点错位（证明为什么不用行号做主锚点）", "mise.toml:2 !checkstyle", false);
  fs.rmSync(dir, { recursive: true, force: true });
  const bad = cases.filter((c) => c.got !== c.expectOk);
  for (const c of cases) console.log(`  ${c.got === c.expectOk ? "PASS" : "FAIL"}  ${c.name} —— ${c.detail}`);
  console.log(`\n自测 ${cases.length - bad.length}/${cases.length} 通过`);
  return bad.length === 0;
}

function parseScopes(argv) {
  const raw = [];
  for (const arg of argv) {
    if (arg.startsWith("--scope=")) {
      raw.push(...arg.slice("--scope=".length).split(/[,\s]+/));
    }
  }
  return raw.map((s) => s.trim()).filter(Boolean);
}

function printScope(name, scope) {
  const s0 = scope.steps.filter((s) => s.level === "S0");
  const s1 = scope.steps.filter((s) => s.level === "S1");
  console.log("");
  console.log(`== ${name} — ${scope.label} ==`);
  console.log(`触发面：${scope.triggers.join(" ｜ ")}`);
  console.log(`升 L2：${scope.upgrade}`);
  console.log(`合计：S0 ${s0.length} 条（必跑） / S1 ${s1.length} 条（申请窗口前自证）`);
  for (const step of scope.steps) {
    console.log("");
    console.log(`  [${step.level}] ${step.title}`);
    console.log(`        cd ${step.dir}`);
    console.log(`        ${step.cmd}`);
    console.log(`        判据：${step.verdict}`);
    console.log(`        证据：${step.evidence}`);
  }
}

function buildJson(names) {
  const scopes = {};
  for (const name of names) {
    const scope = SCOPES[name];
    scopes[name] = {
      label: scope.label,
      triggers: scope.triggers,
      upgrade: scope.upgrade,
      steps: scope.steps.map((step, index) => ({
        order: index + 1,
        level: step.level,
        title: step.title,
        dir: step.dir,
        cmd: step.cmd,
        verdict: step.verdict,
        evidence: step.evidence,
      })),
    };
  }
  return {
    generatedAt: new Date().toISOString(),
    repo: "A03-xihe",
    note: "planner 只打印不执行；本 JSON 的 exit 0 不代表自检通过",
    receiptTemplate: "internal/A03-xihe/docs/module-selfcheck-matrix.md#6-自检回执格式",
    scopes,
  };
}

const argv = process.argv.slice(2);
const wantList = argv.includes("--list");
const wantJson = argv.includes("--json");
const wantHelp = argv.includes("--help") || argv.includes("-h");
const wantCheckAnchors = argv.includes("--check-anchors");
const wantSelftest = argv.includes("--selftest");
const requested = parseScopes(argv);

if (wantHelp) {
  console.log(USAGE);
  process.exit(0);
}

if (wantSelftest) {
  const ok = runSelftest();
  process.exit(ok ? 0 : 1);
}

if (wantCheckAnchors) {
  const { rows, problems } = runAnchorChecks();
  const keyed = rows.filter((r) => r.anchor.symbol).length;
  const lined = rows.filter((r) => r.anchor.line).length;
  const sectioned = rows.filter((r) => r.anchor.section).length;
  for (const row of rows) {
    console.log(`  ${row.result.ok ? "OK  " : "FAIL"} ${row.scopeName} ｜ ${row.title.slice(0, 34)} ｜ ${row.result.where ?? row.result.why}`);
  }
  console.log("");
  console.log(`指针 ${rows.length} 条：键名锚点 ${keyed} / 章节锚点 ${sectioned} / 行号兜底 ${lined}；问题 ${problems.length} 条`);
  if (problems.length > 0) {
    console.error("");
    for (const p of problems) console.error(`E_ANCHOR ${p}`);
    process.exit(1);
  }
  process.exit(0);
}

if (!wantList && requested.length === 0) {
  console.log(USAGE);
  console.error("");
  console.error("错误：必须给 --list 或 --scope=<a,b>");
  process.exit(2);
}

const unknown = requested.filter((s) => !Object.hasOwn(SCOPES, s));
if (unknown.length > 0) {
  console.error(`错误：未知 scope：${unknown.join(", ")}`);
  console.error(`合法 scope：${Object.keys(SCOPES).join(", ")}`);
  process.exit(2);
}

const selected = wantList ? Object.keys(SCOPES) : requested;

if (wantJson) {
  console.log(JSON.stringify(buildJson(selected)));
  process.exit(0);
}

console.log("模块自检计划（只打印，不执行）");
console.log(`生成时间 ${new Date().toISOString()}  ·  仓库 A03-xihe`);

if (wantList) {
  console.log("");
  console.log("scope 一览：");
  for (const [name, scope] of Object.entries(SCOPES)) {
    const s0 = scope.steps.filter((s) => s.level === "S0").length;
    const s1 = scope.steps.length - s0;
    console.log(`  ${pad(name, 12)}S0 ${s0} / S1 ${s1}   ${scope.label}`);
    console.log(`  ${pad("", 12)}${scope.triggers.join(" ｜ ")}`);
  }
  for (const name of selected) printScope(name, SCOPES[name]);
} else {
  for (const name of selected) printScope(name, SCOPES[name]);
}

console.log("");
console.log("── 提醒 ──");
console.log("· 本工具不执行任何命令；S0 未全绿或红点含「产品回归」⇒ 不得申请 L2 窗口（见 matrix R1/R2/R3）");
console.log("· 回执格式：internal/A03-xihe/docs/module-selfcheck-matrix.md §6");
console.log("· 命令与文档不一致时以本文件为准，并同批改文档（matrix §8）");
