import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { i18n } from "../index";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

type Leaf = { path: string; value: string };

function leaves(node: unknown, path = ""): Leaf[] {
    if (typeof node === "string") return [{ path, value: node }];
    if (Array.isArray(node)) return node.flatMap((v, i) => leaves(v, `${path}[${i}]`));
    if (node && typeof node === "object") {
        return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
            leaves(v, path ? `${path}.${k}` : k),
        );
    }
    return [];
}

const BARE_RUN = /\bRun\b/;

/** 动词/动作标签（非主名词）白名单；技术实体 run 使用小写，不匹配 BARE_RUN。 */
const EN_ALLOWED = new Set(["Run a workspace job", "Run"]);

describe("terminology: 界面主名词（PLAN-0674 T3.2）", () => {
    it("zh 文案不出现裸 Run（应统一为「回合」）", () => {
        const offenders = leaves(i18n.global.getLocaleMessage("zh-CN"))
            .filter((leaf) => BARE_RUN.test(leaf.value))
            .map((leaf) => `${leaf.path}: ${leaf.value}`);
        expect(offenders).toEqual([]);
    });

    it("en 文案主名词不出现裸 Run（动词/动作标签白名单除外）", () => {
        const offenders = leaves(i18n.global.getLocaleMessage("en-US"))
            .filter((leaf) => BARE_RUN.test(leaf.value) && !EN_ALLOWED.has(leaf.value))
            .map((leaf) => `${leaf.path}: ${leaf.value}`);
        expect(offenders).toEqual([]);
    });
});

/** 取 zh-CN 某键的渲染文案（走 messages 树，避免依赖当前 locale 状态）。 */
function zhCopy(path: string): string {
    return (
        leaves(i18n.global.getLocaleMessage("zh-CN")).find((leaf) => leaf.path === path)?.value ??
        ""
    );
}

const LOCK_COPY_KEYS = [
    "settings.configLockValueHint",
    "settings.configLockClearValue",
    "settings.configLockReasonINSTANCE_ONLY",
    "settings.configLockReasonENV_LOCKED",
] as const;

/**
 * task-14 / F-07：原先 config-locks 页把 `instance` / `code default` / `env` 裸词
 * 直接写在提示与状态词里（层名应走「实例层 / 代码默认值 / 环境变量」口径）。
 */
describe("F-07 文案残留（task-14 P2）", () => {
    it("config-locks 四句不含 instance / code default / env 裸词", () => {
        for (const key of LOCK_COPY_KEYS) {
            const value = zhCopy(key);
            expect(value, key).not.toBe("");
            expect(value, key).not.toMatch(/\binstance\b/i);
            expect(value.toLowerCase(), key).not.toContain("code default");
            expect(value, key).not.toMatch(/(^|[\s（(])env([\s，。）)]|$)/);
        }
    });

    it("llm 实例页连接槽帮助文案不含裸状态码 409", () => {
        const value = zhCopy("settings.llmInstanceConnectionKeyHelp");
        expect(value).not.toBe("");
        expect(value).not.toContain("409");
        expect(value).toContain("连接冲突");
    });
});

/**
 * task-22 / P2-3：设置区四页的 eyebrow 原先是硬编码英文（`XH / Credentials` 等），
 * i18n 三查抓不到硬编码 ⇒ 这里两侧都钉：词表存在（zh 侧含中文）+ 源码里不许再写回英文。
 */
const EYEBROW_SOURCES = [
    "components/settings/credentials/CredentialsPanel.vue",
    "components/settings/AgentPrincipalsPanel.vue",
    "views/settings/AuditView.vue",
    "views/settings/ToolFacesView.vue",
] as const;

describe("设置区 eyebrow 走 i18n（task-22 P2-3）", () => {
    it("四个 eyebrow 词条存在且 zh 侧为中文", () => {
        for (const key of ["credentials", "agentPrincipals", "audit", "policy"] as const) {
            const value = zhCopy(`settings.eyebrow.${key}`);
            expect(value, key).not.toBe("");
            expect(value, key).toMatch(/[\u4e00-\u9fa5]/);
        }
    });

    it("四处页面源码不再硬编码英文 eyebrow", () => {
        for (const file of EYEBROW_SOURCES) {
            const source = readFileSync(resolve(SRC_ROOT, file), "utf8");
            // 行首即 eyebrow 文本才算硬编码（注释里提到旧字样不算）
            expect(source, file).not.toMatch(
                /^\s*XH\s*\/\s*(Credentials|Agent principals|Audit|Policy)\s*$/m,
            );
        }
    });
});
