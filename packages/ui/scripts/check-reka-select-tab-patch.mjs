#!/usr/bin/env node
/**
 * check-reka-select-tab-patch.mjs — reka-ui Select「Tab 关层并前移焦点」patch 的退役判据门
 * （task-1040；上游 PR unovue/reka-ui#3168 合入 v3 但未发版）。
 *
 * 为什么要有这门（判据级理由，不是「多个检查」）：
 *   `patches/reka-ui@2.11.0.patch` 是打在**已构建产物**上的 92 行补丁（dist/Select/
 *   SelectContentImpl.js|.cjs 各 2 hunk），上游 2.11.0 里 `if (event.key === "Tab")
 *   event.preventDefault();` 把 Tab 无条件吞掉 ⇒ 键盘用户离不开弹层。上游已在
 *   PR #3168 改成「Tab 关层 + 非 Shift 前移焦点」，但 **没有任何已发布版本包含它**
 *   （2.11.0 发布于 2026-10-05，alpha 3.0.0-alpha.0 发布于 2026-11-05 08:35，
 *   PR 合并于 2026-11-06 12:44 ⇒ 时序上必然早于合并）。所以 patch 现在**必须留着**。
 *
 *   退役是「上游发布了等价行为」才发生的动作，不是「patch 看着多余」。本门把这条
 *   判据机器化，避免靠人记「等发版再看看」——那是纯文档维护，用户明确否决过。
 *
 * 本门只读回答三件事：
 *   ① 安装树里 reka-ui 的实际版本 + patch_hash（lock 与 workspace 声明各取一处）
 *   ② dist 里 Tab 分支是「无条件吞掉」还是「关层并前移」
 *      —— 必须同时识别 v2 落点（dist/Select/SelectContentImpl）与 v3 落点
 *      （dist/Select/useSelect，上游把处理搬了文件），靠平衡括号解析 if 体，不靠行号
 *   ③ 结论 PATCH_REQUIRED / PATCH_OBSOLETE（后者附版本号）
 *
 * 缓存红线（E1/E3 教训，写进行为而不是文档提醒）：
 *   `.vite/deps/reka-ui.js`（1.55 MB 预打包副本）是**第二个代码来源**，可与 dist 各自
 *   独立过期：缓存旧而 dist 新 ⇒ 行为验证假红（E3）；两者都旧 ⇒ 假绿（E1）。因此本门
 *   在 dist=FIXED 时**要求**预打包副本同样含修复标记，否则**拒绝给结论**（exit 2，
 *   verdict=INCONCLUSIVE_CACHE_STALE），并提示 `--purge-cache`。不静默删缓存：删它会让
 *   正在跑的 dev server 重新优化依赖，这是有副作用的行为，必须由调用者显式触发。
 *
 * 为什么不进 `pnpm run lint` 链（诚实说明，不假装已接线）：
 *   它读的是 `node_modules/` 与上游 registry 的事实，不是本仓源码。
 *   · 干净检出/CI 没有 node_modules ⇒ 只能 NOT_EVALUATED，接进 lint 只会造假绿噪声；
 *   · 它的红表示「上游发版了该退役了」，不是本仓缺陷，不该阻断无关改动；
 *   · 正确触发点是依赖升级卡与定期巡检（`--registry`），不是每次 lint。
 *   因此本门作为独立可执行件交付，由升级卡/巡检调用；接入点写进 docs 的退役清单。
 *
 * 用法：
 *   node scripts/check-reka-select-tab-patch.mjs                  # 本地结论文（只读）
 *   node scripts/check-reka-select-tab-patch.mjs --json           # 机读输出
 *   node scripts/check-reka-select-tab-patch.mjs --purge-cache    # 先删 .vite 预打包副本再判定
 *   node scripts/check-reka-select-tab-patch.mjs --expect required # 断言「patch 仍必需」
 *   node scripts/check-reka-select-tab-patch.mjs --registry       # 查已发布版本是否含修复
 *   node scripts/check-reka-select-tab-patch.mjs --upstream       # 拉同版本上游 tarball 做退役对照
 *   node scripts/check-reka-select-tab-patch.mjs --registry --tmp-dir H:/zeotmp/task1040/probe
 *   node scripts/check-reka-select-tab-patch.mjs --selftest       # 内存夹具，不碰 node_modules
 *
 * 退出码：0 = 结论已定（且满足 --expect）；1 = 结论与 --expect 相反；2 = 用法/环境/结论不可定。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const EXIT = { OK: 0, CONTRADICT: 1, BAD_INPUT: 2 };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_UI_ROOT = path.resolve(HERE, "..");

export const VERDICT = Object.freeze({
    REQUIRED: "PATCH_REQUIRED",
    OBSOLETE: "PATCH_OBSOLETE",
    EFFECT_INSTALLED: "PATCH_EFFECT_INSTALLED",
    NOT_APPLIED: "PATCH_DECLARED_NOT_APPLIED",
    INCONCLUSIVE_CACHE: "INCONCLUSIVE_CACHE_STALE",
    INCONCLUSIVE_STATE: "INCONCLUSIVE_UNKNOWN_DIST",
});

/** 修复后被上游/我们的 patch 都会写进去的标记：v2 patch 用 tabFocusedOut，v3 上游用 focus-outside。 */
const FIX_MARKERS = [/tabFocusedOut/, /focus-outside/];

/** v2 / v3 两种落点。上游把 Tab 处理从 SelectContentImpl 搬到了 useSelect（PR #3168）。 */
export const TAB_LANDING_FILES = [
    "Select/SelectContentImpl.js",
    "Select/SelectContentImpl.cjs",
    "Select/useSelect.js",
    "Select/useSelect.cjs",
];

const KEY_TAB = /(?:event|ev)\.key\s*===\s*(["'])Tab\1/g;

function lineOf(text, index) {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
    return line;
}

/** 从 if 关键字位置找到配对右括号，返回 { condStart, condEnd }（索引均指向括号本身）。 */
function findIfCondition(text, ifIndex) {
    const head = /^if\s*\(/.exec(text.slice(ifIndex, ifIndex + 16));
    if (!head) return null;
    const open = ifIndex + head[0].length - 1;
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        const ch = text[i];
        if (ch === "(") depth++;
        else if (ch === ")") {
            depth--;
            if (depth === 0) return { condStart: open, condEnd: i };
        }
    }
    return null;
}

/** 取 if 体：花括号块（平衡计数）或单条语句（到分号）。 */
export function ifBody(text, condEnd) {
    let i = condEnd + 1;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === "{") {
        let depth = 0;
        for (let j = i; j < text.length; j++) {
            if (text[j] === "{") depth++;
            else if (text[j] === "}") {
                depth--;
                if (depth === 0) return text.slice(i + 1, j);
            }
        }
        return text.slice(i + 1);
    }
    const semi = text.indexOf(";", i);
    return text.slice(i, semi === -1 ? undefined : semi + 1);
}

/**
 * 判定一个 Tab 分支：
 *   ADVANCE = 关层并前移（preventDefault + 关层（onOpenChange / focus-outside）+ focusOut 调用）
 *   SWALLOW = 无条件吞掉（体里只有 event.preventDefault()，没有任何后续）
 *   OTHER   = 别的 Tab 语义（如 FocusScope 的 modal Tab 循环），不计入 Select 判据
 */
export function classifyTabBranch(condText, bodyText) {
    const body = bodyText.replace(/\s+/g, " ").trim();
    if (!/preventDefault/.test(body)) return "OTHER";
    // FocusScope 的 modal Tab 循环也形如「单句 preventDefault」，靠条件区分，不靠文件路径。
    if (/modal/.test(condText)) return "OTHER";
    const closesLayer = /onOpenChange\(/.test(body) || /focus-outside/.test(body);
    const movesFocus = /tabFocusOut\(/.test(body) || /\bfocusOut\(/.test(body);
    if (closesLayer && movesFocus) return "ADVANCE";
    if (/^event\.preventDefault\(\);?$/i.test(body)) return "SWALLOW";
    return "OTHER";
}

/** 扫描一段源码里所有 Tab 分支。 */
export function scanTabBranches(text) {
    const out = [];
    KEY_TAB.lastIndex = 0;
    let match;
    while ((match = KEY_TAB.exec(text)) !== null) {
        const ifIndex = text.lastIndexOf("if", match.index);
        if (ifIndex === -1) continue;
        const cond = findIfCondition(text, ifIndex);
        if (!cond || cond.condEnd < match.index) continue;
        const condText = text.slice(cond.condStart, cond.condEnd + 1);
        const body = ifBody(text, cond.condEnd);
        out.push({
            kind: classifyTabBranch(condText, body),
            line: lineOf(text, ifIndex),
            cond: condText.replace(/\s+/g, " ").trim(),
            body: body.replace(/\s+/g, " ").trim().slice(0, 160),
        });
    }
    return out;
}

/** 对 dist 目录做落点扫描：返回 { files, fixed, swallow, handlers }。 */
export function classifyDist(distDir) {
    const files = [];
    const handlers = [];
    for (const rel of TAB_LANDING_FILES) {
        const abs = path.join(distDir, ...rel.split("/"));
        if (!existsSync(abs)) continue;
        const text = readFileSync(abs, "utf8");
        const found = scanTabBranches(text);
        files.push({ file: rel, bytes: statSync(abs).size, handlers: found.length });
        for (const f of found) handlers.push({ file: rel, ...f });
    }
    const fixed = handlers.filter((h) => h.kind === "ADVANCE").length;
    const swallow = handlers.filter((h) => h.kind === "SWALLOW").length;
    return { files, handlers, fixed, swallow };
}

/** dist 状态 → FIXED / SWALLOW / NO_TAB_HANDLER。 */
export function distState(classified) {
    if (classified.fixed > 0) return "FIXED";
    if (classified.swallow > 0) return "SWALLOW";
    return "NO_TAB_HANDLER";
}

/** 预打包副本状态：missing / fixed / swallow（用修复标记判，因为在 bundle 里做括号解析不可靠）。 */
export function cacheState(cacheFile) {
    if (!existsSync(cacheFile)) return { state: "missing", markers: [] };
    const text = readFileSync(cacheFile, "utf8");
    const markers = FIX_MARKERS.filter((re) => re.test(text)).map(String);
    return {
        state: markers.length > 0 ? "fixed" : "swallow",
        markers,
        bytes: statSync(cacheFile).size,
    };
}

export function readInstalledVersion(pkgRoot) {
    const pj = path.join(pkgRoot, "package.json");
    if (!existsSync(pj)) return null;
    try {
        return JSON.parse(readFileSync(pj, "utf8")).version ?? null;
    } catch {
        return null;
    }
}

/** lock 里 reka-ui 的 patch_hash；workspace yaml 里的 patchedDependencies 声明。 */
export function readPatchWiring(uiRoot) {
    const lock = path.join(uiRoot, "pnpm-lock.yaml");
    const ws = path.join(uiRoot, "pnpm-workspace.yaml");
    const out = {
        lockHash: null,
        lockVersion: null,
        declared: null,
        patchFile: null,
        patchExists: false,
    };
    if (existsSync(lock)) {
        const text = readFileSync(lock, "utf8");
        // 只有 snapshots 的解析行带 patch_hash —— patchedDependencies 段那行「命中也无 hash」，
        // 早先的正则先匹配到它，导致 patch_hash 读成空。锚到「(vue@」解析行。
        const resolved = /reka-ui@([0-9][^\s()]*)(?:\(patch_hash=([0-9a-f]{64})\))?\(vue@/.exec(
            text,
        );
        if (resolved) {
            out.lockVersion = resolved[1];
            out.lockHash = resolved[2] ?? null;
        }
    }
    if (existsSync(ws)) {
        const text = readFileSync(ws, "utf8");
        const m = /reka-ui@([0-9][^:\s]*):\s*([^\s]+)/.exec(text);
        if (m) {
            out.declared = m[1];
            out.patchFile = m[2];
            out.patchExists = existsSync(path.join(uiRoot, m[2]));
        }
    }
    return out;
}

/**
 * 汇总结论。缓存不一致 ⇒ 拒绝给结论（exit 2），宁可红也不给假绿。
 *
 * 本卡最容易被误判的一处：dist 现在是「关层前移」，但这**可能是我们自己的 patch 打上去的**，
 * 与「上游发版了」是两件事。所以离线模式只能判「patch 是否在起作用」= PATCH_EFFECT_INSTALLED，
 * 不许判退役。退役必须拿**同版本上游 tarball** 对照（`--upstream`）：
 *   上游 SWALLOW + 本地 FIXED ⇒ 是 patch 在承担修复 ⇒ PATCH_REQUIRED
 *   上游 FIXED              ⇒ 上游自带 ⇒ PATCH_OBSOLETE <版本>
 *   声明了 patch 却仍是 SWALLOW ⇒ patch 没打上 ⇒ PATCH_DECLARED_NOT_APPLIED
 * @returns {{verdict: string, version: string|null, reason: string}}
 */
export function decide({ dist, cache, version, wiring, upstream }) {
    const state = distState(dist);
    if (state === "NO_TAB_HANDLER") {
        const scanned = dist.files.map((f) => f.file).join(", ") || "无";
        return {
            verdict: VERDICT.INCONCLUSIVE_STATE,
            version,
            reason: `dist 里既没有「吞掉」也没有「关层前移」的 Tab 分支，落点可能再次搬迁（已扫 ${scanned}）`,
        };
    }
    const localInEffect = state === "FIXED" ? "fixed" : "swallow";
    if (cache && cache.state !== "missing" && cache.state !== localInEffect) {
        return {
            verdict: VERDICT.INCONCLUSIVE_CACHE,
            version,
            reason: `dist=${state} 但 .vite 预打包副本=${cache.state}：第二个代码来源与 dist 不一致，行为验证会假绿/假红（E1/E3）`,
        };
    }

    const declared = !!wiring?.declared;
    if (upstream) {
        const upstreamState = upstream.state;
        if (upstreamState === "FIXED" && state === "FIXED") {
            return {
                verdict: VERDICT.OBSOLETE,
                version,
                reason: `上游 ${version} 的 tarball 自带「关层并前移」，patch 可退役`,
            };
        }
        if (upstreamState === "SWALLOW" && state === "FIXED") {
            return {
                verdict: VERDICT.REQUIRED,
                version,
                reason: `上游 ${version} tarball 仍无条件吞 Tab，是本地 patch 在承担修复`,
            };
        }
        if (upstreamState === "SWALLOW" && state === "SWALLOW") {
            return {
                verdict: declared ? VERDICT.NOT_APPLIED : VERDICT.REQUIRED,
                version,
                reason: declared
                    ? "声明了 patch 但 dist 里看不到修复 ⇒ patch 没真正打上（E1/E3 同族）"
                    : "上游仍吞 Tab 且未声明 patch ⇒ 键盘可达性缺口",
            };
        }
        return {
            verdict: VERDICT.INCONCLUSIVE_STATE,
            version,
            reason: `上游=${upstreamState} 与本地=${state} 的组合无法解释`,
        };
    }

    if (state === "SWALLOW") {
        return {
            verdict: declared ? VERDICT.NOT_APPLIED : VERDICT.REQUIRED,
            version,
            reason: declared
                ? "声明了 patch 但 dist 仍是吞掉语义 ⇒ patch 没真正打上（E1/E3 同族）"
                : "dist 仍是「无条件吞掉」，patch 仍在承担键盘可达性",
        };
    }
    return {
        verdict: VERDICT.EFFECT_INSTALLED,
        version,
        reason: "dist 已是「关层并前移」，但离线无法区分「我们 patch 打的」与「上游自带」⇒ 退役需 --upstream 对照",
    };
}

async function fetchJson(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${url} ⇒ HTTP ${res.status}`);
    return res.json();
}

function extractTarball(tgz, destDir) {
    const r = spawnSync("tar", ["-xzf", tgz, "-C", destDir], { encoding: "utf8" });
    if (r.status !== 0) {
        throw new Error(`tar 解包失败（status=${r.status}）：${(r.stderr || "").trim()}`);
    }
}

/** 查已发布版本是否已含该修复（退役判据的机器可验形态）。 */
async function probeRegistry({ tmpDir, prerelease }) {
    const meta = await fetchJson("https://registry.npmjs.org/reka-ui");
    const tags = meta["dist-tags"] ?? {};
    const targets = new Set();
    for (const v of Object.values(tags)) {
        // 退役判据只看「已发布」：带 - 的 prerelease 默认不探、也不参与结论。
        // 早先写成 `&& name !== "alpha"`，等于把 alpha tag 放进了默认清单 ⇒ 与文档口径相反。
        if (!prerelease && /-/.test(v)) continue;
        targets.add(v);
    }
    for (const v of Object.keys(meta.versions ?? {})) if (v === tags.latest) targets.add(v);

    const rows = [];
    rmSync(tmpDir, { recursive: true, force: true });
    let cleaned = false;
    try {
        for (const version of targets) {
            const dir = path.join(tmpDir, version);
            const tgz = path.join(tmpDir, `${version}.tgz`);
            const res = await fetch(meta.versions[version].dist.tarball, {
                signal: AbortSignal.timeout(120_000),
            });
            if (!res.ok) throw new Error(`tarball HTTP ${res.status}`);
            mkdirSync(dir, { recursive: true });
            writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
            extractTarball(tgz, dir);
            const dist = path.join(dir, "package", "dist");
            const classified = classifyDist(dist);
            rows.push({
                version,
                published: meta.time?.[version] ?? null,
                prerelease: /-/.test(version),
                state: distState(classified),
                handlers: classified.handlers.map((h) => `${h.file}:${h.line} ${h.kind}`),
            });
        }
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
        cleaned = true;
    }
    const stableFixed = rows.find((r) => !r.prerelease && r.state === "FIXED");
    return { rows, stableFixed: stableFixed?.version ?? null, cleaned };
}

/** 内存夹具自检：脱仓可跑，不依赖 node_modules。 */
export function selftest() {
    const v2Swallow = `
function handleKeyDown(event) {
    const isModifierKey = event.ctrlKey || event.altKey || event.metaKey;
    if (event.key === "Tab") event.preventDefault();
    if (event.code === "Space") { return; }
}`;
    const v2Patched = `
function handleKeyDown(event) {
    const isModifierKey = event.ctrlKey || event.altKey || event.metaKey;
    if (event.key === "Tab" && !isModifierKey) {
        event.preventDefault();
        if (!event.shiftKey) tabFocusOut();
        onOpenChange(false);
        return;
    }
}`;
    const v3AlphaSwallow = `
function onKeydown(event) {
    const isModifierKey = event.ctrlKey || event.altKey || event.metaKey;
    if (event.key === "Tab") event.preventDefault();
}`;
    const v3UpstreamFixed = `
function onKeydown(event) {
    const isModifierKey = event.ctrlKey || event.altKey || event.metaKey;
    if (event.key === "Tab" && !isModifierKey) {
        event.preventDefault();
        if (context.onOpenChange(false, "focus-outside", event)) focusOut(event.shiftKey);
        return;
    }
}`;
    const focusScopeModal = `
function onKeyDown(event) {
    if (event.key === "Tab" && rootContext.modal.value) event.preventDefault();
}`;

    const cases = [
        {
            id: "v2 未打补丁 ⇒ SWALLOW",
            got: () =>
                distState(classifyDistFromTexts({ "Select/SelectContentImpl.js": v2Swallow })),
            want: "SWALLOW",
        },
        {
            id: "v2 我们的 patch ⇒ FIXED",
            got: () =>
                distState(classifyDistFromTexts({ "Select/SelectContentImpl.js": v2Patched })),
            want: "FIXED",
        },
        {
            id: "v3 alpha 落点搬迁后仍吞 ⇒ SWALLOW",
            got: () => distState(classifyDistFromTexts({ "Select/useSelect.js": v3AlphaSwallow })),
            want: "SWALLOW",
        },
        {
            id: "v3 上游 #3168 ⇒ FIXED",
            got: () => distState(classifyDistFromTexts({ "Select/useSelect.js": v3UpstreamFixed })),
            want: "FIXED",
        },
        {
            id: "FocusScope modal Tab 不算 Select 分支",
            got: () =>
                distState(
                    classifyDistFromTexts({ "Select/SelectContentImpl.js": focusScopeModal }),
                ),
            want: "NO_TAB_HANDLER",
        },
        {
            id: "落点全部消失 ⇒ 不可判定",
            got: () =>
                decide({
                    dist: classifyDistFromTexts({}),
                    cache: { state: "missing", markers: [] },
                    version: "9.9.9",
                }).verdict,
            want: VERDICT.INCONCLUSIVE_STATE,
        },
        {
            id: "dist 已修但缓存旧的 ⇒ 拒绝结论（不假绿）",
            got: () =>
                decide({
                    dist: classifyDistFromTexts({ "Select/SelectContentImpl.js": v2Patched }),
                    cache: { state: "swallow", markers: [] },
                    version: "2.11.0",
                }).verdict,
            want: VERDICT.INCONCLUSIVE_CACHE,
        },
        {
            id: "离线看到「已修」不许判退役，只能判「patch 生效中」",
            got: () =>
                decide({
                    dist: classifyDistFromTexts({ "Select/SelectContentImpl.js": v2Patched }),
                    cache: { state: "fixed", markers: ["tabFocusedOut"] },
                    version: "2.11.0",
                    wiring: { declared: "2.11.0" },
                }).verdict,
            want: VERDICT.EFFECT_INSTALLED,
        },
        {
            id: "上游 tarball 仍吞 + 本地已修 ⇒ REQUIRED（patch 在干活）",
            got: () =>
                decide({
                    dist: classifyDistFromTexts({ "Select/SelectContentImpl.js": v2Patched }),
                    cache: { state: "fixed", markers: ["tabFocusedOut"] },
                    version: "2.11.0",
                    wiring: { declared: "2.11.0" },
                    upstream: { state: "SWALLOW" },
                }).verdict,
            want: VERDICT.REQUIRED,
        },
        {
            id: "上游 tarball 已自带修复 ⇒ OBSOLETE",
            got: () =>
                decide({
                    dist: classifyDistFromTexts({ "Select/SelectContentImpl.js": v2Patched }),
                    cache: { state: "fixed", markers: ["tabFocusedOut"] },
                    version: "2.11.0",
                    wiring: { declared: "2.11.0" },
                    upstream: { state: "FIXED" },
                }).verdict,
            want: VERDICT.OBSOLETE,
        },
        {
            id: "声明了 patch 但 dist 仍吞 ⇒ 判定为没打上，不是「不需要」",
            got: () =>
                decide({
                    dist: classifyDistFromTexts({ "Select/SelectContentImpl.js": v2Swallow }),
                    cache: { state: "swallow", markers: [] },
                    version: "2.11.0",
                    wiring: { declared: "2.11.0" },
                    upstream: { state: "SWALLOW" },
                }).verdict,
            want: VERDICT.NOT_APPLIED,
        },
        {
            id: "dist 吞 + 缓存也吞 ⇒ REQUIRED",
            got: () =>
                decide({
                    dist: classifyDistFromTexts({ "Select/SelectContentImpl.js": v2Swallow }),
                    cache: { state: "swallow", markers: [] },
                    version: "2.11.0",
                }).verdict,
            want: VERDICT.REQUIRED,
        },
        {
            id: "修饰键 Tab 不算吞掉（条件带 modal 才排除）",
            got: () =>
                scanTabBranches(
                    'if (event.key === "Tab" && event.shiftKey) { doSomething(); return; }',
                )[0]?.kind ?? "none",
            want: "OTHER",
        },
    ];

    const failed = [];
    for (const c of cases) {
        let got;
        try {
            got = c.got();
        } catch (e) {
            got = `throw: ${e.message}`;
        }
        const ok = got === c.want;
        if (!ok) failed.push(c.id);
        process.stdout.write(
            `[reka-tab-patch] selftest ${ok ? "PASS" : "FAIL"} ${c.id} ⇒ ${got}\n`,
        );
    }
    process.stdout.write(
        `[reka-tab-patch] selftest ${cases.length - failed.length}/${cases.length}\n`,
    );
    return failed.length === 0;
}

/** 夹具版 classifyDist（不碰磁盘）。 */
export function classifyDistFromTexts(texts) {
    const files = [];
    const handlers = [];
    for (const [rel, text] of Object.entries(texts)) {
        const found = scanTabBranches(text);
        files.push({ file: rel, bytes: text.length, handlers: found.length });
        for (const f of found) handlers.push({ file: rel, ...f });
    }
    const fixed = handlers.filter((h) => h.kind === "ADVANCE").length;
    const swallow = handlers.filter((h) => h.kind === "SWALLOW").length;
    return { files, handlers, fixed, swallow };
}

function parseArgv(argv) {
    const opts = {
        json: argv.includes("--json"),
        selftest: argv.includes("--selftest"),
        registry: argv.includes("--registry"),
        upstream: argv.includes("--upstream"),
        purgeCache: argv.includes("--purge-cache"),
        prerelease: argv.includes("--include-prerelease"),
        expect: null,
        root: DEFAULT_UI_ROOT,
        tmpDir: path.resolve("H:/zeotmp/task1040/registry-probe"),
    };
    const idx = (f) => argv.indexOf(f);
    if (idx("--expect") !== -1) opts.expect = argv[idx("--expect") + 1] ?? "";
    if (idx("--root") !== -1) opts.root = path.resolve(argv[idx("--root") + 1] ?? "");
    if (idx("--tmp-dir") !== -1) opts.tmpDir = path.resolve(argv[idx("--tmp-dir") + 1] ?? "");
    return opts;
}

async function main() {
    const opts = parseArgv(process.argv.slice(2));
    if (opts.selftest) return selftest() ? EXIT.OK : EXIT.CONTRADICT;

    const uiRoot = opts.root;
    const pkgRoot = path.join(uiRoot, "node_modules", "reka-ui");
    const distDir = path.join(pkgRoot, "dist");
    const cacheFile = path.join(uiRoot, "node_modules", ".vite", "deps", "reka-ui.js");

    if (opts.registry) {
        try {
            const probe = await probeRegistry({ tmpDir: opts.tmpDir, prerelease: opts.prerelease });
            const verdict = probe.stableFixed
                ? `${VERDICT.OBSOLETE} ${probe.stableFixed}`
                : VERDICT.REQUIRED;
            for (const r of probe.rows) {
                process.stdout.write(
                    `${r.version}\t${r.prerelease ? "prerelease" : "published"}\t${r.published ?? "-"}\t${r.state}\t${r.handlers.join("|") || "-"}\n`,
                );
            }
            process.stdout.write(`registry-verdict: ${verdict}\n`);
            process.stdout.write(`tmp: ${probe.cleaned ? "已清理" : "未清理"}\n`);
            if (opts.json) {
                process.stdout.write(
                    `${JSON.stringify({ mode: "registry", verdict, rows: probe.rows })}\n`,
                );
            }
            return EXIT.OK;
        } catch (e) {
            process.stderr.write(`[reka-tab-patch] registry probe 失败：${e.message}\n`);
            return EXIT.BAD_INPUT;
        }
    }

    if (!existsSync(pkgRoot)) {
        process.stderr.write(`[reka-tab-patch] 找不到 ${pkgRoot}（未安装依赖？）\n`);
        return EXIT.BAD_INPUT;
    }
    if (opts.purgeCache) {
        const mapFile = `${cacheFile}.map`;
        let removed = 0;
        for (const f of [cacheFile, mapFile]) {
            if (existsSync(f)) {
                rmSync(f, { force: true });
                removed++;
                process.stdout.write(`[reka-tab-patch] 已删缓存副本 ${path.relative(uiRoot, f)}\n`);
            }
        }
        if (removed === 0) process.stdout.write("[reka-tab-patch] 缓存副本本就不存在\n");
    }

    const version = readInstalledVersion(pkgRoot);
    const wiring = readPatchWiring(uiRoot);
    const dist = classifyDist(distDir);
    const cache = cacheState(cacheFile);

    let upstream = null;
    if (opts.upstream && version) {
        try {
            const meta = await fetchJson("https://registry.npmjs.org/reka-ui");
            const dist_url = meta.versions?.[version]?.dist?.tarball;
            if (!dist_url) throw new Error(`registry 没有 ${version} 的 tarball`);
            const probeDir = path.join(opts.tmpDir, `upstream-${version}`);
            rmSync(probeDir, { recursive: true, force: true });
            const tgz = path.join(opts.tmpDir, `reka-ui-${version}.tgz`);
            const res = await fetch(dist_url, { signal: AbortSignal.timeout(120_000) });
            if (!res.ok) throw new Error(`tarball HTTP ${res.status}`);
            mkdirSync(probeDir, { recursive: true });
            writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
            extractTarball(tgz, probeDir);
            const upstreamDist = classifyDist(path.join(probeDir, "package", "dist"));
            upstream = {
                version,
                state: distState(upstreamDist),
                handlers: upstreamDist.handlers.map((h) => `${h.file}:${h.line} ${h.kind}`),
                source: dist_url,
            };
            process.stdout.write(`upstream ${version}: ${upstream.state} (${dist_url})\n`);
        } catch (e) {
            process.stderr.write(`[reka-tab-patch] upstream 对照失败：${e.message}\n`);
            return EXIT.BAD_INPUT;
        } finally {
            rmSync(path.join(opts.tmpDir, `upstream-${version}`), { recursive: true, force: true });
            rmSync(path.join(opts.tmpDir, `reka-ui-${version}.tgz`), { force: true });
            process.stdout.write(`[reka-tab-patch] upstream 临时目录已清理\n`);
        }
    }

    const result = decide({ dist, cache, version, wiring, upstream });

    const payload = {
        mode: "local",
        uiRoot,
        installed: { version, patchHash: wiring.lockHash, lockVersion: wiring.lockVersion },
        declared: {
            version: wiring.declared,
            patchFile: wiring.patchFile,
            patchExists: wiring.patchExists,
        },
        upstream,
        dist: {
            state: distState(dist),
            files: dist.files,
            handlers: dist.handlers,
        },
        cache,
        ...result,
    };

    if (opts.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
        process.stdout.write(`installed: ${version}\n`);
        process.stdout.write(`patch_hash: ${wiring.lockHash ?? "(无)"}\n`);
        process.stdout.write(
            `declared: ${wiring.declared ?? "(无)"} -> ${wiring.patchFile ?? "(无)"}\n`,
        );
        for (const f of dist.files) {
            process.stdout.write(`dist ${f.file}: ${f.bytes} B, ${f.handlers} 个 Tab 分支\n`);
        }
        for (const h of dist.handlers) {
            process.stdout.write(`  ${h.file}:${h.line} ${h.kind}  cond=${h.cond}\n`);
        }
        process.stdout.write(
            `cache: ${cache.state}${cache.markers?.length ? ` markers=${cache.markers.join(",")}` : ""}\n`,
        );
        process.stdout.write(
            `verdict: ${result.verdict}${result.version ? ` (${result.version})` : ""} — ${result.reason}\n`,
        );
    }

    if (result.verdict === VERDICT.INCONCLUSIVE_CACHE) {
        process.stderr.write(
            "[reka-tab-patch] 预打包副本与 dist 不一致 ⇒ 先 --purge-cache 再判定（E1 假绿 / E3 假红根因）\n",
        );
        return EXIT.BAD_INPUT;
    }
    if (result.verdict === VERDICT.INCONCLUSIVE_STATE) {
        process.stderr.write("[reka-tab-patch] 落点不可识别 ⇒ 需人工核对上游是否再次搬迁文件\n");
        return EXIT.BAD_INPUT;
    }
    if (opts.expect) {
        const alias = {
            required: VERDICT.REQUIRED,
            obsolete: VERDICT.OBSOLETE,
            effect: VERDICT.EFFECT_INSTALLED,
        };
        const want = alias[opts.expect] ?? opts.expect;
        if (result.verdict !== want) {
            process.stderr.write(
                `[reka-tab-patch] 结论 ${result.verdict} 与 --expect ${opts.expect} 相反\n`,
            );
            return EXIT.CONTRADICT;
        }
    }
    return EXIT.OK;
}

const invokedDirectly =
    process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    main().then(
        (code) => process.exit(code),
        (e) => {
            process.stderr.write(`[reka-tab-patch] 崩溃：${e?.stack ?? e}\n`);
            process.exit(EXIT.BAD_INPUT);
        },
    );
}

export { main };
