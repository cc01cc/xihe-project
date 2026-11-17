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

/** 取某 locale 某键的文案（走 messages 树，避免依赖当前 locale 状态）。 */
function copyOf(locale: "zh-CN" | "en-US", path: string): string {
    return (
        leaves(i18n.global.getLocaleMessage(locale)).find((leaf) => leaf.path === path)?.value ?? ""
    );
}

/**
 * task-251 / D-1043：**层名只能有一个**。
 * `settings.ia.layerUser`「个人配置」是导航组的"分组功能名"（保留）；层名 SSOT 是「个人层」。
 * `settings.contextTemplate.layerUser` 曾把同一层写成「用户层 / User layer」（第三个名字）⇒ 钉死。
 * 只钉这一对键（+ 同一文案里的帮助句），不做全文件快照：快照会因无关改动频繁红。
 */
describe("层名词典（task-251）：同一层只有一个层名", () => {
    it("contextTemplate.layerUser 不得用「用户层 / User layer」", () => {
        expect(copyOf("zh-CN", "settings.contextTemplate.layerUser"), "zh 层名").toBe("个人层");
        expect(copyOf("en-US", "settings.contextTemplate.layerUser"), "en 层名").toBe(
            "Personal layer",
        );
    });

    // task-108（2026-11-15）：本规则此前还有第二个见证键 `settings.ia.gapNoteAgent`（帮助句里不得写
    // 「用户层」）—— 该键已作为死文案删除（消费者 task-165 摘除、真入口 task-91 上线），断言随键一并收窄。
    // 删掉的是一条**见证**，不是规则：D-1043 仍由上面 contextTemplate.layerUser 那两个精确等值断言守。
});

/**
 * task-82 / D-1112 裁定 #2：层**标签**（左栏 / tab / 面包屑 / 命令面板等宽度紧张处）用「工作区默认」，
 * **去「值/层」后缀**；带「值」的「工作区默认值」是**概念名**，只留在正文句与台账/注释里。
 * 钉死标签键，防止「概念名漏进标签」（task-82 修复前的状态就是左栏写着「工作区默认值」）。
 */
describe("层标签（task-82 / D-1112）：宽度紧张的标签不带「值/层」后缀", () => {
    it("left-nav layer label is 工作区默认 / Workspace default", () => {
        expect(copyOf("zh-CN", "settings.ia.layerWorkspaceDefault"), "zh 左栏层标签").toBe(
            "工作区默认",
        );
        expect(copyOf("en-US", "settings.ia.layerWorkspaceDefault"), "en 左栏层标签").toBe(
            "Workspace default",
        );
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

/**
 * task-18 / D-1664：实体主名词标准化为 "Provider"（技术专名未译，如 API/MCP；跨 locale 一致）。
 * 两层钉死，参照既有规则形态：① Run 形态禁词扫描——zh 树任何角落不许再出现「提供商」；
 * ② 层名形态关键键精确等值——钉主名词键，防漂成第三个名字。只钉主名词，不做全文件快照。
 */
describe("Provider 主名词（task-18 / D-1664）：统一 Provider，不译「提供商」", () => {
    it("zh 文案不出现「提供商」（技术专名未译，如 API/MCP）", () => {
        const offenders = leaves(i18n.global.getLocaleMessage("zh-CN"))
            .filter((leaf) => leaf.value.includes("提供商"))
            .map((leaf) => `${leaf.path}: ${leaf.value}`);
        expect(offenders).toEqual([]);
    });

    it("关键键钉死：domainLlmProvider / provider / providerSelect / addProvider", () => {
        expect(copyOf("zh-CN", "settings.domainLlmProvider"), "zh 域标签").toBe("LLM Provider");
        expect(copyOf("en-US", "settings.domainLlmProvider"), "en 域标签").toBe("LLM Provider");
        expect(copyOf("zh-CN", "settings.provider"), "zh 字段标签").toBe("Provider");
        expect(copyOf("en-US", "settings.provider"), "en 字段标签").toBe("Provider");
        expect(copyOf("zh-CN", "settings.providerSelect"), "zh 选择占位").toBe("选择 Provider");
        expect(copyOf("zh-CN", "settings.addProvider"), "zh 添加按钮").toBe("添加 Provider");
    });
});

/** 汉字探测走码点，避开 `\p{Script=Han}` 在不同解析路径下的转义差异。 */
function hasHan(value: string): boolean {
    for (const ch of value) {
        const code = ch.codePointAt(0) ?? 0;
        if (code >= 19968 && code <= 40959) return true; // U+4E00–U+9FFF（CJK 统一表意文字区间）
    }
    return false;
}

function lastPathSegment(path: string): string {
    const segments = path.split(".");
    return segments[segments.length - 1] ?? "";
}

/** 键名以 Human/Agent 结尾的一族 = 身份类别标签（`kindHuman` / `creatorHuman` / `mentionAgent` …）。 */
function isIdentityLabelKey(path: string): boolean {
    return /(Human|Agent)(s?)$/.test(lastPathSegment(path));
}

/** 值的英文化形态：小写、去空白后**整体只由**身份类别词构成 ⇒ 「裸英文类别名」。 */
const IDENTITY_WORD = new Set([
    "human",
    "agent",
    "user",
    "service",
    "system",
    "principal",
    "member",
    "person",
    "people",
    "bot",
]);

function isBareEnglishIdentity(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    if (!/^[a-z ]+$/.test(normalized)) return false;
    const words = normalized.match(/[a-z]+/g) ?? [];
    if (words.length === 0) return false;
    return (
        words.every((word) => IDENTITY_WORD.has(word)) &&
        words.some((word) => word === "human" || word === "agent")
    );
}

/**
 * task-88：身份类别标签（人类 / 智能体）在 zh 树里必须是**中文词**。
 *
 * <p>改前缺陷：`workspace.scheduledTasks.creatorHuman` 的值是字面 `"human"`，于是定时任务列表的
 * 「创建者」列渲染成「阿岚 human」—— 中文界面里的类别名是英文，与同列「智能体」中英混排。
 * 同族三键（`orgMembers.kindHuman` / `workspace.participantKindHuman` / `chat.input.mentionHuman`）
 * 早已是「人类」⇒ 它是漏网而非约定，判 A（纯漏译）。术语依据见 DEV-032 §1.1a「agent = 智能体」
 * 正名，以及 zh 侧「描述性 Agent 一律译作智能体」的既有 sweep（PLAN-0622 口径）。</p>
 *
 * <p><b>为什么这是语义判据而不是快照</b>：判据只约束「有没有汉字」「是不是裸英文类别词」，
 * **不钉具体选词** —— `creatorHuman` 换成「人类」「人类成员」「人工」任一合法中文词都不红，
 * 只有写回英文（`human` / `Human` / `agent` …）才红。快照式 `=== "人类"` 则会在每次正常改词时假红，
 * 与本文件既有规则「不做全文件快照」的口径一致。</p>
 *
 * <p>两条判据互补：① 按**键名**扫（抓住「这一族标签被写成英文」）；② 按**值**扫（抓住
 * 「新键名不在这一族、值仍是裸英文类别名」，例如改名后的 `creatorKind: "human"`）。
 * 只留 ① 会漏掉这类改名后新增的键。</p>
 *
 * <p><b>为什么 ② 要排除「刻意保留英文的技术专名」**：zh 树里确有应当保留英文的键（如
 * `settings.providerHub.scopeWorkspace: "Workspace"` —— provider 连接 scope 的技术标识，
 * 与 `Provider` / `API key` 同一策略）。② 只点 human/agent，正是把「身份类别必须中文」这一条
 * 与「技术专名保留英文」区分开；把全部英文词一禁，判据会先红在不是缺陷的地方。</p>
 */
describe("身份类别标签（task-88）：zh 的人类 / 智能体类别名必须是中文词", () => {
    it("① 键名以 Human/Agent 结尾的 zh 文案必须含汉字（不得是裸英文类别名）", () => {
        const offenders = leaves(i18n.global.getLocaleMessage("zh-CN"))
            .filter((leaf) => isIdentityLabelKey(leaf.path) && !hasHan(leaf.value))
            .map((leaf) => `${leaf.path}: ${leaf.value}`);
        // 改前读数：唯一红点 = `workspace.scheduledTasks.creatorHuman: human`。
        expect(offenders).toEqual([]);
    });

    it("② zh 文案里不存在「值整体就是裸英文身份词」的条目（键名不限）", () => {
        const offenders = leaves(i18n.global.getLocaleMessage("zh-CN"))
            .filter((leaf) => isBareEnglishIdentity(leaf.value))
            .map((leaf) => `${leaf.path}: ${leaf.value}`);
        expect(offenders).toEqual([]);
    });

    it("③ 反向：en 侧同族键不得出现汉字（防把中文抄进英文 locale）", () => {
        const offenders = leaves(i18n.global.getLocaleMessage("en-US"))
            .filter((leaf) => isIdentityLabelKey(leaf.path) && hasHan(leaf.value))
            .map((leaf) => `${leaf.path}: ${leaf.value}`);
        expect(offenders).toEqual([]);
    });
});
