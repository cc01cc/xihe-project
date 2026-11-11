#!/usr/bin/env node
/**
 * `scripts/i18n-scan.mjs` 的自测（task-96）。
 *
 * 门禁脚本最危险的失效是**永远绿**：一个正则写错、跳过条件放宽，报告照样"0 项问题"，谁也不会发现。
 * 所以这里用临时目录夹具**故意造错**，逐类证明它真会红：
 *   - 键差集（en 少一个键）→ exit 1 且点名键 + locale；
 *   - 占位漂移（两侧 {count} vs {count}{extra}）→ exit 1；
 *   - 未解析 t()（.vue 里引用不存在的键）→ exit 1 且点名 `file:line`；
 *   - 结构坏掉（没有 locale 文件）→ exit 2（脚本自身问题，不是产品问题）；
 *   - 正常态 → exit 0 且**零输出**；
 *   - 两类合法花括号（vue-i18n 字面量 `{'@'}`、JSON 样板）不得误报 —— 误报会把门禁喂成噪音。
 *
 * 跑法：`node --test scripts/i18n-scan.test.mjs`（已接进 `mise run test:cli`）。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./i18n-scan.mjs", import.meta.url));

function localeModule({ zh, en }) {
    return `import { createI18n } from "vue-i18n";

const messages = {
    "zh-CN": ${JSON.stringify(zh, null, 4)},
    "en-US": ${JSON.stringify(en, null, 4)},
};

export const i18n = createI18n({
    legacy: false,
    locale: "zh-CN",
    fallbackLocale: "en-US",
    messages,
});
`;
}

/** 造一个最小仓库根：`packages/ui/src/i18n/index.ts` + 可选源码文件。 */
function makeFixture(t, { locale, files = {} }) {
    const root = mkdtempSync(join(tmpdir(), "i18n-scan-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "packages/ui/src/i18n"), { recursive: true });
    if (locale !== undefined) {
        writeFileSync(join(root, "packages/ui/src/i18n/index.ts"), locale);
    }
    for (const [rel, content] of Object.entries(files)) {
        const target = join(root, rel);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, content);
    }
    return root;
}

function run(root, ...args) {
    const result = spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], {
        encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("clean fixtures pass with zero output", (t) => {
    const root = makeFixture(t, {
        locale: localeModule({ zh: { chat: { hi: "你好 {name}" } }, en: { chat: { hi: "Hi {name}" } } }),
        files: { "packages/ui/src/views/Hi.vue": '<template>{{ t("chat.hi") }}</template>\n' },
    });

    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "", "clean run must stay silent (noise-free gate)");
});

test("a key missing on the en side fails and names the locale + key", (t) => {
    const root = makeFixture(t, {
        locale: localeModule({ zh: { chat: { hi: "你好", bye: "再见" } }, en: { chat: { hi: "Hi" } } }),
    });

    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /missing-key/);
    assert.match(result.stdout, /en-US/);
    assert.match(result.stdout, /chat\.bye/);
});

test("placeholder drift between locales fails", (t) => {
    const root = makeFixture(t, {
        locale: localeModule({
            zh: { workspace: { members: "会话成员，{count} 人" } },
            en: { workspace: { members: "Members: {count} of {total}" } },
        }),
    });

    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /placeholder-drift/);
    assert.match(result.stdout, /workspace\.members/);
});

test("an unresolved static t() reference fails and points at file:line", (t) => {
    const root = makeFixture(t, {
        locale: localeModule({ zh: { chat: { hi: "你好" } }, en: { chat: { hi: "Hi" } } }),
        files: {
            "packages/ui/src/features/chat/ApprovalModal.vue": [
                "<script setup lang=\"ts\">",
                "const { t } = useI18n();",
                "</script>",
                "<template>",
                '    <p>{{ t("chat.approvalResolvedElsewhereDraftKept") }}</p>',
                "</template>",
                "",
            ].join("\n"),
        },
    });

    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /unresolved-t/);
    assert.match(result.stdout, /ApprovalModal\.vue:5/);
    assert.match(result.stdout, /chat\.approvalResolvedElsewhereDraftKept/);
});

test("a key-like literal passed as a variable (t(labelKey)) fails when the key is missing", (t) => {
    // task-93：这是 ui-1 在 task-87 撞到的真实形态 —— `t(item.labelKey)` 的键是**字面量常量**，
    // 静态正则 `t("…")` 看不见它。验收判据：漏写 i18n 键要在**定义处**就红，不必追调用链。
    const root = makeFixture(t, {
        locale: localeModule({
            zh: { settings: { ia: { resourceAgents: "智能体" } } },
            en: { settings: { ia: { resourceAgents: "Agents" } } },
        }),
        files: {
            "packages/ui/src/lib/settingsIa.ts": [
                "export function instanceResourceGroup() {",
                "    return [",
                '        { id: "agents", labelKey: "settings.ia.resourceAgents" },',
                '        { id: "skills", labelKey: "settings.ia.resourceSkills" },',
                "    ];",
                "}",
                "",
            ].join("\n"),
        },
    });

    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /unresolved-key/);
    assert.match(result.stdout, /settingsIa\.ts:4/);
    assert.match(result.stdout, /settings\.ia\.resourceSkills/);
});

test("a key-like literal missing on only one side names that locale", (t) => {
    const root = makeFixture(t, {
        locale: localeModule({
            zh: { settings: { skills: { title: "技能" } } },
            en: { settings: {} },
        }),
        files: {
            "packages/ui/src/components/X.vue":
                '<template><p>{{ t("settings.skills.title") }}</p></template>\n',
        },
    });

    const result = run(root, "--json");
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    const finding = report.findings.find((item) => item.kind === "unresolved-key-literal");
    assert.ok(finding, "应当有 unresolved-key-literal");
    assert.deepEqual(finding.missingIn, ["en-US"]);
});

test("template attribute bindings and comments are not key literals (no false positives)", (t) => {
    // 假阳性会把门禁喂成噪音（本仓实测过：`:key="workspace.id"` 9 处、注释里列状态词表 4 处）。
    const root = makeFixture(t, {
        locale: localeModule({
            zh: { workspace: { name: "工作区" }, chat: { hi: "你好" } },
            en: { workspace: { name: "Workspace" }, chat: { hi: "Hi" } },
        }),
        files: {
            "packages/ui/src/components/Picker.vue": [
                "<script setup lang=\"ts\">",
                "// 词表注释：chat.notAKey / monitor.status 都不是键，只是说明文字",
                'import { t } from "vue-i18n";',
                "</script>",
                "<template>",
                '    <li v-for="workspace in list" :key="workspace.id">',
                '        <span :data-testid="`picker-${workspace.name}`">{{ workspace.name }}</span>',
                "    </li>",
                "</template>",
                "",
            ].join("\n"),
        },
    });

    const result = run(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, "");
});

test("--json returns structured findings with the same verdict", (t) => {
    const root = makeFixture(t, {
        locale: localeModule({ zh: { a: "一" }, en: {} }),
    });

    const clean = run(root, "--json");
    assert.equal(clean.status, 1);
    const report = JSON.parse(clean.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.locales[0], "zh-CN");
    assert.deepEqual(
        report.findings.map((finding) => finding.kind),
        ["missing-key"],
    );
    assert.equal(report.findings[0].key, "a");
});

test("a broken repository structure exits 2, not 1", (t) => {
    const root = makeFixture(t, { locale: undefined });

    const result = run(root);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /读不到 locale 文件/);
});

test("legitimate braces (vue-i18n literals, JSON samples) are not false positives", (t) => {
    const jsonSample = '{\n  "mcpServers": {}\n}';
    const root = makeFixture(t, {
        locale: localeModule({
            zh: {
                chat: { mentioned: "被 {'@'}：{name}" },
                settings: { jsonPlaceholder: jsonSample },
            },
            en: {
                chat: { mentioned: "Mentioned: {name}" },
                settings: { jsonPlaceholder: jsonSample },
            },
        }),
    });

    const result = run(root);
    assert.equal(result.status, 0, result.stdout);
});

test("a leftover {…} placeholder shape does fail", (t) => {
    const root = makeFixture(t, {
        locale: localeModule({
            zh: { settings: { broken: "请填写 {...}" } },
            en: { settings: { broken: "Fill in {...}" } },
        }),
    });

    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /literal-brace/);
});
