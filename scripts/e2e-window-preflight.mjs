#!/usr/bin/env node
/**
 * task-246：窗口开窗前置 —— **一条命令出表 + 一行 `PASS 开窗` / `FAIL <原因>`**。
 *
 * 两种模式（必须二选一并写清用哪套；详见 `internal/A03-xihe/evidence/2026-11-12-window-preflight-draft/`）：
 *   - **严格模式（默认，窗口放行门只用它）**：G1…G10 全部满足才 PASS。`behind == 0` 是窗口门，不是可选项。
 *   - **内容模式（`--content`，仅用于解释"非窗口期可不重建"）**：在严格表之外追加 **G5'** 一行，**双证缺一不可**：
 *       ① `git rev-list --count <cpBuild.runningCommit>..HEAD -- packages/control-plane` == 0（提交面）；
 *       ② 内容等价（内容面）：e2e 侧读 `e2e-preflight.mjs` 的 `byte-identical to the artifact built from <sha>` 行；
 *          dev 栈 CP 无 fat jar ⇒ 用 **CP 子树 tree-sha 相等**（`git rev-parse <rev>:packages/control-plane`）。
 *       ⚠ G5' **绝不进窗口放行门**：它只回答"这次不重建有没有依据"，不回答"能不能开窗"。
 *
 * ── 三条"不算失败"（误判清单写进工具本身，别在实现里重犯）─────────────────────────────
 *  1) **`e2e-preflight` 的 CP jar 段 FAIL = 可自愈类**：`scripts/e2e-host.mjs:2642-2659`（及 `:578` 默认路径）
 *     会在 preflight **之前** `mvn package` 重建 jar 并盖戳；只有"重建失败"才是真 FAIL（该处 `process.exit(1)`）。
 *     因此 A4 行**只记录、不进 FAIL**，即使它退出非 0 也一样。
 *  2) **`lease.state=cold` ≠ 掉线**：`dev-stack` 租约心跳有 10min 阈值，无人读 `status` 就过期。
 *     判"掉线"要看 `services[].httpStatus / services[].ready / services[].alive`，**不能**用 `lease.state` 单字段。
 *     所以 G10 的 ok 取 `verdict === 'healthy'`（它已含服务事实），`lease.state` 只进备注。
 *  3) **`gc` 的 `nothing to collect` 只覆盖 dev 栈**（租约/pid）。e2e 的容器/网络/卷要**按 run-id 名字**判归属
 *     （`xihe-e2e-host-<runId>-*`）：看到新 run-id 说明**别的窗口在跑**，不能倒推"上一窗有残留"。因此 A3/A5 分开记。
 *
 * 用法：
 *   node scripts/e2e-window-preflight.mjs --pin <sha7..40> [--batch real-full] [--only <name>]
 *        [--stack stack-1] [--content] [--json]
 * 退出码：**0 = PASS 开窗 / 1 = FAIL（原因列在结论行）/ 2 = 用法或前置错误（缺 pin、status 读不到）**。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { deriveStack } from "./lib/stack-ports.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

/** health 探针路径：**agent 不是 `/health`**（直打会 404，实测）。 */
const HEALTH_PATHS = Object.freeze({
    ui: "/",
    cp: "/api/v1/health",
    agent: "/internal/v1/agent/health",
    runtime: "/health",
});
const SERVICE_ORDER = ["ui", "cp", "agent", "runtime"];
const E2E_PORT_MIN = 27000;
const E2E_PORT_MAX = 28511;
const MIGRATION_DIR = "packages/control-plane/src/main/resources/db/migration";

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
    const out = {
        pin: null,
        batch: "real-full",
        only: "",
        stack: "stack-1",
        content: false,
        json: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--pin") out.pin = String(argv[(i += 1)] ?? "").trim();
        else if (arg.startsWith("--pin=")) out.pin = arg.slice("--pin=".length).trim();
        else if (arg === "--batch") out.batch = String(argv[(i += 1)] ?? "").trim() || "real-full";
        else if (arg.startsWith("--batch=")) out.batch = arg.slice("--batch=".length).trim();
        else if (arg === "--only") out.only = String(argv[(i += 1)] ?? "").trim();
        else if (arg.startsWith("--only=")) out.only = arg.slice("--only=".length).trim();
        else if (arg === "--stack") out.stack = String(argv[(i += 1)] ?? "").trim() || "stack-1";
        else if (arg.startsWith("--stack=")) out.stack = arg.slice("--stack=".length).trim();
        else if (arg === "--content") out.content = true;
        else if (arg === "--json") out.json = true;
        else if (arg === "--help" || arg === "-h") out.help = true;
        else throw new UsageError(`unknown argument: ${arg}`);
    }
    return out;
}

class UsageError extends Error {}

function validateArgs(options) {
    if (options.help) return;
    if (!options.pin) throw new UsageError("缺少 --pin <sha>：窗口门必须显式给钉靶，脚本不会替你猜");
    if (!/^[0-9a-fA-F]{7,40}$/.test(options.pin)) {
        throw new UsageError(`--pin 非法：${JSON.stringify(options.pin)}（需 7..40 位十六进制）`);
    }
    try {
        deriveStack(options.stack);
    } catch (error) {
        throw new UsageError(error.message);
    }
}

// ---------------------------------------------------------------- 事实采集（真实命令；测试只用 evaluate*）

function git(repoRoot, args) {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
}

function porcelainCount(repoRoot, subdir) {
    const raw = git(repoRoot, ["status", "--porcelain", "--", subdir]);
    return raw === "" ? 0 : raw.split("\n").length;
}

function stackStatus(repoRoot, stackId) {
    const result = spawnSync(
        process.execPath,
        [path.join(repoRoot, "scripts/dev-stack.mjs"), "status", "--stack", stackId, "--json"],
        { encoding: "utf8", cwd: repoRoot, timeout: 120_000 },
    );
    const stdout = result.stdout ?? "";
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start === -1 || end <= start) {
        throw new Error(
            `dev-stack status 读不到 JSON（exit=${result.status}）：${(result.stderr || stdout).trim().slice(0, 300)}`,
        );
    }
    return JSON.parse(stdout.slice(start, end + 1));
}

async function httpStatus(url, timeoutMs = 8000) {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        return response.status;
    } catch {
        return "ERR";
    }
}

function migrationFileMax(repoRoot) {
    const dir = path.join(repoRoot, MIGRATION_DIR);
    let max = 0;
    for (const name of fs.readdirSync(dir)) {
        const match = /^V(\d+)__.+\.sql$/.exec(name);
        if (match) max = Math.max(max, Number(match[1]));
    }
    return max;
}

function dbVersionMax(repoRoot, stackId) {
    const derived = deriveStack(stackId);
    const container = `${derived.composeProject}-postgres-1`;
    const script = 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -c "select max(version::int) from flyway_schema_history"';
    const result = spawnSync("docker", ["exec", container, "sh", "-c", script], {
        encoding: "utf8",
        cwd: repoRoot,
        timeout: 60_000,
    });
    if (result.status !== 0) {
        return { container, version: null, error: (result.stderr || result.stdout || "").trim().slice(0, 200) };
    }
    const digits = String(result.stdout ?? "").replace(/[^0-9]/g, "");
    return { container, version: digits === "" ? null : Number(digits), error: "" };
}

function plannerVerdict(repoRoot, { batch, only, sha }) {
    const args = [path.join(repoRoot, "scripts/e2e-batch-plan.mjs"), `--batch=${batch}`, `--sha=${sha}`];
    if (only) args.push(`--only=${only}`);
    const result = spawnSync(process.execPath, args, { encoding: "utf8", cwd: repoRoot, timeout: 120_000 });
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const readyLines = text.split("\n").filter((line) => line.includes("[verdict] READY"));
    return {
        batch,
        only,
        sha,
        ready: readyLines.length === 1,
        exit: result.status,
        tail: readyLines[0]?.trim() ?? text.trim().slice(-160),
    };
}

/** Windows 专用探针（A1/A2）；其它平台记 SKIP。 */
function windowsProbe(command) {
    if (process.platform !== "win32") return { ok: false, value: "SKIP(非 Windows)", raw: "" };
    const result = spawnSync("pwsh", ["-NoProfile", "-Command", command], { encoding: "utf8", timeout: 120_000 });
    if (result.status !== 0) return { ok: false, value: "ERR", raw: (result.stderr ?? "").trim().slice(0, 160) };
    return { ok: true, value: (result.stdout ?? "").trim(), raw: "" };
}

function dockerE2eContainers() {
    const result = spawnSync("docker", ["ps", "-a", "--format", "{{.Names}} {{.Status}}"], {
        encoding: "utf8",
        timeout: 60_000,
    });
    if (result.status !== 0) return { ok: false, up: [], all: [] };
    const rows = String(result.stdout ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.includes("xihe-e2e-host"));
    const up = rows.filter((line) => /\bUp\b/i.test(line));
    return { ok: true, up, all: rows };
}

function devStackGc(repoRoot) {
    const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts/dev-stack.mjs"), "gc"], {
        encoding: "utf8",
        cwd: repoRoot,
        timeout: 120_000,
    });
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    return { nothing: text.includes("nothing to collect"), exit: result.status, head: text.trim().split("\n")[0] ?? "" };
}

function e2ePreflight(repoRoot) {
    const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts/e2e-preflight.mjs")], {
        encoding: "utf8",
        cwd: repoRoot,
        timeout: 300_000,
    });
    const lines = String(`${result.stdout ?? ""}\n${result.stderr ?? ""}`).split("\n");
    const failLine = lines.find((line) => /^\s*FAIL/.test(line))?.trim() ?? "";
    const identicalLine = lines.find((line) => line.includes("byte-identical to the artifact built from"))?.trim() ?? "";
    return { exit: result.status, failLine, identicalLine };
}

async function gatherFacts(repoRoot, options) {
    const headFull = git(repoRoot, ["rev-parse", "HEAD"]);
    const head12 = git(repoRoot, ["rev-parse", "--short=12", "HEAD"]);
    const status = stackStatus(repoRoot, options.stack);
    const derived = deriveStack(options.stack);
    const codes = {};
    for (const service of SERVICE_ORDER) {
        const port = derived.ports[service];
        codes[service] = await httpStatus(`http://127.0.0.1:${port}${HEALTH_PATHS[service]}`);
    }
    const db = dbVersionMax(repoRoot, options.stack);
    const planner = plannerVerdict(repoRoot, { batch: options.batch, only: options.only, sha: head12 });
    const facts = {
        headFull,
        head12,
        cpDirty: porcelainCount(repoRoot, "packages/control-plane"),
        uiDirty: porcelainCount(repoRoot, "packages/ui"),
        cpBuild: {
            verdict: status.cpBuild?.verdict ?? "unknown",
            behind: Number(status.cpBuild?.behind ?? 0),
            dirty: Boolean(status.cpBuild?.dirty),
            runningCommit: status.cpBuild?.runningCommit ?? "",
            headCommit: status.cpBuild?.headCommit ?? "",
        },
        stack: {
            verdict: status.verdict ?? "unknown",
            leaseState: status.lease?.state ?? "unknown",
            services: (status.services ?? []).map((service) => ({
                service: service.service,
                httpStatus: service.httpStatus,
                ready: Boolean(service.ready),
                alive: Boolean(service.alive),
            })),
        },
        ports: { derived: derived.ports, codes },
        db: { fileMax: migrationFileMax(repoRoot), dbMax: db.version, container: db.container, error: db.error },
        planner,
        annotations: buildAnnotations(repoRoot),
    };
    if (options.content) facts.content = buildContentProof(repoRoot, facts);
    return facts;
}

function buildAnnotations(repoRoot) {
    const e2eProcesses = windowsProbe(
        "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'e2e-host\\.mjs' } | Measure-Object).Count",
    );
    const e2ePorts = windowsProbe(
        // 注意：`@(... | Measure-Object).Count` 会永远得 1（数组里只有 MeasureObjectInfo 一个元素），
        // 这个坑在草案里就存在；正确写法是 `@(...).Count` 或 `(... | Measure-Object).Count`。
        `@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge ${E2E_PORT_MIN} -and $_.LocalPort -le ${E2E_PORT_MAX} -and $_.OwningProcess -ne 4 }).Count`,
    );
    const containers = dockerE2eContainers();
    const preflight = e2ePreflight(repoRoot);
    const gc = devStackGc(repoRoot);
    return { e2eProcesses, e2ePorts, containers, preflight, gc };
}

/** 内容模式双证（**缺一不可**）：① CP-scoped 计数 ② 子树 tree-sha / e2e byte-identical。 */
function buildContentProof(repoRoot, facts) {
    const running = facts.cpBuild.runningCommit;
    const proof = { running: running.slice(0, 12), cpScoped: null, treeRunning: "", treeHead: "", treeEqual: null, error: "" };
    if (!running) {
        proof.error = "cpBuild.runningCommit 为空（构建戳缺失），内容模式不可用";
        return proof;
    }
    try {
        proof.cpScoped = Number(git(repoRoot, ["rev-list", "--count", `${running}..HEAD`, "--", "packages/control-plane"]));
        // 注意：`git rev-parse <rev>:packages/control-plane` 直接用目录路径即得 tree sha；
        // 追加 `^{tree}` 会 fatal（实测 `fatal: path ... does not exist`），别画蛇添足。
        proof.treeRunning = git(repoRoot, ["rev-parse", `${running}:packages/control-plane`]);
        proof.treeHead = git(repoRoot, ["rev-parse", "HEAD:packages/control-plane"]);
        proof.treeEqual = proof.treeRunning === proof.treeHead;
    } catch (error) {
        proof.error = error.message.slice(0, 200);
    }
    proof.e2eByteIdentical = facts.annotations.preflight.identicalLine;
    return proof;
}

// ---------------------------------------------------------------- 判定（纯函数，自测直接喂 facts 夹具）

function displayWidth(text) {
    let display = 0;
    for (const char of String(text ?? "")) display += char.codePointAt(0) > 0x2e80 ? 2 : 1;
    return display;
}

function padDisplay(text, width) {
    return String(text ?? "") + " ".repeat(Math.max(0, width - displayWidth(text)));
}

function rowsToTable(rows) {
    const columns = [
        { header: "ID", key: "id" },
        { header: "检查", key: "check" },
        { header: "读数", key: "value" },
        { header: "期望", key: "expect" },
        { header: "状态", key: "status" },
        { header: "备注", key: "note" },
    ];
    const cells = rows.map((row) => ({
        id: row.id,
        check: row.check,
        value: row.value,
        expect: row.expect,
        status: row.ok ? "OK" : "FAIL",
        note: row.note ?? "",
    }));
    const widths = columns.map((column) =>
        Math.max(displayWidth(column.header), ...cells.map((cell) => displayWidth(cell[column.key]))),
    );
    const render = (values) =>
        values
            .map((value, index) => padDisplay(value, widths[index]))
            .join("  ")
            .trimEnd();
    return [render(columns.map((column) => column.header)), ...cells.map((cell) => render(columns.map((column) => cell[column.key])))]
        .join("\n");
}

/**
 * @returns {{rows: Array, failures: Array, conclusion: string}}
 */
export function evaluatePreflight({ pin, facts }) {
    const rows = [];
    const push = (id, check, value, expect, ok, note = "", gate = true) => {
        rows.push({ id, check, value, expect, ok, note, gate });
    };
    const pinPrefix = String(pin).toLowerCase();
    // head12 是 12 位短 sha；pin 允许 7..40 位 ⇒ 用「head 是否以该前缀开头」判等（不会把 12 位 pin 误判成 40 位）。
    const headMatch = String(facts.head12).toLowerCase().startsWith(pinPrefix);
    push("G1", "HEAD==钉靶", `head=${facts.head12} pin=${pinPrefix}`, "相等", headMatch);
    push("G2", "CP 子树 0 条", `${facts.cpDirty} 条`, "0", facts.cpDirty === 0);
    push("G3", "packages/ui/** 0 条", `${facts.uiDirty} 条`, "0", facts.uiDirty === 0, "D-1037：ui 是 packages/ui/**，不是 ui/src");
    push("G4", "cpBuild.verdict", String(facts.cpBuild.verdict), "fresh", facts.cpBuild.verdict === "fresh");
    push(
        "G5",
        "cpBuild.behind",
        String(facts.cpBuild.behind),
        "0",
        facts.cpBuild.behind === 0,
        "⚠ behind 是**全部提交数**（含纯 UI/e2e），不是 CP 子树提交数（D-1040）",
    );
    push(
        "G6",
        "cpBuild.dirty",
        String(facts.cpBuild.dirty),
        "false",
        facts.cpBuild.dirty === false,
        "弱判据：构建时戳而非当前树（D-1032）；主判据是 G2/G3",
    );
    const codes = SERVICE_ORDER.map((service) => `${service}=${facts.ports.codes[service]}`).join(" ");
    const allOk = SERVICE_ORDER.every((service) => facts.ports.codes[service] === 200);
    push("G7", "四端口 200", codes, "4×200", allOk, "agent 探针是 /internal/v1/agent/health（不是 /health）");
    push(
        "G8",
        "DB 迁移==最新迁移文件",
        `db=${facts.db.dbMax ?? "-"} file=${facts.db.fileMax}${facts.db.error ? ` (${facts.db.error})` : ""}`,
        "相等",
        facts.db.dbMax !== null && facts.db.dbMax === facts.db.fileMax,
        `容器 ${facts.db.container}`,
    );
    push(
        "G9",
        "批规划 READY",
        `batch=${facts.planner.batch ?? "-"} only=${facts.planner.only || "-"} ready=${facts.planner.ready ? 1 : 0}`,
        "1",
        Boolean(facts.planner.ready),
    );
    const healthy = facts.stack.verdict === "healthy";
    push(
        "G10",
        "stack.verdict",
        String(facts.stack.verdict),
        "healthy",
        healthy,
        `lease=${facts.stack.leaseState}（cold≠掉线，看 services[].httpStatus/ready/alive）`,
    );
    if (facts.content) {
        const proof = facts.content;
        const ok = proof.cpScoped === 0 && proof.treeEqual === true;
        push(
            "G5'",
            "CP-scoped behind + tree-sha（内容模式，不进窗口门）",
            `scoped=${proof.cpScoped ?? "?"} tree=${String(proof.treeRunning).slice(0, 12)}/${String(proof.treeHead).slice(0, 12)}${proof.error ? ` ERR=${proof.error}` : ""}`,
            "0 且相等",
            ok,
            proof.e2eByteIdentical ? `e2e: ${proof.e2eByteIdentical}` : "e2e byte-identical 行未取到",
            false,
        );
    }
    const annotations = facts.annotations;
    push(
        "A1",
        "e2e 未在跑",
        `e2e-host 进程=${annotations.e2eProcesses.ok ? annotations.e2eProcesses.value : "ERR"}`,
        "0",
        annotations.e2eProcesses.ok && annotations.e2eProcesses.value === "0",
        "非 0 ⇒ 可能别的窗口在跑（只记录，不 FAIL）",
        false,
    );
    push(
        "A2",
        "e2e 段非 System listener",
        `${annotations.e2ePorts.ok ? annotations.e2ePorts.value : "ERR"} 个`,
        "0",
        annotations.e2ePorts.ok && annotations.e2ePorts.value === "0",
        "27000-28511 只允许 System 自身监听",
        false,
    );
    push(
        "A3",
        "e2e 容器 Up",
        `${annotations.containers.up.length} 个 Up / ${annotations.containers.all.length} 个存在`,
        "0 个 Up",
        annotations.containers.ok && annotations.containers.up.length === 0,
        "按 run-id 名字判归属（xihe-e2e-host-<runId>-*）；Exited 可留",
        false,
    );
    push(
        "A4",
        "e2e-preflight（jar 段=自愈类）",
        annotations.preflight.failLine || `exit=${annotations.preflight.exit}`,
        "无失败，或仅 CP jar 陈旧",
        annotations.preflight.failLine === "",
        "jar 段 FAIL 由 e2e-host 在 preflight 前重建（e2e-host.mjs:2642-2659）；只记录",
        false,
    );
    push(
        "A5",
        "dev 栈残留（gc）",
        annotations.gc.nothing ? "nothing to collect" : annotations.gc.head,
        "nothing to collect",
        annotations.gc.nothing,
        "gc 只扫 dev 栈租约/pid，不扫 e2e 容器",
        false,
    );
    const failures = rows.filter((row) => row.gate && !row.ok);
    const conclusion =
        failures.length === 0
            ? "PASS 开窗"
            : `FAIL ${failures.map((row) => `${row.id}(${row.check})=${row.value}`).join("; ")}`;
    return { rows, failures, conclusion };
}

// ---------------------------------------------------------------- CLI

async function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
        validateArgs(options);
    } catch (error) {
        if (error instanceof UsageError) {
            console.error(`[e2e-window-preflight] ${error.message}`);
            console.error(
                "  usage: node scripts/e2e-window-preflight.mjs --pin <sha7..40> [--batch real-full] [--only <name>] [--stack stack-1] [--content] [--json]",
            );
            return 2;
        }
        throw error;
    }
    if (options.help) {
        console.log("usage: node scripts/e2e-window-preflight.mjs --pin <sha7..40> [--batch real-full] [--only <name>] [--stack stack-1] [--content] [--json]");
        return 0;
    }
    let facts;
    try {
        facts = await gatherFacts(REPO_ROOT, options);
        facts.planner = { ...facts.planner, batch: options.batch, only: options.only };
    } catch (error) {
        console.error(`[e2e-window-preflight] 前置读取失败：${error.message}`);
        return 2;
    }
    const { rows, failures, conclusion } = evaluatePreflight({ pin: options.pin, facts });
    if (options.json) {
        console.log(
            JSON.stringify(
                {
                    pin: options.pin,
                    batch: options.batch,
                    only: options.only,
                    stack: options.stack,
                    mode: options.content ? "content" : "strict",
                    head: facts.head12,
                    rows,
                    failures: failures.map((row) => row.id),
                    conclusion,
                },
                null,
                2,
            ),
        );
        return failures.length === 0 ? 0 : 1;
    }
    console.log(
        `[e2e-window-preflight] stack=${options.stack} mode=${options.content ? "content(附注)" : "strict(窗口门)"} pin=${options.pin} batch=${options.batch} only=${options.only || "-"}`,
    );
    console.log(rowsToTable(rows));
    if (options.content && facts.content) {
        const proof = facts.content;
        console.log(
            `  内容模式双证：① CP-scoped=${proof.cpScoped ?? "?"}（0 才成立）② tree ${String(proof.treeRunning).slice(0, 12)} / ${String(proof.treeHead).slice(0, 12)}（相等才成立）${proof.error ? ` ERR=${proof.error}` : ""}`,
        );
        console.log(
            "  铁律：内容模式只解释「非窗口期值不值得重建」，不进窗口放行门；开窗仍按严格模式（behind=0）重建。",
        );
    }
    console.log(conclusion);
    return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    process.exit(await main());
}
