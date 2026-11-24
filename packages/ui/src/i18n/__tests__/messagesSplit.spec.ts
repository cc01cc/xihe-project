import { describe, expect, it } from "vitest";

import { messages } from "../index";

/**
 * task-1027：`index.ts` 按域拆分后，聚合入口必须仍暴露原样的顶层域与双语键清单。
 * 这里断言的是**结构**（域集合 / 键路径），不是文案值 —— 文案由各业务卡自行演进。
 */
const DOMAINS = [
    "errors",
    "authErrors",
    "userQuestions",
    "teamBoard",
    "steer",
    "nav",
    "tabs",
    "files",
    "orgMembers",
    "workspaceNav",
    "standaloneChat",
    "standaloneDialog",
    "sidebar",
    "monitor",
    "workspacePicker",
    "workspace",
    "workspaceAgents",
    "chat",
    "resources",
    "knowledge",
    "settings",
    "multimodal",
    "validation",
    "common",
    "login",
    "register",
    "onboarding",
    "agentBindings",
    "agentPrincipals",
    "agentPrincipalDetail",
    "credentials",
    "sessionSettings",
];

type Tree = Record<string, unknown>;

function keyPaths(node: unknown, prefix = "", out: string[] = []): string[] {
    if (typeof node === "string") {
        if (prefix) out.push(prefix);
        return out;
    }
    if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node as Tree)) {
            keyPaths(value, prefix ? `${prefix}.${key}` : key, out);
        }
    }
    return out;
}

describe("i18n messages split", () => {
    it("聚合入口按原顺序暴露 32 个顶层域，两个 locale 域集合一致", () => {
        const zh = messages["zh-CN"] as Tree;
        const en = messages["en-US"] as Tree;
        expect(Object.keys(zh)).toEqual(DOMAINS);
        expect(Object.keys(en)).toEqual(DOMAINS);
    });

    it("zh-CN 与 en-US 的键路径集合逐条一致（不漏翻）", () => {
        const zh = keyPaths(messages["zh-CN"]).sort();
        const en = keyPaths(messages["en-US"]).sort();
        expect(zh).toEqual(en);
        expect(zh.length).toBeGreaterThan(0);
    });
});
