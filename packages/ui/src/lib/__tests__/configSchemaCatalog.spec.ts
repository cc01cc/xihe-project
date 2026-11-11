import { execFileSync } from "node:child_process";
import {
    copyFileSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_SCHEMA_CATALOG, CONFIG_SCHEMA_DOMAINS } from "../configSchemaCatalog";

/**
 * task-138 / PLAN-0764 T1.1：config schema 生成器与漂移门。
 *
 * 判据来自卡面：①生成物可复现（连跑两次字节一致）②--check exit 0 ③负例红（防恒真，D-884）
 * ④内容断言盯住展平规则（点号键 / map / type 数组 / enum），否则「生成器跑通」可能只是空跑。
 *
 * 负例用 --schemas 夹具目录 + --out 指向真实产物，夹具改动必须让门变红；同一夹具不改动时
 * 必须仍绿（对照），证明红不是夹具路径本身造成的。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(here, "../../..");
const script = path.resolve(uiRoot, "scripts/gen-config-schema.mjs");
const schemaDir = path.resolve(uiRoot, "../control-plane/src/main/resources/config-schemas");
const outFile = path.resolve(uiRoot, "src/lib/configSchemaCatalog.ts");
const SCHEMA_FILES = readdirSync(schemaDir)
    .filter((file) => file.endsWith(".json"))
    .sort();
const FIELD_TYPES = ["string", "integer", "number", "boolean", "enum", "map", "json"];

const tempDirs: string[] = [];
afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop() as string;
        rmSync(dir, { recursive: true, force: true });
    }
});

function tempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "xh-config-schema-"));
    tempDirs.push(dir);
    return dir;
}

function runGen(args: string[]): { status: number; stdout: string; stderr: string } {
    try {
        const stdout = execFileSync(process.execPath, [script, ...args], { encoding: "utf8" });
        return { status: 0, stdout, stderr: "" };
    } catch (error) {
        const failed = error as {
            status?: number;
            stdout?: string;
            stderr?: string;
            message?: string;
        };
        return {
            status: failed.status ?? -1,
            stdout: String(failed.stdout ?? ""),
            stderr: String(failed.stderr ?? failed.message ?? ""),
        };
    }
}

/** 以真实 CP schema 为底复制一份夹具目录（--schemas 挂钩）。 */
function cloneSchemas(): string {
    const dir = tempDir();
    for (const file of SCHEMA_FILES) {
        copyFileSync(path.join(schemaDir, file), path.join(dir, file));
    }
    return dir;
}

const byDomain = (domain: string) => CONFIG_SCHEMA_CATALOG[domain] ?? [];
const fieldOf = (domain: string, key: string) =>
    byDomain(domain).find((field) => field.key === key);

function domainOf(file: string): string {
    return file.replace(/\.json$/, "");
}

describe("生成物与 CP 真源", () => {
    it("域集合 = config-schemas 目录里的 .json 文件名（排序一致）", () => {
        expect(CONFIG_SCHEMA_DOMAINS).toEqual(SCHEMA_FILES.map(domainOf));
        // 13 个域是 ConfigDomainSchema 的加载集合；目录增删域时这里先变红，提示重生成。
        expect(CONFIG_SCHEMA_DOMAINS.length).toBe(SCHEMA_FILES.length);
    });

    it("每域字段 key 非空唯一，type 都在约定集合内（防空跑）", () => {
        for (const domain of CONFIG_SCHEMA_DOMAINS) {
            const fields = byDomain(domain);
            expect(fields.length, domain + " 无字段").toBeGreaterThan(0);
            const keys = fields.map((field) => field.key);
            expect(new Set(keys).size, domain + " 字段 key 重复").toBe(keys.length);
            for (const field of fields) {
                expect(field.key.trim(), domain + " 空 key").toBe(field.key);
                expect(field.key.length, domain + " 空 key").toBeGreaterThan(0);
                expect(FIELD_TYPES, domain + ":" + field.key).toContain(field.type);
            }
        }
    });

    it("展平规则逐条盯住：点号键 / map / type 数组首标量 / json / enum", () => {
        // 嵌套 object 展平成点号键，且父节点不残留成独立字段。
        expect(fieldOf("embedding", "profile.providerId")?.type).toBe("string");
        expect(fieldOf("embedding", "profile")).toBeUndefined();
        // additionalProperties 为对象 ⇒ map（llm-provider modelParams / context-policy models）。
        expect(fieldOf("llm-provider", "modelParams")?.type).toBe("map");
        expect(fieldOf("context-policy", "models")?.type).toBe("map");
        // type 数组取首个标量：["integer","string"] ⇒ integer。
        expect(fieldOf("agent-runtime", "systemToolTimeoutS")?.type).toBe("integer");
        // type 数组首项是 object 且非 map ⇒ json（pricing models 的 ["object","string"]）。
        expect(fieldOf("pricing", "models")?.type).toBe("json");
        // enum ⇒ type enum + enumValues（大小写两套值都在）。
        const logLevel = fieldOf("logging", "logLevel");
        expect(logLevel?.type).toBe("enum");
        expect(logLevel?.enumValues?.map((value) => value.value)).toEqual([
            "TRACE",
            "DEBUG",
            "INFO",
            "WARN",
            "ERROR",
            "trace",
            "debug",
            "info",
            "warn",
            "error",
        ]);
        // description 原样带出（中文 label 不在本模块）。
        expect(fieldOf("llm-provider", "modelParams")?.description).toBeTruthy();
    });
});

describe("漂移门 (--check)", () => {
    it("真实 schema 与生成物一致 ⇒ exit 0", () => {
        const result = runGen(["--check"]);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("无漂移");
    }, 15000);

    it("生成物可复现：两次生成字节一致，且与仓内生成物相同", () => {
        const first = path.join(tempDir(), "catalog-a.ts");
        const second = path.join(tempDir(), "catalog-b.ts");
        expect(runGen(["--out", first]).status).toBe(0);
        expect(runGen(["--out", second]).status).toBe(0);
        const firstBytes = readFileSync(first, "utf8");
        expect(readFileSync(second, "utf8")).toBe(firstBytes);
        expect(readFileSync(outFile, "utf8")).toBe(firstBytes);
    }, 15000);

    it("夹具与真源一致时仍绿（对照，证明下面的红来自改动本身）", () => {
        const dir = cloneSchemas();
        const result = runGen(["--check", "--schemas", dir, "--out", outFile]);
        expect(result.status).toBe(0);
    }, 15000);

    it("夹具加一个字段 ⇒ exit 1 且报漂移（负例自红，D-884）", () => {
        const dir = cloneSchemas();
        const target = path.join(dir, "logging.json");
        const json = JSON.parse(readFileSync(target, "utf8")) as {
            properties: Record<string, unknown>;
        };
        json.properties.confiSchemaGenProbe = { type: "string" };
        writeFileSync(target, JSON.stringify(json, null, 2));
        const result = runGen(["--check", "--schemas", dir, "--out", outFile]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("漂移");
    }, 15000);

    it("夹具多一个域文件 ⇒ exit 1（域集合漂移也拦）", () => {
        const dir = cloneSchemas();
        copyFileSync(path.join(dir, "logging.json"), path.join(dir, "zz-new-domain.json"));
        const result = runGen(["--check", "--schemas", dir, "--out", outFile]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("漂移");
    }, 15000);

    it("schema 目录读不到 ⇒ exit 2（环境问题与漂移分开报）", () => {
        const result = runGen(["--schemas", path.join(tempDir(), "missing"), "--out", outFile]);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain("exit 2");
    }, 15000);
});
