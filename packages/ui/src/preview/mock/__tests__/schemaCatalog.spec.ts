import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCHEMA_CATALOG, SCHEMA_DOMAINS } from "../data/schema-catalog";

/**
 * task-127：schema-catalog 生成物的漂移门（D-884 —— 守卫必须能自红，负例在下方）。
 *
 * - 正例：对 CP config-schemas 重生成并与盘上生成物比对，必须「无漂移」；
 * - 负例：夹具 schema 加一个键后 --check 必须报漂移（证明这道门真的会红）；
 * - 结构：13 域齐全、字段键非空、enum 带 options（生成器展平规则的最小事实集）。
 */

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const script = path.join(uiRoot, "scripts", "gen-mock-schema-catalog.mjs");

function runScript(args: string[]) {
    return spawnSync(process.execPath, [script, ...args], {
        cwd: uiRoot,
        encoding: "utf8",
    });
}

describe("schema-catalog 生成物（task-127 漂移门）", () => {
    it("正例：CP config-schemas 与生成物无漂移", () => {
        const res = runScript(["--check"]);
        expect(res.status, res.stderr || res.stdout).toBe(0);
        expect(res.stdout).toContain("无漂移");
    });

    it("负例：夹具 schema 加一个键 ⇒ 漂移门必红（D-884）", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "schema-catalog-"));
        try {
            const fixtureDir = path.join(dir, "schemas");
            await mkdir(fixtureDir);
            const upstream = path.join(
                uiRoot,
                "../control-plane/src/main/resources/config-schemas/user-preference.json",
            );
            const fixture = JSON.parse(await readFile(upstream, "utf8"));
            fixture.properties.addedByFixture = { type: "string" };
            await writeFile(path.join(fixtureDir, "user-preference.json"), JSON.stringify(fixture));
            const out = path.join(dir, "catalog.ts");
            const gen = runScript(["--schemas", fixtureDir, "--out", out]);
            expect(gen.status, gen.stderr || gen.stdout).toBe(0);
            // 同一夹具再生成必然自洽（先证明 --out 路径本身可用），随后改夹具让 check 变红。
            const checkSelf = runScript(["--schemas", fixtureDir, "--out", out, "--check"]);
            expect(checkSelf.status).toBe(0);
            fixture.properties.addedAgain = { type: "string" };
            await writeFile(path.join(fixtureDir, "user-preference.json"), JSON.stringify(fixture));
            const check = runScript(["--schemas", fixtureDir, "--out", out, "--check"]);
            expect(check.status).toBe(1);
            expect(check.stderr).toContain("漂移");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("结构：13 域齐全、每域字段键非空、enum 带 options", () => {
        expect(SCHEMA_DOMAINS).toHaveLength(13);
        for (const [domain, fields] of Object.entries(SCHEMA_CATALOG)) {
            expect(fields.length, domain).toBeGreaterThan(0);
            for (const field of fields) {
                expect(field.key.length).toBeGreaterThan(0);
                if (field.type === "enum") {
                    expect(field.options?.length, field.key).toBeGreaterThan(0);
                }
            }
        }
    });
});
