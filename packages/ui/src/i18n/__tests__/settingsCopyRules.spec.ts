import { describe, expect, it } from "vitest";
import { i18n } from "../index";

/**
 * task-509（T-02 / T-07）：**用户可见文案不得出现内部编号与实现标识**。
 *
 * <p>起因（task-507 选题表第 1 条）：左栏缺口徽标直出「后端缺口 G4」，悬停提示出现
 * `mcp_remote_servers` / `workspace_id` 这类表名列名；用户读到的不是能力缺失，而是
 * 「数据库长什么样」—— 后果是**永久误解**系统模型，且不会因为后续修好样式被挽回。</p>
 *
 * <p>判据为什么写成数据驱动（扫 locale 树）而不是逐个渲染断言：文案在 6 个组件里出现，
 * 逐个挂载只会覆盖「我今天想到的那几处」；扫树是**全集**判据，新增文案自动纳入。
 * 代价是它测的是 locale 值而不是最终 DOM —— 因此组件侧另有两条渲染断言（徽标文本 +
 * 提示 title），两侧都在。</p>
 *
 * <p>规则（全部可证伪，不看「好读不好读」）：<br>
 * ① 不出现 `G1…G9` 这类缺口编号；<br>
 * ② 不出现 snake_case 标识符（表名/列名/枚举值，如 `mcp_remote_servers`、`owner_type`）；<br>
 * ③ 不出现 D-/PLAN-/BL- 编号（内部决策号不属于用户界面）；<br>
 * ④ 不出现「缺口」这个内部概念词（用户语言是「暂不可用 / 尚未提供」）。</p>
 */
type Flat = Array<{ path: string; value: string }>;

function flatten(node: unknown, prefix = ""): Flat {
    if (typeof node === "string") return [{ path: prefix, value: node }];
    if (node && typeof node === "object") {
        return Object.entries(node as Record<string, unknown>).flatMap(([key, child]) =>
            flatten(child, prefix ? prefix + "." + key : key),
        );
    }
    return [];
}

const LOCALES = ["zh-CN", "en-US"] as const;

function settingsCopy(locale: (typeof LOCALES)[number]): Flat {
    const message = i18n.global.getLocaleMessage(locale) as Record<string, unknown>;
    return flatten(message.settings, "settings");
}

const RULES: Array<{ name: string; test: (value: string) => boolean; sample: string }> = [
    { name: "缺口编号 G1…G9", test: (v) => /\bG\d\b/.test(v), sample: "后端缺口 G4" },
    {
        name: "snake_case 标识符（表名/列名/枚举值）",
        test: (v) => /[a-z][a-z0-9]*_[a-z0-9_]+/.test(v),
        sample: "mcp_remote_servers 的 workspace_id",
    },
    {
        name: "内部编号 D-/PLAN-/BL-",
        test: (v) => /\b(D|PLAN|BL)-\d{2,5}\b/.test(v),
        sample: "D-951 排期",
    },
    {
        name: "内部概念词「缺口」",
        test: (v) => /缺口/.test(v) || /\bbackend gap\b/i.test(v),
        sample: "后端缺口",
    },
];

describe("设置区用户可见文案：不得出现内部编号与实现标识（task-509）", () => {
    for (const locale of LOCALES) {
        describe(locale, () => {
            const copy = settingsCopy(locale);
            for (const rule of RULES) {
                it(`不含${rule.name}`, () => {
                    const offenders = copy
                        .filter((entry) => rule.test(entry.value))
                        .map((entry) => entry.path + " = " + JSON.stringify(entry.value));
                    // 失败信息给「键路径 + 原文」，不写"有违规" —— 否则还得自己 grep 一遍。
                    expect(offenders, `示例违规形态：${rule.sample}`).toEqual([]);
                });
            }
        });
    }
});
