#!/usr/bin/env node
/**
 * 设置区 mock 截图器（执行器；口径见 packages/ui/AGENTS.md「UI 预览（mock）工作流」）。
 *
 * 为什么要有这个脚本：交付图必须能用「commit sha + 一条命令」重建。手拍的 PNG 是孤本，
 * 别人改了 1 px 也无法判断图变是改对了还是当初就没拍准。
 *
 * 铁律（写死在代码里，不是口头约定）：
 * - **工作树脏（有未提交改动）时默认拒绝出图**（exit 1 并列出脏路径）：图必须钉在 commit sha 上，
 *   脏树上拍的图 sha 再稳也只对应当下那一团未提交的东西，事后没人能证明它对应哪条提交。
 * - `--allow-dirty` **只用于自查迭代，不得用于交付批次**。它会把 `allowDirty: true` 写进 manifest，
 *   所以"这个批次的图是不是脏树拍的"事后可查 —— 不要把它当成"加个 flag 就能出图"的日常通道。
 *
 * 用法（cwd 任意，路径都相对本文件推导）：
 *   node packages/ui/scripts/ui-mock-shot.mjs
 *   node packages/ui/scripts/ui-mock-shot.mjs --out ../../.tmp/xh/ui-mock-shot
 *   node packages/ui/scripts/ui-mock-shot.mjs --url http://127.0.0.1:5199   # 复用已起的 dev server
 *   node packages/ui/scripts/ui-mock-shot.mjs --only 01,04                  # 只适合迭代自查
 *   node packages/ui/scripts/ui-mock-shot.mjs --allow-dirty                 # 脏树自查，禁止用于交付
 *
 * 退出码：0 成功；1 参数/环境/工作树脏；2 dev server 起不来；3 截图不确定（连拍 sha 不一致）/被裁/折行。
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(scriptDir, "..");
const require = createRequire(path.join(uiRoot, "package.json"));
const { chromium } = require("@playwright/test");

/** 画布契约尺寸：1920x1080（AGENTS.md 规定的最小交付尺寸）。 */
const CANVAS = { width: 1920, height: 1080 };
/** 视口要留出画布外的 chrome 与 SheetFrame 的自动缩放空间，否则 scale < 1 会缩图。 */
const VIEWPORT = { width: 2000, height: 1400 };

/**
 * 截图环境的注入样式（只作用于截图，不改仓库代码）：
 * 1. 画布固定 1080 高，但页面按浏览器窗口高排版 ⇒ 超出部分被画布 overflow-hidden 静默吃掉（实测 320 px）。
 * 2. 内容列在真实产品里是滚动的，mock 里是 overflow-hidden ⇒ 长页第二屏拍不出来。
 * 3. 动画/过渡/光标闪烁会让连拍出现两态，sha 自校验必然失败。
 * 4. 页面级滚动条周期性出现/消失会把画布推 1~5 px，整帧像素都变（实测 scrollWidth 1990 / clientWidth 2000）。
 */
const SHOT_CSS = [
    "[data-mock-canvas] > *:first-child { height: 1080px !important; min-height: 0 !important; }",
    '[data-mock-canvas] [class*="min-h-svh"], [data-mock-canvas] [class*="h-svh"], [data-mock-canvas] .h-screen, [data-mock-canvas] .min-h-screen { height: 1080px !important; min-height: 0 !important; }',
    "[data-mock-canvas] .min-h-0.flex-1.overflow-hidden { overflow-y: auto !important; }",
    "[data-mock-canvas] * { transition: none !important; animation: none !important; caret-color: transparent !important; }",
    "[data-mock-canvas] { scrollbar-width: none !important; }",
    "html, body { overflow: hidden !important; scrollbar-width: none !important; }",
    "*::-webkit-scrollbar { width: 0 !important; height: 0 !important; }",
].join("\n");

/**
 * fullPage（task-127 单页整图）变体：**不钉 1080 高** —— 前三行是把整屏画布压到 1080 的钳制，
 * 单页长图要的是内容真实高度。只保留「动画/光标/滚动条」三条稳定化规则。
 */
const SHOT_CSS_FULL = [
    "[data-mock-canvas] * { transition: none !important; animation: none !important; caret-color: transparent !important; }",
    "[data-mock-canvas] { scrollbar-width: none !important; }",
    "html, body { overflow: hidden !important; scrollbar-width: none !important; }",
    "*::-webkit-scrollbar { width: 0 !important; height: 0 !important; }",
].join("\n");

/**
 * 交付镜头（task-127 / D-903 起）：**单页合一**。SHEETS/hash 切换器已撤（MockApp 直渲
 * MockSinglePage），交付图 = 单页整图一张（fullPage 收全高）；query 为空 ⇒ 干净基址天然正确。
 * 退役的场景稿条目（?notes=0&domain=…#N 与 #4/#5/#6 整屏）留在 git 历史，勿复用。
 */
const SHOTS = [
    // task-137 rev2（D-914）：交付对象是**真产品页面**（真路由 + 真组件），
    // 图只作审计留证。整窗 = 设置默认落地页（实例层第一个域），1920×1080 整屏。
    { id: "01", name: "window", path: "/settings", app: true },
    // llm-provider 取用户层：实例层只展示默认身份 + 「实例层不管理连接」，用户层才是连接管理主界面。
    { id: "02", name: "llm-provider", path: "/settings/user/llm-provider", app: true },
    {
        id: "03",
        name: "agent-runtime",
        path: "/settings/instance/agent-runtime",
        app: true,
        expand: "[data-testid=config-domain-agent-runtime] button",
    },
    {
        id: "04",
        name: "context-policy",
        path: "/settings/instance/context-policy",
        app: true,
        expand: "[data-testid=config-domain-context-policy] button",
    },
    {
        id: "05",
        name: "logging",
        path: "/settings/instance/logging",
        app: true,
        expand: "[data-testid=config-domain-logging] button",
    },
    {
        id: "06",
        name: "user-preference",
        path: "/settings/user/user-preference",
        app: true,
        expand: "[data-testid=config-domain-user-preference] button",
    },
    // task-146 修复后补的第 7 张：实例层 embedding 面板现在显示真实 profile 解析结果
    // （嵌入连接 / 模型 / 维度 / 生效层 / 模型来源 + 生效来源表），无需展开分组。
    { id: "07", name: "embedding", path: "/settings/instance/embedding", app: true },
    // task-165：实例层三资源页（真路由 + 真组件；数据来自 preview/mock 的 /instance/* 端点，
    // 见 data/instanceResources.ts）。左栏入口也在真组件里渲染，所以图能同时证明「导航项存在」。
    // PLAN-0772 M2：资源面搬出 /settings；实例层是页内 tab（`?layer=INSTANCE`），不是独立路径段。
    {
        id: "08",
        name: "resources-credentials",
        path: "/resources/credentials?layer=INSTANCE",
        app: true,
    },
    { id: "09", name: "resources-agents", path: "/resources/agents?layer=INSTANCE", app: true },
    { id: "10", name: "resources-mcp", path: "/resources/mcp?layer=INSTANCE", app: true },
    // task-167：实例层技能页。11 = 列表 + 「导入技能」入口（持有 MANAGE_SKILL_LIBRARY ⇒ 可点）；
    // 12 = 点开导入对话框（expand 点的是真按钮，弹的是真 Dialog，不是静态壳）。
    { id: "11", name: "resources-skills", path: "/resources/skills?layer=INSTANCE", app: true },
    {
        id: "12",
        name: "skills-import-dialog",
        path: "/resources/skills?layer=INSTANCE",
        app: true,
        expand: "[data-testid=settings-skills-import]",
    },
    // task-189（D-896 / BL-584 / BL-578）：全局条双态 + 二级菜单。
    // 13 = **折叠态**（56px）+ 悬停打开的「资源」二级菜单 —— 折叠态只剩图标，悬浮菜单是
    //      「这个图标是什么 / 点下去有哪些页」的唯一通道，所以这张就是 D-896 的验收图；
    // 14 = **展开态**（图标 + 文字）+ 点开的「设置」二级菜单 —— 双态控件（`global-rail-toggle`）
    //      与「一级模块 = 菜单入口」两件事同屏。
    // ⚠️ 13 依赖**新 context 的默认折叠态**，顺序不能与 14 颠倒（14 会把状态写成展开并留在
    //    localStorage 里）；`--only 13,14` 按本顺序为真，倒序拍会得到两张展开图。
    {
        id: "13",
        name: "global-rail-collapsed",
        path: "/settings/user/llm-provider",
        app: true,
        hover: "[data-testid=global-rail-module-resources]",
    },
    {
        id: "14",
        name: "global-rail-expanded",
        path: "/settings/user/llm-provider",
        app: true,
        expand: ["[data-testid=global-rail-toggle]", "[data-testid=global-rail-menu-settings]"],
        // 菜单打开后若把鼠标挪走，`pointerleave` 会在 160ms 后把它关掉（GlobalRailModule 的
        // 真实行为）⇒ 指针必须留在触发器上，否则这张图会变成「展开态但没有菜单」。
        keepPointer: true,
    },
];

/**
 * `app: true` 的镜头拍的是**真路由真组件**，而真页面要求已登录（`auth` 只认 localStorage 的
 * `xihe-token`）。不塞这个值，1920×1080 拍到的是 `/login` —— 2026-11-12 实测：08/09/10/11
 * 四张的 sha 全是 `78967385176d93d7`（同一张登录页），这属于"四张图长得一模一样"的硬故障，
 * 靠肉眼比对才发现。token 值必须是 mock 中间件认的那个（`/auth/me` 会回带 capabilities 的用户）。
 */
const MOCK_APP_TOKEN = "mock-token";

const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);

/** 工作树脏：默认拒绝出图（不是警告，是拦下）。 */
class DirtyTreeError extends Error {
    constructor(git) {
        const paths = git.dirtyPaths.map((item) => "  - " + item).join("\n");
        super(
            [
                "工作树有未提交改动，拒绝出图（commit " + String(git.commit).slice(0, 12) + "）：",
                paths,
                "",
                "原因：图必须钉在 commit sha 上；脏树拍的图事后无法证明对应哪条提交。",
                "先提交再拍。若脏改动确实不影响像素（比如别处的 WIP），加 --allow-dirty 并配 --dirty-proof <json>：",
                "  每个脏路径都要有一条可复算命令 + 它的实际输出，脚本会把两者一起写进 manifest.dirtyNonRendering。",
                "  「已忽略」不是证明；能跑的命令才是。",
            ].join("\n"),
        );
        this.name = "DirtyTreeError";
    }
}

function fail(code, message) {
    process.stderr.write("[ui-mock-shot] " + message + "\n");
    process.exitCode = code;
}

/**
 * 脏检查范围 = 整个 UI 包（pathspec 相对 uiRoot，即 `git -C packages/ui` 的 cwd）。
 * 为什么不只盯 preview/mock 与 scripts：影响像素的东西远不止这两个目录 —— 样式、vendor 组件、
 * vite 配置改一行都能让图变，只盯 mock 会漏掉它们，于是"干净"变成一句假话。
 */
const GIT_SCOPE = ["."];

/**
 * 读 HEAD 与工作树脏路径。为什么用 git 而不自造快照：脏路径必须与人看到的 git status 逐条一致，
 * 否则"这图是不是脏树拍的"就永远对不上账。不在 git 仓库里（比如拷出去单跑）返回 commit: null。
 */
function gitState() {
    const run = (args) => {
        const res = spawnSync("git", ["-C", uiRoot].concat(args), { encoding: "utf8" });
        if (res.error || res.status !== 0) {
            return { ok: false, output: String(res.stderr || res.error || "").trim() };
        }
        return { ok: true, output: String(res.stdout).trim() };
    };
    const head = run(["rev-parse", "HEAD"]);
    if (!head.ok) {
        return {
            commit: null,
            dirtyPaths: [],
            gitError: head.output || "git 不可用",
            repoRoot: null,
        };
    }
    const toplevel = run(["rev-parse", "--show-toplevel"]);
    const repoRoot = toplevel.ok ? toplevel.output : null;
    const status = run(["status", "--porcelain", "-uall", "--"].concat(GIT_SCOPE));
    if (!status.ok) {
        return { commit: head.output, dirtyPaths: [], gitError: status.output, repoRoot };
    }
    const dirtyPaths = status.output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/^[A-Z?!]{1,2}\s+/, ""));
    return { commit: head.output, dirtyPaths, gitError: null, repoRoot };
}

/**
 * 脏树交付的**证据层**：每个脏路径都要给一条可复算命令，脚本亲自跑、把输出写进 manifest。
 *
 * 为什么不是"允许 --allow-dirty 就完事"：那条门的目的是「这图确实代表这个 commit」，
 * 干净树只是达成手段之一。脏改动若确实不进渲染图（别处 WIP、e2e 用例、未跟踪文件），
 * 用「命令 + 实际输出」证明它不进，比"等树干净"更强也更快 —— 但它必须**可复算**，
 * 所以这里跑的是命令本身，而不是相信我写在 reason 里的话。
 *
 * 证明文件格式（JSON 数组）：
 *   [{ "path": "packages/ui/x.ts", "reason": "为什么不影响像素",
 *      "command": ["git", "grep", "-n", "…", "--", "packages/ui/src/preview"],
 *      "expect": "empty" }]      // expect 可选：empty = 期望无输出（如"0 命中"）
 */
function loadDirtyProofs(proofPath, dirtyPaths, repoRoot) {
    const normalize = (value) => String(value).replace(/\\/g, "/").replace(/^\.\//, "");
    const wanted = dirtyPaths.map(normalize);
    let entries = [];
    if (proofPath) {
        const raw = fs.readFileSync(proofPath, "utf8");
        entries = JSON.parse(raw);
        if (!Array.isArray(entries)) throw new Error("--dirty-proof 必须是 JSON 数组");
    }
    const byPath = new Map(entries.map((item) => [normalize(item.path), item]));
    const missing = wanted.filter((item) => !byPath.has(item));
    if (missing.length > 0) {
        throw new Error(
            [
                "以下未提交路径没有「不影响渲染」的证明，拒绝把它们当成可忽略：",
                ...missing.map((item) => "  - " + item),
                "",
                "给 --dirty-proof <json> 补上每条：{ path, reason, command: [argv…], expect? }",
                "「已忽略」不是证明；能跑的命令 + 它的实际输出才是。",
            ].join("\n"),
        );
    }
    const stale = [...byPath.keys()].filter((item) => !wanted.includes(item));
    if (stale.length > 0) {
        process.stderr.write(
            "[ui-mock-shot] 警告: 证明里有 " +
                stale.length +
                " 条已不再脏（" +
                stale.join(", ") +
                "）\n",
        );
    }
    return wanted.map((item) => {
        const proof = byPath.get(item);
        const argv = Array.isArray(proof.command) ? proof.command : null;
        if (!argv || argv.length === 0) {
            throw new Error(
                '证明缺少 command（argv 数组，例如 ["git","grep","-n","x","--","packages/ui/src/preview"]）：' +
                    item,
            );
        }
        const cwd = repoRoot ?? uiRoot;
        const res = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", timeout: 60000 });
        const output = String((res.stdout ?? "") + (res.stderr ?? "")).trim();
        const record = {
            path: item,
            reason: proof.reason ?? null,
            // 把声明写进证据：expect 为 empty 时「output 为空」本身就是结论（如 grep 0 命中、exit=1），
            // 不是「没跑出东西」。缺这一列，读 manifest 的人分不清「通过」与「没证据」。
            expect: proof.expect ?? null,
            command: argv
                .map((part) => (part.includes(" ") ? JSON.stringify(part) : part))
                .join(" "),
            cwd: path.relative(cwd, cwd) || ".",
            exit: res.status,
            output: output.slice(0, 4000),
        };
        if (proof.expect === "empty" && output.length > 0) {
            throw new Error(
                "脏路径 " +
                    item +
                    " 的证明命令**有输出**，与 expect: empty 矛盾（命令：" +
                    record.command +
                    "）：\n" +
                    record.output,
            );
        }
        if (proof.expect === "nonempty" && output.length === 0) {
            throw new Error(
                "脏路径 " + item + " 的证明命令无输出，与 expect: nonempty 矛盾：" + record.command,
            );
        }
        process.stdout.write(
            "[ui-mock-shot] 脏路径证明 " +
                item +
                " → exit=" +
                res.status +
                " output=" +
                (output.length === 0 ? "(空)" : output.split("\n").length + " 行") +
                "\n",
        );
        return record;
    });
}

/**
 * `--extra-shot <id>:<name>:<path>`：**临时加拍**一镜，不进 SHOTS 常量。
 *
 * <p>为什么要这个口子：SHOTS 是**交付批次**的定义（改它 = 改批次身份与证据包清单），
 * 而真实需求里常出现「某张卡只要一张页面的初始态」—— 那种图必须仍由本执行器拍（真路由 + 真组件
 * + 双拍比 sha + manifest），不能退化成手拍。所以临时镜头走参数、manifest 里带 `adHoc: true`，
 * 默认批次仍是那 14 张。</p>
 */
function parseExtraShot(spec) {
    const parts = String(spec).split(":");
    if (parts.length < 3) {
        throw new Error("--extra-shot 需要 <id>:<name>:<path>，收到: " + spec);
    }
    const id = parts.shift().trim();
    const name = parts.shift().trim();
    const route = parts.join(":").trim();
    if (!id || !name || !route.startsWith("/")) {
        throw new Error("--extra-shot 的 id/name 不能空，path 必须以 / 开头，收到: " + spec);
    }
    return { id, name, path: route, app: true, adHoc: true };
}

function parseArgs(argv) {
    const opts = {
        url: null,
        out: path.resolve(uiRoot, "../../.tmp/xh/ui-mock-shot"),
        channel: "chrome-beta",
        // 可重复传；用途是把「同一 commit 两批图不一样」的变量逐个关掉（合成路径 / GPU 开关）。
        chromiumArgs: [],
        only: null,
        allowDirty: false,
        dirtyProof: null,
        // 临时加拍镜头的原始规格（<id>:<name>:<path>），可重复；见 parseExtraShot
        extraShots: [],
        selftest: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const value = argv[i + 1];
        if (arg === "--url") {
            opts.url = value;
            i += 1;
        } else if (arg === "--out") {
            opts.out = path.resolve(process.cwd(), value);
            i += 1;
        } else if (arg === "--channel") {
            opts.channel = value;
            i += 1;
        } else if (arg === "--chromium-arg") {
            if (!value)
                throw new Error("--chromium-arg 需要一个值，例如 --chromium-arg=--disable-gpu");
            opts.chromiumArgs.push(value);
            i += 1;
        } else if (arg.startsWith("--chromium-arg=")) {
            opts.chromiumArgs.push(arg.slice("--chromium-arg=".length));
        } else if (arg === "--only") {
            opts.only = new Set(
                value
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean),
            );
            i += 1;
        } else if (arg === "--extra-shot") {
            if (!value) throw new Error("--extra-shot 需要一个 <id>:<name>:<path> 值");
            opts.extraShots.push(value);
            i += 1;
        } else if (arg === "--extra-shot=") {
            throw new Error("--extra-shot 用空格传值，不用 =");
        } else if (arg.startsWith("--extra-shot=")) {
            opts.extraShots.push(arg.slice("--extra-shot=".length));
        } else if (arg === "--selftest") {
            // 只跑探活自检：不起浏览器、不需要 dev server，秒级返回（负例必须快速失败）。
            opts.selftest = true;
        } else if (arg === "--dirty-proof") {
            opts.dirtyProof = path.resolve(process.cwd(), value);
            i += 1;
        } else if (arg === "--allow-dirty") {
            // 只用于自查迭代：脏树出的图不得当交付批次，manifest 里会留 allowDirty: true。
            opts.allowDirty = true;
        } else if (arg === "--help" || arg === "-h") {
            process.stdout.write(
                [
                    "用法: node packages/ui/scripts/ui-mock-shot.mjs [--url <base>] [--out <dir>] [--only 01,04] [--channel <chrome-beta|chrome>] [--chromium-arg=<arg> …] [--extra-shot <id>:<name>:<path> …] [--allow-dirty] [--selftest]",
                    "--extra-shot 可重复传：临时加拍一镜（真路由真组件、同样双拍比 sha），不进 SHOTS 批次定义；manifest 里该镜带 adHoc: true。",
                    "--chromium-arg 可重复传，原样进 chromium.launch 的 args（例：--chromium-arg=--disable-gpu 强制软件合成）；它和 channel/版本一起写进 manifest.browser。",
                    "工作树脏时默认 exit 1；--allow-dirty --dirty-proof <json> 用于「脏改动不影响像素」的交付批次（每个脏路径一条可复算命令 + 实际输出）。",
                    "--selftest 只跑探活自检（不开浏览器、不起 dev server），用于验证「探不到要快速失败且报全 URL」。",
                ].join("\n") + "\n",
            );
            process.exit(0);
        } else {
            throw new Error("未知参数: " + arg);
        }
    }
    return opts;
}

/** 让系统给一个空闲端口，避免与别人已起的 dev server 抢口。 */
function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 单次探活的上限。**没有它就是一个真 bug**：`fetch` 默认没有超时，只要有一次请求挂住，
 * `while` 循环就再也检查不到 deadline，于是"探活失败"被报成"120 s 没就绪"——现象与根因脱钩。
 * 2026-11-11 之前就是这个形状（task-84）。
 */
const PROBE_ATTEMPT_TIMEOUT_MS = 2000;
/** 自起 dev server 的启动预算：vite 冷启动 + 首次优化依赖，实测 1~5 s，留足余量。 */
const BOOT_TIMEOUT_MS = 120000;
/**
 * `--url` 复用已有 server 的探活预算：它**必须快速失败** ——
 * 用户语义是"复用已经起好的 server"，探不到就该立刻说，而不是等两分钟。
 */
const REUSE_PROBE_TIMEOUT_MS = 5000;

/** 把 fetch 的各种失败压成一行人话（ECONNREFUSED / 超时 / 代理 / DNS 要能分辨）。 */
function describeFetchError(error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        return "超时 " + PROBE_ATTEMPT_TIMEOUT_MS + " ms";
    }
    const cause = error?.cause;
    if (cause?.code) return String(cause.code);
    if (cause?.message) return String(cause.message).slice(0, 120);
    return String(error?.message ?? error).slice(0, 120);
}

/** 一次探活 = 一个 URL + 独立超时 + 耗时/错误码（失败也要有信息量，不能只抛一句）。 */
async function probeOnce(url) {
    const startedAt = Date.now();
    try {
        const res = await fetch(url, {
            method: "GET",
            signal: AbortSignal.timeout(PROBE_ATTEMPT_TIMEOUT_MS),
        });
        return {
            url,
            ok: res.ok,
            status: res.status,
            ms: Date.now() - startedAt,
            error: res.ok ? null : "HTTP " + res.status,
        };
    } catch (error) {
        return {
            url,
            ok: false,
            status: null,
            ms: Date.now() - startedAt,
            error: describeFetchError(error),
        };
    }
}

/**
 * 候选探活地址。为什么要四个：本机 `localhost` 可能先落 `::1` 也可能先落 `127.0.0.1`，
 * 而 vite 的 `--host` 决定它到底听哪一族；**探活目标与真实监听地址不一致时，现象只是超时**，
 * 从报错里看不出是"没起"还是"起在另一族"。所以四个都试，并在失败时全部打印出来。
 *
 * 顺序：实际 base（vite 打印的 host）→ 127.0.0.1 → localhost → [::1]。
 */
function candidateBases(base) {
    const urls = [];
    const add = (url) => {
        if (url && !urls.includes(url)) urls.push(url);
    };
    add(base);
    let port = "";
    try {
        port = new URL(base).port;
    } catch {
        return urls;
    }
    if (port) {
        add("http://127.0.0.1:" + port);
        add("http://localhost:" + port);
        add("http://[::1]:" + port);
    }
    return urls;
}

/** TCP 层诊断：区分"没人监听"（连接被拒）与"监听了但 HTTP 不应答"（连上却超时）。 */
function probeTcp(host, port, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        const socket = net.connect({ host, port });
        const done = (result) => {
            try {
                socket.destroy();
            } catch {
                // 销毁失败不影响结论
            }
            resolve({ host, port, ms: Date.now() - startedAt, ...result });
        };
        socket.setTimeout(timeoutMs, () => done({ ok: false, error: "超时 " + timeoutMs + " ms" }));
        socket.once("connect", () => done({ ok: true, remote: socket.remoteAddress }));
        socket.once("error", (error) => done({ ok: false, error: error.code || error.message }));
    });
}

/** 把"试过哪些 URL、各自试了几次、最后一次错在哪"拼成可读报告（探活失败时唯一的现场）。 */
function formatProbeReport(rows, tcpRows, note) {
    const lines = [note];
    for (const row of rows) {
        lines.push(
            "  " +
                (row.url ?? row.base) +
                "   尝试 " +
                row.attempts +
                " 次  最后一次 " +
                (row.lastMs ?? "-") +
                " ms  " +
                (row.lastError ?? "ok"),
        );
    }
    if (tcpRows.length > 0) {
        lines.push("TCP 直连诊断：");
        for (const row of tcpRows) {
            lines.push(
                "  " +
                    row.host +
                    ":" +
                    row.port +
                    "  " +
                    (row.ok
                        ? "端口在听（" + row.ms + " ms, remote " + row.remote + "）"
                        : row.error + "（" + row.ms + " ms）"),
            );
        }
    }
    return lines.join("\n");
}

/**
 * 等待 dev server 就绪：**每一轮并行探全部候选**，每个请求各自带超时。
 * 成功返回实际探通的那个 base（可能不是脚本猜的那一个 —— 这正是本函数存在的意义）。
 */
/** 从候选 URL 里取出要直连诊断的 (host, port) 对（去重）。 */
function tcpTargets(bases) {
    const seen = new Set();
    const targets = [];
    for (const base of bases) {
        let parsed;
        try {
            parsed = new URL(base);
        } catch {
            continue;
        }
        const host = parsed.hostname.replace(/^\[|\]$/g, "");
        const port = parsed.port;
        if (!host || !port) continue;
        const key = host + ":" + port;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({ host, port: Number(port) });
    }
    return targets;
}

/**
 * @param bases 候选 base URL（顺序即优先级）
 * @param child 自起的 dev server 进程；null = 复用外部 server
 * @param timeoutMs 总预算
 * @param options.failFastWhenNoListener 复用模式下为 true：连 TCP 都没人听时立刻失败（不等满预算）
 *        —— "指向空端口必须快速失败"这条判据就落在这里；自起模式不能这么做，vite 还没绑呢。
 */
async function waitForServer(bases, child, timeoutMs, options = {}) {
    const failFastWhenNoListener = options.failFastWhenNoListener === true;
    const deadline = Date.now() + timeoutMs;
    const stats = bases.map((base) => ({ base, attempts: 0, lastError: null, lastMs: null }));
    let round = 0;
    /** 一旦 TCP 确认"有端口在听"，失败报告就带上它 —— 这是"听了但 HTTP 不应答"的唯一证据。 */
    let lastTcpRows = [];
    while (Date.now() < deadline) {
        round += 1;
        if (child?.spawnError) {
            throw new Error("dev server 启动失败: " + child.spawnError);
        }
        if (child && child.exitCode !== null) {
            throw new Error("dev server 提前退出，exitCode=" + child.exitCode);
        }
        const results = await Promise.all(
            bases.map((base) => probeOnce(base + "/preview-mock.html")),
        );
        results.forEach((result, index) => {
            const stat = stats[index];
            stat.attempts += 1;
            stat.lastError = result.error;
            stat.lastMs = result.ms;
            if (result.ok) stat.ready = true;
        });
        const hit = stats.find((stat) => stat.ready);
        if (hit) {
            return {
                base: hit.base,
                readyVia: hit.base + "/preview-mock.html",
                attempts: hit.attempts,
            };
        }
        // 试过 3 轮仍全失败 ⇒ 用 TCP 直连判断"到底有没有人在听"，别把"没起"和"起在别处"混成一句超时。
        if (round >= 3) {
            const tcpRows = await Promise.all(
                tcpTargets(bases).map((item) => probeTcp(item.host, item.port)),
            );
            const anyListening = tcpRows.some((row) => row.ok);
            if (anyListening) {
                lastTcpRows = tcpRows;
            } else if (failFastWhenNoListener) {
                throw new Error(
                    formatProbeReport(
                        stats,
                        tcpRows,
                        "端口没有监听（TCP 也连不上）—— 快速失败，不占满预算：",
                    ),
                );
            }
        }
        await sleep(300);
    }
    // 预算用完：优先用过程中已经拿到的 TCP 证据，没有就现探一次（失败报告必须带这一层）。
    const tcpRows =
        lastTcpRows.length > 0
            ? lastTcpRows
            : await Promise.all(tcpTargets(bases).map((item) => probeTcp(item.host, item.port)));
    throw new Error(
        formatProbeReport(
            stats,
            tcpRows,
            "dev server 在 " +
                timeoutMs +
                " ms 内没有就绪。探测记录（每次探活上限 " +
                PROBE_ATTEMPT_TIMEOUT_MS +
                " ms）：",
        ),
    );
}

function killTree(child) {
    if (!child || child.exitCode !== null) return;
    if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
        child.kill("SIGTERM");
    }
}

/**
 * vite 自己打印的地址（`Local: http://<host>:<port>/`）—— 这是"脚本实际绑定的 host"的唯一可信来源：
 * 我们在命令行上写 `--host 127.0.0.1`，但真正监听哪一族由 vite 决定，探活必须以它为准（其次才兜候选）。
 */
function boundBaseFromLog(log, fallbackBase) {
    const matches = [...log.matchAll(/Local:\s+(https?:\/\/[^\s]+)/g)];
    if (matches.length === 0) return fallbackBase;
    const raw = matches[matches.length - 1][1].replace(/\/$/, "");
    try {
        new URL(raw);
        return raw;
    } catch {
        return fallbackBase;
    }
}

/**
 * 临时 dev server 的 mock 开关（BL-620，task-203 ①）：**显式注入，不靠父进程继承**。
 * 未设 ⇒ 补 `1` 并打一行说明（暗改不算修 —— 不打印就等于没人知道这批图是 mock 态拍的）；
 * 显式设成非 `1` ⇒ WARN（那是排障用法，必须留痕，免得有人拿它当交付图）。
 * `--url` 复用分支不在此列：外接真栈时 mock 态由调用方负责。
 */
function mockApiEnvPatch() {
    const raw = process.env.XIHE_UI_MOCK_API;
    if (raw === undefined || raw === "") {
        console.log("[ui-mock-shot] XIHE_UI_MOCK_API 未设置 ⇒ 临时 dev server 默认补 1（mock 态）");
        return { XIHE_UI_MOCK_API: "1" };
    }
    if (raw !== "1") {
        console.warn(
            "[ui-mock-shot] WARN XIHE_UI_MOCK_API=" +
                raw +
                " ⇒ 临时 dev server 不是 mock 态，这样拍的图不能当 mock 交付图",
        );
    }
    return { XIHE_UI_MOCK_API: raw };
}

/** 起一个临时 vite dev server（只在没给 --url 时用）。 */
async function startServer() {
    const port = await freePort();
    const base = "http://127.0.0.1:" + port;
    // 直接跑 vite 的入口：经 pnpm 转一层在 Windows 上会 spawn EINVAL（.cmd 不能无 shell 直跑），
    // 而且多一层进程会让 taskkill 的树杀更容易漏。vite 的 package.json 不在 exports 里，
    // 所以只能按文件路径读 bin 字段（不 require，绕开 exports 限制）。
    const viteDir = path.join(uiRoot, "node_modules", "vite");
    const vitePkg = JSON.parse(fs.readFileSync(path.join(viteDir, "package.json"), "utf8"));
    const viteBin = path.join(viteDir, String(vitePkg.bin.vite));
    // 显式绑 127.0.0.1：vite 默认只听 localhost，在 Windows 上可能只落 ::1。
    // 但**不假设**它一定按我们说的绑 —— 探活失败时会连同 vite 打印的 Local: 一起报出来。
    const childEnv = { ...process.env, ...mockApiEnvPatch() };
    const child = spawn(
        process.execPath,
        [viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
        {
            cwd: uiRoot,
            // **必须显式给 env**：不给就继承父进程 ⇒ 父 shell 没设 mock 开关时，这里跑的是
            // 「真应用 + 无后端」，而 app 镜头照样能 goto、#app 照常挂载、不触发 /login 守卫
            // ⇒ 截出一张「看着像正常产品页」的空壳图，且 exit 0 / sha 稳定 / 无任何 WARN
            // （BL-620，task-203 ①：这是「失败看起来像成功」那一类）。
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
        },
    );
    let log = "";
    child.stdout.on("data", (chunk) => {
        log += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
        log += chunk.toString();
    });
    // spawn 本身失败（EPERM/EINVAL/找不到 bin）时 exitCode 可能永远为 null，
    // 不接这个事件就会退化成"等 120 s 后说没有就绪"。这类错误必须立刻冒出来。
    child.on("error", (error) => {
        child.spawnError = error.code || error.message;
    });
    let ready = null;
    try {
        await waitForServer(candidateBases(base), child, BOOT_TIMEOUT_MS);
        // 等 vite 把 Local: 打出来（已就绪时通常已在日志里），再按实际绑定地址复探一次确认。
        const boundBase = boundBaseFromLog(log, base);
        const candidates = candidateBases(base);
        if (!candidates.includes(boundBase)) candidates.unshift(boundBase);
        ready = await waitForServer(candidates, child, PROBE_ATTEMPT_TIMEOUT_MS * 2);
    } catch (error) {
        killTree(child);
        throw new Error(
            error.message +
                (log.trim()
                    ? "\n--- vite 输出（末尾 2000 字符）---\n" + log.slice(-2000)
                    : "\n--- vite 无输出 ---"),
        );
    }
    return {
        base: ready.base,
        readyVia: ready.readyVia,
        candidates: candidateBases(base).concat(
            [boundBaseFromLog(log, base)].filter((item) => !candidateBases(base).includes(item)),
        ),
        log,
        stop: () => killTree(child),
    };
}

/** 详情态页面可能超一屏：找到“真的被裁掉一段”的容器（>24 px 才算，伪溢出会把整页推 1 px）。 */
const findScroller = () => {
    const canvas = document.querySelector("[data-mock-canvas]");
    const found = [...canvas.querySelectorAll("*")].find(
        (el) => el.scrollHeight - el.clientHeight > 24 && el.clientHeight > 200,
    );
    if (!found) return null;
    const info = {
        gap: found.scrollHeight - found.clientHeight,
        scrollHeight: found.scrollHeight,
        clientHeight: found.clientHeight,
    };
    found.scrollTop = found.scrollHeight;
    return info;
};

async function shootOne(page, base, shot, outDir) {
    if (shot.app) {
        // 真页面：1920×1080 视口，等真 App 挂载 + 首屏数据落定（不是空壳）。
        await page.setViewportSize({ width: CANVAS.width, height: CANVAS.height });
    }
    const targetUrl = shot.app
        ? base + shot.path
        : base + "/preview-mock.html" + (shot.query ?? "");
    // 真页面有 /user-events 的 SSE 长连接（task-149 stub 会保持连接）⇒ networkidle 永不满足，
    // 所以 app 镜头等 DOM 就绪 + 显式等 #app 挂载；mock 画布镜头仍用 networkidle。
    await page.goto(targetUrl, { waitUntil: shot.app ? "domcontentloaded" : "networkidle" });
    if (shot.app) {
        await page.waitForFunction(
            () => (document.querySelector("#app")?.children.length ?? 0) > 0,
            {
                timeout: 20000,
            },
        );
        // 守卫：`app` 镜头必须真的落在产品页上。没有 token 时 `#app` 也会挂载（登录表单），
        // 这个探针就是让"拍到登录页"从"肉眼看出来"变成"开拍即失败"。
        if (new URL(page.url()).pathname === "/login") {
            throw new Error(
                "[ui-mock-shot] " +
                    shot.id +
                    " 落在 /login：app 镜头缺 mock token（见 MOCK_APP_TOKEN 注释）",
            );
        }
        await page.evaluate(() => document.fonts.ready);
        // task-189：`expand` 允许**数组**（按顺序连点），用于「先切双态、再开二级菜单」这类
        // 需要两步才能到达的画面；字符串形态保持原语义（单次点击），旧镜头零改动。
        const expandSteps = shot.expand
            ? Array.isArray(shot.expand)
                ? shot.expand
                : [shot.expand]
            : [];
        for (const selector of expandSteps) {
            // 域面板默认折叠；审计图要看字段级内容 ⇒ 点开再拍（这也是 B 轻量版要证的一种交互）。
            await page.click(selector, { timeout: 10000 });
            await page.waitForTimeout(500);
        }
        if (shot.hover) {
            // task-189：折叠态的二级菜单**只有悬浮才开**（D-896 把它定为折叠态的可读性通道）⇒
            // 交付图必须由真悬浮触发，不能用 click 假装。等 160ms 打开延迟 + 弹层定位落定。
            await page.hover(shot.hover, { timeout: 10000 });
            await page.waitForTimeout(900);
        }
        await page.waitForTimeout(600);
    } else {
        await page.waitForFunction(
            () => document.querySelectorAll("[data-mock-canvas]").length === 1,
        );
        // fullPage（单页长图）用不钳高的变体，整屏镜头仍用钳到 1080 的 SHOT_CSS。
        await page.addStyleTag({ content: shot.fullPage ? SHOT_CSS_FULL : SHOT_CSS });
    }
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        window.scrollTo(0, 0);
        for (const el of document.querySelectorAll("[data-mock-canvas] *")) el.scrollTop = 0;
    });
    // 鼠标停在左栏会留下 hover 底色；挪到内容区空白处，避免"看起来像同时选中两项"。
    // task-189：`hover` 镜头（画面就是悬停态）与 `keepPointer` 镜头（弹层靠指针位置维持）
    // **都不能挪鼠标** —— 挪走 = pointerleave = 菜单按 160ms 关闭，交付图里就没有菜单了。
    if (!shot.hover && !shot.keepPointer) {
        await page.mouse.move(VIEWPORT.width - 200, VIEWPORT.height - 100);
        await page.waitForTimeout(400);
    }

    // 三种取景：整窗元素（element）/ 单页长图（fullPage 画布）/ 整屏画布（默认 1920×1080）。
    const target = shot.element
        ? page.locator(shot.element)
        : shot.app
          ? null // 真页面：整屏（视口）截图，元素截图会被滚动条挤成 1910 宽
          : page.locator("[data-mock-canvas]");
    const shotOpts = shot.fullPage
        ? { fullPage: true, animations: "disabled" }
        : { animations: "disabled" };
    let stable = null;
    let previous = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const buf = target ? await target.screenshot(shotOpts) : await page.screenshot(shotOpts);
        const digest = sha(buf);
        if (previous && previous.digest === digest) {
            stable = { buf, digest, attempts: attempt + 1 };
            break;
        }
        previous = { buf, digest };
        await page.waitForTimeout(400);
    }
    if (!stable) {
        throw new Error(
            shot.id + " 连拍 10 次仍未收敛（sha 抖动）：" + String(previous && previous.digest),
        );
    }

    const mainFile = path.join(outDir, shot.id + "-" + shot.name + ".png");
    fs.writeFileSync(mainFile, stable.buf);
    const size = { width: stable.buf.readUInt32BE(16), height: stable.buf.readUInt32BE(20) };
    // fullPage 只校验宽下限（高 = 内容真实高度，宽 = 视口盒 2000px）；
    // element（整窗）与整屏镜头维持 1920×1080 契约。
    const widthOk = shot.fullPage ? size.width >= CANVAS.width : size.width === CANVAS.width;
    if (!widthOk || (!shot.fullPage && size.height !== CANVAS.height)) {
        throw new Error(shot.id + " 画布尺寸不对：" + size.width + "x" + size.height);
    }

    const probe = await page.evaluate(() => {
        const canvasEl =
            document.querySelector("[data-mock-canvas]") ?? document.querySelector("#app");
        const nodes = canvasEl ? [...canvasEl.querySelectorAll("[data-single-line]")] : [];
        let textNodes = 0;
        let wrapped = 0;
        for (const el of nodes) {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            let node = walker.nextNode();
            while (node) {
                if (node.nodeValue && node.nodeValue.trim()) {
                    textNodes += 1;
                    const range = document.createRange();
                    range.selectNodeContents(node);
                    const tops = new Set(
                        [...range.getClientRects()].map((rect) => Math.round(rect.top)),
                    );
                    if (tops.size > 1) wrapped += 1;
                }
                node = walker.nextNode();
            }
        }
        return {
            singleLineElements: nodes.length,
            textNodes,
            wrapped,
            chromeInsideCanvas: canvasEl.querySelectorAll("[data-mock-chrome]").length,
            title:
                canvasEl
                    .querySelector("h1")
                    ?.parentElement?.innerText.replace(/\\s+/g, " ")
                    .trim() ?? null,
        };
    });

    const overflow =
        shot.fullPage || shot.element || shot.app ? null : await page.evaluate(findScroller);
    let bottomFile = null;
    if (overflow) {
        await page.waitForTimeout(300);
        const buf = await canvas.screenshot({ animations: "disabled" });
        bottomFile = path.join(outDir, shot.id + "-" + shot.name + "-bottom.png");
        fs.writeFileSync(bottomFile, buf);
    }

    return {
        id: shot.id,
        name: shot.name,
        // 临时加拍（`--extra-shot`）的镜头必须自证「我不是那 14 张交付批次之一」。
        adHoc: Boolean(shot.adHoc),
        // task-189：`app` 镜头跑的是**真路由**（`base + shot.path`），此前这里一律写
        // `preview-mock.html` + `shot.query` ⇒ 真页面镜头的 manifest 记成
        // `preview-mock.htmlundefined`，即「图从哪来」这件事记错了。证据包的 url 必须可复算，
        // 记错来源比缺字段更糟（照着它无法重建图）。
        url: shot.app ? base + shot.path : base + "/preview-mock.html" + (shot.query ?? ""),
        file: mainFile,
        sha256_16: stable.digest,
        size,
        bytes: stable.buf.length,
        deterministic: true,
        probe,
        bottom: bottomFile
            ? { file: bottomFile, overflow, sha256_16: sha(fs.readFileSync(bottomFile)) }
            : null,
    };
}

/**
 * 探活自检（\`--selftest\`）：不开浏览器、不起 dev server，秒级跑完。
 * 为什么要有它：探活失败这条路径平时只在"真出事"时才走到，没人会手动验证；
 * 而它一旦退化成 120 s 黑盒等待（task-84 之前的形状），最需要诊断的时刻恰好没有诊断。
 */
/**
 * Chromium 启动参数。**必须单独成函数**：manifest 要记下它，selftest 也要断言它原样透传 ——
 * 2026-11-11 实证：同一 commit、同一 channel，仅合成路径不同就能让 1 张图差 4 个抗锯齿像素，
 * 而当时产物里没有任何字段能说明「这两批图是不是同一台浏览器、带同样开关拍的」。
 */
function launchOptions(opts) {
    const args = opts.chromiumArgs ?? [];
    return args.length > 0
        ? { channel: opts.channel, args: args.slice() }
        : { channel: opts.channel };
}

async function runSelftest() {
    const checks = [];
    const check = (name, ok, detail) => {
        checks.push({ name, ok, detail });
    };

    // 负例 1：刚释放的空端口（TCP 没人听）⇒ 复用模式必须在预算内快速失败
    const deadPort = await freePort();
    const deadBase = "http://127.0.0.1:" + deadPort;
    const startedAt = Date.now();
    let probeError = null;
    try {
        await waitForServer(candidateBases(deadBase), null, REUSE_PROBE_TIMEOUT_MS, {
            failFastWhenNoListener: true,
        });
    } catch (error) {
        probeError = error;
    }
    const elapsed = Date.now() - startedAt;
    check("空端口必须失败", probeError !== null, probeError === null ? "居然探通了" : "");
    check(
        "空端口必须快速失败（<=" + REUSE_PROBE_TIMEOUT_MS + " ms）",
        elapsed <= REUSE_PROBE_TIMEOUT_MS,
        "实测 " + elapsed + " ms",
    );
    const message = probeError?.message ?? "";
    const candidates = candidateBases(deadBase);
    check(
        "失败报告列出全部候选 URL",
        candidates.every((url) => message.includes(url)),
        candidates.join(" | "),
    );
    check("失败报告带 TCP 直连诊断", /TCP 直连诊断/.test(message), "");
    check(
        "候选覆盖 127.0.0.1 / localhost / [::1]",
        ["127.0.0.1", "localhost", "[::1]"].every((host) =>
            candidates.some((url) => url.includes(host)),
        ),
        candidates.join(" | "),
    );

    // 负例 2：解析 vite 打印的 Local: 行（"脚本实际绑定的 host"的唯一可信来源）
    check(
        "解析 vite 的 Local: 行",
        boundBaseFromLog("  ➜  Local:   http://127.0.0.1:5199/", "http://fallback:1") ===
            "http://127.0.0.1:5199",
        boundBaseFromLog("  ➜  Local:   http://127.0.0.1:5199/", "http://fallback:1"),
    );
    check(
        "无 Local: 行时回落 base",
        boundBaseFromLog("vite 没有打印地址", "http://fallback:1") === "http://fallback:1",
        "",
    );

    // 负例 3：--chromium-arg 必须可重复、按序收集，并原样透传进 launch options
    const parsedArgs = parseArgs([
        "--chromium-arg=--disable-gpu",
        "--chromium-arg",
        "--use-gl=swiftshader",
    ]);
    check(
        "--chromium-arg 可重复且按序收集",
        JSON.stringify(parsedArgs.chromiumArgs) ===
            JSON.stringify(["--disable-gpu", "--use-gl=swiftshader"]),
        JSON.stringify(parsedArgs.chromiumArgs),
    );
    check(
        "--chromium-arg 原样透传到 launch options",
        JSON.stringify(launchOptions(parsedArgs)) ===
            JSON.stringify({
                channel: "chrome-beta",
                args: ["--disable-gpu", "--use-gl=swiftshader"],
            }),
        JSON.stringify(launchOptions(parsedArgs)),
    );
    check(
        "无 --chromium-arg 时 launch options 不带 args",
        JSON.stringify(launchOptions(parseArgs([]))) === JSON.stringify({ channel: "chrome-beta" }),
        JSON.stringify(launchOptions(parseArgs([]))),
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
        fail(1, "自检失败 " + failed.length + "/" + checks.length);
        return;
    }
    process.stdout.write("[ui-mock-shot] 自检通过 " + checks.length + "/" + checks.length + "\n");
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.selftest) {
        await runSelftest();
        return;
    }
    // 交付批次 = SHOTS（`--only` 时按 id 收窄）；临时加拍镜头追加在后面，manifest 带 adHoc 标记。
    const extraShots = opts.extraShots.map(parseExtraShot);
    const shots = (
        opts.only ? SHOTS.filter((shot) => opts.only.has(shot.id)) : SHOTS.slice()
    ).concat(opts.only ? extraShots.filter((shot) => opts.only.has(shot.id)) : extraShots);
    if (shots.length === 0) throw new Error("--only 没有匹配到任何镜头");

    const git = gitState();
    if (git.dirtyPaths.length > 0 && !opts.allowDirty) {
        throw new DirtyTreeError(git);
    }
    if (git.gitError) {
        process.stderr.write(
            "[ui-mock-shot] 警告: 读不到 git 状态（" +
                git.gitError +
                "），manifest 里 commit=null\n",
        );
    }
    // 脏树能不能当交付批次，取决于「每一条脏改动是否被一条可复算命令证明不影响渲染」，
    // 而不是取决于树脏不脏 —— 缺少证明就到这里为止（loadDirtyProofs 会点名缺哪条）。
    const dirtyNonRendering =
        git.dirtyPaths.length > 0
            ? loadDirtyProofs(opts.dirtyProof, git.dirtyPaths, git.repoRoot)
            : [];
    if (git.dirtyPaths.length > 0) {
        process.stderr.write(
            "[ui-mock-shot] 说明: 工作树有 " +
                git.dirtyPaths.length +
                " 处未提交改动，已逐条附「不影响渲染」的证明（manifest.dirtyNonRendering，命令 + 实际输出）；" +
                "allowDirty: true\n",
        );
    }
    fs.mkdirSync(opts.out, { recursive: true });

    let server = null;
    let base = opts.url;
    let serverInfo = null;
    if (base) {
        // --url 复用模式也要探活：没人监听时必须在几秒内失败，而不是把 Playwright 的
        // 30 s 导航超时当成"截图失败"（现象会与根因脱钩 —— 那些图根本没到页面这一步）。
        const reuseCandidates = candidateBases(base);
        const ready = await waitForServer(reuseCandidates, null, REUSE_PROBE_TIMEOUT_MS, {
            // 复用模式：TCP 都没人听就该立刻报 ——「指向空端口必须快速失败」这条判据落在这里。
            failFastWhenNoListener: true,
        }).catch((error) => {
            throw new Error(
                "dev server 探活失败（--url 复用模式）：\n" +
                    error.message +
                    "\n提示：--url 是「复用已起的 dev server」，探不到说明该端口没有 server；要自起请去掉 --url。",
            );
        });
        base = ready.base;
        serverInfo = {
            mode: "reused",
            base,
            readyVia: ready.readyVia,
            attempts: ready.attempts,
            candidates: reuseCandidates,
        };
        process.stdout.write(
            "[ui-mock-shot] 复用 dev server: " + base + "（探通 via " + ready.readyVia + "）\n",
        );
    } else {
        server = await startServer();
        base = server.base;
        serverInfo = {
            mode: "spawned",
            base,
            readyVia: server.readyVia,
            candidates: server.candidates,
        };
        process.stdout.write(
            "[ui-mock-shot] 临时 dev server: " + base + "（探通 via " + server.readyVia + "）\n",
        );
    }

    const browser = await chromium.launch(launchOptions(opts));
    // 浏览器指纹：不记它，「这批图是哪台浏览器、带什么开关拍的」就不可复算（只能靠反推）。
    const browserInfo = {
        channel: opts.channel,
        version: browser.version(),
        chromiumArgs: (opts.chromiumArgs ?? []).slice(),
    };
    process.stdout.write(
        "[ui-mock-shot] 浏览器: " +
            browserInfo.channel +
            " " +
            browserInfo.version +
            "  args=" +
            (browserInfo.chromiumArgs.length > 0 ? browserInfo.chromiumArgs.join(" ") : "(默认)") +
            "\n",
    );
    const results = [];
    try {
        const context = await browser.newContext({ viewport: VIEWPORT });
        // 每个新文档开拍前先种 mock token（`addInitScript` 对后续所有导航生效，只需挂一次）。
        await context.addInitScript((token) => {
            localStorage.setItem("xihe-token", token);
        }, MOCK_APP_TOKEN);
        const page = await context.newPage();
        const consoleErrors = [];
        page.on("console", (message) => {
            if (message.type() === "error") consoleErrors.push(message.text());
        });
        for (const shot of shots) {
            const result = await shootOne(page, base, shot, opts.out);
            results.push(result);
            process.stdout.write(
                [
                    result.id,
                    "sha=" + result.sha256_16,
                    "scan=" + result.probe.singleLineElements + "/" + result.probe.textNodes,
                    "wrap=" + result.probe.wrapped,
                    "chromeIn=" + result.probe.chromeInsideCanvas,
                    // 底部图是**另一张文件**，必须报它自己的 sha：只印主图 sha 时，从 stdout 誊写
                    // 报告的人会把「04 的 sha」当成「04 与 04-bottom 的 sha」（2026-11-11 实测发生过）。
                    result.bottom
                        ? "bottom=yes(+" +
                          result.bottom.overflow.gap +
                          "px, sha=" +
                          result.bottom.sha256_16 +
                          ")"
                        : "bottom=n/a",
                ].join("  ") + "\n",
            );
        }
        fs.writeFileSync(
            path.join(opts.out, "manifest.json"),
            JSON.stringify(
                {
                    commit: git.commit,
                    dirtyPaths: git.dirtyPaths,
                    // 每条脏路径的「不影响渲染」证据：{ path, reason, expect, command, cwd, exit, output }
                    dirtyNonRendering,
                    // 证明文件本身也钉住：换了证明文件，sha 会变
                    dirtyProof: opts.dirtyProof
                        ? {
                              path: path.relative(uiRoot, opts.dirtyProof).replace(/\\/g, "/"),
                              sha256_16: sha(fs.readFileSync(opts.dirtyProof)),
                          }
                        : null,
                    allowDirty: opts.allowDirty,
                    base,
                    // 服务器怎么来的、探通用的是哪个候选地址：自起模式修好（task-84）之后，
                    // "这图是自起拍的还是复用拍的"必须能从 manifest 里读出来。
                    server: serverInfo,
                    // 浏览器指纹：channel / 版本 / 启动参数。换浏览器整张图就会变（实测
                    // chrome-beta → chrome 让 04 主图从 0525a43b 变成 8901dbee），必须留痕。
                    browser: browserInfo,
                    viewport: VIEWPORT,
                    canvas: CANVAS,
                    shots: results,
                    consoleErrors,
                },
                null,
                4,
            ),
        );
    } finally {
        await browser.close();
        if (server) server.stop();
    }

    const wrapped = results.filter((item) => item.probe.wrapped > 0);
    const chromeInside = results.filter((item) => item.probe.chromeInsideCanvas > 0);
    if (wrapped.length > 0) {
        fail(3, "折行检查失败：" + wrapped.map((item) => item.id).join(","));
        return;
    }
    if (chromeInside.length > 0) {
        fail(3, "画布内出现 data-mock-chrome：" + chromeInside.map((item) => item.id).join(","));
        return;
    }
    process.stdout.write("[ui-mock-shot] 完成，输出目录: " + opts.out + "\n");
}

main().catch((error) => {
    const code = process.exitCode && process.exitCode !== 0 ? process.exitCode : 1;
    if (String(error.message).includes("dev server")) {
        fail(2, error.message);
    } else if (error instanceof DirtyTreeError) {
        fail(1, error.message);
    } else if (String(error.message).includes("连拍")) {
        fail(3, error.message);
    } else {
        fail(code, error.stack || error.message);
    }
});
