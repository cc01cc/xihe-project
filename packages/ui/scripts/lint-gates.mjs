#!/usr/bin/env node
/**
 * lint-gates.mjs — 通用 keep-going 门执行器（task-28，方案 (a)，Lead 2026-11-18 裁定）
 *
 * 为什么存在（判据级理由，不是「多跑几条」）：
 *   package.json 的 && 串联 ⇒ 前置门一红，后面所有门**静默不跑**，而输出处只写「前面红了」。
 *   实证（task-28 实测复现 / task-27 撞上）：oxfmt 一处格式漂移红了，oxlint + 3 个 check 门
 *   当轮**零输出**；同一族事故在 mise 层记为 D-1457-S1（「被并行 depends 首个失败掐掉」），
 *   task-176 实测无 -c 的 validate 5.4 s 即被快红掐死。门被永久遮住比开不了的门更糟（D-1074 同族）。
 *
 * 本文件的定位（Lead 附加要求，防养出两套机制）：
 *   **门清单是数据，从命令行传入或从外部调用 runGates(gates) 注入；runner 本身不含任何门名。**
 *   设计为**可被 mise 层复用**：task-30 收拾 mise.toml 里那 5 条 run = "...&&..." 门内链
 *   （lint:agent / lint:runtime / check:types / check:config-schema / test:cli）时直接复用本 runner。
 *   **终态是方案 (b)**（复用 mise 自己的 -c continue-on-error）；届时本文件要么被 mise 任务调用、
 *   要么退役 —— 它只是把 ui 包的门先变诚实的过渡件，不是第二个长期实现。
 *
 * 判据零变更原则：本 runner 只改「全部跑完 vs 首红短路」与「退出码聚合」，
 *   不改任何门本身的命令、阈值、白名单。门的判据由各门自己说了算。
 *
 * 用法：
 *   node scripts/lint-gates.mjs --gate "id=命令 与 参数" [--gate ...]   # 门清单在参数里
 *   node scripts/lint-gates.mjs --gate="id=命令"                        # 同一形式的等号写法
 *   node scripts/lint-gates.mjs --selftest                              # 4 例自检（不碰仓库状态）
 *
 * 退出码聚合（镜像 A03-xihe/scripts/validate-run.mjs 的 aggregateExit 口径，同 run-e2e-static-gates.mjs）：
 *   任一门 2（环境/用法档）⇒ 2 ｜ 否则任一门非 0 ⇒ 1 ｜ 全绿 ⇒ 0
 *
 * 为什么用 shell: true：pnpm 在本机以 cmd.exe 跑 script（实测 script-shell 未配置、
 *   echo SHELL=$0 原样打印），而 oxfmt / oxlint 在 Windows 是 node_modules\.bin 下的 .cmd 垫片；
 *   走 shell 与 pnpm 今天的执行语义完全一致，既不改变门的行为，也不引入「内联 node -e 巨串」那种
 *   不可审阅的写法。命令串按原样交给 shell，门参数因此与旧 && 链逐字相同。
 */
import { spawnSync } from "node:child_process";

/** 聚合规则：环境/用法错误压过判定失败，判定失败压过全绿。 */
export function aggregateExit(codes) {
    if (codes.some((code) => code === 2)) return 2;
    if (codes.some((code) => code === 1)) return 1;
    if (codes.some((code) => code !== 0)) return 1;
    return 0;
}

/** 解析 "id=命令 与 参数" ⇒ { id, command }。id 取第一个 = 之前，其余整体视为命令行。 */
export function parseGateArg(arg) {
    const i = arg.indexOf("=");
    if (i <= 0) throw new Error("--gate 需要 id=命令 形式，收到: " + arg);
    return { id: arg.slice(0, i), command: arg.slice(i + 1).trim() };
}

/** 命令行参数 → 门清单（支持 --gate=id=cmd 与 --gate "id=cmd" 两种写法）。 */
export function parseGateArgs(argv) {
    const gates = [];
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--gate" || a === "-g") {
            const next = argv[i + 1];
            if (next === undefined) throw new Error("--gate 缺少值");
            gates.push(parseGateArg(next));
            i += 1;
        } else if (a.startsWith("--gate=")) {
            gates.push(parseGateArg(a.slice("--gate=".length)));
        } else if (a === "--cwd") {
            i += 1; // 由调用方读取；此处跳过已消费
        }
    }
    return gates;
}

const pad = (s, n) => (String(s) + " ".repeat(n)).slice(0, n);

/**
 * 逐个跑完所有门（keep-going），打印逐门 PASS/FAIL 汇总，返回聚合退出码。
 * @param gates  门清单数据 [{ id, command }]，**由调用方提供**
 * @param opts   { cwd, log, stdio } ；stdio 默认 inherit（让「哪个门跑了、红在哪」一眼可见）
 */
export function runGates(gates, opts = {}) {
    const cwd = opts.cwd || process.cwd();
    const log = opts.log || ((line) => console.log(line));
    const stdio = opts.stdio || "inherit";

    if (!Array.isArray(gates) || gates.length === 0) {
        // 空清单不是「全绿」：那正是「门没人跑」的假绿形态，按环境问题档处理。
        log("lint-gates: 门清单为空 ⇒ 拒绝执行（空清单不等于绿，按 exit 2 处理）");
        return { rows: [], codes: [], exit: 2 };
    }

    const rows = [];
    for (const gate of gates) {
        log("");
        log("──────── gate: " + gate.id + " ────────");
        log("$ " + gate.command);
        const started = Date.now();
        const result = spawnSync(gate.command, { cwd, shell: true, stdio });
        const ms = Date.now() - started;
        // status === null ⇒ 被信号杀死或起不来，属环境档（2），不许当成 0 或 1。
        const code = result.status === null || result.status === undefined ? 2 : result.status;
        rows.push({ id: gate.id, command: gate.command, code, ms, signal: result.signal || null });
    }

    const codes = rows.map((r) => r.code);
    const exit = aggregateExit(codes);
    const failed = rows.filter((r) => r.code !== 0);

    log("");
    log("════════ lint-gates 汇总（共 " + rows.length + " 门，全部执行，无短路）════════");
    for (const r of rows) {
        const verdict = r.code === 0 ? "PASS" : "FAIL";
        const sig = r.signal ? " signal=" + r.signal : "";
        log(
            "  " +
                verdict +
                "  " +
                pad(r.id, 22) +
                " exit=" +
                r.code +
                sig +
                "  " +
                pad(r.ms + "ms", 10),
        );
    }
    if (failed.length === 0) {
        log("  ⇒ " + rows.length + " 门全绿");
    } else {
        log(
            "  ⇒ " +
                failed.length +
                " 门红: " +
                failed.map((r) => r.id + "(" + r.code + ")").join(", "),
        );
        log(
            "  红因见上方对应门自身的输出；其余 " +
                (rows.length - failed.length) +
                " 门本轮**确实跑过了**。",
        );
    }
    return { rows, codes, exit };
}

// ── 自检：证明「后面的门不再被短路」这条机制本身成立，不依赖仓库状态 ──
function selftest() {
    const q = (code) => 'node -e "process.exit(' + code + ')"';
    const cases = [
        {
            name: "全绿 ⇒ exit 0",
            gates: [
                { id: "a", command: q(0) },
                { id: "b", command: q(0) },
            ],
            want: 0,
        },
        {
            name: "首门红 ⇒ 后 2 门仍跑，exit 1",
            gates: [
                { id: "a", command: q(1) },
                { id: "b", command: q(0) },
                { id: "c", command: q(0) },
            ],
            want: 1,
        },
        {
            name: "任一 exit 2 ⇒ 压过 exit 1",
            gates: [
                { id: "a", command: q(1) },
                { id: "b", command: q(2) },
            ],
            want: 2,
        },
        { name: "空门清单 ⇒ exit 2（空清单不是绿）", gates: [], want: 2 },
    ];
    let bad = 0;
    for (const c of cases) {
        const lines = [];
        const res = runGates(c.gates, { log: (l) => lines.push(l), stdio: "ignore" });
        const ranAll = lines.filter((l) => l.startsWith("$ ")).length;
        const okExit = res.exit === c.want;
        const okRan = c.gates.length === 0 || ranAll === c.gates.length;
        if (!okExit || !okRan) bad += 1;
        console.log(
            (okExit && okRan ? "PASS " : "FAIL ") +
                c.name +
                "  [exit=" +
                res.exit +
                " 期望=" +
                c.want +
                " 跑了几门=" +
                ranAll +
                "]",
        );
    }
    // 纯函数侧：聚合口径
    const pure = [
        [aggregateExit([0, 0]), 0],
        [aggregateExit([1, 0]), 1],
        [aggregateExit([0, 1, 2]), 2],
        [aggregateExit([3, 0]), 1],
    ];
    for (const [got, want] of pure) {
        if (got !== want) {
            bad += 1;
            console.log("FAIL aggregateExit  got=" + got + " want=" + want);
        } else console.log("PASS aggregateExit ⇒ " + want);
    }
    console.log(bad === 0 ? "selftest: ALL PASS" : "selftest: " + bad + " FAIL");
    return bad === 0 ? 0 : 1;
}

const argv = process.argv.slice(2);
if (argv.includes("--selftest")) {
    process.exit(selftest());
} else {
    const cwdIdx = argv.indexOf("--cwd");
    const cwd = cwdIdx >= 0 ? argv[cwdIdx + 1] : undefined;
    let gates;
    try {
        gates = parseGateArgs(argv);
    } catch (e) {
        console.error("lint-gates: " + e.message);
        process.exit(2);
    }
    if (gates.length === 0) {
        console.error(
            '用法: node scripts/lint-gates.mjs --gate "id=命令…" [--gate …] ｜ --selftest',
        );
        console.error("（门清单必须由参数/调用方给出 —— 本 runner 不内置任何门名）");
        process.exit(2);
    }
    process.exit(runGates(gates, { cwd }).exit);
}
