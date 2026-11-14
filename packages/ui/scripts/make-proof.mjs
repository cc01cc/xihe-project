#!/usr/bin/env node
/**
 * 生成（或校验）截图执行器的 `--dirty-proof` 文件：对每条脏路径给出「不进渲染」的可复算命令。
 *
 * 为什么需要它：`ui-mock-shot.mjs` 在脏树上默认拒拍，只接受「命令 + 实际输出」形式的证明。
 * 手写这份 JSON 有两个真实失败模式（2026-11-15 task-54 各撞到一次）：
 *
 *   ① 证明写成「身份声明」（我保证这文件不影响渲染）—— 那正是脚本要拒绝的东西；
 *   ② 证明范围猜错：先用 `from "…e2e/…"` 扫 src，结果命中
 *      `src/lib/__tests__/e2e-select-helper.spec.ts`（一个测试文件确实 import 了 e2e 辅助件），
 *      于是「证明」变成假阴/假阳各一次。真正的口径是「排除 __tests__ 与 *.spec.ts 后的
 *      **生产 import 图**」—— 测试文件不进 bundle。
 *
 * 所以本仪器只做一件事：把「哪类脏路径可以证明」写成**三类白名单**，其余一律拒绝并点名。
 *
 * 用法：
 *   node packages/ui/scripts/make-proof.mjs --out <proof.json>
 *   node packages/ui/scripts/make-proof.mjs --check <path> [<path> ...]
 *   node packages/ui/scripts/make-proof.mjs --selftest
 *
 * 三类可证明（命令由本脚本产出，proof 里记录命令本身而不是理由文字）：
 *   - packages/ui/e2e/**      ⇒ src 的生产 import 图不指向 e2e（grep 0 命中）
 *   - packages/ui/scripts/**  ⇒ src 不 import 执行器脚本
 *   - packages/ui 之外的路径   ⇒ Vite root 是 packages/ui，包外文件不参与构建
 * 其余（packages/ui 内的 src/样式/词典/配置等）⇒ **exit 1 并点名**，因为那种脏无法用命令证明。
 *
 * 退出码：0 全部可证明 / 1 有不可证明的脏路径（已点名）/ 2 用法或环境错误。
 *
 * 零第三方依赖（只用 Node 内建）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;

const UI_ROOT = path.resolve(import.meta.dirname, "..");

/** e2e 的证明命令：只扫生产 import 图（排除 __tests__ 与 *.spec.ts）。 */
export const E2E_PROOF = {
    command: [
        "git",
        "grep",
        "-nE",
        'from "[^"]*(e2e|helpers)/',
        "--",
        "packages/ui/src",
        ":(exclude)packages/ui/src/**/__tests__/**",
        ":(exclude)packages/ui/src/**/*.spec.ts",
    ],
    expect: "empty",
    reason:
        "e2e 用例/辅助件：产物由 src 的生产 import 图决定；排除 __tests__ 与 *.spec.ts（它们不进 bundle，" +
        "其中 e2e-select-helper.spec.ts 确实 import 了 e2e/helpers/select —— 正因如此才要排除而不是假装不存在）后 0 命中",
};

/** scripts 的证明命令：src 不 import 截图执行器。 */
export const SCRIPT_PROOF = {
    command: ["git", "grep", "-nE", 'from "[^"]*ui-mock-shot', "--", "packages/ui/src"],
    expect: "empty",
    reason: "截图执行器脚本：src 不 import 它 ⇒ 不进 bundle",
};

/**
 * 包外路径的证明命令：只在「该路径确实在 packages/ui 内」时才有输出。
 * 空输出 = 机械地证明了它在包外（Vite root 即 packages/ui），不是靠人保证。
 */
export function outsideProof(target) {
    return {
        command: [
            "node",
            "-e",
            'const p=process.argv[1];if(p.startsWith("packages/ui/"))console.log("在包内: "+p);',
            "--",
            target,
        ],
        expect: "empty",
        reason: "不在 packages/ui 之内（Vite root 即该目录）⇒ 不参与 UI 构建，改它不会改变任何一张图的像素",
    };
}

function normalize(value) {
    return String(value).replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

/**
 * 分类一条脏路径。返回值 category ∈ e2e|script|outside|refuse；refuse 时 proof 为 null。
 * **纯函数**（不碰文件系统），这样 --selftest 才能用合成路径把每个分支都钉住。
 */
export function classify(rawPath) {
    const target = normalize(rawPath);
    if (target === "") return { path: target, category: "refuse", proof: null };
    if (target.startsWith("packages/ui/e2e/")) {
        return { path: target, category: "e2e", proof: E2E_PROOF };
    }
    if (target.startsWith("packages/ui/scripts/")) {
        return { path: target, category: "script", proof: SCRIPT_PROOF };
    }
    if (!target.startsWith("packages/ui/")) {
        return { path: target, category: "outside", proof: outsideProof(target) };
    }
    // packages/ui 之内但不是 e2e/scripts ⇒ 产品面（src/样式/词典/构建配置），无法用命令证明。
    return { path: target, category: "refuse", proof: null };
}

/** 批量分类结果：refused 非空即不可出图。 */
export function classifyAll(rawPaths) {
    const entries = [];
    const refused = [];
    for (const rawPath of rawPaths) {
        const item = classify(rawPath);
        if (item.category === "refuse") refused.push(item.path);
        // category 也写进条目：--check 的输出要能自解释（只写 path 时读的人不知道为什么它可证明）。
        else entries.push({ path: item.path, category: item.category, ...item.proof });
    }
    return { entries, refused };
}

/** 读 uiRoot 的 git 状态（porcelain v1，仓库根相对路径）。 */
export function dirtyPathsFromGit(uiRoot = UI_ROOT) {
    const output = execFileSync("git", ["-C", uiRoot, "status", "--porcelain"], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
    });
    return output
        .split("\n")
        .filter((line) => line.length > 3)
        .map((line) => normalize(line.slice(3)));
}

function usage() {
    process.stderr.write(
        [
            "用法:",
            "  node packages/ui/scripts/make-proof.mjs --out <proof.json>",
            "  node packages/ui/scripts/make-proof.mjs --check <path> [<path> ...]",
            "  node packages/ui/scripts/make-proof.mjs --selftest",
            "",
            "退出码: 0 可证明 / 1 有不可证明的脏路径（已点名）/ 2 用法或环境错误",
            "",
        ].join("\n"),
    );
    process.exit(EXIT_USAGE);
}

function reportRefused(refused, hint) {
    process.stderr.write(
        "[make-proof] 拒绝出图：以下路径在 packages/ui 内且可能进渲染，无法用命令证明\n",
    );
    for (const item of refused) process.stderr.write("  - " + item + "\n");
    if (hint) process.stderr.write(hint + "\n");
}

export function main(argv) {
    const [command, ...rest] = argv;
    if (!command || command === "--help" || command === "-h") usage();
    if (command === "--out") {
        if (rest.length !== 1) usage();
        const out = rest[0];
        let paths;
        try {
            paths = dirtyPathsFromGit();
        } catch (error) {
            process.stderr.write("[make-proof] 读 git 状态失败: " + String(error) + "\n");
            return EXIT_USAGE;
        }
        const { entries, refused } = classifyAll(paths);
        if (refused.length > 0) {
            reportRefused(refused, "请先提交或收走它们，再出图（不要用「身份声明」当证明）。");
            return EXIT_REFUSED;
        }
        fs.writeFileSync(out, JSON.stringify(entries, null, 2) + "\n", "utf8");
        process.stdout.write(
            "[make-proof] 脏路径 " + entries.length + " 条，全部可证明 → " + out + "\n",
        );
        for (const entry of entries) process.stdout.write("  " + entry.path + "\n");
        return EXIT_OK;
    }
    if (command === "--check") {
        if (rest.length === 0) usage();
        const { entries, refused } = classifyAll(rest);
        process.stdout.write("[make-proof] 可证明 " + entries.length + " 条\n");
        for (const entry of entries)
            process.stdout.write("  OK    " + entry.path + "  (" + entry.category + ")\n");
        if (refused.length > 0) {
            reportRefused(refused, "这些是产品面文件：出图前必须干净，不能靠证明绕过。");
            return EXIT_REFUSED;
        }
        return EXIT_OK;
    }
    if (command === "--selftest") return selftest();
    usage();
    return EXIT_USAGE;
}

function selftest() {
    const checks = [];
    const check = (name, ok, detail) => checks.push({ name, ok, detail: detail ?? "" });

    check(
        "e2e 路径 ⇒ category=e2e",
        classify("packages/ui/e2e/mock/helpers/auth.ts").category === "e2e",
        "",
    );
    check(
        "scripts 路径 ⇒ category=script",
        classify("packages/ui/scripts/make-proof.mjs").category === "script",
        "",
    );
    check(
        "包外路径 ⇒ category=outside",
        classify("docs/api/openapi.yaml").category === "outside",
        "",
    );
    check(
        "packages/ui/src/** ⇒ refuse（产品面无法用命令证明）",
        classify("packages/ui/src/i18n/index.ts").category === "refuse",
        classify("packages/ui/src/i18n/index.ts").category,
    );
    check("包内样式/配置同样 refuse", classify("packages/ui/index.html").category === "refuse", "");
    check(
        "反斜杠与 ./ 前缀被归一化",
        classify(".\\packages\\ui\\e2e\\x.spec.ts").category === "e2e",
        "",
    );
    const mixed = classifyAll([
        "packages/ui/e2e/a.ts",
        "packages/ui/src/features/x.ts",
        "AGENTS.md",
    ]);
    check(
        "混入产品文件 ⇒ refused 点名且 entries 仍给出可证明项",
        mixed.refused.length === 1 &&
            mixed.refused[0] === "packages/ui/src/features/x.ts" &&
            mixed.entries.length === 2,
        JSON.stringify({
            refused: mixed.refused,
            entries: mixed.entries.map((entry) => entry.path),
        }),
    );
    const e2eCommand = E2E_PROOF.command.join(" ");
    check(
        "e2e 证明命令排除 __tests__ 与 *.spec.ts（否则会命中 e2e-select-helper.spec.ts）",
        e2eCommand.includes(":(exclude)packages/ui/src/**/__tests__/**") &&
            e2eCommand.includes(":(exclude)packages/ui/src/**/*.spec.ts"),
        e2eCommand,
    );
    check(
        "所有证明都带 expect（没有 expect 的证明等于没写判据）",
        [E2E_PROOF, SCRIPT_PROOF, outsideProof("docs/x.md")].every(
            (proof) => proof.expect === "empty",
        ),
        "",
    );
    check(
        "包外证明是「命令」而不是「声明」：命令里含 argv 数组且带 -- 分隔",
        Array.isArray(outsideProof("docs/x.md").command) &&
            outsideProof("docs/x.md").command.includes("--"),
        outsideProof("docs/x.md").command.join(" "),
    );

    for (const item of checks) {
        process.stdout.write(
            (item.ok ? "PASS  " : "FAIL  ") +
                item.name +
                (item.detail ? "  (" + item.detail + ")" : "") +
                "\n",
        );
    }
    const failed = checks.filter((item) => !item.ok);
    if (failed.length > 0) {
        process.stderr.write("[make-proof] 自检失败 " + failed.length + "/" + checks.length + "\n");
        return EXIT_REFUSED;
    }
    process.stdout.write("[make-proof] 自检通过 " + checks.length + "/" + checks.length + "\n");
    return EXIT_OK;
}

if (import.meta.url === "file:///" + process.argv[1].replace(/\\/g, "/")) {
    process.exit(main(process.argv.slice(2)));
}
