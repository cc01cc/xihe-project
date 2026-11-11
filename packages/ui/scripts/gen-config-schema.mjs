/**
 * gen-config-schema.mjs — PLAN-0764 T1.1 / task-138：从 CP config-schemas 生成前端 configSchemaCatalog.ts。
 *
 * Why：实例层 12 域要字段级表单（T1.2 generic 渲染器 + T1.3 中文适配），字段清单手抄必然漂移（D-889）。
 * 参照物 = mock 侧 scripts/gen-mock-schema-catalog.mjs（task-127 已验证「生成器 + --check + 负例自红」）。
 * 本文件是产品侧唯一一份 schema 展平实现；mock 侧改为 import 本模块产物（Lead 2026-11-11 契约定死，防两套生成器漂移）。
 *
 * Usage（cwd = packages/ui）：
 *   node scripts/gen-config-schema.mjs                 # 生成（写 src/lib/configSchemaCatalog.ts）
 *   node scripts/gen-config-schema.mjs --check         # 漂移门：生成物与 CP 真源不一致 ⇒ exit 1
 *   node scripts/gen-config-schema.mjs --schemas <dir> --out <file>   # 测试挂钩（夹具走正/负例）
 *
 * 展平规则：嵌套 object 的属性 → 点号键（profile.providerId）；additionalProperties 为对象（map 值型）→
 * type map；type 数组（[integer, string]）→ 取首个标量；enum → type enum + enumValues。
 *
 * 字节级确定：catalog 以 JSON.stringify 原文内嵌模板字面量，只转义反斜杠/反引号/${；oxfmt 不改字符串内容
 * ⇒ --check 的文本比对成立（生成物须经 oxfmt 一次再提交）。
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DQ = String.fromCharCode(34); // 双引号：生成物里的 TS 字符串统一用双引号，避免在源码里层层转义。
const BACKTICK = String.fromCharCode(96);
const BACKSLASH = String.fromCharCode(92);

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = argOf("--schemas")
    ? path.resolve(argOf("--schemas"))
    : path.resolve(uiRoot, "../control-plane/src/main/resources/config-schemas");
const outFile = argOf("--out")
    ? path.resolve(argOf("--out"))
    : path.resolve(uiRoot, "src/lib/configSchemaCatalog.ts");
const check = process.argv.includes("--check");

// 测试挂钩：--schemas <dir> / --out <file> 让单测能用夹具目录走正/负例（D-884 守卫要能自红）。
function argOf(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 展平：返回 { key, type, enumValues?, description? } 数组（中文 label 属 fieldLabels.ts，不在此模块）。 */
function flatten(node, prefix) {
    if (!node || typeof node !== "object") return [];
    if (node.type === "object" && node.properties) {
        const out = [];
        for (const [key, child] of Object.entries(node.properties)) {
            const fullKey = prefix ? prefix + "." + key : key;
            if (child?.type === "object" && child.properties) out.push(...flatten(child, fullKey));
            else out.push(leaf(fullKey, child));
        }
        return out;
    }
    return [leaf(prefix, node)];
}

function leaf(key, node) {
    const rawType = node?.type;
    let type = Array.isArray(rawType) ? rawType[0] : rawType;
    if (node?.enum) type = "enum";
    else if (type === "object")
        type = node?.additionalProperties?.type === "object" ? "map" : "json";
    else if (type === "array") type = "json";
    const field = { key, type: String(type ?? "string") };
    if (Array.isArray(node?.enum)) field.enumValues = node.enum.map((value) => ({ value }));
    if (node?.description) field.description = node.description;
    return field;
}

let files;
try {
    files = (await readdir(schemaDir)).filter((f) => f.endsWith(".json")).sort();
} catch {
    console.error("[gen-config-schema] 读不到 schema 目录：" + schemaDir + "（exit 2）");
    process.exit(2);
}
if (files.length === 0) {
    console.error("[gen-config-schema] schema 目录里没有 .json：" + schemaDir + "（exit 2）");
    process.exit(2);
}

const catalog = {};
for (const file of files) {
    const domain = file.replace(/\.json$/, "");
    let json;
    try {
        json = JSON.parse(await readFile(path.join(schemaDir, file), "utf8"));
    } catch (error) {
        console.error(
            "[gen-config-schema] " + file + " 不是合法 JSON：" + error.message + "（exit 2）",
        );
        process.exit(2);
    }
    catalog[domain] = flatten(json, "");
}

// 模板字面量里只有三类字符需要转义：反斜杠（翻倍）、反引号、${；其余（含普通引号与换行）原样保留。
const literal = JSON.stringify(catalog, null, 4)
    .split(BACKSLASH)
    .join(BACKSLASH + BACKSLASH)
    .split(BACKTICK)
    .join(BACKSLASH + BACKTICK)
    .split("${")
    .join(BACKSLASH + "${");

const HEAD = [
    "/**",
    " * **生成物** — 由 scripts/gen-config-schema.mjs 从 CP config-schemas 生成，请勿手改。",
    " * 再生成（cwd=packages/ui）：node scripts/gen-config-schema.mjs",
    " * 漂移自查：node scripts/gen-config-schema.mjs --check（生成物与真源不一致 ⇒ exit 1）",
    " *",
    " * 真源：packages/control-plane/src/main/resources/config-schemas/*.json（" +
        files.length +
        " 域）",
    " * 展平规则：嵌套 object → 点号键；additionalProperties 为对象 → type " +
        DQ +
        "map" +
        DQ +
        "；type 数组取首标量；",
    " * enum → type " +
        DQ +
        "enum" +
        DQ +
        " + enumValues（中文 label 见 fieldLabels.ts，不并入本模块）。",
    " */",
    "",
    "export type SchemaFieldType = " +
        ["string", "integer", "number", "boolean", "enum", "map", "json"]
            .map((name) => DQ + name + DQ)
            .join(" | ") +
        ";",
    "",
    "export interface SchemaField {",
    "    key: string;",
    "    type: SchemaFieldType;",
    "    enumValues?: { value: string; label?: string }[];",
    "    description?: string;",
    "}",
    "",
    "/** 内嵌 JSON 原文：oxfmt 不改字符串内容 ⇒ 生成物字节级确定。 */",
    "const CATALOG_JSON = " + BACKTICK,
].join("\n");

const TAIL =
    BACKTICK +
    " as const;\n\n" +
    "export const CONFIG_SCHEMA_CATALOG: Record<string, SchemaField[]> = JSON.parse(\n" +
    "    CATALOG_JSON,\n" +
    ") as Record<string, SchemaField[]>;\n\n" +
    "export const CONFIG_SCHEMA_DOMAINS: string[] = Object.keys(CONFIG_SCHEMA_CATALOG);\n";

const output = HEAD + literal + TAIL;

if (check) {
    const existing = await readFile(outFile, "utf8").catch(() => null);
    if (existing === output) {
        console.log("[gen-config-schema] 无漂移");
        process.exit(0);
    }
    console.error(
        "[gen-config-schema] 漂移：CP config-schemas 与 " +
            path.relative(uiRoot, outFile) +
            " 不一致，请重生成：node scripts/gen-config-schema.mjs",
    );
    process.exit(1);
}
await writeFile(outFile, output, "utf8");
console.log("[gen-config-schema] 生成 " + files.length + " 域 → " + path.relative(uiRoot, outFile));
for (const [domain, fields] of Object.entries(catalog)) {
    console.log("  " + domain + ": " + fields.length + " 字段");
}
