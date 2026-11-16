#!/usr/bin/env node
/**
 * 门禁结论契约（gate receipt）—— **task-93 的唯一判据来源**。
 *
 * <h3>为什么需要它（不是「再包一层」，是今天真实栽的那一跤）</h3>
 * <p>2026-11-16 有两次收卡带着「测试通过」，但 HEAD 是红的。根因不是命令写错，而是
 * <b>「到底跑了多少」在结论里不可读</b>：</p>
 * <ul>
 *   <li>`cargo test search_files` 匹配 0 个测试也 exit 0；</li>
 *   <li>`pnpm exec vitest run <不存在的路径>` 可能 0 个用例而退出码为 0。</li>
 * </ul>
 * <p>⇒ **「0 个通过」和「跑了很多都通过」在 exit code 上无法区分**。这是本契约存在的全部理由：
 * 结论必须是 `verdict` + `executed` 两个字段，缺一个都不成立。</p>
 *
 * <h3>与既有 `xh-verify-gates.mjs` 的关系（膨胀门：先说清被否决的更简方案）</h3>
 * <p>`scripts/xh-verify-gates.mjs` 已经在跑门集并落 JSON 证据（`gates[]`，每行
 * `name/cmd/exit/durationMs/status/skipReason` + `summary`）。看似「已经有了」，但对照本卡要的四条，
 * 它三处都不够，且**都不能靠加字段补**：</p>
 * <ol>
 *   <li><b>没有 `executed`</b>：它的 runner 只取退出码（`out.exit === 0 ? "PASS" : "FAIL"`），
 *       子进程 stdout 从不落盘 ⇒ 「跑了多少」在源头就丢了，事后无法补算。</li>
 *   <li><b>没有 `error` 态</b>：`exit !== 0` 一律 `FAIL` ⇒ 用法错误/环境缺失与「产品真红」同码，
 *       而 `--strict` 又把 SKIP 降级成 FAIL，三种处境共用一个词。</li>
 *   <li><b>它被别的门依赖</b>：`scripts/gate-parity.mjs` 直接 `import { DEFAULT_GATES }` 并做三方
 *       对账，改它的行结构会牵动门梯次断言。</li>
 * </ol>
 * <p><b>被否决的更简方案</b>：（a）给它加字段 —— 会改到 gate-parity 依赖的导出与既有多条
 * `assert.deepEqual` 断言；（b）只写一个 reader 去解析各命令的**人读文本** —— 恰好保留了本卡要消灭的
 * 「靠人读」；（c）把六条门硬编码进 reader —— 加第七条门时必然分叉。
 * <b>采用的方案</b>：本文件只定义**契约与解析**（纯函数、零 I/O），runner 自己 spawn（因为要拿 stdout），
 * 老的 `xh-verify-gates.mjs` <b>一行不改</b>。</p>
 *
 * <h3>D-1736：参数形态的检查点必须在被调用方</h3>
 * <p>`mutate-verify.mjs` 要求 `--cmd` 是**裸命令**（带 `FOO=1` 前缀会让 baseline 腿算错）。这条约定
 * 过去只写在卡面/README 上，下一个人照样踩。⇒ 本文件提供 `assertBareCommand`，
 * 由 runner 在**调用前**自己校验并给出可判错误码 `E_CMD_NOT_BARE`，不靠文档。</p>
 */

/** receipt schema 版本。加字段不升版；改语义/删字段必须升版。 */
export const SCHEMA_VERSION = 1;

/**
 * 四态 verdict。**`error` 与 `fail` 必须分开**：
 * - `fail`  = 命令跑通了，判据不满足（产品/代码真红）；
 * - `error` = 命令没法得出判据（用法错、环境缺、输出无法解析、假绿）；
 * 两者混用会让「我的代码红了」和「你的工具没跑起来」无法区分。
 */
export const VERDICTS = Object.freeze(["pass", "fail", "error", "skipped"]);

/** 可判错误码。新增时同步本表与用例。 */
export const CODES = Object.freeze({
    OK: "OK",
    /** 命令退出非 0，且输出能解析出失败计数 ⇒ 真红。 */
    E_GATE_FAILED: "E_GATE_FAILED",
    /** 命令跑了但输出解析不出计数 ⇒ 无法判定，不许当绿。 */
    E_UNPARSABLE: "E_UNPARSABLE",
    /** verdict=pass 但 executed 无正数工作计数 ⇒ **假绿**（本契约的核心防线）。 */
    E_FAKE_GREEN: "E_FAKE_GREEN",
    /** mutate-verify 的 --cmd 不是裸命令（带环境变量前缀等）。D-1736。 */
    E_CMD_NOT_BARE: "E_CMD_NOT_BARE",
    /** 调用方传参/用法错。 */
    E_USAGE: "E_USAGE",
    /** 门显式跳过（缺输入、环境不满足），必须带 reason。 */
    E_SKIPPED: "E_SKIPPED",
    /** receipt 自身不符合 schema。 */
    E_SCHEMA: "E_SCHEMA",
    /* ── task-2（拍图前置门 gate-screenshot-preflight）专用码；**additive，不改既有语义** ──
     * 为什么不给本门自造一套 verdict 词表：这三类都是「判不了 / 判不满足」，
     * 必须落进同一份 receipt 契约才能被 gate-receipt-read 采信（自造第二套词表就是 task-94 拆掉的那种病）。 */
    /** CP 子树与 HEAD 不一致（treeVerdict!=equal）⇒ 跑的不是 HEAD 的 CP 代码。 */
    E_CP_NOT_AT_HEAD: "E_CP_NOT_AT_HEAD",
    /** 4 服务未全部「端口在听 + http 200」⇒ 没有栈可拍图。 */
    E_STACK_NOT_READY: "E_STACK_NOT_READY",
    /** 指定栈在 dev-stack status 里不存在（栈名拼错 / 该栈无名份）。 */
    E_STACK_NOT_FOUND: "E_STACK_NOT_FOUND",
    /** 读不出栈状态（空 stdout / 非 JSON / 夹具读失败）⇒ **未检查**，不许当绿。 */
    E_STATUS_UNREADABLE: "E_STATUS_UNREADABLE",
    /** 输入里带的 verdict 戳与本门**现算**结果不符（伪造的 equal 戳）。 */
    E_FORGED_STAMP: "E_FORGED_STAMP",
    /** 未给被审页面 ⇒ 「脏树 × 所审页面」这条没检查（fail-closed）。 */
    E_NO_PAGES: "E_NO_PAGES",
    /** cp-verdict.mjs（双 verdict 判据唯一实现）不可用 ⇒ 子树维度判不了。 */
    E_VERIFIER_MISSING: "E_VERIFIER_MISSING",
    /* ── T-2327（截拍门判据加固）新增；**additive，不改既有语义** ── */
    /** cpBuild.verdict=dirty ⇒ 构建含未提交改动、内容不可复现（BL-325：dirty 按非 fresh 处理，绝不按 stale）。 */
    E_CP_DIRTY: "E_CP_DIRTY",
    /** liveStatus=true 时 numbers.head != git rev-parse HEAD（读数与现场不同源），或 HEAD 读不出 ⇒ 判不了。 */
    E_HEAD_MISMATCH: "E_HEAD_MISMATCH",
});

/**
 * mutate-verify 要求 `--cmd` 是裸命令。
 *
 * <p>判定：形如 `A=1 B=2 cmd ...` 的前缀赋值即为非裸；`env A=1 cmd` 同样非裸。
 * 返回 `{ ok, code, reason }`，**不抛异常** —— 调用方要能把它写进 receipt。</p>
 */
export function assertBareCommand(cmd) {
    if (typeof cmd !== "string" || cmd.trim() === "") {
        return { ok: false, code: CODES.E_USAGE, reason: "--cmd 不能为空" };
    }
    const trimmed = cmd.trim();
    const first = trimmed.split(/\s+/)[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
        return {
            ok: false,
            code: CODES.E_CMD_NOT_BARE,
            reason: '--cmd 必须是裸命令，不能带环境变量前缀（首 token 为 "' + first + '"）；'
                + "请改用先设置环境变量再执行的方式，否则 baseline 腿会算错",
        };
    }
    if (first === "env" && /\s[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) {
        return {
            ok: false,
            code: CODES.E_CMD_NOT_BARE,
            reason: "--cmd 必须是裸命令，不能用 env 前缀注入环境变量",
        };
    }
    return { ok: true, code: CODES.OK, reason: null };
}

/* ─────────────────────────── 各门的输出解析 ─────────────────────────── */
/*
 * 全部是**纯函数**：输入子进程 stdout、输出 `{ parsed, numbers, executed }`。
 * 解析不出关键计数 ⇒ `parsed: false`，由 runner 判 `E_UNPARSABLE`（**不许猜**）。
 */

/** oxfmt：`Finished in 45ms on 1 files using 32 threads` */
export function parseOxfmt(stdout) {
    const files = /Finished in [\d.]+m?s on (\d+) files?/.exec(stdout);
    const offenders = (stdout.match(/^\S+\.(?:[cm]?[jt]s|vue|json|md) \([\d.]+m?s\)$/gm) ?? []).length;
    if (!files) return { parsed: false, numbers: { unformatted: offenders }, executed: { files: null } };
    return {
        parsed: true,
        numbers: { filesMatched: Number(files[1]), unformatted: offenders },
        executed: { files: Number(files[1]) },
    };
}

/** oxlint：`Found 0 warnings and 0 errors.` + `Finished in 150ms on 1 file with 220 rules ...` */
export function parseOxlint(stdout) {
    const found = /Found (\d+) warnings? and (\d+) errors?/.exec(stdout);
    const files = /Finished in [\d.]+m?s on (\d+) files?/.exec(stdout);
    if (!found || !files) {
        return { parsed: false, numbers: { warnings: null, errors: null }, executed: { files: null } };
    }
    return {
        parsed: true,
        numbers: {
            warnings: Number(found[1]),
            errors: Number(found[2]),
            filesLinted: Number(files[1]),
        },
        executed: { files: Number(files[1]) },
    };
}

/**
 * vue-tsc：配合 `--listFiles` 才有可测的「检查了多少个文件」。
 *
 * <p>不带 `--listFiles` 时 stdout 只有错误、成功时为空 ⇒ 成功态永远拿不到计数 ⇒ 必然假绿。
 * 这是本卡「executed 不可省」的一个直接后果：**为了让成功可证明，命令形态本身要改**。</p>
 */
export function parseTypecheck(stdout) {
    const errorLines = stdout.match(/^.+\(\d+,\d+\): error TS\d+/gm) ?? [];
    const fileLines = stdout.match(/^\S+\.(?:d\.ts|ts|tsx|vue|mts|cts)$/gm) ?? [];
    const files = fileLines.length;
    if (files === 0 && errorLines.length === 0) {
        return { parsed: false, numbers: { errors: null }, executed: { files: null } };
    }
    return {
        parsed: true,
        numbers: { errors: errorLines.length, filesChecked: files },
        executed: { files },
    };
}

/** vitest：`Test Files  2 passed (2)` + `Tests  19 passed (19)` */
export function parseVitest(stdout) {
    const filesLine = /Test Files\s+(.+)/.exec(stdout);
    const testsLine = /Tests\s+(.+)/.exec(stdout);
    if (!testsLine) {
        return { parsed: false, numbers: { passed: null, failed: null }, executed: { tests: null, files: null } };
    }
    const counts = (line) => {
        const out = { passed: 0, failed: 0, skipped: 0 };
        if (!line) return out;
        for (const m of line.matchAll(/(\d+) (passed|failed|skipped)/g)) out[m[2]] = Number(m[1]);
        return out;
    };
    const t = counts(testsLine[1]);
    const f = counts(filesLine?.[1]);
    return {
        parsed: true,
        numbers: {
            testsPassed: t.passed,
            testsFailed: t.failed,
            testsSkipped: t.skipped,
            files: f.passed + f.failed,
        },
        executed: { tests: t.passed + t.failed + t.skipped, files: f.passed + f.failed },
    };
}

/** mutate-verify：`MATCH_COUNT=1` … `VERDICT=gate-catches` */
export function parseMutate(stdout) {
    const pick = (key) => {
        const m = new RegExp("^" + key + "=(\\S+)$", "m").exec(stdout);
        return m ? m[1] : null;
    };
    const verdict = pick("VERDICT");
    const matchCount = pick("MATCH_COUNT");
    if (verdict === null) {
        return { parsed: false, numbers: {}, executed: { mutationLegs: null } };
    }
    const ran = pick("BASELINE_EXIT") !== null && pick("MUTATED_EXIT") !== null;
    return {
        parsed: true,
        numbers: {
            matchCount: matchCount === null ? null : Number(matchCount),
            verdict,
            gateCatches: verdict === "gate-catches",
        },
        // 一条变异腿 = 两次真实编译/测试跑（baseline + mutated）。跑没跑看这两个退出码有没有出现。
        executed: { mutationLegs: ran ? 1 : 0 },
    };
}

/** i18n-scan `--json`：`counts.sourceFiles` 才是「扫了多少」，findings 是结果不是执行量。 */
export function parseI18nScan(stdout) {
    let json;
    try {
        json = JSON.parse(stdout);
    } catch {
        return { parsed: false, numbers: {}, executed: { files: null } };
    }
    const counts = json?.counts ?? {};
    return {
        parsed: typeof counts.sourceFiles === "number",
        numbers: {
            sourceFiles: counts.sourceFiles ?? null,
            keyLiterals: counts.keyLiterals ?? null,
            uniqueKeys: counts.uniqueKeys ?? null,
            findings: Array.isArray(json.findings) ? json.findings.length : null,
        },
        executed: { files: counts.sourceFiles ?? null },
    };
}

/**
 * 拍图前置门（task-2 / 原 task-97）：**它的 stdout 就是自己的 receipt JSON** ⇒ 解析即读回。
 *
 * <p>与其余六条门不同，本门不打子进程跑测试命令：它读 **栈状态**（dev-stack status）与 **git 树**，
 * 输出「能不能拍图」。因此 `counter` 是 `checks`（真正执行完的检查条数），
 * 而不是文件/用例数 —— 但「pass 必须证明干了活」这条不变：未给 `--pages` 之类没检查的情况
 * 一律 `verdict=error`，不存在「什么都没看还报 pass」的路径。</p>
 */
export function parseScreenshotPreflight(stdout) {
    const text = typeof stdout === "string" ? stdout : "";
    const fail = () => ({ parsed: false, numbers: {}, executed: { checks: null } });
    const isOurs = (o) => o && typeof o === "object" && o.gate === "screenshot-preflight";
    // 夹具/人读行可能混在前面：先整体试，再逐行找第一个属于本门的对象。
    try {
        const whole = JSON.parse(text.trim());
        if (isOurs(whole)) {
            return {
                parsed: true,
                numbers: whole.numbers ?? {},
                executed: whole.executed ?? { checks: null },
            };
        }
    } catch {
        /* 落到逐行再试 */
    }
    for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        try {
            const o = JSON.parse(t);
            if (isOurs(o)) {
                return { parsed: true, numbers: o.numbers ?? {}, executed: o.executed ?? { checks: null } };
            }
        } catch {
            /* 下一行 */
        }
    }
    return fail();
}

/**
 * 门表：**唯一的门清单**。加门只改这里 + 一个解析函数；reader 不认识具体门。
 *
 * <p>`counter` 是「这条门要证明自己真的干活了」的那个数。**pass 时它必须 > 0，否则判假绿。**</p>
 *
 * <p>`manual: true` = 该门必须带显式参数跑（`--all` 里**排除**它，否则只会产出一条 `E_USAGE` 错误行，
 * 把整批结论拖成 ERROR）。task-2 起由 `gate-receipt-run.mjs` 读这个字段，不再硬编码 `g !== "mutate"`。</p>
 */
export const GATES = Object.freeze({
    typecheck: { parse: parseTypecheck, counter: "files" },
    oxfmt: { parse: parseOxfmt, counter: "files" },
    oxlint: { parse: parseOxlint, counter: "files" },
    vitest: { parse: parseVitest, counter: "tests" },
    mutate: { parse: parseMutate, counter: "mutationLegs", manual: true },
    "i18n-scan": { parse: parseI18nScan, counter: "files" },
    "screenshot-preflight": { parse: parseScreenshotPreflight, counter: "checks", manual: true },
});

export const GATE_IDS = Object.freeze(Object.keys(GATES));

/**
 * 造一份 receipt。纯函数，不做 I/O，便于用例直接断言。
 */
export function createReceipt(input) {
    const { gate, verdict, code, numbers = {}, command, durationMs, executed, reason = null } = input;
    return {
        schemaVersion: SCHEMA_VERSION,
        gate,
        verdict,
        code,
        numbers,
        command,
        durationMs,
        executed,
        reason,
        at: input.at ?? new Date().toISOString(),
    };
}

/** 从 `parse()` 的产物直接造 receipt（runner 走这条）。 */
export function receiptFromRun({ gate, stdout, exitCode, durationMs, command, at }) {
    const spec = GATES[gate];
    if (!spec) {
        return createReceipt({
            gate,
            verdict: "error",
            code: CODES.E_USAGE,
            numbers: {},
            command,
            durationMs,
            executed: {},
            reason: '未知的门 "' + gate + '"；已知：' + GATE_IDS.join(", "),
            at,
        });
    }
    const { parsed, numbers, executed } = spec.parse(stdout);
    if (!parsed) {
        return createReceipt({
            gate,
            verdict: "error",
            code: CODES.E_UNPARSABLE,
            numbers,
            command,
            durationMs,
            executed,
            reason: "命令输出里解析不出必需计数 —— 无法判定，不许当绿",
            at,
        });
    }
    const ok = exitCode === 0;
    return createReceipt({
        gate,
        verdict: ok ? "pass" : "fail",
        code: ok ? CODES.OK : CODES.E_GATE_FAILED,
        numbers,
        command,
        durationMs,
        executed,
        reason: ok ? null : "退出码 " + exitCode,
        at,
    });
}

/**
 * **假绿判据**：`verdict === "pass"` 但该门的工作计数不是正数 ⇒ 这就是本契约要拦的东西。
 *
 * <p>「0 个测试通过」与「跑了很多都通过」在退出码上无法区分，只能在这里区分。</p>
 */
export function isFakeGreen(receipt) {
    if (receipt?.verdict !== "pass") return false;
    const spec = GATES[receipt.gate];
    if (!spec) return false;
    const v = receipt.executed?.[spec.counter];
    return typeof v !== "number" || !(v > 0);
}

/** 校验 receipt 结构。返 `{ ok, problems[] }`，不抛。 */
export function validateReceipt(r, { now = Date.now(), maxAgeMs = null } = {}) {
    const problems = [];
    if (!r || typeof r !== "object") return { ok: false, problems: ["receipt 不是对象"] };
    if (r.schemaVersion !== SCHEMA_VERSION) {
        problems.push("schemaVersion 应为 " + SCHEMA_VERSION + "，实为 " + r.schemaVersion);
    }
    if (!GATES[r.gate]) problems.push('未知门 "' + r.gate + '"');
    if (!VERDICTS.includes(r.verdict)) problems.push('verdict 非法："' + r.verdict + '"');
    if (!Object.values(CODES).includes(r.code)) problems.push('code 非法："' + r.code + '"');
    if (typeof r.command !== "string" || r.command.trim() === "") {
        problems.push("command 为空：receipt 必须能复现");
    }
    if (typeof r.durationMs !== "number" || r.durationMs < 0) problems.push("durationMs 非法");
    if (!r.executed || typeof r.executed !== "object") {
        problems.push("executed 缺失：这是本契约的核心字段");
    }
    if (r.verdict === "skipped" && !r.reason) problems.push("verdict=skipped 必须带 reason");
    if (r.verdict === "error" && !r.reason) problems.push("verdict=error 必须带 reason");
    if (maxAgeMs !== null) {
        const t = Date.parse(r.at);
        if (Number.isNaN(t)) problems.push('at 不是时间："' + r.at + '"');
        else if (now - t > maxAgeMs) {
            problems.push("receipt 过期：" + Math.round((now - t) / 1000) + "s > " + Math.round(maxAgeMs / 1000) + "s");
        }
    }
    return { ok: problems.length === 0, problems };
}
