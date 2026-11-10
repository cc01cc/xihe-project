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

/** 六个交付镜头：3 个专用面板域的列表态 + 详情态（层固定 user，?notes=0）。 */
const SHOTS = [
    { id: "01", name: "embedding-list", query: "?notes=0&domain=embedding&layer=user#1" },
    {
        id: "02",
        name: "embedding-detail",
        query: "?notes=0&domain=embedding&detail=1&layer=user#1",
    },
    {
        id: "03",
        name: "agent-templates-list",
        query: "?notes=0&domain=agent-templates&layer=user#1",
    },
    {
        id: "04",
        name: "agent-templates-detail",
        query: "?notes=0&domain=agent-templates&detail=1&layer=user#1",
    },
    {
        id: "05",
        name: "api-request-templates-list",
        query: "?notes=0&domain=api-request-templates&layer=user#1",
    },
    {
        id: "06",
        name: "api-request-templates-detail",
        query: "?notes=0&domain=api-request-templates&detail=1&layer=user#1",
    },
];

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
                "先提交再拍。若只是自查迭代，可加 --allow-dirty（manifest 会记 allowDirty: true，不得用于交付批次）。",
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
    if (!head.ok) return { commit: null, dirtyPaths: [], gitError: head.output || "git 不可用" };
    const status = run(["status", "--porcelain", "-uall", "--"].concat(GIT_SCOPE));
    if (!status.ok) return { commit: head.output, dirtyPaths: [], gitError: status.output };
    const dirtyPaths = status.output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/^[A-Z?!]{1,2}\s+/, ""));
    return { commit: head.output, dirtyPaths, gitError: null };
}

function parseArgs(argv) {
    const opts = {
        url: null,
        out: path.resolve(uiRoot, "../../.tmp/xh/ui-mock-shot"),
        channel: "chrome-beta",
        only: null,
        allowDirty: false,
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
        } else if (arg === "--only") {
            opts.only = new Set(
                value
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean),
            );
            i += 1;
        } else if (arg === "--allow-dirty") {
            // 只用于自查迭代：脏树出的图不得当交付批次，manifest 里会留 allowDirty: true。
            opts.allowDirty = true;
        } else if (arg === "--help" || arg === "-h") {
            process.stdout.write(
                [
                    "用法: node packages/ui/scripts/ui-mock-shot.mjs [--url <base>] [--out <dir>] [--only 01,04] [--allow-dirty]",
                    "工作树脏时默认 exit 1；--allow-dirty 只给自查迭代用，不得用于交付批次。",
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

async function waitForServer(base, child, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child && child.exitCode !== null) {
            throw new Error("dev server 提前退出，exitCode=" + child.exitCode);
        }
        try {
            const res = await fetch(base + "/preview-mock.html", { method: "GET" });
            if (res.ok) return;
        } catch {
            // 还没起来，继续等
        }
        await sleep(300);
    }
    throw new Error("dev server 在 " + timeoutMs + " ms 内没有就绪: " + base);
}

function killTree(child) {
    if (!child || child.exitCode !== null) return;
    if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
        child.kill("SIGTERM");
    }
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
    // 必须绑 127.0.0.1：vite 默认只听 localhost，在 Windows 上可能只落 ::1，
    // 探活请求打 127.0.0.1 会一直超时（实测 ready 了但探不通）。
    const child = spawn(
        process.execPath,
        [viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
        {
            cwd: uiRoot,
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
    try {
        await waitForServer(base, child, 120000);
    } catch (error) {
        killTree(child);
        throw new Error(error.message + "\n--- vite 输出 ---\n" + log.slice(-2000));
    }
    return { base, stop: () => killTree(child) };
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
    await page.goto(base + "/preview-mock.html" + shot.query, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelectorAll("[data-mock-canvas]").length === 1);
    await page.addStyleTag({ content: SHOT_CSS });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        window.scrollTo(0, 0);
        for (const el of document.querySelectorAll("[data-mock-canvas] *")) el.scrollTop = 0;
    });
    // 鼠标停在左栏会留下 hover 底色；挪到内容区空白处，避免"看起来像同时选中两项"。
    await page.mouse.move(VIEWPORT.width - 200, VIEWPORT.height - 100);
    await page.waitForTimeout(400);

    const canvas = page.locator("[data-mock-canvas]");
    let stable = null;
    let previous = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const buf = await canvas.screenshot({ animations: "disabled" });
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
    if (size.width !== CANVAS.width || size.height !== CANVAS.height) {
        throw new Error(shot.id + " 画布尺寸不对：" + size.width + "x" + size.height);
    }

    const probe = await page.evaluate(() => {
        const canvasEl = document.querySelector("[data-mock-canvas]");
        const nodes = [...canvasEl.querySelectorAll("[data-single-line]")];
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

    const overflow = await page.evaluate(findScroller);
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
        url: base + "/preview-mock.html" + shot.query,
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

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const shots = opts.only ? SHOTS.filter((shot) => opts.only.has(shot.id)) : SHOTS;
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
    if (git.dirtyPaths.length > 0) {
        process.stderr.write(
            "[ui-mock-shot] 警告: 工作树有 " +
                git.dirtyPaths.length +
                " 处未提交改动，本批次 **不得用于交付**（manifest 会记 allowDirty: true）\n",
        );
    }
    fs.mkdirSync(opts.out, { recursive: true });

    let server = null;
    let base = opts.url;
    if (!base) {
        server = await startServer();
        base = server.base;
        process.stdout.write("[ui-mock-shot] 临时 dev server: " + base + "\n");
    }

    const browser = await chromium.launch({ channel: opts.channel });
    const results = [];
    try {
        const context = await browser.newContext({ viewport: VIEWPORT });
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
                    result.bottom
                        ? "bottom=yes(+" + result.bottom.overflow.gap + "px)"
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
                    allowDirty: opts.allowDirty,
                    base,
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
