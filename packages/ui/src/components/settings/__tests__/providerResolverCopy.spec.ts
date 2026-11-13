import { describe, expect, it } from "vitest";
import { i18n } from "../../../i18n";

/**
 * task-167 / task-152 定稿 resolver 文案断言。
 *
 * 最终语义：profile 整组按 workspace > workspace-default > user > instance 取第一组存在的配置（无键级合并）；
 * 连接归属提供该 profile 的那一层（owner 规则，不是优先序）；该层连接不可用时唯一末位
 * 兜底 = 共享 INSTANCE 连接；不跨层搜索连接。旧口径（"连接与密钥由使用者的个人/工作区
 * 连接提供"、"实例 profile 落到消费用户的个人连接"这类无兜底的 USER 直连陈述）不得回流。
 */
type Dict = { [key: string]: unknown };

const zh = i18n.global.getLocaleMessage("zh-CN") as Dict;
const en = i18n.global.getLocaleMessage("en-US") as Dict;

const ZH_FINAL =
    "模型配置按 工作区 > 工作区默认 > 个人 > 实例 的顺序取第一组存在的配置；连接归属提供该配置的那一层，仅当该层连接不可用时才回退到实例共享连接，不会改用其他层的个人或工作区连接。";
const EN_FINAL =
    "Profiles resolve as a whole unit in the order workspace > workspace-default > personal > instance; the connection belongs to the layer that supplied the profile, falling back to the shared instance connection only when that layer's connection is unavailable - connections from other layers are never used.";

function settings(dict: Dict): Dict {
    return dict.settings as Dict;
}

function providerHub(dict: Dict): Dict {
    return settings(dict).providerHub as Dict;
}

describe("provider resolver copy（task-152 定稿语义）", () => {
    it("长语境使用定稿句（实例层 note + 连接作用域说明）", () => {
        expect(settings(zh).providerInstanceNote).toBe(ZH_FINAL);
        expect(providerHub(zh).scopeNoteBody).toContain(ZH_FINAL);
        expect(settings(en).providerInstanceNote).toBe(EN_FINAL);
        expect(providerHub(en).scopeNoteBody).toContain(EN_FINAL);
    });

    it("旧口径不再出现（zh/en 两侧全量扫描）", () => {
        const zhAll = JSON.stringify(zh);
        const enAll = JSON.stringify(en);
        for (const stale of [
            "连接与密钥由使用者的个人/工作区连接提供",
            "连接仍由使用者的个人/工作区连接提供",
            "实际解析仍走使用者自己的连接",
            "实例 profile 落到消费用户的个人连接",
            "连接在用户作用域解析",
        ]) {
            expect(zhAll).not.toContain(stale);
        }
        for (const stale of [
            "connections and credentials come from the user's personal/workspace connections",
            "resolution still uses the consumer's own connections",
            "an instance profile resolves to the consuming user's user connection",
            "the connection resolves in the user scope",
        ]) {
            expect(enAll).not.toContain(stale);
        }
    });

    it("短标签型 embedding 文案同口径（供给层归属 + 末位兜底）", () => {
        expect(settings(zh).embeddingInstanceNote).toContain("连接归属随供给层");
        expect(settings(zh).embeddingInstanceNote).toContain("末位回退共享实例连接");
        expect(settings(en).embeddingInstanceNote).toContain(
            "the connection follows the supplying layer",
        );
        expect(settings(en).embeddingInstanceNote).toContain("shared instance connection");
    });

    it("实例层分区描述与默认模型描述不再声称 USER 直连", () => {
        // llmInstanceDefaultDesc 仍承载 owner 规则「连接归属随配置供给层」（task-284 未改它），正向锚点保留。
        expect(String(settings(zh).llmInstanceDefaultDesc)).toContain("连接归属随配置供给层");
        expect(String(settings(en).llmInstanceDefaultDesc)).toContain("the connection follows");
        // providerPartitionDescInstance 经 task-284/D-1140 四层文案改写，改述「分区结构 + 默认身份是派生值」，
        // 不再复述连接归属 —— 该语义由 providerInstanceNote / providerHub.scopeNoteBody 承载（见上一条用例，
        // 仍 toBe 定稿句）⇒ 属合法改写而非文案回归。此处同步到现行正确文案的正向锚点（不是第二套真源）。
        expect(String(settings(zh).providerPartitionDescInstance)).toContain("默认身份");
        expect(String(settings(zh).providerPartitionDescInstance)).toContain("不是第二套真源");
        expect(String(settings(en).providerPartitionDescInstance)).toContain("default identity");
        expect(String(settings(en).providerPartitionDescInstance)).toContain(
            "not a second source of truth",
        );
        // 本意（负断言，不弱化）：两个实例层描述都不许回流「USER 直连」旧口径。
        for (const value of [
            settings(zh).providerPartitionDescInstance,
            settings(zh).llmInstanceDefaultDesc,
        ]) {
            expect(String(value)).not.toContain("实例 profile 落到消费用户的个人连接");
            expect(String(value)).not.toContain("连接与密钥由使用者的个人/工作区连接提供");
        }
        for (const value of [
            settings(en).providerPartitionDescInstance,
            settings(en).llmInstanceDefaultDesc,
        ]) {
            expect(String(value)).not.toContain(
                "an instance profile resolves to the consuming user's user connection",
            );
            expect(String(value)).not.toContain(
                "connections and credentials come from the user's personal/workspace connections",
            );
        }
    });
});
