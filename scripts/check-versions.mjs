#!/usr/bin/env node
/**
 * PLAN-0534 version consistency check.
 *
 * Verifies the four manifests are the only authority, production source has no
 * module-version literal, the derivation anchors exist, and CHANGELOG has the
 * expected structure. Read-only; exits 1 on any failure.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const failures = [];
const checks = [];

function fail(message) {
    failures.push(message);
}

function ok(message) {
    checks.push(message);
}

function read(relPath) {
    return readFileSync(join(root, relPath), "utf8");
}

function walk(relDir, extensions) {
    const start = join(root, relDir);
    const files = [];
    for (const entry of readdirSync(start, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const full = join(entry.parentPath ?? entry.path, entry.name);
        if (extensions.some((ext) => full.endsWith(ext))) files.push(full);
    }
    return files;
}

function parseJsonVersion(relPath) {
    const value = JSON.parse(read(relPath)).version;
    if (typeof value !== "string") throw new Error(`${relPath}: version is not a string`);
    return value;
}

function parseTomlVersion(relPath) {
    const line = read(relPath)
        .split(/\r?\n/)
        .find((candidate) => /^version\s*=\s*"[^"]+"/.test(candidate.trim()));
    if (!line) throw new Error(`${relPath}: version field not found`);
    return line.trim().match(/^version\s*=\s*"([^"]+)"/)[1];
}

function parsePomVersion(relPath) {
    const match = read(relPath).match(
        /<artifactId>control-plane<\/artifactId>\s*<version>([^<]+)<\/version>/,
    );
    if (!match) throw new Error(`${relPath}: control-plane <version> not found`);
    return match[1].trim();
}

const manifests = [
    ["ui", "packages/ui/package.json", parseJsonVersion],
    ["cp", "packages/control-plane/pom.xml", parsePomVersion],
    ["agent", "packages/agent/pyproject.toml", parseTomlVersion],
    ["runtime", "packages/runtime/Cargo.toml", parseTomlVersion],
];
const versions = {};
for (const [name, relPath, parser] of manifests) {
    try {
        const version = parser(relPath);
        if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
            fail(`${name}: ${relPath} version "${version}" is not semver`);
        } else {
            versions[name] = version;
            ok(`${name}: ${version} (${relPath})`);
        }
    } catch (error) {
        fail(`${name}: ${error.message}`);
    }
}

const productionScopes = [
    ["agent", "packages/agent/src", [".py"]],
    ["cp", "packages/control-plane/src/main", [".java"]],
    ["runtime", "packages/runtime/src", [".rs"]],
    ["ui", "packages/ui/src", [".ts", ".vue"]],
];
for (const [name, dir, extensions] of productionScopes) {
    const version = versions[name];
    if (!version) continue;
    const literal = new RegExp(`["']${version.replaceAll(".", "\\.")}["']`);
    for (const file of walk(dir, extensions)) {
        const rel = relative(root, file).split(sep).join("/");
        readFileSync(file, "utf8")
            .split(/\r?\n/)
            .forEach((line, index) => {
                if (literal.test(line)) fail(`${rel}:${index + 1}: hardcoded ${name} version "${version}"`);
            });
    }
    ok(`${name}: no production version literal`);
}

for (const version of new Set(Object.values(versions))) {
    const literal = new RegExp(`\\b${version.replaceAll(".", "\\.")}\\b`);
    const docs = [
        join(root, "README.md"),
        ...walk("docs", [".md"]),
    ].filter((file) => !file.endsWith(`${sep}CHANGELOG.md`));
    for (const file of docs) {
        const rel = relative(root, file).split(sep).join("/");
        readFileSync(file, "utf8")
            .split(/\r?\n/)
            .forEach((line, index) => {
                if (literal.test(line)) fail(`${rel}:${index + 1}: stale module version "${version}" in docs`);
            });
    }
}
ok("docs: no module version literal (CHANGELOG excluded)");

const anchors = [
    ["agent metadata", "packages/agent/src/xihe_agent/version.py", "importlib.metadata"],
    ["agent package", "packages/agent/src/xihe_agent/version.py", 'PACKAGE_NAME = "xihe-agent"'],
    ["cp filtered pom", "packages/control-plane/src/main/resources/META-INF/maven/com.cc01cc.p.xihe/control-plane/pom.properties", "@project.version@"],
    ["cp build reader", "packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/status/BuildVersion.java", "pom.properties"],
    ["cp version route", "packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/status/VersionController.java", "/api/v1/version"],
    ["cp mcp clientInfo", "packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/mcp/McpProxyController.java", "clientInfo"],
    ["runtime cargo version", "packages/runtime/src/main.rs", 'env!("CARGO_PKG_VERSION")'],
    ["ui vite define", "packages/ui/vite.config.ts", "VITE_XIHE_SERVICE_VERSION"],
    ["ui logger consumer", "packages/ui/src/lib/logger.ts", "VITE_XIHE_SERVICE_VERSION"],
];
for (const [label, relPath, needle] of anchors) {
    try {
        if (!read(relPath).includes(needle)) fail(`${label}: ${relPath} does not contain "${needle}"`);
        else ok(`${label}: anchor present`);
    } catch (error) {
        fail(`${label}: ${error.message}`);
    }
}

try {
    const changelog = read("CHANGELOG.md");
    if (!/^## \[Unreleased\]/m.test(changelog)) fail("CHANGELOG.md: missing [Unreleased]");
    if (!/^## \[\d+\.\d+\.\d+\]/m.test(changelog)) fail("CHANGELOG.md: no dated version section");
    if (!changelog.includes("## Versioning")) fail("CHANGELOG.md: missing Versioning policy section");
    if (!failures.some((item) => item.startsWith("CHANGELOG"))) ok("CHANGELOG.md: structure present");
} catch (error) {
    fail(`CHANGELOG.md: ${error.message}`);
}

for (const message of checks) console.log(`ok   ${message}`);
for (const message of failures) console.error(`FAIL ${message}`);
console.log(
    failures.length === 0
        ? `\nPASS: ${Object.keys(versions).length} manifests, ${checks.length} checks`
        : `\nFAIL: ${failures.length} issue(s)`,
);
process.exit(failures.length === 0 ? 0 : 1);
