#!/usr/bin/env node
/**
 * check:copy-leak —— 面向用户的文案不得出现「审查者形态」的字符串（判据 DEV-011 §14）。
 *
 * 来源：D-1879 裁定二 + D-1880 五必填 + task-47（F-5）/ task-51（F-5b）。
 *
 * 为什么是「正则形态」而不是枚举字符串：
 *   枚举追不上新形态。task-47 实测同一页同时泄露类名 / grep 命令 / openapi.yaml /
 *   文件:行号 / 接口路径，没有一条在预先枚举的清单里。
 *
 * 为什么必须在「渲染文本」上跑，不在 i18n 源上跑（DEV-011 §14.1「在哪些层读」）：
 *   扫源会假阳 —— 源级 66 行命中里绝大多数是注释与已迁走/未挂载的面（实证：
 *   MANAGE_PERSONAL_SKILLS 与内部票号 P-189-3 从源里认得出来，但从未在任何已渲染页面出现）。
 *   所以渲染文本层是**唯一判据层**；i18n 源层只用来定位。
 *
 * 为什么必须有 matrix 文件（DEV-011 §14.3）：
 *   只扫路由默认态会假阴。task-47 实测 /resources/skills 默认层是「已迁到工作区设置」提示
 *   （正文 66 字符），面板在 role=tab 之后；据此误判「9 页只有 1 页泄露」，实际 4 面命中。
 *   矩阵落盘 = 下一个人能看出「扫过哪几格」，而不是只有一句「扫了 9 页」。
 *
 * 退出码（与 check:ui-copy 同构的三态）：
 *   0  跑完（--enforce 未给时，有命中也只报；或没有命中）
 *   0  跳过（没有可达的前端实例）—— **默认不判红**，理由见下
 *   1  --enforce 且有命中
 *   2  判不了（--require-stack 给了但没有实例 / 浏览器起不来 / 登录失败 / 矩阵读不出）
 *
 * 为什么「没有实例」默认 exit 0 而不是 2：
 *   本门要接进 mise run lint 的 30 门。lint 是在**没有栈**的环境里跑的，若没有实例就 exit 2，
 *   等于让一个「只在有栈时才有意义」的判据永久红掉 30 门（Lead 2026-11-19 裁定一：基线红则整扇窗作废）。
 *   ⇒ 默认 SKIP 且**大声打印盲区**；需要把它当门用时加 --require-stack（windowed / CI 用这个形态）。
 *   **SKIP 不是通过**：报告里 skipped: true 会落盘，引用时必须写明「本轮未覆盖」。
 *
 * 用法：
 *   node packages/ui/scripts/check-copy-leak.mjs                       # 默认 http://localhost:12640 + 12641
 *   node packages/ui/scripts/check-copy-leak.mjs --url http://127.0.0.1:12650 --api http://127.0.0.1:12651
 *   node packages/ui/scripts/check-copy-leak.mjs --json .tmp/copy-leak.json
 *   node packages/ui/scripts/check-copy-leak.mjs --require-stack --enforce   # 当作阻断门用
 *   node packages/ui/scripts/check-copy-leak.mjs --selftest                    # 纯决策逻辑，10 例
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = resolve(HERE, "..");
const A03_ROOT = resolve(UI_ROOT, "../..");

/** 9 形态。与 DEV-011 §14.2 的正则白名单逐条对应，改动必须两侧同批。 */
export const LEAK_PATTERNS = [
    ["类名", /[A-Z][A-Za-z]*(Controller|Service|Repository|Middleware)\b/],
    ["命令", /\bgrep\b/],
    ["契约文件名", /\b(openapi|swagger)\.ya?ml\b/],
    ["源码 文件:行号", /\b[\w./-]+\.(ts|vue|java|yaml|yml|mjs|js|json):\d+/],
    ["接口路径", /\/api\/v1\//],
    ["权限原子/枚举常量", /\b[A-Z][A-Z0-9]+(_[A-Z0-9]+)+\b/],
    ["内部票号", /\b[A-Z]-\d+\b/],
    ["内部术语 读面", /读面|\bread-face\b|\bread face\b/i],
    ["内部术语 契约", /契约|\bcontracts?\b/i],
];

const BLIND_SPOTS = [
    "只覆盖矩阵里列出的 route × tab 格子；弹窗 / 浮层 / tooltip 里的文案不覆盖",
    "只跑 zh-CN；英文界面要另跑一次 --language en-US（i18n-scan 只保证键与占位一致，不保证英文读得通）",
    "只跑一个视口（默认 1920x1080）；窄视口可能走不同的条件渲染分支",
    "需要真实栈 + 真实数据；没有实例时本轮 SKIP，**SKIP 不等于通过**",
    "文本层用 main.innerText：sr-only 与 display:none 子树不计入 —— 若某个判据要求 sr-only 也不许泄露，本门覆盖不到",
];

export function classify({
    stackReachable,
    matrixReadable,
    browserError,
    loginError,
    findings,
    enforce,
    requireStack,
}) {
    if (!matrixReadable) return { exit: 2, reason: "matrix unreadable" };
    if (!stackReachable)
        return {
            exit: requireStack ? 2 : 0,
            reason: requireStack
                ? "stack unreachable (--require-stack)"
                : "stack unreachable (SKIP)",
        };
    if (browserError) return { exit: 2, reason: "browser launch failed: " + browserError };
    if (loginError) return { exit: 2, reason: "login failed: " + loginError };
    if (findings > 0)
        return { exit: enforce ? 1 : 0, reason: enforce ? "findings" : "findings (report-only)" };
    return { exit: 0, reason: "clean" };
}

function parseArgs(argv) {
    const a = {
        url: process.env.XIHE_UI_URL || "http://localhost:12640",
        api: process.env.XIHE_API_URL || "http://localhost:12641",
        matrix: resolve(HERE, "copy-leak-matrix.json"),
        json: null,
        identifier: "admin@xihe.local",
        language: "zh-CN",
        channel: "chrome-beta",
        enforce: false,
        requireStack: false,
        selftest: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const next = () => argv[++i];
        if (k === "--url") a.url = next();
        else if (k === "--api") a.api = next();
        else if (k === "--matrix") a.matrix = resolve(next());
        else if (k === "--json") a.json = resolve(next());
        else if (k === "--identifier") a.identifier = next();
        else if (k === "--language") a.language = next();
        else if (k === "--channel") a.channel = next();
        else if (k === "--enforce") a.enforce = true;
        else if (k === "--require-stack") a.requireStack = true;
        else if (k === "--selftest") a.selftest = true;
        else if (k === "--help" || k === "-h") {
            console.log("see header docs");
            process.exit(0);
        } else {
            console.error("[copy-leak] unknown arg: " + k);
            process.exit(2);
        }
    }
    return a;
}

function selftest() {
    const cases = [
        [
            {
                stackReachable: true,
                matrixReadable: true,
                findings: 0,
                enforce: false,
                requireStack: false,
            },
            0,
        ],
        [
            {
                stackReachable: true,
                matrixReadable: true,
                findings: 3,
                enforce: false,
                requireStack: false,
            },
            0,
        ],
        [
            {
                stackReachable: true,
                matrixReadable: true,
                findings: 3,
                enforce: true,
                requireStack: false,
            },
            1,
        ],
        [
            {
                stackReachable: false,
                matrixReadable: true,
                findings: 0,
                enforce: false,
                requireStack: false,
            },
            0,
        ],
        [
            {
                stackReachable: false,
                matrixReadable: true,
                findings: 0,
                enforce: false,
                requireStack: true,
            },
            2,
        ],
        [
            {
                stackReachable: false,
                matrixReadable: true,
                findings: 0,
                enforce: true,
                requireStack: true,
            },
            2,
        ],
        [
            {
                stackReachable: true,
                matrixReadable: false,
                findings: 0,
                enforce: false,
                requireStack: false,
            },
            2,
        ],
        [
            {
                stackReachable: true,
                matrixReadable: true,
                browserError: "x",
                findings: 0,
                enforce: false,
                requireStack: false,
            },
            2,
        ],
        [
            {
                stackReachable: true,
                matrixReadable: true,
                loginError: "x",
                findings: 0,
                enforce: false,
                requireStack: false,
            },
            2,
        ],
        [
            {
                stackReachable: true,
                matrixReadable: true,
                findings: 0,
                enforce: true,
                requireStack: true,
            },
            0,
        ],
    ];
    let bad = 0;
    cases.forEach(([input, want], i) => {
        const got = classify(input).exit;
        const ok = got === want;
        if (!ok) bad++;
        console.log((ok ? "  PASS " : "  FAIL ") + "#" + (i + 1) + " want=" + want + " got=" + got);
    });
    console.log(
        "[copy-leak] selftest " +
            (cases.length - bad) +
            "/" +
            cases.length +
            (bad === 0 ? " 全过" : " 有失败"),
    );
    process.exit(bad === 0 ? 0 : 1);
}

async function probe(url) {
    try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 2500);
        const r = await fetch(url, { signal: ctl.signal });
        clearTimeout(t);
        return r.ok || r.status < 500;
    } catch {
        return false;
    }
}

function applyPatterns(text) {
    const out = [];
    for (const [shape, re] of LEAK_PATTERNS) {
        const m = text.match(new RegExp(re.source, "g" + (re.flags.includes("i") ? "i" : "")));
        if (m) out.push({ shape, count: m.length, samples: [...new Set(m)].slice(0, 5) });
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.selftest) selftest();

    let matrix = null;
    try {
        matrix = JSON.parse(await readFile(args.matrix, "utf8"));
    } catch (e) {
        console.error("[copy-leak] 矩阵读不出：" + args.matrix + " —— " + e.message);
        console.error(classify({ matrixReadable: false }).reason);
        process.exit(2);
    }
    const surfaces = matrix.surfaces || [];
    console.log(
        "[copy-leak] 矩阵 " +
            args.matrix +
            "： " +
            surfaces.length +
            " 个面（" +
            (matrix.criteria || "DEV-011 §14") +
            "）",
    );

    const uiUp = await probe(args.url);
    const apiUp = await probe(args.api + "/api/v1/health");
    if (!uiUp) {
        const d = classify({
            stackReachable: false,
            matrixReadable: true,
            findings: 0,
            enforce: args.enforce,
            requireStack: args.requireStack,
        });
        console.log("[copy-leak] SKIP：前端不可达 " + args.url + "（" + d.reason + "）");
        console.log("[copy-leak] 盲区 —— 本轮**未覆盖**，引用时不许写成「已通过」：");
        for (const b of BLIND_SPOTS) console.log("        · " + b);
        if (args.json)
            await writeFile(
                args.json,
                JSON.stringify(
                    {
                        skipped: true,
                        reason: d.reason,
                        url: args.url,
                        takenAt: new Date().toISOString(),
                        blindSpots: BLIND_SPOTS,
                    },
                    null,
                    2,
                ),
                "utf8",
            );
        process.exit(d.exit);
    }
    if (!apiUp) {
        console.error(
            "[copy-leak] 判不了：前端在但 API 不可达 " +
                args.api +
                "（没有登录态就取不到真实 rendered text）",
        );
        process.exit(2);
    }

    const mod = await import(
        pathToFileURL(resolve(A03_ROOT, "scripts/lib/dev-admin-password.mjs")).href
    );
    const resolved = mod.resolveDevAdminPassword({ projectRoot: A03_ROOT, persist: false });
    const lr = await fetch(args.api + "/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: args.identifier, password: resolved.password }),
    });
    const lj = await lr.json().catch(() => ({}));
    if (!lj.accessToken) {
        console.error(
            "[copy-leak] 判不了：登录失败 HTTP " +
                lr.status +
                "（identifier=" +
                args.identifier +
                "，口令来源=" +
                resolved.source +
                "，不回显口令）",
        );
        process.exit(2);
    }
    const token = lj.accessToken;

    const wr = await fetch(args.api + "/api/v1/workspaces", {
        headers: { authorization: "Bearer " + token },
    });
    const wj = await wr.json().catch(() => null);
    const list = Array.isArray(wj) ? wj : (wj && (wj.items || wj.workspaces)) || [];
    const wsId = list.length ? list[0].id || list[0].workspaceId : null;
    if (!wsId) {
        console.error("[copy-leak] 判不了：取不到工作区 id（矩阵里 {ws} 无法替换）");
        process.exit(2);
    }

    const require = createRequire(resolve(UI_ROOT, "package.json"));
    const { chromium } = require("@playwright/test");
    let browser;
    try {
        browser = await chromium.launch({ channel: args.channel, headless: true });
    } catch (e) {
        console.error("[copy-leak] 判不了：浏览器起不来 " + (e.message || e));
        process.exit(2);
    }
    const ctx = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        locale: args.language,
    });
    const page = await ctx.newPage();
    await page.addInitScript((t) => localStorage.setItem("xihe-token", t), token);
    await page.addInitScript(
        (w) => localStorage.setItem("xihe-user", JSON.stringify({ workspaceId: w })),
        wsId,
    );
    await page.addInitScript((lang) => {
        localStorage.setItem("xihe-theme", "light");
        localStorage.setItem("xihe-language", lang);
    }, args.language);

    const results = [];
    for (const s of surfaces) {
        const route = String(s.route).replace("{ws}", wsId);
        if (s.via === "mock") {
            // 真栈凑不出这个形态（例：实例层列表为空）⇒ 门跑不到。**显式打印并跳过**，
            // 不静默略过 —— 静默会让「覆盖 N 面」变成假话。覆盖方由 spec 列给出，可核。
            results.push({
                id: s.id,
                route,
                tabs: s.tabs || [],
                expectedBefore: s.expectedBefore,
                status: "mock-covered",
                hits: [],
                coveredBy: s.spec || "(未登记 spec)",
            });
            continue;
        }
        const row = {
            id: s.id,
            route,
            tabs: s.tabs || [],
            expectedBefore: s.expectedBefore,
            status: "ok",
            hits: [],
        };
        try {
            await page.goto(args.url + route, { waitUntil: "domcontentloaded", timeout: 60000 });
            await page.waitForTimeout(2600);
            await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
            for (const tabName of row.tabs) {
                const el = page.locator("[role=tab]", { hasText: tabName }).first();
                if (await el.count()) {
                    await el.click({ timeout: 8000 }).catch(() => {});
                    await page.waitForTimeout(1500);
                } else
                    row.hits.push({
                        shape: "(矩阵失配)",
                        count: 0,
                        samples: ["找不到 tab：" + tabName],
                    });
            }
            const text = await page.evaluate(
                // 必须用 innerText，不能用 textContent：textContent 会把 sr-only、display:none 子树与脚本串
                // 一起吞进来 => 假阳（DEV-011 §14.1「在哪量」明写这一条）。oxlint 这条规则在此不适用，
                // 且**不许**按它改 —— 按它改，本门就变成了「什么都没泄露」的假绿。
                // eslint-disable-next-line unicorn/prefer-dom-node-text-content
                () => (document.querySelector("main") || document.body).innerText || "",
            );
            row.chars = text.length;
            row.hits = row.hits.concat(applyPatterns(text));
        } catch (e) {
            row.status = "error";
            row.error = String(e.message || e).slice(0, 200);
        }
        results.push(row);
    }
    await browser.close();

    let findings = 0;
    for (const r of results) {
        const n = r.hits.reduce((a, h) => a + h.count, 0);
        findings += n;
        const flag =
            r.status === "error"
                ? "ERR "
                : r.status === "mock-covered"
                  ? "MOCK"
                  : n > 0
                    ? "HIT "
                    : "  ok";
        // mock-covered 不许打印「0 字符」—— 那读起来像「扫过且干净」，而门根本没扫它。
        const detail =
            r.status === "mock-covered"
                ? "门未扫（真栈凑不出该形态），由 " + (r.coveredBy || "未登记 spec") + " 覆盖"
                : "期望修复前 " + (r.expectedBefore ?? "?") + "，" + (r.chars ?? 0) + " 字符";
        console.log("  " + flag + " " + r.id.padEnd(30) + " 命中 " + n + "  (" + detail + ")");
        for (const h of r.hits)
            console.log("        [" + h.shape + "] x" + h.count + " -> " + h.samples.join(" | "));
    }
    const errors = results.filter((r) => r.status === "error").length;
    const d = classify({
        stackReachable: true,
        matrixReadable: true,
        findings,
        enforce: args.enforce,
        requireStack: args.requireStack,
    });

    console.log("");
    console.log(
        "[copy-leak] 面 " +
            results.length +
            " 个（error " +
            errors +
            "） ｜ 9 形态命中合计 " +
            findings +
            " ｜ " +
            d.reason +
            " ｜ exit " +
            d.exit,
    );
    console.log("[copy-leak] 盲区（结构上不覆盖，勿据此认为全覆盖）：");
    for (const b of BLIND_SPOTS) console.log("        · " + b);
    if (args.json) {
        await writeFile(
            args.json,
            JSON.stringify(
                {
                    skipped: false,
                    takenAt: new Date().toISOString(),
                    url: args.url,
                    api: args.api,
                    language: args.language,
                    matrix: args.matrix,
                    surfaces: results,
                    findings,
                    exit: d.exit,
                    reason: d.reason,
                    blindSpots: BLIND_SPOTS,
                },
                null,
                2,
            ),
            "utf8",
        );
        console.log("[copy-leak] 报告已写入 " + args.json);
    }
    process.exit(d.exit);
}

main().catch((e) => {
    console.error("[copy-leak] 未捕获异常：" + (e && e.stack ? e.stack : e));
    process.exit(2);
});
