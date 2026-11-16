#!/usr/bin/env node
/**
 * gate-screenshot-preflight — 拍图前置门（task-2 / 原 task-97）
 *
 * <h3>这道门为什么存在（判据层面的错，不是工具缺失）</h3>
 * <p>自审批次拍图前必须能回答一句话：<b>「我拍的图，是哪个 sha 的代码？」</b>。旧卡面判据写的是
 * cpBuild.behind === 0 —— <b>错</b>：behind 把「只改 UI 的提交」也算进去，那种 behind&gt;0 但 CP 行为没变
 * ⇒ 不必重建，按 behind 判红就是假信号。真正的判据是 <b>treeVerdict === "equal"</b>
 * （packages/control-plane 子树内容与 HEAD 相同）。</p>
 *
 * <p>而 behind=0 只保证「<b>那一刻</b>同源」，不代表「自审期间一直同源」—— 2026-11-16 HEAD 在 40 分钟里
 * 动过两次（d24b153ba → 0cfd5304d）。所以本门是<b>前置门</b>：每次拍图前重跑，receipt 跟着图一起交。</p>
 *
 * <h3>三条检查（缺一条 = 未检查 = error，不是 pass）</h3>
 * <ol>
 *   <li><b>CP 子树</b>：目标栈的 cpBuild → cpVerdictsOf() 现算 treeVerdict；!= equal ⇒ E_CP_NOT_AT_HEAD。
 *       <b>本门从不采信输入里自带的 verdict 戳</b>：带了戳就与现算值比对，不符 ⇒ E_FORGED_STAMP
 *       （「读一个伪造的 equal 戳」必须报错）。</li>
 *   <li><b>4 服务</b>：cp / runtime / agent / ui 每个都要 listening 且 ready 且 httpStatus===200。
 *       任一不满足，或<b>服务行根本不存在</b> ⇒ E_STACK_NOT_READY（行缺失同样是「没检查」）。</li>
 *   <li><b>脏树 × 所审页面</b>：git status --porcelain -uall 全清单 + 与 --pages 的交集。
 *       <b>未给 --pages ⇒ E_NO_PAGES</b>（交集判不了就不许 pass）。交集只记录不判红 ——
 *       但脏的全局样式会污染截图颜色（交接档 §15 那条），所以必须写进 receipt。</li>
 * </ol>
 *
 * <h3>「未检查必须报 error」是怎么落实的</h3>
 * <p>本门<b>没有 skipped 态</b>，也<b>没有 fail 态</b>：它判的是「能不能拍图」，不是「代码对不对」。
 * 代价是任何一条读不出来（dev-stack 空 stdout / 非 JSON / 栈名不存在 / 判据模块缺失 / 没有 --pages）
 * 都必须走 verdict=error 并带可判 code。这就是 fail-closed：<b>判不了 ≠ 没问题</b>。</p>
 *
 * <p>schema 与 task-93 的 receipt 契约同一份（scripts/lib/gate-receipt.mjs 的 validateReceipt）；
 * receipt 落盘前<b>先自校</b>，自校不过就改判 E_SCHEMA —— 不产出「看不出问题但其实不合规」的 receipt。</p>
 *
 * <h3>用法（第二人复算就这一行）</h3>
 * <pre>
 * node scripts/gate-screenshot-preflight.mjs --pages WorkspaceView.vue,WorkspaceMembersView.vue
 * node scripts/gate-screenshot-preflight.mjs --pages X.vue --json
 * node scripts/gate-screenshot-preflight.mjs --pages X.vue --stack-status fixture.json
 * </pre>
 *
 * <p>退出码：pass ⇒ 0，error ⇒ 2（本门不产 fail=1）。</p>
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CODES, createReceipt, validateReceipt } from "./lib/gate-receipt.mjs";

const GATE_ID = "screenshot-preflight";
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");                                  // A03-xihe
const ONE = resolve(ROOT, "..");                                   // one
const CP_VERDICT_MODULE = resolve(ONE, "internal", "A03-xihe", "scripts", "cp-verdict.mjs");
const REQUIRED_SERVICES = Object.freeze(["cp", "runtime", "agent", "ui"]);
const DEFAULT_STACK = "stack-2";
const DEFAULT_OUT = resolve(ROOT, ".local", "receipts", GATE_ID + ".json");
const STATUS_TIMEOUT_MS = 120000;

/* ───────────────────────── 读：栈状态 ───────────────────────── */

/**
 * 读 dev-stack status --all --json。
 *
 * <p><b>非零退出不等于无输出</b>：dev-stack.mjs status --all 只要任一栈 ok=false 就 exit 1
 * （scripts/dev-stack.mjs:591），而「栈没起」正是本门最常遇到的处境 —— 那时 stdout 里的 cpBuild
 * 仍然完整。所以这里<b>不看退出码</b>，只看 stdout（同 xh-monitor 的既有教训）。</p>
 *
 * <p>--stack-status 是<b>显式</b>夹具入口（变异腿/用例用）：默认不带，带了会原样写进 receipt 的
 * command 字段，谁读 receipt 都看得见判据输入不是实时现场。</p>
 */
function readStackStatus({ stackStatus, timeoutMs = STATUS_TIMEOUT_MS }) {
  const live = "node scripts/dev-stack.mjs status --all --json   (cwd=A03-xihe)";
  if (stackStatus) {
    const p = resolve(stackStatus);
    const cmd = live + "  [夹具 " + p + "]";
    try {
      return { data: JSON.parse(readFileSync(p, "utf8")), command: cmd, live: false };
    } catch (e) {
      return { error: "读不出夹具 " + p + "：" + String(e?.message ?? e), command: cmd };
    }
  }
  const r = spawnSync(process.execPath, ["scripts/dev-stack.mjs", "status", "--all", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const raw = (r.stdout ?? "").trim();
  const exitInfo = "exit=" + (r.status ?? "?") + (r.error ? ", spawn=" + r.error.message : "");
  if (!raw) {
    const tail = (r.stderr ?? "").trim().slice(0, 300);
    return {
      error: "dev-stack status 无 stdout（" + exitInfo + (tail ? "；stderr=" + tail : "；stderr 空") + "）",
      command: live,
    };
  }
  try {
    return { data: JSON.parse(raw), command: live, live: true };
  } catch (e) {
    return {
      error: "dev-stack status stdout 非 JSON（" + exitInfo + "；" + e.message + "；前 160 字=" + raw.slice(0, 160) + "）",
      command: live,
    };
  }
}

/* ───────────────────────── 现算：CP 双 verdict ───────────────────────── */

function gitRaw(args) {
  return execFileSync("git", ["-C", ROOT, ...args], {
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** git ls-tree -r <rev> -- <subtree> 的<b>原始字节</b> sha256（与 jar sidecar 同形）。 */
function subtreeSha(rev, subtree) {
  if (!rev || !/^[0-9a-f]{7,40}$/i.test(rev)) return { sha: null, reason: "bad-rev" };
  try {
    const buf = gitRaw(["ls-tree", "-r", rev, "--", subtree]);
    if (!buf || !buf.length) return { sha: null, reason: "empty-output" };
    return { sha: createHash("sha256").update(buf).digest("hex"), reason: null };
  } catch {
    return { sha: null, reason: "git-failed" };
  }
}

/** a 是否为 b 的祖先：true/false/null（判不了不猜）。 */
function isAncestor(a, b) {
  const r = spawnSync("git", ["-C", ROOT, "merge-base", "--is-ancestor", a, b], { stdio: "ignore", timeout: 10000 });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null;
}

/** 判据本体在 internal/A03-xihe/scripts/cp-verdict.mjs（唯一一份，此处不复刻）。 */
async function loadCpVerdictModule() {
  try {
    return await import(pathToFileURL(CP_VERDICT_MODULE).href);
  } catch (e) {
    return { error: "判据模块不可用（" + CP_VERDICT_MODULE + "）：" + String(e?.message ?? e) };
  }
}

function cpVerdictsOf(mod, cpBuild) {
  return mod.cpVerdictsOf(cpBuild, {
    subtrees: mod.CP_SUBTREES,
    subtreeSha: (rev) => subtreeSha(rev, mod.CP_SUBTREES[0]),
    isAncestor,
  });
}

/* ───────────────────────── 读：脏树 ───────────────────────── */

/** git status --porcelain -uall → [{code, path}]（rename 取新路径；带引号剥引号）。 */
function dirtyRows() {
  const out = execFileSync("git", ["-C", ROOT, "status", "--porcelain", "-uall"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return (out ? out.split(/\r?\n/).filter(Boolean) : []).map((l) => {
    const rest = l.slice(2).replace(/^\s+/, "");
    const arrow = rest.lastIndexOf(" -> ");
    const p = arrow >= 0 ? rest.slice(arrow + 4) : rest;
    return { code: l.slice(0, 2), path: p.trim().replace(/^"|"$/g, "") };
  });
}

/** 页面标识 → 命中的脏路径（等值 / 后缀 / 子串三种写法都算命中，宁可多报）。 */
function overlapOf(dirty, pages) {
  const norm = (s) => String(s).replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  const hits = [];
  for (const page of pages) {
    const q = norm(page);
    const matched = dirty.filter((row) => {
      const p = norm(row.path);
      return p === q || p.endsWith("/" + q) || p.includes(q);
    });
    if (matched.length) hits.push({ page, paths: matched.map((m) => m.path) });
  }
  return hits;
}

/* ───────────────────────── 判：一次算齐 ───────────────────────── */

async function evaluate(opts) {
  const startedAt = Date.now();
  const problems = [];
  const numbers = { stack: opts.stack, pages: [...opts.pages] };
  const executed = { checks: 0, servicesProbed: 0, pagesChecked: 0 };
  let summary = null;
  const add = (code, detail) => { problems.push({ code, detail }); };

  /* ① 栈状态 */
  const status = readStackStatus(opts);
  numbers.statusCommand = status.command;
  let row = null;
  if (status.error) {
    add(CODES.E_STATUS_UNREADABLE, status.error);
  } else {
    executed.checks += 1;
    numbers.liveStatus = status.live !== false;
    row = (status.data?.stacks ?? []).find((s) => s?.stackId === opts.stack) ?? null;
    if (!row) {
      const have = (status.data?.stacks ?? []).map((s) => s?.stackId).filter(Boolean).join(", ") || "无";
      add(CODES.E_STACK_NOT_FOUND, "dev-stack status 里没有 " + opts.stack + "（有：" + have + "）");
    }
  }

  /* ② CP 子树（treeVerdict）—— 现算，绝不采信输入里的戳 */
  if (row) {
    const mod = await loadCpVerdictModule();
    if (mod.error) {
      add(CODES.E_VERIFIER_MISSING, mod.error);
    } else {
      const cpBuild = row.cpBuild ?? null;
      const cpv = cpVerdictsOf(mod, cpBuild);
      executed.checks += 1;
      numbers.treeVerdict = cpv.treeVerdict;
      numbers.treeReason = cpv.treeReason;
      numbers.treeSha = cpv.treeSha;
      numbers.subtrees = cpv.subtrees;
      numbers.behind = cpv.behind;
      numbers.ahead = cpv.ahead;
      numbers.head = cpBuild?.headCommit ?? null;
      numbers.runningCommit = cpBuild?.runningCommit ?? null;
      numbers.builtAt = cpBuild?.builtAt ?? null;
      // 源词表（dev-stack 的 fresh/stale/dirty/missing）原样记录：**不与上面两维互推**。
      numbers.cpBuildVerdict = cpBuild?.verdict ?? null;
      numbers.cpBuildDirty = cpBuild?.dirty ?? null;
      numbers.targetDir = cpBuild?.targetDir ?? null;
      summary = cpv.summary;

      // 「戳」= 输入自带、非本门现算的 verdict 声明。带了就必须与现算一致，否则判伪造。
      const claims = [
        ["row.treeVerdict", row.treeVerdict, cpv.treeVerdict],
        ["cpBuild.treeVerdict", cpBuild?.treeVerdict, cpv.treeVerdict],
        ["row.commitVerdict", row.commitVerdict, cpv.verdict],
        ["cpBuild.commitVerdict", cpBuild?.commitVerdict, cpv.verdict],
      ].filter(([, v]) => v !== undefined && v !== null);
      for (const [where, claim, computed] of claims) {
        numbers.stampClaims = [...(numbers.stampClaims ?? []), { where, claim, computed }];
        if (String(claim) !== String(computed)) {
          add(
            CODES.E_FORGED_STAMP,
            where + " 声称 " + JSON.stringify(claim) + "，本门现算 " + JSON.stringify(computed)
              + " ⇒ 不采信输入自带结论（伪造的 equal 戳不许当 pass）",
          );
        }
      }
      if (cpv.treeVerdict !== "equal") {
        add(
          CODES.E_CP_NOT_AT_HEAD,
          "treeVerdict=" + cpv.treeVerdict + "（" + cpv.subtrees.join("+") + " 子树与 HEAD "
            + (cpv.treeVerdict === "differs" ? "不一致" : "一致性未能验证")
            + "；verdict=" + cpv.verdict + (cpv.behind != null ? " behind=" + cpv.behind : "") + "）"
            + " ⇒ 拍到的图不是你审的 HEAD 的 CP 代码",
        );
      }
    }
  }

  /* ③ 4 服务：端口在听 + http 200（行缺失也算没检查） */
  if (row) {
    const rows = Array.isArray(row.services) ? row.services : [];
    const detail = REQUIRED_SERVICES.map((name) => {
      const svc = rows.find((s) => s?.service === name) ?? null;
      if (!svc) return { service: name, ok: false, missing: true };
      executed.servicesProbed += 1;
      const ok = svc.listening === true && svc.ready === true && svc.httpStatus === 200;
      return {
        service: name,
        ok,
        port: svc.port ?? null,
        listening: svc.listening === true,
        ready: svc.ready === true,
        httpStatus: svc.httpStatus ?? null,
        pid: svc.pid ?? null,
      };
    });
    executed.checks += 1;
    numbers.services = detail;
    numbers.servicesReady = detail.filter((d) => d.ok).length + "/" + REQUIRED_SERVICES.length;
    const bad = detail.filter((d) => !d.ok);
    if (bad.length) {
      add(
        CODES.E_STACK_NOT_READY,
        opts.stack + " 服务未就绪 " + bad.length + "/" + REQUIRED_SERVICES.length + "："
          + bad.map((d) => d.service + (d.missing
            ? "(无服务行=未检查)"
            : "(端口 " + (d.port ?? "?") + ", 监听=" + (d.listening ? "是" : "否")
              + ", http=" + (d.httpStatus ?? "无") + ")")).join("; "),
      );
    }
  } else {
    numbers.servicesReady = "0/" + REQUIRED_SERVICES.length;
  }

  /* ④ 脏树 × 所审页面 */
  let dirty = null;
  try {
    dirty = dirtyRows();
    executed.checks += 1;
    numbers.dirtyCount = dirty.length;
    numbers.dirtyPaths = dirty.map((d) => d.path);
  } catch (e) {
    add(CODES.E_STATUS_UNREADABLE, "git status 读不出：" + String(e?.message ?? e));
    numbers.dirtyCount = null;
  }
  if (opts.pages.length === 0) {
    add(CODES.E_NO_PAGES, "未给 --pages ⇒「脏树 × 所审页面」这条没检查（未检查不许当 pass）");
  } else if (dirty) {
    executed.pagesChecked = opts.pages.length;
    const overlap = overlapOf(dirty, opts.pages);
    numbers.dirtyOverlap = overlap;
    numbers.dirtyOverlapCount = overlap.reduce((n, o) => n + o.paths.length, 0);
  }

  /* 结论 */
  const code = problems.length ? problems[0].code : CODES.OK;
  const verdict = problems.length ? "error" : "pass";
  const reason = problems.length ? problems.map((p) => "[" + p.code + "] " + p.detail).join(" │ ") : null;

  const receipt = createReceipt({
    gate: GATE_ID,
    verdict,
    code,
    numbers,
    command: opts.command,
    durationMs: Date.now() - startedAt,
    executed,
    reason,
  });

  // 自校：不合 schema 就改判 E_SCHEMA（不产出「看不出问题但其实不合规」的 receipt）
  const v = validateReceipt(receipt);
  if (!v.ok) {
    return {
      receipt: createReceipt({
        gate: GATE_ID,
        verdict: "error",
        code: CODES.E_SCHEMA,
        numbers,
        command: opts.command,
        durationMs: receipt.durationMs,
        executed,
        reason: "receipt 自校不过（" + v.problems.join("; ") + "）" + (reason ? "；原判：" + reason : ""),
      }),
      summary,
    };
  }
  return { receipt, summary };
}

/* ───────────────────────── CLI ───────────────────────── */

function parseArgs(argv) {
  const opts = {
    stack: DEFAULT_STACK,
    pages: [],
    stackStatus: null,
    out: DEFAULT_OUT,
    json: false,
    write: true,
    timeoutMs: STATUS_TIMEOUT_MS,
    echo: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--stack") { opts.stack = next(); opts.echo.push(a, opts.stack); }
    else if (a === "--pages") {
      const v = next() ?? "";
      opts.pages = v.split(",").map((s) => s.trim()).filter(Boolean);
      opts.echo.push(a, v);
    } else if (a === "--stack-status") { opts.stackStatus = next(); opts.echo.push(a, opts.stackStatus); }
    else if (a === "--out") { opts.out = resolve(next()); opts.echo.push(a, String(opts.out)); }
    else if (a === "--timeout-ms") { opts.timeoutMs = Number(next()); opts.echo.push(a, String(opts.timeoutMs)); }
    else if (a === "--json") { opts.json = true; opts.echo.push(a); }
    else if (a === "--no-write") { opts.write = false; opts.echo.push(a); }
    else if (a === "--help" || a === "-h") { opts.help = true; }
    else { opts.unknown = a; }
  }
  opts.command = ["node scripts/gate-screenshot-preflight.mjs", ...opts.echo].join(" ");
  return opts;
}

function printHelp() {
  console.log("usage: node scripts/gate-screenshot-preflight.mjs --pages <a.vue[,b.vue...]> [options]");
  console.log("");
  console.log("  拍图前置门（task-2）。判据 = 目标栈 CP 子树 treeVerdict=equal + 4 服务 http 200。");
  console.log("  任何「没检查」都报 error（fail-closed），不存在 skipped/pass 的中间态。");
  console.log("");
  console.log("  --stack <id>          要验的栈，默认 stack-2");
  console.log("  --pages <a,b>         被审页面（文件名或仓库相对路径），缺省 ⇒ E_NO_PAGES");
  console.log("  --stack-status <file> 用夹具代替实跑 dev-stack status（变异腿/用例；会写进 command）");
  console.log("  --out <file>          receipt 落点，默认 .local/receipts/screenshot-preflight.json");
  console.log("  --no-write            只打印不落盘");
  console.log("  --json                receipt JSON 打到 stdout");
  console.log("");
  console.log("退出码：pass ⇒ 0，error ⇒ 2（本门不产 fail）。");
  console.log("");
  console.log("复算（第二人）：");
  console.log("  node scripts/gate-screenshot-preflight.mjs --pages <同一组页面> --json");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); process.exit(0); }
  if (opts.unknown) { console.error("未知参数 " + opts.unknown + "（--help 看用法）"); process.exit(2); }

  const { receipt, summary } = await evaluate(opts);

  if (opts.write) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, JSON.stringify(receipt, null, 2) + "\n");
  }
  if (opts.json) {
    console.log(JSON.stringify(receipt, null, 2));
  } else {
    const n = receipt.numbers;
    console.log(
      "[preflight] " + receipt.verdict.toUpperCase() + "  " + receipt.code
      + "  stack=" + n.stack
      + "  treeVerdict=" + (n.treeVerdict ?? "unverified")
      + " behind=" + (n.behind ?? "?")
      + " head=" + (n.head ? String(n.head).slice(0, 9) : "?")
      + " builtAt=" + (n.builtAt ?? "?")
      + "  services=" + (n.servicesReady ?? "?")
      + "  dirty=" + (n.dirtyCount ?? "?")
      + " overlap=" + (n.dirtyOverlapCount ?? 0)
      + (opts.write ? "  → " + opts.out : ""),
    );
    if (summary) console.log("└ " + summary);
    if (receipt.reason) console.log("└ " + receipt.reason);
  }
  process.exit(receipt.verdict === "pass" ? 0 : 2);
}

if (process.argv[1]?.endsWith("gate-screenshot-preflight.mjs")) {
  main().catch((e) => {
    console.error("preflight 自身崩了：" + String(e?.stack ?? e));
    process.exit(2);
  });
}

export { GATE_ID, ROOT, dirtyRows, evaluate, overlapOf, readStackStatus, subtreeSha };
