import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    cacheState,
    classifyDist,
    classifyDistFromTexts,
    decide,
    distState,
    readPatchWiring,
    scanTabBranches,
    selftest,
    VERDICT,
} from "./check-reka-select-tab-patch.mjs";

const UI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(UI_ROOT, "node_modules", "reka-ui", "dist");
/**
 * 只把「路径不存在」当作未安装依赖。
 * 早先这里是个裸 catch，把 `readdirSync` 未导入造成的 ReferenceError 吞成「未安装依赖」，
 * 于是三条真实盘用例静默跳过、读数看着像「14 pass」——catch-all 掩盖真错误的活案例。
 */
const depsMissing = () => {
    if (!existsSync(DIST)) return "dist 目录不存在";
    if (readdirSync(DIST).length === 0) return "dist 目录为空";
    return false;
};

/* ---------- 纯函数：落点识别 ---------- */

test("① v2 未打补丁的「无条件吞掉」被认成 SWALLOW", () => {
    const text =
        'function handleKeyDown(event) {\n  if (event.key === "Tab") event.preventDefault();\n}';
    const found = scanTabBranches(text);
    assert.equal(found.length, 1, "应识别到 1 个 Tab 分支");
    assert.equal(found[0].kind, "SWALLOW");
});

test("② 我们的 patch 被认成 ADVANCE（关层 + 前移）", () => {
    const text = `function handleKeyDown(event) {
  const isModifierKey = event.ctrlKey || event.altKey || event.metaKey;
  if (event.key === "Tab" && !isModifierKey) {
    event.preventDefault();
    if (!event.shiftKey) tabFocusOut();
    onOpenChange(false);
    return;
  }
}`;
    const found = scanTabBranches(text);
    assert.equal(found[0].kind, "ADVANCE");
});

test("③ 上游 v3（useSelect 落点）的「关层 + focus-outside」被认成 ADVANCE", () => {
    const text = `function onKeydown(event) {
  const isModifierKey = event.ctrlKey || event.altKey || event.metaKey;
  if (event.key === "Tab" && !isModifierKey) {
    event.preventDefault();
    if (context.onOpenChange(false, "focus-outside", event)) focusOut(event.shiftKey);
    return;
  }
}`;
    assert.equal(scanTabBranches(text)[0].kind, "ADVANCE");
});

test("④ FocusScope 的 modal Tab 循环不被误算成 Select 分支", () => {
    const text =
        'function onKeyDown(event) {\n  if (event.key === "Tab" && rootContext.modal.value) event.preventDefault();\n}';
    assert.equal(scanTabBranches(text)[0].kind, "OTHER");
    assert.equal(distState(classifyDistFromTexts({ "a.js": text })), "NO_TAB_HANDLER");
});

test("⑤ 单语句无花括号的 if 体也能取到（上游产物常见形态）", () => {
    const text = 'if (event.key === "Tab") event.preventDefault();';
    const found = scanTabBranches(text);
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, "SWALLOW");
});

test("⑥ 落点整体消失 ⇒ NO_TAB_HANDLER（不许静默当成已修）", () => {
    assert.equal(distState(classifyDistFromTexts({})), "NO_TAB_HANDLER");
});

/* ---------- decide()：四象限 + 两条不可判定 ---------- */

const swallowDist = () =>
    classifyDistFromTexts({
        "Select/SelectContentImpl.js": 'if (event.key === "Tab") event.preventDefault();',
    });
const fixedDist = () =>
    classifyDistFromTexts({
        "Select/SelectContentImpl.js":
            'if (event.key === "Tab" && !m) { event.preventDefault(); tabFocusOut(); onOpenChange(false); }',
    });

test("⑦ 本地修 + 上游吞 ⇒ PATCH_REQUIRED（这一幕绝不能判退役）", () => {
    const r = decide({
        dist: fixedDist(),
        cache: { state: "fixed" },
        version: "2.11.0",
        wiring: { declared: "2.11.0" },
        upstream: { state: "SWALLOW" },
    });
    assert.equal(r.verdict, VERDICT.REQUIRED);
});

test("⑧ 本地修 + 上游也修 ⇒ PATCH_OBSOLETE 且带版本号", () => {
    const r = decide({
        dist: fixedDist(),
        cache: { state: "fixed" },
        version: "3.1.0",
        wiring: { declared: "2.11.0" },
        upstream: { state: "FIXED" },
    });
    assert.equal(r.verdict, VERDICT.OBSOLETE);
    assert.equal(r.version, "3.1.0");
});

test("⑨ 离线看到「已修」只能判 EFFECT_INSTALLED，不许判退役（防假绿核心）", () => {
    const r = decide({
        dist: fixedDist(),
        cache: { state: "fixed" },
        version: "2.11.0",
        wiring: { declared: "2.11.0" },
    });
    assert.equal(r.verdict, VERDICT.EFFECT_INSTALLED);
    assert.match(r.reason, /--upstream/);
});

test("⑩ 声明了 patch 但 dist 仍吞 ⇒ NOT_APPLIED 而非 REQUIRED", () => {
    const r = decide({
        dist: swallowDist(),
        cache: { state: "swallow" },
        version: "2.11.0",
        wiring: { declared: "2.11.0" },
        upstream: { state: "SWALLOW" },
    });
    assert.equal(r.verdict, VERDICT.NOT_APPLIED);
});

test("⑪ dist 与预打包副本不一致 ⇒ 拒绝给结论（E1/E3 根因）", () => {
    const r = decide({
        dist: fixedDist(),
        cache: { state: "swallow" },
        version: "2.11.0",
        wiring: { declared: "2.11.0" },
    });
    assert.equal(r.verdict, VERDICT.INCONCLUSIVE_CACHE);
});

test("⑫ 缓存缺失不阻断（干净检出可判文本语义）", () => {
    const r = decide({
        dist: swallowDist(),
        cache: { state: "missing" },
        version: "2.11.0",
        wiring: { declared: null },
    });
    assert.equal(r.verdict, VERDICT.REQUIRED);
});

/* ---------- 真实盘（无依赖时跳过，不造假绿） ---------- */

test("⑬ 真实 dist 若可读：文本语义与 lock 声明自洽", { skip: depsMissing() }, () => {
    const wiring = readPatchWiring(UI_ROOT);
    assert.ok(wiring.patchExists, `声明的 patch 文件必须存在：${wiring.patchFile}`);
    assert.equal(wiring.lockVersion, "2.11.0");
    assert.match(wiring.lockHash ?? "", /^[0-9a-f]{64}$/, "lock 必须带 64 位 patch_hash");
    const dist = classifyDist(DIST);
    assert.equal(distState(dist), "FIXED", "当前树应是 patch 生效状态");
});

test("⑭ 预打包副本读取：缺文件时报 missing 而非报错", () => {
    const r = cacheState(path.join(UI_ROOT, "node_modules", ".vite", "deps", "__not_here__.js"));
    assert.equal(r.state, "missing");
});

/* ---------- CLI 契约 ---------- */

test("⑮ --selftest 走 CLI 退出 0 且输出 13 例", () => {
    const r = spawnSync(
        process.execPath,
        ["scripts/check-reka-select-tab-patch.mjs", "--selftest"],
        { cwd: UI_ROOT, encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /selftest 13\/13/);
    assert.ok(selftest() === true);
});

test("⑯ --expect 与实测结论相反时退出 1（不许静默通过）", { skip: depsMissing() }, () => {
    // 不传 --purge-cache：那会真删依赖缓存，而本例只验「结论与期望相反 ⇒ 退出 1」
    const r = spawnSync(
        process.execPath,
        ["scripts/check-reka-select-tab-patch.mjs", "--expect", "obsolete"],
        { cwd: UI_ROOT, encoding: "utf8" },
    );
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /与 --expect obsolete 相反/);
});

test("⑰ 缓存与 dist 冲突时 CLI 退出 2 并点名 --purge-cache", { skip: depsMissing() }, () => {
    const dir = path.join(UI_ROOT, "node_modules", ".vite", "deps");
    const file = path.join(dir, "reka-ui.js");
    const backup = existsSync(file) ? readFileSync(file, "utf8") : null;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, 'if (event.key === "Tab") event.preventDefault();', "utf8");
    try {
        const r = spawnSync(process.execPath, ["scripts/check-reka-select-tab-patch.mjs"], {
            cwd: UI_ROOT,
            encoding: "utf8",
        });
        assert.equal(r.status, 2, `stdout=${r.stdout}\nstderr=${r.stderr}`);
        assert.match(r.stdout, /INCONCLUSIVE_CACHE_STALE/);
        assert.match(r.stderr, /--purge-cache/);
    } finally {
        if (backup === null) rmSync(file, { force: true });
        else writeFileSync(file, backup, "utf8");
    }
});
