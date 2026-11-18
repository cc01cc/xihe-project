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
    "文本层两把轴：main.innerText（老账、判红轴）+ body 级不含 main 的 portal 子树（新轴，默认只报不判红，--portals-enforce 才并账）。sr-only 与 display:none 在两把轴上都不计入（innerText 为空）",
    "portal 轴只扫已经存在的 body 级子树：矩阵里没声明 open 步骤的浮层，门不会自己去点开，依然不覆盖",
    "#app 内的导航 chrome（rail / 侧栏 / 页签栏 / 面包屑）不进扫描轴，只由 --survey-roots 量出文本量并如实报 —— 改成 body 一把根会把这批正常文案并进泄露账",
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
        surveyRoots: false,
        anchor: false,
        viewport: "1920x1080",
        out: null,
        portalsEnforce: false,
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
        else if (k === "--survey-roots") a.surveyRoots = true;
        else if (k === "--anchor") a.anchor = true;
        else if (k === "--viewport") a.viewport = next();
        else if (k === "--out") a.out = resolve(next());
        else if (k === "--portals-enforce") a.portalsEnforce = true;
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

/**
 * 取文根：**两把轴分开取，不合成一把 body**。
 *
 * 为什么不直接用 document.body（task-75 卡面给的第一个选项）：
 *   Vue 挂在 #app 里，#app 又包含 <main> 与整条导航 chrome。改成 body 一把根会**同时**
 *   把「portal 盲区」与「应用外壳 chrome」两件事并进老账，一夜冒出的大批命中分不清
 *   哪条是产品泄露、哪条是导航正常文案 —— 卡面明写「必须先分类，不能直接当泄露修」。
 *   而实测盲区（MobileChangesSheet）恰恰是 **body 直接子层、且不含 main** 的那批子树
 *   （reka-ui / 自建 portal 一律挂到 document.body）。所以按这个形状取：
 *   只圈 portal 族，逐块带身份，命中天然归类。
 *
 * 仍必须 innerText 不用 textContent（理由同主循环那条注释：隐藏子树会假阳）。
 * 隐藏子树的 innerText 为空串 ⇒ 老口径「sr-only / display:none 不计入」在这里仍然成立，
 * 没有因为多取一把根而被悄悄放宽。
 */
async function readRoots(page, containerSel) {
    return page.evaluate((container) => {
        const SKIP = new Set([
            "SCRIPT",
            "STYLE",
            "LINK",
            "META",
            "TITLE",
            "TEMPLATE",
            "NOSCRIPT",
            "IFRAME",
        ]);
        const ident = (el) => {
            // 归类全靠这个身份串 —— 只给 tag 名（实测锚点宿主曾只报出 "div"）等于没归类
            const cls =
                (typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "") || "";
            return (
                el.tagName.toLowerCase() +
                (el.id ? "#" + el.id : "") +
                (el.getAttribute("data-testid")
                    ? "[data-testid=" + el.getAttribute("data-testid") + "]"
                    : "") +
                (el.getAttribute("role") ? "[role=" + el.getAttribute("role") + "]" : "") +
                (cls ? "." + cls.slice(0, 28) : "")
            );
        };
        const mainEl = document.querySelector("main");
        const 面容器 = container ? document.querySelector(container) : null;
        // 取文根优先级：main → 面自带容器 → body 兜底。**用了哪一把必须落进读数**：
        // 实测 /members（OrgMembersView.vue:40 明写「本页没有 <main>」）静默落到 body，
        // 报告里却只写「2940 字符」，读起来像标准轴 —— 那是仪器在撒谎，不是产品泄露。
        const root = mainEl || 面容器 || document.body;
        const 根 = mainEl ? "main" : 面容器 ? "container:" + ident(面容器) : "body(兜底)";
        if (!mainEl && !container) {
            return {
                根,
                有main: false,
                mainChars: 0,
                // eslint-disable-next-line unicorn/prefer-dom-node-text-content
                bodyChars: (document.body.innerText || "").length,
                // eslint-disable-next-line unicorn/prefer-dom-node-text-content
                mainText: (document.body.innerText || "").trim(),
                portals: [],
                壳内非main: [],
            };
        }
        const portals = [];
        const 壳内非main = [];
        for (const el of Array.from(document.body.children)) {
            if (SKIP.has(el.tagName)) continue;
            // eslint-disable-next-line unicorn/prefer-dom-node-text-content
            const t = (el.innerText || "").trim();
            if (el === root || el.contains(root)) {
                // #app 这一支：含 main，也含导航 chrome。chrome 不进扫描轴（那是另一条盲区，
                // 由 survey 单独量出「壳内非 main 文本量」并如实报，不静默并账）。
                if (t.length) 壳内非main.push({ 身份: ident(el), chars: t.length });
                continue;
            }
            if (!t) continue;
            portals.push({
                身份: ident(el),
                在main内: !!mainEl && mainEl.contains(el),
                chars: t.length,
                text: t,
            });
        }
        return {
            根,
            有main: !!mainEl,
            // eslint-disable-next-line unicorn/prefer-dom-node-text-content
            mainChars: root === document.body ? 0 : (root.innerText || "").length,
            // eslint-disable-next-line unicorn/prefer-dom-node-text-content
            bodyChars: (document.body.innerText || "").length,
            // eslint-disable-next-line unicorn/prefer-dom-node-text-content
            mainText: (root.innerText || "").trim(),
            portals,
            壳内非main,
        };
    }, containerSel || null);
}

async function surveyRoots({ page, args, surfaces, wsId }) {
    const rows = [];
    for (const s of surfaces) {
        const route = String(s.route).replace("{ws}", wsId);
        if (s.via === "mock") {
            rows.push({
                id: s.id,
                route,
                status: "mock-covered",
                说明:
                    "真栈凑不出该形态，门不扫 ⇒ 本 survey 也扫不到（由 " +
                    (s.spec || "未登记 spec") +
                    " 覆盖）",
            });
            continue;
        }
        const row = { id: s.id, route, status: "ok" };
        try {
            // 面级视口必须与门一致：实测打过脸 —— 同一面门里 portal=1、普查 @1920 里 =0，
            // 因为普查先前只复刻了 goto+tab，没走 viewport/open。两套驱动读同一个面不能给两个答案。
            const vpS = /^(\d+)x(\d+)$/.exec(s.viewport || "") || [];
            if (vpS.length)
                await page.setViewportSize({ width: Number(vpS[1]), height: Number(vpS[2]) });
            await page.goto(args.url + route, { waitUntil: "domcontentloaded", timeout: 60000 });
            await page.waitForTimeout(2600);
            await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
            for (const tabName of s.tabs || []) {
                const el = page.locator("[role=tab]", { hasText: tabName }).first();
                if (await el.count()) {
                    await el.click({ timeout: 8000 }).catch(() => {});
                    await page.waitForTimeout(1500);
                }
            }
            // 与主循环同一套驱动：普查若不走 open 步骤，同一面在门与普查里的 portal 块数
            // 会互相打脸（实测就打过一次：门扫到 1 块 Sheet，普查报 0）。
            for (const osel of s.open || []) {
                await page.click(osel, { timeout: 5000 }).catch(() => {});
                await page.waitForTimeout(700);
            }
            const r = await readRoots(page, s.container || null);
            row.视口 = s.viewport || args.viewport;
            row.取文根 = r.根;
            row.main字符 = r.mainChars;
            row.body字符 = r.bodyChars;
            row.差值 = r.bodyChars - r.mainChars;
            row.有main = r.有main;
            row.portal = r.portals.map((p) => ({
                身份: p.身份,
                chars: p.chars,
                命中: applyPatterns(p.text).reduce((a, h) => a + h.count, 0),
                形态: applyPatterns(p.text).map((h) => h.shape),
            }));
            row.壳内非main = r.壳内非main;
        } catch (e) {
            row.status = "error";
            row.error = String(e.message || e).slice(0, 200);
        }
        rows.push(row);
    }
    return rows;
}

async function anchorPortal({ page, args, wsId }) {
    // 宿主必须是卡面点名的那块 Sheet，不能是「body 下第一个不是 main 的东西」——
    // 实测第一版落到遮罩 div.bg-black/10（innerText 为空）上：判据照样 PASS，但它证的是
    // 「任意 body 子树」，不是「这块面的文本读不到」。锚点必须钉在它所声称的那块上。
    // 反例锚点：一条**只在 portal 内可见**的泄露串。判据两侧都钉着：
    //   改前（main 一把根）必须 0 命中 ⇒ 证明盲区真实存在，不是嘴上说说；
    //   改后（portal 轴）必须报出 ⇒ 才算收敛证明。「改后 0 命中」不算通过。
    const LEAK = "XhAnchorProbeSkillController.java:42 /api/v1/xh-anchor-probe";
    await page.goto(args.url + "/workspace/" + wsId, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
    });
    await page.waitForTimeout(2600);
    await page
        .click('[data-testid="workspace-toolbar-changes"]', { timeout: 4000 })
        .catch(() => {});
    await page.waitForTimeout(600);
    await page
        .click('[data-testid="workspace-diff-tab-pending"]', { timeout: 4000 })
        .catch(() => {});
    await page.waitForTimeout(800);
    const host = await page.evaluate((leak) => {
        const mainEl = document.querySelector("main");
        const SKIP = new Set([
            "SCRIPT",
            "STYLE",
            "LINK",
            "META",
            "TITLE",
            "TEMPLATE",
            "NOSCRIPT",
            "IFRAME",
        ]);
        const ident = (el) =>
            el.tagName.toLowerCase() +
            (el.id ? "#" + el.id : "") +
            (el.getAttribute("data-testid")
                ? "[data-testid=" + el.getAttribute("data-testid") + "]"
                : "") +
            (el.getAttribute("role") ? "[role=" + el.getAttribute("role") + "]" : "");
        const all = Array.from(document.body.children).filter(
            (el) => !SKIP.has(el.tagName) && !el.contains(mainEl),
        );
        const want = '[data-testid="mobile-changes-sheet"], #mobile-changes-sheet';
        const cands = all.filter((el) => el.matches(want));
        const 候选 = all.map((el) => ({
            身份: ident(el),
            // eslint-disable-next-line unicorn/prefer-dom-node-text-content
            文本非空: !!(el.innerText || "").trim(),
            是声称宿主: el.matches(want),
        }));
        const picked = cands[0] || null;
        if (!picked)
            return {
                有宿主: false,
                原因:
                    "该视口下没打开移动变更 Sheet（body 直接子层里找不到 " +
                    want +
                    "）⇒ 锚点无处注入，open 步骤或视口不对",
                候选,
            };
        const n = document.createElement("div");
        n.id = "xh-anchor-portal-leak";
        n.textContent = leak;
        picked.appendChild(n);
        return {
            有宿主: true,
            宿主身份: ident(picked),
            候选,
            注入在main内: !!(mainEl && mainEl.contains(n)),
            // 盲区的定义要两个读数同时成立：渲染文本里**看得见**（不是藏在隐藏子树里），
            // 而 main 那把根**读不到**。只证后者会漏掉「注入到一个不渲染的地方」这种假锚点。
            // eslint-disable-next-line unicorn/prefer-dom-node-text-content
            渲染可见: (document.body.innerText || "").includes(leak),
            // eslint-disable-next-line unicorn/prefer-dom-node-text-content
            main读到: !!(mainEl && (mainEl.innerText || "").includes(leak)),
        };
    }, LEAK);
    if (!host.有宿主)
        return {
            有效: false,
            原因: "该视口下 body 直接子层没有 main 外的子树 ⇒ 锚点无处注入",
            读数: host,
        };
    const r = await readRoots(page);
    const 旧根命中 = applyPatterns(r.mainText);
    // 不用 map 里 spread（oxc(no-map-spread) ↔ eslint(prefer-object-spread) 是登记在册的互斥对，
    // 仓库口径 = 抽成具名写法让 spread 不进 map 回调体）：这里直接展开成显式字段。
    const portal命中 = [];
    for (const x of r.portals) {
        for (const h of applyPatterns(x.text))
            portal命中.push({ shape: h.shape, count: h.count, samples: h.samples, 身份: x.身份 });
    }
    return {
        有效: true,
        视口: args.viewport,
        渲染可见: host.渲染可见,
        main读到: host.main读到,
        宿主身份: host.宿主身份,
        portal候选: host.候选,
        注入在main内: host.注入在main内,
        泄露串: LEAK,
        旧根命中数: 旧根命中.reduce((a, h) => a + h.count, 0),
        旧根形态: 旧根命中.map((h) => h.shape),
        新根命中数: portal命中.reduce((a, h) => a + h.count, 0),
        新根形态: portal命中.map((h) => h.shape + "@" + h.身份),
    };
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
    const vp = /^(\d+)x(\d+)$/.exec(args.viewport) || [];
    const ctx = await browser.newContext({
        viewport: { width: Number(vp[1]) || 1920, height: Number(vp[2]) || 1080 },
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

    if (args.surveyRoots || args.anchor) {
        const payload = {
            takenAt: new Date().toISOString(),
            url: args.url,
            api: args.api,
            viewport: args.viewport,
            language: args.language,
            channel: args.channel,
            matrix: args.matrix,
            面数: surfaces.length,
        };
        let code = 0;
        if (args.surveyRoots) {
            payload.survey = await surveyRoots({ page, args, surfaces, wsId });
            const 在main外 = payload.survey.filter((r) => (r.portal || []).length);
            console.log(
                "[copy-leak] 取文根普查 @ " +
                    args.viewport +
                    "：面 " +
                    payload.survey.length +
                    " 个 ｜ 存在 body 级 main 外子树的 " +
                    在main外.length +
                    " 个",
            );
            for (const r of payload.survey) {
                if (r.status !== "ok") {
                    console.log(
                        "  -- " + r.id.padEnd(30) + " " + r.status + (r.说明 ? " " + r.说明 : ""),
                    );
                    continue;
                }
                console.log(
                    "  " +
                        r.id.padEnd(30) +
                        " main " +
                        String(r.main字符).padStart(6) +
                        " 字符 ｜ body 外 " +
                        String(r.差值).padStart(5) +
                        " ｜ portal 子树 " +
                        (r.portal || []).length +
                        " 块" +
                        ((r.portal || []).length
                            ? " ⇒ " +
                              r.portal
                                  .map((x) => x.身份 + "(" + x.chars + "字符,命中" + x.命中 + ")")
                                  .join(" ")
                            : ""),
                );
            }
        }
        // 残缺普查不能长得像干净普查：实测撞过 UI 被别的 lane 重启的窗口，
        // 4 面 ERR_CONNECTION_REFUSED 而 exit 仍是 0 —— 那等于交一份瞎掉的读数出去。
        const 坏面 = (payload.survey || []).filter((r) => r.status === "error");
        if (坏面.length) {
            payload.不完整 = true;
            payload.坏面 = 坏面.map((r) => ({ id: r.id, error: r.error }));
            console.log(
                "[copy-leak] 普查有 " +
                    坏面.length +
                    " 面 error（" +
                    坏面.map((r) => r.id).join("、") +
                    "）⇒ 本轮读数不完整，判不了就 exit 非 0，别当干净普查用",
            );
            code ||= 1;
        }
        if (args.anchor) {
            payload.anchor = await anchorPortal({ page, args, wsId });
            const a = payload.anchor;
            if (!a.有效) {
                console.error("[copy-leak] 锚点无效：" + a.原因 + " —— " + JSON.stringify(a.读数));
                code = 2;
            } else {
                const 判据 = [
                    [
                        "宿主是卡面点名的 Sheet（不是遮罩/任意 body 子树）",
                        String(a.宿主身份).includes("mobile-changes-sheet"),
                    ],
                    ["注入串在渲染文本里可见（不是藏进隐藏子树）", a.渲染可见 === true],
                    ["main 那把根读不到它", a.main读到 === false],
                    ["注入确实落在 main 外", a.注入在main内 === false],
                    ["改前（main 一把根）0 命中 ⇒ 盲区真实", a.旧根命中数 === 0],
                    ["改后（portal 轴）报出 ⇒ 收敛证明", a.新根命中数 > 0],
                ];
                console.log(
                    "[copy-leak] 反例锚点 @ " +
                        a.视口 +
                        " 宿主 " +
                        a.宿主身份 +
                        " 串「" +
                        a.泄露串 +
                        "」",
                );
                console.log(
                    "        渲染可见=" +
                        a.渲染可见 +
                        " ｜ main读到=" +
                        a.main读到 +
                        " ｜ body 外候选块数=" +
                        a.portal候选.length,
                );
                console.log(
                    "        旧根命中 " +
                        a.旧根命中数 +
                        " " +
                        JSON.stringify(a.旧根形态) +
                        " ｜ 新根命中 " +
                        a.新根命中数 +
                        " " +
                        JSON.stringify(a.新根形态),
                );
                for (const [n, ok] of 判据) console.log("  " + (ok ? "PASS " : "FAIL ") + n);
                code = 判据.every(([, ok]) => ok) ? 0 : 1;
            }
        }
        if (args.out) {
            await writeFile(args.out, JSON.stringify(payload, null, 2), "utf8");
            console.log("[copy-leak] 读数已写入 " + args.out);
        }
        await browser.close();
        process.exit(code);
    }

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
            // 面级视口（盲区是视口条件化的）+ 面级容器，见 surveyRoots 同款注释
            const vp0 = /^(\d+)x(\d+)$/.exec(s.viewport || "") || [];
            if (vp0.length)
                await page.setViewportSize({ width: Number(vp0[1]), height: Number(vp0[2]) });
            row.视口 = s.viewport || args.viewport;
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
            // open 步骤：矩阵里声明「要点哪些东西这块面才存在」。没有这一步，门的驱动只认
            // route + role=tab ⇒ **portal 类面永远不会被打开**（task-75 实测：无 open 步骤时
            // 1920 与 390 两轮普查里 portal 块数恒 0 —— 门从没点出过 Sheet，不是 Sheet 不在）。
            for (const osel of s.open || []) {
                await page.click(osel, { timeout: 5000 }).catch((e) => {
                    row.hits.push({
                        shape: "(open 步骤失配)",
                        count: 0,
                        samples: ["点不到：" + osel + " —— " + String(e.message || e).slice(0, 80)],
                    });
                });
                await page.waitForTimeout(700);
            }
            const r0 = await readRoots(page, s.container || null);
            row.取文根 = r0.根;
            row.chars = r0.mainChars;
            row.hits = row.hits.concat(applyPatterns(r0.mainText));
            // 第二条轴：body 级、main 外的 portal 子树（task-73 实测 MobileChangesSheet 挂这里）。
            // 命中**单独计数、单独归属**，默认不并进 findings —— 并进去就等于把「新覆盖」
            // 当成「新泄露」，卡面明令禁止。要让它判红用 --portals-enforce。
            row.有main = r0.有main;
            row.portals = r0.portals.map((x) => ({
                身份: x.身份,
                chars: x.chars,
                hits: applyPatterns(x.text),
            }));
            row.portalChars = r0.portals.reduce((a, x) => a + x.chars, 0);
            row.portalHits = row.portals.reduce(
                (a, x) => a + x.hits.reduce((b, h) => b + h.count, 0),
                0,
            );
            row.壳内非main = r0.壳内非main;
        } catch (e) {
            row.status = "error";
            row.error = String(e.message || e).slice(0, 200);
        }
        results.push(row);
    }
    await browser.close();

    let findings = 0;
    let portalFindings = 0;
    for (const r of results) {
        const n = r.hits.reduce((a, h) => a + h.count, 0);
        findings += n;
        portalFindings += r.portalHits || 0;
        const flag =
            r.status === "error"
                ? "ERR "
                : r.status === "mock-covered"
                  ? "MOCK"
                  : n > 0
                    ? "HIT "
                    : "  ok";
        // mock-covered 不许打印「0 字符」—— 那读起来像「扫过且干净」，而门根本没扫它。
        if (r.portalHits) {
            for (const x of r.portals)
                for (const h of x.hits)
                    console.log(
                        "        [portal] " +
                            x.身份 +
                            " [" +
                            h.shape +
                            "] x" +
                            h.count +
                            " -> " +
                            h.samples.join(" | "),
                    );
        }
        const detail =
            r.status === "mock-covered"
                ? "门未扫（真栈凑不出该形态），由 " + (r.coveredBy || "未登记 spec") + " 覆盖"
                : "期望修复前 " +
                  (r.expectedBefore ?? "?") +
                  "，" +
                  (r.chars ?? 0) +
                  " 字符" +
                  (r.取文根 && r.取文根 !== "main" ? "（取文根=" + r.取文根 + "，非 main）" : "");
        console.log("  " + flag + " " + r.id.padEnd(30) + " 命中 " + n + "  (" + detail + ")");
        for (const h of r.hits)
            console.log("        [" + h.shape + "] x" + h.count + " -> " + h.samples.join(" | "));
    }
    const errors = results.filter((r) => r.status === "error").length;
    if (portalFindings)
        console.log(
            "[copy-leak] portal 轴命中 " +
                portalFindings +
                " 条：**未计入 findings**（新覆盖不等于新泄露，先按子树身份分类；要判红加 --portals-enforce）",
        );
    if (args.portalsEnforce) findings += portalFindings;
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
