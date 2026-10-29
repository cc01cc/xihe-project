#!/usr/bin/env node
/**
 * PLAN-0534 version consistency check.
 *
 * Verifies the four manifests are the only authority, production source has no
 * module-version literal, the derivation anchors exist, and CHANGELOG has the
 * expected structure. Read-only; exits 1 on any failure.
 *
 * PLAN-0574 T1.4: the check is exported as checkVersions(root) so `xihe version
 * --check` reuses this exact logic instead of duplicating it. Importing this
 * module no longer runs the check; the CLI entry runs only when executed.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

export function parseJsonVersionText(text, relPath = "manifest") {
    const value = JSON.parse(text).version;
    if (typeof value !== "string") throw new Error(`${relPath}: version is not a string`);
    return value;
}

export function parseTomlVersionText(text, relPath = "manifest") {
    const line = text
        .split(/\r?\n/)
        .find((candidate) => /^version\s*=\s*"[^"]+"/.test(candidate.trim()));
    if (!line) throw new Error(`${relPath}: version field not found`);
    return line.trim().match(/^version\s*=\s*"([^"]+)"/)[1];
}

export function parsePomVersionText(text, relPath = "manifest") {
    const match = text.match(
        /<artifactId>control-plane<\/artifactId>\s*<version>([^<]+)<\/version>/,
    );
    if (!match) throw new Error(`${relPath}: control-plane <version> not found`);
    return match[1].trim();
}

export function checkVersions(root = defaultRoot) {
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

    const manifests = [
        ["ui", "packages/ui/package.json", (relPath) => parseJsonVersionText(read(relPath), relPath)],
        ["cp", "packages/control-plane/pom.xml", (relPath) => parsePomVersionText(read(relPath), relPath)],
        ["agent", "packages/agent/pyproject.toml", (relPath) => parseTomlVersionText(read(relPath), relPath)],
        ["runtime", "packages/runtime/Cargo.toml", (relPath) => parseTomlVersionText(read(relPath), relPath)],
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
        let files;
        try {
            files = walk(dir, extensions);
        } catch (error) {
            fail(`${name}: ${error.message}`);
            continue;
        }
        for (const file of files) {
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
        let docs;
        try {
            docs = [
                join(root, "README.md"),
                ...walk("docs", [".md"]),
            ].filter((file) => !file.endsWith(`${sep}CHANGELOG.md`));
        } catch (error) {
            fail(`docs: ${error.message}`);
            continue;
        }
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

    return { ok: failures.length === 0, failures, checks, versions };
}

export function printVersionCheck(result) {
    for (const message of result.checks) console.log(`ok   ${message}`);
    for (const message of result.failures) console.error(`FAIL ${message}`);
    console.log(
        result.failures.length === 0
            ? `\nPASS: ${Object.keys(result.versions).length} manifests, ${result.checks.length} checks`
            : `\nFAIL: ${result.failures.length} issue(s)`,
    );
}

const isMain = process.argv[1]
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
    const result = checkVersions();
    printVersionCheck(result);
    process.exit(result.ok ? 0 : 1);
}
