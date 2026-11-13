#!/usr/bin/env node
// 真栈视觉基线 · Linux 容器执行器（一条命令从零到出图）
//
// 为什么需要它：`expectPlatformScreenshot` 在非 linux 平台直接 test.skip
// （packages/ui/e2e/helpers/visual.ts:16-34，task-174 故意改的），所以真栈截图
// 必须在 Linux 容器里跑；而栈（CP + Vite）跑在宿主 Windows 上。
// 于是整个执行方式由两半组成，缺任何一半都复现不了：
//   半 A（宿主，本文件）：docker run 的参数 —— 镜像 / 挂载 / 环境变量 / 工作目录
//   半 B（容器内，嵌入在 CONTAINER_SH）：端口转发 + readiness 轮询 + 跑 spec
//
// 参数出处（逐项，全部可由 git 内文件复核，不凭记忆）：
//   镜像 digest    evidence/2026-11-13-bl601-real-lane/runlog/r1-generate-4.txt:3
//   挂载 target    ebd. :4（原文：「node_modules 是 Windows 绝对 symlink，必须挂到同一路径」）
//   环境变量       ebd. :5（CI=1 XIHE_E2E_EXTERNAL_SERVER=1 XIHE_UI_PORT=12640 XIHE_CP_PORT=12641）
//   容器内命令     ebd. :7
//   端口转发/就绪  ebd. :6,9-11（Vite Host 白名单：直连 host.docker.internal 会 403）
//   工作目录       【推断】= packages/ui：半 B 里的 node_modules/@playwright/test/cli.js
//                  与 --config=e2e/playwright.config.ts 都是相对该目录解析
//   未记录项       --rm / --add-host / --ipc=host：runlog 是摘要不是完整命令行，见 README §8.6
//
// 自证判据（task-342）：没有栈时跑，报的是「栈没起」而不是「参数错」——
//   所以栈探测在**宿主侧**先做一次，容器内再做一次，两侧分别给结论。

//
// lint 说明：本文件把 POSIX sh 脚本内联在普通字符串里，`${...}` 是 sh 的参数展开
// （`: "${UI_PORT:?}"`），不是 JS 模板占位符 —— 改成模板字面量会在解析期直接报错
// （这正是 task-342 初版的 bug）。故按文件关闭这条 warn 级规则：
/* oxlint-disable no-template-curly-in-string */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ---- 从原始跑记录里复原的常量（改它们等于改被测条件，必须同步 README §8.6）----
const IMAGE =
    process.env.XIHE_SHOT_IMAGE ||
    "mcr.microsoft.com/playwright@sha256:ee15712262f017b8157421b212b12099146645f44b1bc5c0514cbbe6a229b1d0";
const CONTAINER_ONE_ROOT = "/mnt/host/h/zeogit/one"; // 固定：与 runlog 一致，勿改
const UI_PORT = process.env.XIHE_UI_PORT || "12640";
const CP_PORT = process.env.XIHE_CP_PORT || "12641";

const EXIT = {
    DOCKER: 10, // docker 不可用
    IMAGE: 11, // 镜像不在本地（不 pull、不 build）
    STACK: 12, // 宿主栈没起 —— 唯一的「环境没准备好」
    DEPS: 13, // packages/ui/node_modules 未安装
    LAYOUT: 14, // 仓库布局不符（找不到 one 根）
    RUN: 15, // 容器跑完但 spec 失败（参数对、环境对，是用例/断言问题）
};

function log(s) {
    process.stdout.write(s + "\n");
}
function die(code, headline, detail) {
    log("");
    log("[FAIL:" + code + "] " + headline);
    for (const line of String(detail || "").split("\n")) if (line) log("  " + line);
    process.exit(code);
}

function run(cmd, args, opts) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, Object.assign({ shell: false }, opts || {}));
        let out = "";
        if (child.stdout)
            child.stdout.on("data", (b) => {
                out += b.toString();
                if (opts && opts.echo) process.stdout.write(b);
            });
        if (child.stderr)
            child.stderr.on("data", (b) => {
                out += b.toString();
                if (opts && opts.echo) process.stderr.write(b);
            });
        child.on("error", (e) => resolve({ code: -1, out: out + "\n" + e.message }));
        child.on("close", (code) => resolve({ code, out }));
    });
}

async function probe(url, tries, gapMs) {
    for (let i = 0; i < tries; i += 1) {
        try {
            const ctl = new AbortController();
            const t = setTimeout(() => ctl.abort(), 1500);
            const r = await fetch(url, { signal: ctl.signal });
            clearTimeout(t);
            return r.status;
        } catch {
            await new Promise((r) => setTimeout(r, gapMs));
        }
    }
    return 0;
}

// ---- 半 B：容器内脚本（POSIX sh；由 docker run ... bash -s 从 stdin 读入）----
const CONTAINER_SH = [
    "",
    "set -eu",
    ': "${UI_PORT:?}"; : "${CP_PORT:?}"',
    "",
    "# 端口转发：容器内 127.0.0.1:UI/CP -> host.docker.internal。",
    "# 为什么必须转发：Vite 有 Host 白名单，浏览器直接访问 host.docker.internal:12640 会",
    "# 403 Blocked request. This host is not allowed.（bl601 real-lane README:121-122）",
    "# 转发后 Host 头仍是 localhost ⇒ 合法。",
    "node -e '",
    '  const net = require("net");',
    "  for (const p of [Number(process.env.UI_PORT), Number(process.env.CP_PORT)]) {",
    "    net.createServer((c) => {",
    '      const u = net.connect(p, "host.docker.internal");',
    "      c.pipe(u); u.pipe(c);",
    '      c.on("error", () => u.destroy());',
    '      u.on("error", () => c.destroy());',
    '    }).listen(p, "127.0.0.1");',
    "  }",
    "' &",
    "FWD=$!",
    "trap 'kill $FWD 2>/dev/null || true' EXIT",
    "",
    "# 就绪轮询：每 500ms 一次，最多 240 次（=120s）。不用固定 sleep 的原因见真实跑记录。",
    "node -e '",
    "  const poll = async (url, tries) => {",
    "    for (let i = 0; i < tries; i++) {",
    "      try { const r = await fetch(url); if (r.status) return r.status; } catch (e) {}",
    "      await new Promise((r) => setTimeout(r, 500));",
    "    }",
    '    throw new Error("not ready: " + url);',
    "  };",
    "  (async () => {",
    '    console.log("[ready] ui=" + await poll("http://localhost:" + process.env.UI_PORT + "/", 240));',
    '    console.log("[ready] cp=" + await poll("http://localhost:" + process.env.CP_PORT + "/actuator/health", 240));',
    "  })();",
    "' || {",
    '  echo "[FAIL-CONTAINER] 容器到宿主不通：host.docker.internal:${UI_PORT}/${CP_PORT} 无响应";',
    '  echo "  宿主侧preflight已通过 ⇒ 问题在容器→宿主这一段，不是栈没起";',
    '  echo "  排查：docker run 是否带 --add-host=host.docker.internal:host-gateway；";',
    '  echo "        宿主防火墙是否拦了 Docker Desktop 的转发";',
    "  exit 21",
    "}",
    "",
    "cd /mnt/host/h/zeogit/one/A03-xihe/packages/ui",
    'echo "[workdir] $(pwd)";',
    'node -e \'console.log("[playwright] " + JSON.parse(require("fs").readFileSync("node_modules/@playwright/test/package.json","utf8")).version)\'',
    'echo "[chromium ] $(readlink -f /ms-playwright/chromium-*/chrome-linux64/chrome 2>/dev/null || echo MISSING)";',
    "",
    "exec node node_modules/@playwright/test/cli.js test \\",
    "  --config=e2e/playwright.config.ts \\",
    "  e2e/real/screenshots.spec.ts \\",
    '  "$@"',
].join("\n");

// ---- 宿主侧 preflight ----
async function main() {
    const argv = process.argv.slice(2);
    const dryRun = argv.includes("--dry-run");
    const passthrough = argv.filter((a) => a !== "--dry-run");

    // 定位 one 根：本文件在 <one>/A03-xihe/packages/ui/e2e/real/
    const here = path.dirname(fileURLToPath(import.meta.url));
    const oneRoot = path.resolve(here, "../../../../..");
    const uiDir = path.join(oneRoot, "A03-xihe", "packages", "ui");
    if (!existsSync(path.join(uiDir, "e2e", "real", "screenshots.spec.ts"))) {
        die(
            EXIT.LAYOUT,
            "仓库布局不符：找不到 e2e/real/screenshots.spec.ts",
            "推断出的 one 根 = " +
                oneRoot +
                "\n本脚本假定位于 <one>/A03-xihe/packages/ui/e2e/real/",
        );
    }

    const dockerArgs = [
        "run",
        "--rm",
        "-i",
        "--add-host=host.docker.internal:host-gateway",
        "-v",
        oneRoot + ":" + CONTAINER_ONE_ROOT,
        "-w",
        CONTAINER_ONE_ROOT + "/A03-xihe/packages/ui",
        "-e",
        "CI=1",
        "-e",
        "XIHE_E2E_EXTERNAL_SERVER=1",
        "-e",
        "UI_PORT=" + UI_PORT,
        "-e",
        "CP_PORT=" + CP_PORT,
        IMAGE,
        "bash",
        "-s",
        "--",
        ...passthrough,
    ];

    log("[params] image    = " + IMAGE);
    log("[params] mount    = " + oneRoot + " -> " + CONTAINER_ONE_ROOT);
    log("[params] workdir  = " + CONTAINER_ONE_ROOT + "/A03-xihe/packages/ui");
    log(
        "[params] env      = CI=1 XIHE_E2E_EXTERNAL_SERVER=1 UI_PORT=" +
            UI_PORT +
            " CP_PORT=" +
            CP_PORT,
    );
    log("[params] stack    = host 127.0.0.1:" + UI_PORT + " (UI) / :" + CP_PORT + " (CP)");

    if (dryRun) {
        log("[dry-run] docker " + dockerArgs.join(" "));
        log("[dry-run] 未做 docker/镜像/栈 检查，也未起容器");
        return 0;
    }

    // ① docker
    const dv = await run("docker", ["version", "--format", "{{.Server.Version}}"]);
    if (dv.code !== 0) die(EXIT.DOCKER, "docker 不可用", dv.out.trim());
    log("[preflight] docker server " + dv.out.trim());

    // ② 镜像（不 pull、不 build：task-342 边界）
    const di = await run("docker", ["image", "inspect", IMAGE, "--format", "{{.Id}}"]);
    if (di.code !== 0) {
        die(
            EXIT.IMAGE,
            "镜像不在本地",
            "需要：" +
                IMAGE +
                "\n" +
                "本脚本不会替你 pull/build（会引入一个「差不多的」镜像，正是 task-342 禁止的）。",
        );
    }
    log("[preflight] image " + di.out.trim());

    // ③ 宿主栈 —— 这条就是「栈没起」与「参数错」的分界线
    const uiStatus = await probe("http://127.0.0.1:" + UI_PORT + "/", 3, 500);
    const cpStatus = await probe("http://127.0.0.1:" + CP_PORT + "/actuator/health", 3, 500);
    if (!uiStatus || !cpStatus) {
        die(
            EXIT.STACK,
            "栈没起（宿主 127.0.0.1:" + UI_PORT + "/" + CP_PORT + " 无响应）",
            "ui=" +
                (uiStatus || "无响应") +
                "  cp=" +
                (cpStatus || "无响应") +
                "\n" +
                "这不是参数问题：容器还没起，参数一条都还没用到。\n" +
                "先起栈（例：mise run dev:stack -- --stack 2），再用本脚本。",
        );
    }
    log("[preflight] host stack ui=" + uiStatus + " cp=" + cpStatus);

    // ④ 依赖（容器内也要用同一份 node_modules）
    const cli = path.join(uiDir, "node_modules", "@playwright", "test", "cli.js");
    if (!existsSync(cli)) die(EXIT.DEPS, "packages/ui 依赖未安装", "缺 " + cli);

    // ⑤ 跑
    const child = spawn("docker", dockerArgs, { stdio: ["pipe", "inherit", "inherit"] });
    child.stdin.write(CONTAINER_SH);
    child.stdin.end();
    const code = await new Promise((r) => child.on("close", r));
    if (code === 21)
        die(EXIT.RUN, "容器→宿主网络不通（容器内已自证，见上）", "退出码 21 来自容器内半段");
    if (code !== 0)
        die(
            EXIT.RUN,
            "spec 失败（参数与环境已通过 preflight，问题在用例/断言）",
            "docker exit=" + code + "\n截图与 diff 在 packages/ui/test-results/",
        );
    log("");
    log("[ok] 4 张基线已跑完；比对逐张 sha256：");
    log(
        "     Get-FileHash packages/ui/e2e/real/screenshots.spec.ts-snapshots/*.png -Algorithm SHA256",
    );
    return 0;
}

main()
    .then((c) => process.exit(c || 0))
    .catch((e) => die(1, "未预期错误", e && e.stack ? e.stack : String(e)));
