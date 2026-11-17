#!/usr/bin/env node
/**
 * 对话框形态静态扫描（task-120 候选 (b)，Lead 2026-11-18 批落地；report-only 纯打印不接 ratchet）。
 *
 * ⚠️ 第一行输出即强制警示：本门只判形态，证明不了可达性。内容真实高度 / fixed 边界 / 权限门都看不到；
 * 主操作可达性由 dialog-reachability-sweep.mjs（候选 (a)，真判据）判。本门是给它减负的路障，不是替代。
 *
 * 规则（task-173 变体 D 已证伪「max-h 单独够」，故 R1 必须 overflow-y-auto|scroll）：
 *  - R1 每个 DialogContent / AlertDialogContent / SheetContent / DrawerContent 内容面板必须自带
 *    overflow-y-auto|overflow-y-scroll（或内部有明确滚动区 —— 静态判不出，标 WARN 人工确认）。
 *  - R2 有 max-h-* 时值必须视口相对（vh/dvh/calc(100vh…)），不得固定 px。
 *  - R3 overflow-hidden 只在「内部另有滚动区」结构里放行（CommandDialog / ProviderHub picker 正例）⇒ WARN。
 *  - 动态 :class 拼接覆盖不全（task-119 同边界）⇒ 站点行标 dynamic，结论降级为「无法判定」。
 *
 * 覆盖边界（脚本自己在输出里打印，防空心绿 D-1804）：
 *  - 只扫 vendor 四类标签 + BaseModal 面板；自定义 fixed modal（如 ProviderHub 删除确认）不经标签命中，
 *    需靠 (a) 门实测兜住。
 *  - mock 数据量决定不了真实内容高度；形态 FAIL ⇒ 一定可疑，形态 PASS ⇏ 可达。
 *
 * 退出码：恒 0（report-only）。加 --enforce 时存在 FAIL 则 1（暂不启用，连续两窗 findings=0 再议）。
 * 用法：node scripts/check-dialog-shape.mjs [--enforce]   // cwd 任意，脚本自定位 packages/ui 根
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ENFORCE = process.argv.includes("--enforce");
const TAGS = ["DialogContent", "AlertDialogContent", "SheetContent", "DrawerContent"];
// task-198：删 TAG_RE 死代码——实际扫描用下方局部 re（[\s\S]*? 多行版）；TAGS 仍被 re 复用。

console.log(
    "形态 only 证明不了可达性 —— 本门只拦形态，不判主操作可达；可达性由 dialog-reachability-sweep 判（D-1721）。",
);

// task-201 方案A（Lead 批）：tracked∪未跟踪未忽略 ⇒ 新组件提交前即进形态门视野；干净树 --others 为空 ⇒ 行为不变。
function gitSrcFiles(args) {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
        .split(/\r?\n/)
        .filter(Boolean);
}
const UNTRACKED = new Set(gitSrcFiles(["ls-files", "--others", "--exclude-standard", "--", "src"]));
function listVueFiles() {
    const out = gitSrcFiles([
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        "src",
    ]);
    // 只排除四个 vendor 原语包装本体（内容 overflow 是调用方责任；同 task-173 inventory 口径）；
    // ui/ 下其它组合件（CommandDialog 等）仍是使用点，要计入。
    const PRIMITIVE =
        /src\/components\/ui\/(dialog\/(DialogContent|DialogScrollContent)|alert-dialog\/AlertDialogContent|sheet\/SheetContent|drawer\/DrawerContent)\.vue$/;
    return out.filter(
        (p) =>
            p.endsWith(".vue") &&
            !p.includes("__tests__") &&
            !p.includes("/preview/") &&
            !PRIMITIVE.test(p),
    );
}

function* tagSites(file) {
    const src = readFileSync(join(ROOT, file), "utf8");
    // 多行标签：从 <Tag 读到 >；排除 v-bind=“{ …$attrs }” 透传包装（同 inventory.mjs 口径）。
    const re = new RegExp("<(" + TAGS.join("|") + ")[\\s\\S]*?>", "g");
    let m;
    while ((m = re.exec(src)) !== null) {
        const tag = m[0];
        if (tag.includes("$attrs")) continue;
        const line = src.slice(0, m.index).split("\n").length;
        const cls = /class="([^"]*)"/.exec(tag);
        const dcls = /:class=/.test(tag);
        yield {
            file,
            line,
            tag: m[1],
            cls: cls ? cls[1] : "",
            dynamic: dcls,
            untracked: UNTRACKED.has(file),
        };
    }
}

function classify(site) {
    const c = site.cls;
    const hasOy = /overflow-y-(auto|scroll)/.test(c);
    const hasMaxH = /max-h-/.test(c);
    const maxHFixed = /max-h-\[\d+(\.\d+)?px\]/.test(c);
    const hasHidden = /overflow-hidden/.test(c);
    if (site.dynamic) return { v: "UNSURE", why: "动态 :class，静态覆盖不全" };
    if (hasOy) return { v: "PASS", why: "自带 overflow-y-auto|scroll" };
    if (hasHidden) return { v: "WARN", why: "overflow-hidden（R3：须确认内部另有滚动区）" };
    if (maxHFixed)
        return { v: "FAIL", why: "max-h 固定 px（R2：必须视口相对）且无 overflow-y（R1）" };
    if (hasMaxH)
        return {
            v: "FAIL",
            why: "max-h-only（task-173 变体 D：内容溢出盒子不可达）且无 overflow-y（R1）",
        };
    return { v: "FAIL", why: "裸面板：无 max-h 无 overflow-y（臂 A 形态）" };
}

const sites = [];
for (const f of listVueFiles()) for (const s of tagSites(f)) sites.push(s);

const groups = { PASS: [], WARN: [], FAIL: [], UNSURE: [] };
for (const s of sites) {
    const r = classify(s);
    groups[r.v].push({ ...s, why: r.why });
}

for (const v of ["FAIL", "WARN", "UNSURE", "PASS"]) {
    console.log("");
    console.log("== " + v + " (" + groups[v].length + ") ==");
    for (const s of groups[v].slice(0, 80))
        console.log(
            "  " +
                s.file +
                ":" +
                s.line +
                " [" +
                s.tag +
                "] " +
                s.why +
                (s.untracked ? " [untracked]" : ""),
        );
    if (groups[v].length > 80) console.log("  … 共 " + groups[v].length + " 处，截断显示");
}

// BaseModal 面板定向检（不在 vendor 标签内）。
try {
    const bm = readFileSync(join(ROOT, "src/components/shared/BaseModal.vue"), "utf8");
    const ok = /max-h-\[[^\]]*vh[^\]]*\]/.test(bm) && /overflow-y-auto/.test(bm);
    console.log("");
    console.log(
        "== BaseModal 面板定向检 == " +
            (ok ? "PASS（max-h vh + overflow-y-auto 在案）" : "FAIL（约束缺失）"),
    );
} catch {
    console.log("BaseModal.vue 未找到，跳过定向检");
}

console.log("");
console.log(
    "边界重申：自定义 fixed modal 不经标签命中（需 (a) 门实测）；形态 PASS ⇏ 可达；mock 数据量 ≠ 真实内容高度。",
);
const untrackedSites = sites.filter((s) => s.untracked).length;
if (untrackedSites > 0)
    console.log(
        "含 untracked 未提交面板站点 " + untrackedSites + " 处（提交前可见，行尾 [untracked] 标）",
    );
console.log(
    "summary: total=" +
        sites.length +
        " FAIL=" +
        groups.FAIL.length +
        " WARN=" +
        groups.WARN.length +
        " UNSURE=" +
        groups.UNSURE.length +
        " PASS=" +
        groups.PASS.length +
        " (report-only)",
);

if (ENFORCE && groups.FAIL.length > 0) process.exit(1);
process.exit(0);
