/**
 * check-mock-domains.mjs — task-127 对账脚本：「schema 键 ⊆ 稿渲染键」逐域核验。
 *
 * 判据（Lead 裁定）：每个出现在设置区层矩阵里的 schema 域，CP config-schemas 的每个键
 * 都必须以 `data-mock-field="{domain}:{key}"` 渲染在单页稿上；enum 字段的选中值必须 ∈ options；
 * 页面不得出现「值缺失」哨兵。api-request-templates 无 schema（专用面板），按行数 ≥1 核验。
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
                return sel
                    ? { id: el.getAttribute("data-mock-field"), selected: sel.textContent.trim() }
                    : null;
            })
            .filter(Boolean);
        const domains = [...document.querySelectorAll("[data-mock-domain]")].map((el) =>
            el.getAttribute("data-mock-domain"),
        );
        return { rendered: [...rendered], missingMarkers, enums, domains };
    });

    let failures = 0;
    const table = [];
    for (const [layer, domains] of [
        ["instance", INSTANCE_DOMAINS],
        ["user", USER_DOMAINS],
    ]) {
        for (const domain of domains) {
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
