#!/usr/bin/env node
// T-2318: `packages/ui/e2e/real/` 每 spec 必须能回答「属于哪条车道」。
//
// 背景：real 车道选择 = `playwright.config.ts:127` 的 `grep: /@host/`（host profile）与
// `grepInvert: /@host/`（compose profile，**车道已冻结 2026-10-07**）。一个既没有 profile 标记
// （@host 写在 test/describe 标题里）也没有 lane 注释的 spec，host 车道 0 命中、compose 车道已死，
// 只剩 profile=all 直跑可达 —— 2026-11-16 实测 137 个 real spec 里 18 个处于这个孤儿态
// （含 task-79 改过 3 处 A 类断言的 auth-flows），见
// `internal/A03-xihe/evidence/2026-11-16-host-spec-lane/classification.md`。
// 本门把「第 19 个孤儿」从静默缺口变成红灯。
//
// 判据（每文件满足其一）：
//   1. **标记**：某行同时是 test/test.describe 调用行且含 profile 标记
//      `@host | @mock | @compose | @real | @visual | @headed`；
//   2. **lane 注释**：某行 `// lane:` 或 `// lane：`（全角冒号也认）。
//
// 防「自证通过」：标记词出现在**注释里不算数** —— lane 注释本身会解释「为什么没有 @host」，
// 若把注释文本也当标记，删掉真标记后门照样绿。块注释整段覆盖的行（词法用
// check-e2e-block-comments.mjs 的 lex()，task-66 已审）与行首 `//` 行都不作标记判据。
// 已知残余盲区（记录不修）：行中缀块注释（`code; /* @host */`）里的标记词会计入 ——
// 构造这种行来骗门比直接写对标记更费力，且真实树腿（单测里对 e2e/real 全量跑）兜底。
//
// 跑法：mise run lint:e2e（= run-e2e-static-gates.mjs 聚合，本门已登记 GATES 表）
//       node scripts/check-e2e-spec-lane.mjs
//       排障：node scripts/check-e2e-spec-lane.mjs --dir <某个目录>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lex } from "./check-e2e-block-comments.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_DIR = path.join(ROOT, "packages/ui/e2e/real");

const PROFILE_MARKER = /@(?:host|mock|compose|real|visual|headed)\b/;
// test( / test.describe( / test.describe.serial( …… 成员链不限段（real 车道 7 个 spec 用
// test.describe.serial("@host …")，首版正则只认一段 ⇒ 假违规 7 个，真实树腿当场拦下）。
const TEST_CALL = /\btest(?:\s*\.\s*\w+)*\s*\(/;
const LANE_COMMENT = /^\/\/\s*lane[:：]/;

/**
 * 纯函数：一段 spec 源码 ⇒ { marker, lane }。
 *
 * - `marker`：存在「test/test.describe 调用行 + profile 标记」同行命中（标题形态，
 *   与 Playwright grep 实际匹配的标题同源；先例 auth-lockout.spec.ts:14 describe 级、
 *   ui-health.spec.ts:112 逐测试级）。
 * - `lane`：存在行首 `// lane:` 注释。
 */
export function classifySpec(text) {
    const { comments } = lex(text);
    let marker = false;
    let lane = false;
    let offset = 0;
    for (const line of text.split("\n")) {
        const start = offset;
        offset += line.length + 1;
        // 块注释整行覆盖 ⇒ 叙述文本，不作标记判据（防注释里提 marker 自证通过）。
        if (comments.some((c) => start >= c.start && start < c.end)) continue;
        const trimmed = line.trim();
        if (LANE_COMMENT.test(trimmed)) {
            lane = true;
            continue;
        }
        if (trimmed.startsWith("//")) continue;
        if (TEST_CALL.test(line) && PROFILE_MARKER.test(line)) marker = true;
    }
    return { marker, lane };
}

function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith(".spec.ts")) out.push(full);
    }
    return out;
}

export function scanDir(dir) {
    const files = walk(dir).sort();
    const violations = [];
    let markerCount = 0;
    let laneCount = 0;
    for (const file of files) {
        const { marker, lane } = classifySpec(fs.readFileSync(file, "utf8"));
        if (marker) markerCount += 1;
        if (lane) laneCount += 1;
        if (!marker && !lane) violations.push(file);
    }
    return { files, violations, markerCount, laneCount };
}

function main(argv) {
    const dirFlag = argv.indexOf("--dir");
    const target = dirFlag >= 0 ? path.resolve(argv[dirFlag + 1]) : DEFAULT_DIR;
    if (!fs.existsSync(target)) {
        console.error(`[spec-lane] ENV: 目录不存在 ${target}`);
        return 2;
    }
    const { files, violations, markerCount, laneCount } = scanDir(target);
    if (files.length === 0) {
        console.error(`[spec-lane] ENV: 目录里没有任何 *.spec.ts（车道消失？）${target}`);
        return 2;
    }
    const ok = files.length - violations.length;
    console.log(
        `[spec-lane] ${path.resolve(target)}: ${files.length} 个 spec，` +
            `标记=${markerCount} lane注释=${laneCount} 通过=${ok} 违规=${violations.length}`,
    );
    for (const file of violations) {
        console.error(
            `[spec-lane] FAIL ${path.relative(process.cwd(), file)}: ` +
                "既没有 profile 标记（test/describe 标题里的 @host 等），也没有 \"// lane:\" 注释 " +
                "⇒ host/compose 车道都无法说明它的归属（T-2318）",
        );
    }
    return violations.length > 0 ? 1 : 0;
}

// 单测会 import 本文件的纯函数 —— 只有「直接执行本文件」时才跑 CLI（task-66 同款守卫）。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exit(main(process.argv.slice(2)));
}
