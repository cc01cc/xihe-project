import { describe, expect, it } from "vitest";
import { i18n } from "../index";

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
