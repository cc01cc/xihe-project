// L2 shard coverage helper: expected runnable test classes from SOURCE, not from filenames.
//
// The covering rule (docs: plan-eff-l2 §判据 1) is: expected = the top-level type names declared in
// `src/test/java`, excluding abstract classes, docker-frozen-only classes, and support types that
// declare no `@Test`. Comparing shard-A ∪ shard-B against this set catches a silently dropped
// package; comparing against surefire XML alone cannot.
//
// WHY source-derived: a test file may declare a class whose name differs from the file
// (`RuntimeAssignmentIntegrationTest.java` declares `RuntimeExecutionSpecIntegrationTest`), and
// renames are exactly the kind of change that can silently shrink shard coverage.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const TEST_ROOTS = ["packages/control-plane/src/test/java", "packages/control-plane/src/test/kotlin"];

function walkJavaFiles(root) {
    const files = [];
    const visit = (dir) => {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) visit(full);
            else if (entry.endsWith(".java")) files.push(full);
        }
    };
    visit(root);
    return files;
}

/** First top-level type declaration (`public? abstract? class|record|interface|enum NAME`). */
function topLevelType(source) {
    const pattern = /^(?:public\s+|final\s+|sealed\s+|non-sealed\s+|strictfp\s+)*(abstract\s+)?(class|record|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;
    let match;
    while ((match = pattern.exec(source)) !== null) {
        // Indented declarations are nested types, not top-level ones.
        const lineStart = source.lastIndexOf("\n", match.index) + 1;
        const indent = match.index - lineStart;
        if (indent === 0) {
            return { name: match[3], abstract: Boolean(match[1]) };
        }
    }
    return null;
}

function isDockerFrozenOnly(source) {
    const tests = (source.match(/@Test\b/g) ?? []).length;
    if (tests === 0) return false;
    const frozenTags = (source.match(/@Tag\(\s*"docker-frozen"\s*\)/g) ?? []).length;
    return frozenTags >= tests;
}

export function computeExpectedTestClasses({ repoRoot }) {
    const expected = [];
    const excludedAbstract = [];
    const excludedSupport = [];
    const excludedDockerFrozen = [];
    const sourceFileCount = (() => {
        let count = 0;
        for (const testRoot of TEST_ROOTS) {
            const absolute = join(repoRoot, testRoot);
            try {
                if (!statSync(absolute).isDirectory()) continue;
            } catch {
                continue;
            }
            const files = walkJavaFiles(absolute);
            count += files.length;
            for (const file of files) {
                const source = readFileSync(file, "utf8");
                if (!source.includes("@Test")) {
                    excludedSupport.push(relative(repoRoot, file).replace(/\\/g, "/"));
                    continue;
                }
                const type = topLevelType(source);
                if (!type) {
                    excludedSupport.push(relative(repoRoot, file).replace(/\\/g, "/"));
                    continue;
                }
                if (type.abstract) {
                    excludedAbstract.push(type.name);
                    continue;
                }
                if (isDockerFrozenOnly(source)) {
                    excludedDockerFrozen.push(type.name);
                    continue;
                }
                const packageMatch = source.match(/^package\s+([\w.]+);/m);
                expected.push(packageMatch ? `${packageMatch[1]}.${type.name}` : type.name);
            }
        }
        return count;
    })();
    return {
        repoRoot,
        sourceFileCount,
        expected: expected.sort(),
        excludedAbstract: excludedAbstract.sort(),
        excludedSupport: excludedSupport.sort(),
        excludedDockerFrozen: excludedDockerFrozen.sort(),
    };
}
