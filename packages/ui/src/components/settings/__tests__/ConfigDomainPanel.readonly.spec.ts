import { describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import ConfigDomainPanel, { type DomainField } from "../ConfigDomainPanel.vue";
import JsonFieldEditor from "../JsonFieldEditor.vue";
import { formatJsonText } from "../jsonFieldFormat";
import { jsonDocText } from "./jsonEditorAsserts";
import { i18n } from "../../../i18n";
import type { ConfigKeyMeta } from "../../../stores/config";

/**
 * task-23 / P2-6：JSON 长值在**只读态**不许单行截断。
 *
 * 为什么这条要单独立 spec：可编辑态本来就是 `<textarea rows="3">`（实测 74 px），
 * 缺陷只在 `readonly`（整域只读 / 实例专属键落到下层）时的取值 span —— 而那一路
 * 在 mock 预览里**拍不到**（mock 账号持有 `MANAGE_WORKSPACE_DEFAULT_CONFIG`，页面始终是可编辑态，
 * 见 `evidence/2026-11-11-settings-p2/p02-probe.json`），所以只能靠组件级断言钉住。
 */
const JSON_VALUE =
    '{"fingerprintEnabled":true,"softThresholdPct":70,"hardThresholdPct":85,' +
    '"keepRecentMessages":12,"agentsMdMaxBytes":65536,"envMaxBytes":32768}';

function meta(key: string): ConfigKeyMeta {
    return {
        key,
        source: "instance",
        locked: false,
        writable: true,
        reason: null,
        instanceEligible: true,
        defaultPresent: true,
        overridable: true,
        adminLocked: false,
        lockReason: null,
    };
}

async function mountReadonly(schema: DomainField[], entries: Record<string, string>) {
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: "/settings/:layer/:domain", component: { template: "<div />" } }],
    });
    const wrapper = mount(ConfigDomainPanel, {
        props: {
            domain: "context-policy",
            title: "上下文策略",
            entries,
            schema,
            meta: Object.fromEntries(schema.map((field) => [field.key, meta(field.key)])),
            layer: "workspace-default",
            readonly: true,
        },
        global: { plugins: [i18n, router] },
    });
    // task-225 起域卡默认展开 ⇒ 字段行挂载即渲染；这里只为旧形态（字段行缺失）兜底点一次。
    if (!wrapper.find('[data-testid^="config-field-"]').exists()) {
        await wrapper.find("button").trigger("click");
    }
    return wrapper;
}

describe("ConfigDomainPanel 只读长值（task-23 P2-6）", () => {
    it("JSON 字段的只读取值换行显示，不再 truncate", async () => {
        const wrapper = await mountReadonly(
            [
                { key: "defaults", label: "压缩默认值（JSON）", type: "json" },
                { key: "models", label: "按模型覆盖（JSON）", type: "json" },
            ],
            { defaults: JSON_VALUE, models: "{}" },
        );

        const value = wrapper
            .findAll("span")
            .find((node) => node.text().includes("fingerprintEnabled"));
        expect(value).toBeTruthy();
        const classes = value!.classes();
        // 关键：单行截断类必须不在，多行三个类必须在
        expect(classes).not.toContain("truncate");
        expect(classes).toContain("whitespace-pre-wrap");
        expect(classes).toContain("break-all");
        expect(classes).toContain("overflow-y-auto");
        // task-337 R1 起：只读态**也**是缩进态（task-23 当时断言的「不格式化」已作废 —— 见下方 R1 用例）。
        expect(value!.text()).toContain('"keepRecentMessages": 12');
        wrapper.unmount();
    });

    it("非多行类型（text）的只读取值仍保持单行 truncate", async () => {
        const wrapper = await mountReadonly(
            [{ key: "summaryProvider", label: "摘要提供方", type: "text" }],
            { summaryProvider: "anthropic" },
        );

        const value = wrapper.findAll("span").find((node) => node.text() === "anthropic");
        expect(value).toBeTruthy();
        expect(value!.classes()).toContain("truncate");
        expect(value!.classes()).not.toContain("whitespace-pre-wrap");
        wrapper.unmount();
    });
});

/**
 * **task-337（R1）：只读态的 JSON 也要格式化，且只影响显示。**
 *
 * 为什么单独立一节：格式化此前只发生在 `JsonFieldEditor`（可编辑态）里，只读分支渲染的是原文 span
 * ⇒ 「整域只读」时单行 JSON 仍是一行长文本。这条由 task-337 补（task-216 只做前提核查、未改源码）。
 *
 * 两条判据都要钉（Lead 给的理由，照抄）：
 * 1. **只读显示是缩进态**；
 * 2. **`editing` 草稿逐字节不变** —— 只钉 ① 会掩盖「顺手改了草稿」，而草稿一变，用户一保存
 *    就把格式化写回数据库。
 *
 * 三种只读来源（整域只读 / 层只读 / 无权限）**各自给读数**：它们在代码里不是同一个分支 ——
 * 整域只读走 span，层只读与无权限仍渲染禁用控件走 `JsonFieldEditor` ⇒ 一种绿不代表三种绿。
 */
const EXPECTED_PRETTY = formatJsonText(JSON_VALUE).text;

type MountOverrides = Partial<{
    readonly: boolean;
    layer: "instance" | "user" | "workspace-default";
    entries: Record<string, string>;
    meta: Record<string, ConfigKeyMeta>;
    schema: DomainField[];
}>;

async function mountPanel(overrides: MountOverrides = {}) {
    const schema = overrides.schema ?? [
        { key: "defaults", label: "压缩默认值（JSON）", type: "json" as const },
    ];
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: "/settings/:layer/:domain", component: { template: "<div />" } }],
    });
    await router.push("/settings/workspace-default/context-policy");
    await router.isReady();
    const wrapper = mount(ConfigDomainPanel, {
        props: {
            domain: "context-policy",
            title: "上下文策略",
            entries: overrides.entries ?? { defaults: JSON_VALUE },
            schema,
            meta:
                overrides.meta ??
                Object.fromEntries(schema.map((field) => [field.key, meta(field.key)])),
            layer: overrides.layer ?? "workspace-default",
            readonly: overrides.readonly ?? false,
        },
        global: { plugins: [i18n, router] },
    });
    await flushPromises();
    return wrapper;
}

const JSON_TESTID = "config-json-context-policy-defaults";
const JSON_HOST = "[data-testid^=config-json-context-policy-defaults]";
const SAVE_LABEL = i18n.global.t("common.save");

function findSaveButton(wrapper: ReturnType<typeof mount>) {
    return wrapper.findAll("button").find((item) => item.text() === SAVE_LABEL);
}

describe("task-337 R1 · 只读来源二：层只读（实例专属键落到下层）", () => {
    it("显示已格式化（task-286 既有），且该键不进 save 载荷", async () => {
        // 层只读的真实开关是 **schema 的 instanceOnly**（非实例层里 meta 根本没有这些键：
        // 见 ConfigDomainPanel 的 isInstanceOnlyField 注释 —— CP 对非实例层直接 continue）。
        const wrapper = await mountPanel({
            layer: "workspace-default",
            schema: [
                { key: "defaults", label: "压缩默认值（JSON）", type: "json", instanceOnly: true },
            ],
        });

        // 读数 1：走**禁用控件**这条路（不是 span）—— 与「整域只读」不是同一分支。
        expect(wrapper.find(JSON_HOST).exists()).toBe(true);
        // 读数 2：文档已是缩进态（task-286 的 seedOnce），不是本卡新增的能力。
        expect(jsonDocText(wrapper, JSON_TESTID)).toBe(EXPECTED_PRETTY);
        // 读数 3（判据 ② 的边界，**如实登记**）：这条路的草稿是被 seed 改过的 —— 既有行为、非本卡引入。
        // 钉住它是为了让「按层推导出只读」不会悄悄退化成「不格式化」。
        expect(wrapper.findComponent(JsonFieldEditor).props("modelValue")).toBe(EXPECTED_PRETTY);

        // 读数 4（安全性质）：草稿虽变，handleSave 按 isLayerReadonlyKey/isWritable 过滤 ⇒ 不进载荷。
        const saveButton = findSaveButton(wrapper);
        expect(saveButton, "找不到保存按钮（用 common.save 文案匹配）").toBeTruthy();
        await saveButton!.trigger("click");
        await flushPromises();
        expect(wrapper.emitted("save")![0]?.[0]).not.toHaveProperty("defaults");
        wrapper.unmount();
    });
});

describe("task-337 R1 · 只读来源三：无权限（meta.writable=false）", () => {
    it("显示已格式化，且该键不进 save 载荷", async () => {
        const wrapper = await mountPanel({
            layer: "instance",
            meta: { defaults: { ...meta("defaults"), writable: false } },
        });

        expect(wrapper.find(JSON_HOST).exists()).toBe(true);
        expect(jsonDocText(wrapper, JSON_TESTID)).toBe(EXPECTED_PRETTY);

        // 无权限时**保存按钮本身就禁用**（:disabled = 没有可写键），比「发了但过滤掉」更靠前。
        const saveButton = findSaveButton(wrapper);
        expect(saveButton, "找不到保存按钮（用 common.save 文案匹配）").toBeTruthy();
        expect(saveButton!.attributes("disabled")).toBeDefined();
        await saveButton!.trigger("click");
        await flushPromises();
        expect(wrapper.emitted("save"), "禁用按钮不该发出保存").toBeUndefined();
        wrapper.unmount();
    });
});

describe("task-337 R1 · 只读来源一：整域只读（本卡补的那条）", () => {
    it("显示为缩进态；entries 逐字节不变、无保存动作", async () => {
        const wrapper = await mountReadonly(
            [{ key: "defaults", label: "压缩默认值（JSON）", type: "json" }],
            { defaults: JSON_VALUE },
        );

        const value = wrapper
            .findAll("span")
            .find((node) => node.text().includes("fingerprintEnabled"));
        expect(value).toBeTruthy();
        // 前置：格式化确实「改了东西」—— 否则下面的相等断言会因为两者本来一样而假绿。
        expect(EXPECTED_PRETTY).not.toBe(JSON_VALUE);
        expect(EXPECTED_PRETTY).toContain("\n");
        // 读数 1：显示 = 缩进态（两空格缩进 + 真换行）。
        expect(value!.text()).toBe(EXPECTED_PRETTY);
        expect(value!.text()).toContain("\n  ");
        // 读数 2：显示变了、值没变 —— props 仍是原始单行串，且没有发生保存。
        expect(wrapper.props("entries").defaults).toBe(JSON_VALUE);
        expect(wrapper.emitted("save")).toBeUndefined();
        wrapper.unmount();
    });

    it("非法 JSON 原样显示：不改写、不报错（判据 ②）", async () => {
        const broken = '{"fingerprintEnabled": true,}';
        const wrapper = await mountReadonly(
            [{ key: "defaults", label: "压缩默认值（JSON）", type: "json" }],
            { defaults: broken },
        );

        const value = wrapper
            .findAll("span")
            .find((node) => node.text().includes("fingerprintEnabled"));
        expect(value).toBeTruthy();
        expect(value!.text()).toBe(broken);
        // 只读态没有输入框，也就不该挂错误提示（不新增前端校验规则）。
        expect(wrapper.find("[data-testid$=-error]").exists()).toBe(false);
        wrapper.unmount();
    });
});
