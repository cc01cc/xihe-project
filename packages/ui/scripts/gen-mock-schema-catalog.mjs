/**
 * gen-mock-schema-catalog.mjs — task-127：从 CP config-schemas 生成 mock 域清单（schema-catalog.ts）。
 *
 * Why：单页稿要求「设置区所有配置域的字段级真实内容，按 config-schemas，禁占位」。
 * 21 域 × 嵌套字段手抄必然漂移（D-889）；生成器让「稿上每个字段的来源」可复算。
 *
 * Usage（packages/ui 目录下）：
 *   node scripts/gen-mock-schema-catalog.mjs          # 生成
 *   node scripts/gen-mock-schema-catalog.mjs --check  # 漂移门（exit 0/1）
 *
 * 展平规则：
 *   - 嵌套 object 的属性 → 点号键（profile.providerId）；
 *   - additionalProperties 为 object（map 值型，如 modelParams）→ 整体标 type "map"；
 *   - type 数组（如 ["integer","string"]）→ 取首个标量；
 *   - enum → options 一并带出。
 *
 * 字节级确定：catalog 以 JSON.stringify 原文内嵌模板字面量，oxfmt 不改字符串内容 ⇒
 * --check 的文本比对成立（生成物先经 oxfmt 一次再提交）。
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = argOf("--schemas")
    ? path.resolve(argOf("--schemas"))
    : path.resolve(uiRoot, "../control-plane/src/main/resources/config-schemas");
const outFile = argOf("--out")
    ? path.resolve(argOf("--out"))
    : path.resolve(uiRoot, "src/preview/mock/data/schema-catalog.ts");
const check = process.argv.includes("--check");
// 测试挂钩：--schemas <dir> / --out <file> 让 spec 能用夹具目录走正/负例（D-884 守卫要能自红）。
function argOf(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

function flatten(node, prefix, required) {
    if (!node || typeof node !== "object") return [];
    const schema = node;
    if (schema.type === "object" && schema.properties) {
        const out = [];
        for (const [key, child] of Object.entries(schema.properties)) {
            const fullKey = prefix ? prefix + "." + key : key;
            const childRequired = Array.isArray(child?.required) ? child.required : [];
            if (child?.type === "object" && child.properties) {
                out.push(...flatten(child, fullKey, childRequired));
            } else {
                out.push(leaf(fullKey, child, childRequired.includes(key)));
            }
        }
        return out;
    }
    return [leaf(prefix, schema, required.includes(prefix.split(".").pop() ?? ""))];
}

function leaf(key, node, required) {
    const rawType = node?.type;
    let type = Array.isArray(rawType) ? rawType[0] : rawType;
    if (node?.enum) type = "enum";
    else if (type === "object")
        type = node?.additionalProperties?.type === "object" ? "map" : "json";
    else if (type === "array") type = "json";
    const field = { key, type: String(type ?? "string") };
    if (node?.enum) field.options = node.enum;
    if (node?.description) field.description = node.description;
    if (required) field.required = true;
    if (node?.default !== undefined) field.default = node.default;
    return field;
}

const files = (await readdir(schemaDir)).filter((f) => f.endsWith(".json")).sort();
/** @type {Record<string, Array<Record<string, unknown>>>} */
const catalog = {};
for (const file of files) {
    const domain = file.replace(/\.json$/, "");
    const json = JSON.parse(await readFile(path.join(schemaDir, file), "utf8"));
    const topRequired = Array.isArray(json.required) ? json.required : [];
    catalog[domain] = flatten(json, "", topRequired);
}

const HEADER = `/**
 * **生成物** — 由 scripts/gen-mock-schema-catalog.mjs 从 CP config-schemas 生成，请勿手改。
 * 重生成：node scripts/gen-mock-schema-catalog.mjs（漂移自查加 --check）。
 * 语义：mock 稿「设置区每个字段的来源」对账底账（task-127）。
 */

export interface MockSchemaField {
    key: string;
    type: "string" | "integer" | "number" | "boolean" | "enum" | "map" | "json";
    options?: string[];
    description?: string;
    required?: boolean;
    default?: unknown;
}

`;

const json = JSON.stringify(catalog, null, 4);
const output =
    HEADER +
    "/** 内嵌 JSON 原文：oxfmt 不改字符串内容 ⇒ 生成物字节级确定。 */\n" +
    "const CATALOG_JSON = `" +
    json +
    "` as const;\n\n" +
    // 尾段按 oxfmt 的规范排版逐字节写死（oxfmt 会把 as Record<...> 收成三行）——
    // 生成器不依赖外部格式化步骤，--check 的文本比对才成立。
    "export const SCHEMA_CATALOG: Record<string, MockSchemaField[]> = JSON.parse(CATALOG_JSON) as Record<\n" +
    "    string,\n" +
    "    MockSchemaField[]\n" +
    ">;\n\n" +
    "export const SCHEMA_DOMAINS = Object.keys(SCHEMA_CATALOG);\n";

if (check) {
    const existing = await readFile(outFile, "utf8").catch(() => null);
    if (existing === output) {
        console.log("[gen-mock-schema-catalog] 无漂移");
        process.exit(0);
    }
    console.error(
        "[gen-mock-schema-catalog] 漂移：CP config-schemas 与 schema-catalog.ts 不一致，请重生成",
    );
    process.exit(1);
}
await writeFile(outFile, output, "utf8");
console.log(
    `[gen-mock-schema-catalog] 生成 ${files.length} 域 → ${path.relative(uiRoot, outFile)}`,
);
for (const [domain, fields] of Object.entries(catalog)) {
    console.log(`  ${domain}: ${fields.length} 字段`);
}
