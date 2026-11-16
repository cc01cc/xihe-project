#!/usr/bin/env node
/**
 * gate-receipt-run — 跑一条门（或全部），产出**一份 receipt**（task-93）。
 *
 * <p>为什么 runner 自己 spawn、而不是复用 `xh-verify-gates.mjs` 的 runner：
 * 那份 runner 只保留退出码，子进程 stdout 直接丢弃 ⇒ `executed` 在源头就丢了。
 * 要「跑了多少」就必须自己拿 stdout。老的 `xh-verify-gates.mjs` 一行不改。</p>
 *
 * <p><b>D-1736</b>：`mutate` 门的 `--cmd` 由**本工具**校验裸命令形态，
 * 不合规直接给 `E_CMD_NOT_BARE`，在调用 mutate-verify 之前就拦住。</p>
 *
 * 用法：
 *   node scripts/gate-receipt-run.mjs --gate typecheck --out .local/receipts
 *   node scripts/gate-receipt-run.mjs --all --out .local/receipts --target src/features/workspace
 *   node scripts/gate-receipt-run.mjs --gate mutate --file <p> --find <s> --replace <s> --cmd <bare>
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    CODES,
    GATES,
    GATE_IDS,
    assertBareCommand,
    createReceipt,
    receiptFromRun,
} from "./lib/gate-receipt.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UI = join(ROOT, "packages/ui");
const MUTATE_VERIFY = join(ROOT, "..", "scripts", "mutate-verify.mjs");
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

/**
 * 门 → 命令形态。
 *
 * <p><b>typecheck 为什么带 `--listFiles`</b>：不带它时成功态 stdout 为空，
 * 「检查了多少文件」无处可测 ⇒ 该门的 pass 永远无法自证 ⇒ 必然假绿。这是「executed 不可省」
 * 反过来对**命令形态**提出的要求。</p>
 */
function gateCommand(gate, { target }) {
    switch (gate) {
        case "typecheck":
            return { cwd: UI, argv: [PNPM, "exec", "vue-tsc", "--noEmit", "--listFiles", "-p", "tsconfig.json"] };
        case "oxfmt":
            return { cwd: UI, argv: [PNPM, "exec", "oxfmt", "--check", "."] };
        case "oxlint":
            return { cwd: UI, argv: [PNPM, "exec", "oxlint", "."] };
        case "vitest":
            return { cwd: UI, argv: [PNPM, "exec", "vitest", "run", target] };
        case "i18n-scan":
            return { cwd: ROOT, argv: ["node", "scripts/i18n-scan.mjs", "--json"] };
        default:
            return null;
    }
}

/**
 * Windows 上 `pnpm` 是 `pnpm.cmd`，Node 24 起 `spawnSync` **不允许直接执行 .cmd**（EINVAL，
 * 2024 年的 Windows 命令注入修复带来的行为）。必须走 shell，而走 shell 时 Node 不会替我们加引号
 * ⇒ 含空格的实参要自己括起来，否则 `vitest run src/a b` 会被拆成两个参数。
 */
function quoteArg(a) {
    return /[\s"]/.test(a) ? '"' + a.replaceAll('"', '""') + '"' : a;
}

function run({ cwd, argv }, timeoutMs) {
    const startedAt = Date.now();
    const isWin = process.platform === "win32";
    const out = spawnSync(isWin ? argv.map(quoteArg).join(" ") : argv[0], isWin ? [] : argv.slice(1), {
        cwd,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        env: process.env,
        shell: isWin,
    });
    const durationMs = Date.now() - startedAt;
    const stdout = (out.stdout ?? "") + (out.stderr ?? "");
    return {
        stdout,
        exitCode: out.status === null ? 124 : out.status,
        durationMs,
        error: out.error ? String(out.error.message ?? out.error) : null,
    };
}

function emit(receipt, outDir) {
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, receipt.gate + ".json");
    writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n");
    return file;
}

/** 一条门的完整流程：跑 → 解析 → 造 receipt → 落盘。 */
function runGate(gate, opts) {
    const spec = gateCommand(gate, opts);
    if (!spec) {
        const r = createReceipt({
            gate,
            verdict: "error",
            code: CODES.E_USAGE,
            command: "",
            durationMs: 0,
            executed: {},
            reason: '此门需要显式参数，不能用 --all 跑：' + gate,
        });
        return emit(r, opts.out);
    }
    const command = spec.argv.join(" ");
    const r = run(spec, opts.timeoutMs);
    const receipt = receiptFromRun({
        gate,
        stdout: r.stdout,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        command,
    });
    if (r.error) receipt.reason = r.error;
    const file = emit(receipt, opts.out);
    console.log(
        "[receipt] " + gate + "  " + receipt.verdict.toUpperCase() + "  " + receipt.code
        + "  executed=" + JSON.stringify(receipt.executed) + "  → " + file,
    );
    return file;
}

/** mutate 门：先校验裸命令（D-1736），再调 mutate-verify。 */
function runMutate(opts) {
    const bare = assertBareCommand(opts.cmd);
    if (!bare.ok) {
        const receipt = createReceipt({
            gate: "mutate",
            verdict: "error",
            code: bare.code,
            command: "node scripts/mutate-verify.mjs ... --cmd " + opts.cmd,
            durationMs: 0,
            executed: { mutationLegs: 0 },
            reason: bare.reason,
        });
        const file = emit(receipt, opts.out);
        console.log("[receipt] mutate  ERROR  " + receipt.code + "  " + bare.reason);
        return file;
    }
    const argv = [
        "node",
        MUTATE_VERIFY,
        "--file", opts.file,
        "--find", opts.find,
        "--replace", opts.replace,
        "--cmd", opts.cmd,
    ];
    const command = "node scripts/mutate-verify.mjs --file " + opts.file
        + " --find <s> --replace <s> --cmd " + opts.cmd;
    const r = run({ cwd: opts.cwd ?? ROOT, argv }, opts.timeoutMs);
    const receipt = receiptFromRun({
        gate: "mutate",
        stdout: r.stdout,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        command,
    });
    const file = emit(receipt, opts.out);
    console.log(
        "[receipt] mutate  " + receipt.verdict.toUpperCase() + "  " + receipt.code
        + "  executed=" + JSON.stringify(receipt.executed) + "  → " + file,
    );
    return file;
}

function parseArgs(argv) {
    const opts = {
        gate: null, all: false, out: join(ROOT, ".local/receipts"),
        target: "src", timeoutMs: 15 * 60 * 1000,
        file: null, find: null, replace: null, cmd: null, cwd: null,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === "--gate") opts.gate = next();
        else if (a === "--all") opts.all = true;
        else if (a === "--out") opts.out = resolve(ROOT, next());
        else if (a === "--target") opts.target = next();
        else if (a === "--timeout-ms") opts.timeoutMs = Number(next());
        else if (a === "--file") opts.file = next();
        else if (a === "--find") opts.find = next();
        else if (a === "--replace") opts.replace = next();
        else if (a === "--cmd") opts.cmd = next();
        else if (a === "--cwd") opts.cwd = next();
        else if (a === "--help" || a === "-h") { console.log("见文件头注释"); process.exit(0); }
        else { console.error("未知参数 " + a); process.exit(2); }
    }
    return opts;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    mkdirSync(opts.out, { recursive: true });
    if (opts.gate === "mutate") {
        if (!opts.file || !opts.find || !opts.replace || !opts.cmd) {
            console.error("mutate 门需要 --file --find --replace --cmd（D-1736：--cmd 必须是裸命令）");
            process.exit(2);
        }
        runMutate(opts);
        return;
    }
    if (opts.gate) {
        if (!GATE_IDS.includes(opts.gate)) {
            console.error("未知门 " + opts.gate + "；已知：" + GATE_IDS.join(", "));
            process.exit(2);
        }
        runGate(opts.gate, opts);
        return;
    }
    if (opts.all) {
        // 需要显式参数的门（`manual: true`）不在 --all 内：它们只会产出 E_USAGE 错误行，
        // 而 reader 见 error 即判整批 ERROR（task-2 把这条从硬编码 `g !== "mutate"` 改成读字段）。
        const auto = GATE_IDS.filter((g) => !GATES[g].manual);
        for (const gate of auto) runGate(gate, opts);
        return;
    }
    console.error("需要 --gate <id> 或 --all <id>");
    process.exit(2);
}

if (import.meta.url === "file://" + process.argv[1].split("\\").join("/") || process.argv[1]?.endsWith("gate-receipt-run.mjs")) {
    main();
}

export { gateCommand, run, runGate, runMutate };
