#!/usr/bin/env node
// task-1027：把 `src/i18n/index.ts` 里 `messages` 的两个 locale 块按 32 个顶层域切成
// `src/i18n/messages/<域>.ts`，`index.ts` 只留聚合 import 与 createI18n。
//
// 纯结构搬移：用 TypeScript 编译器 API 取每个顶层属性的源码切片（含其前导注释），
// 逐字节写入域文件 —— 键名、值、locale 名一律不改。域文件里的属性顺序与缩进保持原样。
//
// 用法：
//   node scripts/split-i18n-messages.mjs                 # 只打印计划（不落盘）
//   node scripts/split-i18n-messages.mjs --write         # 执行拆分
//   node scripts/split-i18n-messages.mjs --write --evidence <dir>
//     → 额外写 keys-before.txt / keys-after.txt / keys-diff.txt，并断言逐字节相同
//
// 可复跑：若 `index.ts` 已无域字面量（已是聚合入口），直接走「已拆分」校验，不重写文件。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const UI = fileURLToPath(new URL("..", import.meta.url));
const I18N_DIR = path.join(UI, "src", "i18n");
const INDEX_PATH = path.join(I18N_DIR, "index.ts");
const MESSAGES_DIR = path.join(I18N_DIR, "messages");

function walkKeys(node, prefix, out) {
    if (typeof node === "string") {
        if (prefix) out.push(prefix);
        return;
    }
    if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
            walkKeys(value, prefix ? `${prefix}.${key}` : key, out);
        }
    }
}

/** 拆分前的老口径（求值整个 index.ts），只用于生成 before 快照。 */
export function flattenFromIndexSource(source) {
    const body = source
        .replace(/^import[^\n]*\n/gm, "")
        .replace(/\bexport\s+(const|let|var|function|class)\b/g, "$1");
    const messages = new Function("createI18n", `${body}\nreturn i18n.global.messages;`)(
        (options) => ({ global: { messages: options.messages } }),
    );
    const keys = [];
    for (const localeMessages of Object.values(messages)) walkKeys(localeMessages, "", keys);
    return keys;
}

function propertyName(node, sourceFile) {
    return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : node.getText(sourceFile);
}

function findMessagesLiteral(sourceFile) {
    for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (
                ts.isIdentifier(declaration.name) &&
                declaration.name.text === "messages" &&
                declaration.initializer &&
                ts.isObjectLiteralExpression(declaration.initializer)
            ) {
                return declaration.initializer;
            }
        }
    }
    return null;
}

/** 解析出 { domains: string[], locales: { "zh-CN": Map<domain, text>, "en-US": ... } }。 */
function extractDomains(source) {
    const sourceFile = ts.createSourceFile(
        INDEX_PATH,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
    const literal = findMessagesLiteral(sourceFile);
    if (!literal) return null;

    const locales = {};
    for (const localeProp of literal.properties) {
        if (!ts.isPropertyAssignment(localeProp)) {
            throw new Error(`messages 下的 locale 不是属性赋值：${localeProp.getText(sourceFile)}`);
        }
        const locale = propertyName(localeProp.name, sourceFile);
        if (locale !== "zh-CN" && locale !== "en-US") {
            throw new Error(`未知 locale：${locale}`);
        }
        if (!ts.isObjectLiteralExpression(localeProp.initializer)) {
            throw new Error(`locale ${locale} 不是对象字面量`);
        }
        // 聚合入口形态（`"zh-CN": { ...errorsMessages["zh-CN"], ... }`）⇒ 已拆分，交给复跑分支。
        if (localeProp.initializer.properties.some((prop) => ts.isSpreadAssignment(prop))) {
            return null;
        }
        const byDomain = new Map();
        for (const domainProp of localeProp.initializer.properties) {
            if (!ts.isPropertyAssignment(domainProp)) {
                throw new Error(
                    `locale ${locale} 下存在非属性赋值：${domainProp.getText(sourceFile)}`,
                );
            }
            const domain = propertyName(domainProp.name, sourceFile);
            if (byDomain.has(domain)) throw new Error(`locale ${locale} 下域重复：${domain}`);
            // fullStart 纳入前导注释/缩进；end 不含后随逗号（由生成器补）。
            byDomain.set(domain, source.slice(domainProp.getFullStart(), domainProp.getEnd()));
        }
        locales[locale] = byDomain;
    }

    const zh = [...locales["zh-CN"].keys()];
    const en = [...locales["en-US"].keys()];
    if (zh.join("\u0000") !== en.join("\u0000")) {
        throw new Error("两个 locale 的顶层域顺序/集合不一致，拒绝拆分（需人工确认）");
    }
    return { domains: zh, locales };
}

function renderDomainFile(zhText, enText) {
    return [
        "export const messages = {",
        `    "zh-CN": {${zhText}`,
        "    },",
        `    "en-US": {${enText}`,
        "    },",
        "};",
        "",
    ].join("\n");
}

function joinProperties(byDomain, domains) {
    return domains
        .map((domain, index) => byDomain.get(domain) + (index < domains.length - 1 ? "," : ""))
        .join("");
}

function renderIndex(source, domains) {
    const tailStart = source.indexOf("export const i18n = createI18n(");
    if (tailStart < 0) throw new Error("index.ts 里找不到 createI18n 段，拒绝改写");
    const tail = source.slice(tailStart);
    const imports = domains
        .map((domain) => `import { messages as ${domain}Messages } from "./messages/${domain}";`)
        .join("\n");
    const zh = domains.map((domain) => `        ...${domain}Messages["zh-CN"],`).join("\n");
    const en = domains.map((domain) => `        ...${domain}Messages["en-US"],`).join("\n");
    return [
        'import { createI18n } from "vue-i18n";',
        imports,
        "",
        "export const messages = {",
        '    "zh-CN": {',
        zh,
        "    },",
        '    "en-US": {',
        en,
        "    },",
        "};",
        "",
        tail,
    ].join("\n");
}

function countLeaves(value) {
    if (typeof value === "string") return 1;
    if (value && typeof value === "object") {
        let n = 0;
        for (const child of Object.values(value)) n += countLeaves(child);
        return n;
    }
    return 0;
}

function countPerDomain(zhText, enText) {
    const evalBlock = (text) => {
        const body = `const x = {${text}};\nreturn x;`;
        return new Function(body)();
    };
    return {
        zh: countLeaves(evalBlock(zhText)),
        en: countLeaves(evalBlock(enText)),
    };
}

function parseArgs(argv) {
    const options = { write: false, evidence: null, source: null };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--write") options.write = true;
        else if (arg === "--evidence") options.evidence = path.resolve(argv[++i]);
        else if (arg === "--source") options.source = path.resolve(argv[++i]);
        else if (arg === "--help" || arg === "-h") options.help = true;
        else throw new Error(`未知参数：${arg}`);
    }
    return options;
}

async function loadAfterKeys() {
    const mod = await import(pathToFileURL(path.join(I18N_DIR, "flatten-keys.ts")).href);
    return mod.flattenI18nKeys(I18N_DIR);
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log("用法：node scripts/split-i18n-messages.mjs [--write] [--evidence <dir>]");
        return;
    }

    const sourcePath = options.source ?? INDEX_PATH;
    const source = fs.readFileSync(sourcePath, "utf8");
    const extracted = extractDomains(source);

    if (!extracted) {
        const after = await loadAfterKeys();
        console.log(
            `[split-i18n] 已拆分：index.ts 无域字面量，扁平键 ${after.length} 条（跳过写入）`,
        );
        return;
    }

    const { domains, locales } = extracted;
    const rows = domains.map((domain) => ({
        domain,
        ...countPerDomain(locales["zh-CN"].get(domain), locales["en-US"].get(domain)),
    }));
    for (const row of rows) {
        if (row.zh !== row.en) {
            throw new Error(`域 ${row.domain} 的 zh/en 叶子数不一致：${row.zh} vs ${row.en}`);
        }
    }
    const total = rows.reduce((sum, row) => sum + row.zh, 0);
    console.log(`[split-i18n] 域 ${domains.length} 个，zh 叶子 ${total} 条（每域 en 同数）`);
    for (const row of rows) {
        console.log(`  ${row.domain}: ${row.zh}`);
    }

    if (!options.write) {
        console.log("[split-i18n] 未传 --write，只打印计划。");
        return;
    }

    const before = flattenFromIndexSource(source);
    const beforeText = `${before.join("\n")}\n`;

    fs.mkdirSync(MESSAGES_DIR, { recursive: true });
    for (const domain of domains) {
        const content = renderDomainFile(
            locales["zh-CN"].get(domain),
            locales["en-US"].get(domain),
        );
        fs.writeFileSync(path.join(MESSAGES_DIR, `${domain}.ts`), content, "utf8");
    }
    fs.writeFileSync(INDEX_PATH, renderIndex(source, domains), "utf8");

    const after = await loadAfterKeys();
    const afterText = `${after.join("\n")}\n`;
    if (beforeText !== afterText) {
        throw new Error("拆分前后 flattenI18nKeys 输出不一致，停止（请检查生成器）");
    }
    console.log(
        `[split-i18n] 已写 ${domains.length} 个域文件；键清单逐字节一致（${after.length} 条）`,
    );

    if (options.evidence) {
        fs.mkdirSync(options.evidence, { recursive: true });
        fs.writeFileSync(path.join(options.evidence, "keys-before.txt"), beforeText, "utf8");
        fs.writeFileSync(path.join(options.evidence, "keys-after.txt"), afterText, "utf8");
        fs.writeFileSync(
            path.join(options.evidence, "keys-diff.txt"),
            beforeText === afterText ? "" : "DIFF\n",
            "utf8",
        );
        console.log(`[split-i18n] 证据：${options.evidence}`);
    }
}

await main();
