/**
 * DEPRECATED(task-137-rev2)：D-914 ① 交付改为「真产品页面 + 网络层 mock」，本文件属更早的「静态设计稿单页」路线，已不再渲染也不再产出交付图；**保留不删**（Lead 口径：零删除，退役由 PLAN-0764 M1 合并时统一处理）。指标：task-137 rev2 的真实入口是 preview-real.html + src/preview/mock/api-server.ts。
 */
/**
 * check-mock-domains.mjs — task-127 对账脚本：「schema 键 ⊆ 稿渲染键」逐域核验。
 *
 * 判据（Lead 裁定）：每个出现在设置区层矩阵里的 schema 域，CP config-schemas 的每个键
 * 都必须以 `data-mock-field="{domain}:{key}"` 渲染在单页稿上；enum 字段的选中值必须 ∈ options；
 * 页面不得出现「值缺失」哨兵。api-request-templates 无 schema（专用面板），按行数 ≥1 核验。
 * task-137：另断言**无未译字段** —— 每个渲染字段的 label 必含中文字符（词典 100% 覆盖的机器判据）。
 *
 * Usage（packages/ui 下）：node scripts/check-mock-domains.mjs [--url http://127.0.0.1:12630]
 * 依赖一个活着的 mock 服务（默认 12630；探不通 exit 2）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const urlArg = process.argv[process.argv.indexOf("--url") + 1];
const base = urlArg && urlArg.startsWith("http") ? urlArg : "http://127.0.0.1:12630";

function loadCatalog() {
    const s = readFileSync(path.join(uiRoot, "src/preview/mock/data/schema-catalog.ts"), "utf8");
    const marker = "const CATALOG_JSON = ";
    const i = s.indexOf(marker) + marker.length + 1;
    const j = s.indexOf(" as const", i) - 1;
    return JSON.parse(s.slice(i, j));
}

// 与产品同一份层矩阵（stores/config 是 CP 白名单镜像）。
const INSTANCE_DOMAINS = [
    "llm-provider",
    "context-policy",
    "embedding",
    "rag",
    "agent-runtime",
    "agent-profile",
    "user-preference",
    "logging",
    "approval-policy",
    "agent-templates",
    "api-request-templates",
    "job-policy",
];
const USER_DOMAINS = [
    "llm-provider",
    "context-policy",
    "embedding",
    "rag",
    "agent-runtime",
    "agent-profile",
    "user-preference",
    "agent-templates",
    "api-request-templates",
];

const catalog = loadCatalog();
const browser = await chromium.launch({ channel: "chrome-beta", headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    const res = await page
        .goto(base + "/preview-mock.html", { waitUntil: "networkidle", timeout: 15000 })
        .catch(() => null);
    if (!res || !res.ok()) {
        console.error("[check-mock-domains] mock 服务探不通：" + base + "（exit 2）");
        process.exit(2);
    }
    const dom = await page.evaluate(() => {
        const rendered = new Set(
            [...document.querySelectorAll("[data-mock-field]")].map((el) =>
                el.getAttribute("data-mock-field"),
            ),
        );
        const missingMarkers = [...document.querySelectorAll("[data-mock-field]")].filter((el) =>
            el.textContent.includes("值缺失"),
        ).length;
        const enums = [...document.querySelectorAll("[data-mock-field]")]
            .map((el) => {
                const sel = el.querySelector(".inline-flex .bg-accent");
                // task-137：选中项显示中文标签 ⇒ 读原始值（data-mock-option），不读可见文本。
                return sel
                    ? {
                          id: el.getAttribute("data-mock-field"),
                          selected: (sel.getAttribute("data-mock-option") ?? "").trim(),
                      }
                    : null;
            })
            .filter(Boolean);
        const domains = [...document.querySelectorAll("[data-mock-domain]")].map((el) =>
            el.getAttribute("data-mock-domain"),
        );
        const labels = [...document.querySelectorAll("[data-mock-field]")].map((el) => ({
            id: el.getAttribute("data-mock-field"),
            label: (el.querySelector("[data-mock-label]")?.textContent ?? "").trim(),
        }));
        return { rendered: [...rendered], missingMarkers, enums, domains, labels };
    });

    let failures = 0;
    const table = [];
    for (const [layer, domains] of [
        ["instance", INSTANCE_DOMAINS],
        ["user", USER_DOMAINS],
    ]) {
        for (const domain of domains) {
            // D-911：用户层只有展开示例域渲染字段（其余域在下方折叠行断言里核）。
            if (layer === "user" && domain !== "user-preference") continue;
            const fields = catalog[domain] ?? [];
            const renderedKeys = new Set(
                [...dom.rendered]
                    .filter((id) => id.startsWith(domain + ":"))
                    .map((id) => id.split(":").slice(1).join(":")),
            );
            const missing = fields.filter((f) => !renderedKeys.has(f.key));
            const status = missing.length === 0 ? "OK " : "MISS";
            if (missing.length) failures++;
            table.push(
                `  [${status}] ${layer}/${domain}: schema ${fields.length} 键, 渲染 ${renderedKeys.size}, 缺 [${missing.map((m) => m.key).join(", ")}]`,
            );
            // enum 选中值 ∈ options
            for (const f of fields) {
                if (f.type !== "enum" || !f.options) continue;
                const hit = dom.enums.find((e) => e.id === `${domain}:${f.key}`);
                if (!hit) {
                    failures++;
                    table.push(`  [MISS] enum 未渲染选中态: ${domain}:${f.key}`);
                } else if (!f.options.includes(hit.selected)) {
                    failures++;
                    table.push(
                        `  [BAD ] enum 选中值 ∉ options: ${domain}:${f.key} = "${hit.selected}" ∉ [${f.options.join(", ")}]`,
                    );
                }
            }
        }
    }
    // D-911：用户层默认折叠 —— 只有展开示例域做「schema 键 ⊆ 渲染键」，其余域要求「折叠行存在」。
    const USER_EXPANDED_DOMAINS = ["user-preference"];
    for (const domain of USER_DOMAINS) {
        if (!dom.domains.includes(domain)) {
            failures++;
            table.push(`  [MISS] user/${domain}: 折叠行未渲染（D-911 要求 9 域都有折叠行）`);
            continue;
        }
        if (USER_EXPANDED_DOMAINS.includes(domain)) continue;
        const fields = catalog[domain] ?? [];
        table.push(`  [OK ] user/${domain}: 折叠行（可覆盖 ${fields.length} 项，展开态为示例域）`);
    }

    const CJK = /[\u4e00-\u9fff]/;
    const untranslated = dom.labels.filter(
        (item) => !CJK.test(item.label) || item.label === item.id.split(":").slice(1).join(":"),
    );
    if (untranslated.length > 0) {
        failures += untranslated.length;
        table.push(
            `  [BAD ] 未译字段 ${untranslated.length} 个: ${untranslated
                .map((item) => item.id + '="' + item.label + '"')
                .join(", ")}`,
        );
    }
    if (!dom.domains.includes("api-request-templates") || dom.missingMarkers > 0) {
        failures++;
        table.push(
            `  [BAD ] api-request-templates 未渲染 或 存在 ${dom.missingMarkers} 个值缺失哨兵`,
        );
    }
    console.log("[check-mock-domains] 逐域对账（schema 键 ⊆ 渲染键）:");
    console.log(table.join("\n"));
    console.log(`[check-mock-domains] 结论: ${failures === 0 ? "PASS" : "FAIL(" + failures + ")"}`);
    process.exit(failures === 0 ? 0 : 1);
} finally {
    await browser.close();
}
