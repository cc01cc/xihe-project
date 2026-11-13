import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ConfigDomainPanel, { type DomainField } from "../settings/ConfigDomainPanel.vue";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter } from "vue-router";
import { openSelectAt, selectCount, selectItemTexts, selectValueAt } from "../../test-utils/select";

const i18n = createI18n({
    legacy: false,
    locale: "en",
    messages: {
        en: {
            settings: {
                notSet: "(not set)",
                empty: "(empty)",
                resetToDefault: "Reset",
                configKeyInstanceOnlyBadge: "Instance only",
                configKeyInstanceOnlyHint:
                    "This key only takes effect at the instance layer: user and workspace layers neither inherit nor can modify it",
                configCardFieldCount: "{count} fields",
                configCardExpandHint: "Expand to see all settings",
                // task-225（默认展开）暴露的夹具缺口：这些行原先被折叠挡住、从未渲染，
                // 于是「裸 i18n 键」守卫一直是**空过**的。补键不放宽断言（守卫照旧全量扫渲染结果）。
                configSourceInstance: "instance",
                configSourceEnv: "环境变量锁定",
                configSourceOverridable: "可被覆盖",
                configSourceInstanceOnly: "仅 instance",
                configSourceInheritedAbove: "继承自上层",
                configSourceReadonly: "只读",
                configSourceUser: "个人覆盖",
                configSourceUserOverride: "个人覆盖此项",
                configSourceNone: "未设置",
                envLockedHint: "env 覆盖",
                adminLockedBadge: "由管理员锁定",
                adminLockReason: "锁定原因：{reason}",
                adminLockValueAtInstance: "以实例层取值为准",
                driftedBadge: "漂移",
                driftedOption: "漂移：{value}",
                driftedClear: "清除",
                driftedHint: "候选集里没有该值",
                customOption: "自定义",
                customPlaceholder: "输入",
                customBack: "回到候选列表",
            },
            common: { save: "Save" },
        },
    },
});

const schema: DomainField[] = [
    {
        key: "mode",
        label: "Provider",
        type: "select",
        options: [
            { label: "DeepSeek", value: "deepseek" },
            { label: "OpenAI", value: "openai" },
        ],
    },
    { key: "apiKey", label: "API Key", type: "password" },
    { key: "model", label: "Model", type: "text" },
    { key: "maxTokens", label: "Max Tokens", type: "number" },
];

/** task-133：组件现在读 `route.hash` 并在徽标点击时 `router.push`，单测必须挂真路由。 */
function makeRouter() {
    return createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: "/settings/instance/:domain", component: { template: "<div />" } },
            { path: "/settings/user/:domain", component: { template: "<div />" } },
        ],
    });
}

function mountPanel(props: Record<string, unknown> = {}) {
    return mount(ConfigDomainPanel, {
        props: {
            domain: "test",
            title: "Test Domain",
            entries: {},
            schema,
            ...props,
        },
        global: { plugins: [i18n, makeRouter()] },
    });
}

async function expandPanel(wrapper: ReturnType<typeof mountPanel>) {
    // task-225 起域卡默认展开 ⇒ 只在字段行缺失时点一次（两态都成立）。
    if (!wrapper.find('[data-testid^="config-field-"]').exists()) {
        await wrapper.find("button").trigger("click");
    }
}

describe("ConfigDomainPanel", () => {
    /**
     * task-225（用户 2026-11-13：「默认都是合拢的，用户还得多次点击」）：域卡**默认展开**。
     *
     * <p>判据分两半，且两半都必须有数：①**初始 DOM 里字段就可见**（零点击，数的是
     * `config-field-*` 节点数而不是 class 名）；②折叠**能力保留**且可逆 —— 点一下才出现
     * 箭头/计数/摘要行（原先这些是"默认态"的外观，现在它们是"用户收起后"的外观）。</p>
     */
    it("TC-F10: 默认展开（零点击可见字段）；点标题才收起，收起态才显示 chevron/计数/摘要", async () => {
        const wrapper = mountPanel({ entries: {} });
        const toggle = wrapper.get('[data-testid="config-domain-toggle-test"]');

        // ① 默认态 = 展开：不看 class，看「字段行是否已在 DOM 里」
        expect(toggle.attributes("aria-expanded")).toBe("true");
        expect(toggle.text()).toContain("▾");
        expect(toggle.text()).toContain("Test Domain");
        expect(wrapper.findAll('[data-testid^="config-field-"]')).toHaveLength(4);
        expect(wrapper.find('[data-testid="config-domain-preview-test"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="config-domain-field-count-test"]').exists()).toBe(false);

        // ② 用户显式收起：箭头与标签同行（不再是一个远在 1080 px 卡右端的 ▸）
        await toggle.trigger("click");
        expect(toggle.attributes("aria-expanded")).toBe("false");
        expect(toggle.text()).toContain("▸");
        expect(wrapper.findAll('[data-testid^="config-field-"]')).toHaveLength(0);
        // 摘要行：没有级联摘要时回落成「展开查看全部设置」
        expect(toggle.get('[data-testid="config-domain-preview-test"]').text()).toBe(
            "Expand to see all settings",
        );
        // 计数徽标 = 本卡字段数（H4 行徽标口径）
        expect(toggle.get('[data-testid="config-domain-field-count-test"]').text()).toBe(
            "4 fields",
        );

        // 给了 summary 就显示 summary（用户偏好那类域有内容可给）—— 同样只在收起态可见
        const withSummary = mountPanel({ entries: {}, summary: "deepseek / model" });
        await withSummary.get('[data-testid="config-domain-toggle-test"]').trigger("click");
        expect(withSummary.get('[data-testid="config-domain-preview-test"]').text()).toBe(
            "deepseek / model",
        );

        // 折叠能力保留且可逆：再点一次回到展开态
        await toggle.trigger("click");
        expect(toggle.attributes("aria-expanded")).toBe("true");
        expect(wrapper.findAll('[data-testid^="config-field-"]')).toHaveLength(4);
    });
    /**
     * task-225 判据①：可读性（对比度有数）。**数值判定在卡面**（token 计算值，WCAG 2.x 公式，
     * 由 `oklch → sRGB → 相对亮度` 推得，见 task-225 卡面 §对比度读数）：
     *   标签：`--muted-foreground`(108,108,108) 对 `--background`(245,245,245) = **4.84:1**（过 4.5，余量仅 8%）
     *         ⇒ 改 `text-foreground`(10,10,10) = **18.15:1**
     *   锁定值：`--muted-foreground` 对 `--muted`(232,232,232) = **4.30:1（未过 4.5）**
     *         ⇒ 改 `text-foreground` = **16.11:1**
     *   控件边框：裸 `border` 取 `--border`(229) 对 `--background` = **1.15:1（白底上几乎看不见）**
     *         ⇒ 改 `border-foreground/50`（10 以 50% 叠在 245 上 = 128）= **3.62:1**（过 WCAG 1.4.11 的 3:1）
     *
     * <p>jsdom 没有级联与布局 ⇒ 这里只能钉住**决定对比度的类**（数值断言在真实浏览器里做，
     * 否则 @supports/变量解析差异会让断言在 jsdom 里恒真）。</p>
     */
    it("可读性：标签/锁定值/控件边框都用够对比度的既有 token（task-225）", async () => {
        const wrapper = mountPanel({
            entries: { model: "db-model", maxTokens: "4096" },
            envLocked: { maxTokens: "8192" },
        });

        // ① 标签块与 FieldLabel 不再用 muted-foreground（4.84:1 且 12px 正文字号余量太薄）
        const labelBlock = wrapper.get(
            String.raw`[data-testid="config-field-test-model"] .text-foreground.w-1\/3`,
        );
        expect(labelBlock.classes()).toContain("text-foreground");
        expect(labelBlock.find("label").classes()).toContain("text-foreground");

        // ② 可编辑控件的边框：不是裸 border（=--border 1.15:1），而是 foreground/50（3.62:1）
        const control = wrapper.get('[data-testid="config-field-test-model"] input');
        expect(control.classes()).toContain("border-foreground/50");
        expect(control.classes()).not.toContain("border-input");

        // ③ env 锁定值（只读 chip）：文字用 foreground（16.11:1），底色仍 muted（不改语义）
        const locked = wrapper.get('[data-testid="config-env-lock-test-maxTokens"]');
        expect(locked.classes()).toContain("text-foreground");
        expect(locked.classes()).toContain("bg-muted");
        expect(locked.text()).toBe("8192");
    });

    it("TC1: renders all schema fields when entries is empty", async () => {
        const wrapper = mountPanel({ entries: {} });
        await expandPanel(wrapper);

        const labels = wrapper.findAll(String.raw`.text-foreground.w-1\/3`);
        expect(labels).toHaveLength(4);
        expect(labels[0].text()).toBe("Provider");
        expect(labels[1].text()).toBe("API Key");
        expect(labels[2].text()).toBe("Model");
        expect(labels[3].text()).toBe("Max Tokens");
    });

    it("TC2: fills values from entries", async () => {
        const wrapper = mountPanel({
            entries: {
                mode: "deepseek",
                apiKey: "sk-xxx",
                model: "gpt-4",
                maxTokens: "4096",
            },
        });
        await expandPanel(wrapper);

        const inputs = wrapper.findAll("input");
        expect(selectValueAt(wrapper, 0)).toBe("deepseek");
        expect(inputs[0].element.value).toBe("sk-xxx");
        expect(inputs[1].element.value).toBe("gpt-4");
        expect(inputs[2].element.value).toBe("4096");
    });

    it("TC3: missing entry fields default to empty string", async () => {
        const wrapper = mountPanel({
            entries: { model: "gpt-4" },
        });
        await expandPanel(wrapper);

        const inputs = wrapper.findAll("input");
        expect(inputs[0].element.value).toBe("");
        expect(inputs[1].element.value).toBe("gpt-4");
        expect(inputs[2].element.value).toBe("");
    });

    it("TC4: readonly mode shows text instead of inputs", async () => {
        const wrapper = mountPanel({
            entries: { apiKey: "sk-12345678", model: "gpt-4" },
            readonly: true,
        });
        await expandPanel(wrapper);

        expect(wrapper.find("input").exists()).toBe(false);
        expect(selectCount(wrapper)).toBe(0);
        const spans = wrapper.findAll(".flex-1.text-sm"),
            passwordSpan = spans.find((s) => s.text().includes("****"));
        expect(passwordSpan).toBeTruthy();
        expect(passwordSpan!.text()).toBe("sk-****5678");
    });

    it("TC5: select type renders dropdown with options", async () => {
        const wrapper = mountPanel();
        await expandPanel(wrapper);

        expect(selectCount(wrapper)).toBe(1);
        await openSelectAt(wrapper, 0);
        expect(selectItemTexts(wrapper)).toEqual(["DeepSeek", "OpenAI"]);
    });

    it("TC6: save emits editing values", async () => {
        const wrapper = mountPanel({
            entries: { apiKey: "sk-old", model: "old-model" },
        });
        await expandPanel(wrapper);

        const modelInput = wrapper.findAll("input")[1];
        await modelInput.setValue("new-model");
        await wrapper
            .findAll("button")
            .filter((b) => b.text() === "Save")[0]
            .trigger("click");

        const emitted = wrapper.emitted("save");
        expect(emitted).toBeTruthy();
        expect(emitted![0][0]).toEqual({
            apiKey: "sk-old",
            model: "new-model",
        });
    });

    it("TC7: admin mode shows reset button and emits reset", async () => {
        const wrapper = mountPanel({ layer: "instance" });
        await expandPanel(wrapper);

        const resetButtons = wrapper.findAll("button").filter((b) => b.text().includes("↺"));
        expect(resetButtons.length).toBe(4);

        await resetButtons[2].trigger("click");
        const emitted = wrapper.emitted("reset");
        expect(emitted).toBeTruthy();
        expect(emitted![0][0]).toBe("model");
    });

    it("TC7b: reset clears that field's draft so the input does not keep the deleted value", async () => {
        // task-74 B1 实测缺陷：editing 草稿只在展开时初始化，重置（父层 DELETE + 整层 reload）后
        // props.entries 变了草稿不重算 ⇒ 输入框留着刚被删掉的旧值（"点了重置没反应"）。
        const wrapper = mountPanel({ layer: "instance", entries: { model: "db-model" } });
        await expandPanel(wrapper);
        const input = wrapper
            .findAll("input")
            .find((el) => (el.element as HTMLInputElement).value === "db-model");
        expect(input).toBeTruthy();
        const resetButton = wrapper.findAll("button").filter((b) => b.text().includes("↺"))[2];
        await resetButton.trigger("click");
        const cleared = wrapper
            .findAll("input")
            .find((el) => (el.element as HTMLInputElement).value === "");
        expect(cleared).toBeTruthy();
        expect(
            wrapper
                .findAll("input")
                .some((el) => (el.element as HTMLInputElement).value === "db-model"),
        ).toBe(false);
    });

    it("TC8: env-locked field shows env value, hides input, and is excluded from save", async () => {
        const wrapper = mountPanel({
            entries: { model: "db-model", apiKey: "sk-old" },
            envLocked: { model: "env-model" },
        });
        await expandPanel(wrapper);

        const lock = wrapper.find('[data-testid="config-env-lock-test-model"]');
        expect(lock.exists()).toBe(true);
        expect(lock.text()).toBe("env-model");
        expect(wrapper.text()).toContain("env");

        const inputs = wrapper.findAll("input");
        expect(inputs).toHaveLength(2);

        await inputs[1].setValue("8192");
        await wrapper
            .findAll("button")
            .filter((b) => b.text() === "Save")[0]
            .trigger("click");

        const emitted = wrapper.emitted("save");
        expect(emitted).toBeTruthy();
        // PLAN-0753 M2: number fields now emit the string draft (reka FieldControl
        // model is string-typed); the config save body keeps all values as strings.
        expect(emitted![0][0]).toEqual({ apiKey: "sk-old", maxTokens: "8192" });
        expect(emitted![0][0]).not.toHaveProperty("model");
    });

    it("TC9: json fields render a textarea and are emitted verbatim", async () => {
        const jsonSchema: DomainField[] = [{ key: "defaults", label: "Defaults", type: "json" }],
            wrapper = mountPanel({
                schema: jsonSchema,
                entries: { defaults: '{"softThresholdPct":0.8}' },
            });
        await expandPanel(wrapper);

        const textarea = wrapper.find("textarea");
        expect(textarea.exists()).toBe(true);
        expect(textarea.element.value).toBe('{"softThresholdPct":0.8}');

        await textarea.setValue('{"softThresholdPct":0.9}');
        await wrapper
            .findAll("button")
            .filter((b) => b.text() === "Save")[0]
            .trigger("click");
        expect(wrapper.emitted("save")![0][0]).toEqual({ defaults: '{"softThresholdPct":0.9}' });
    });

    // PLAN-0752 T3.2：徽标要表达「同域内不同键不同层」，不是整域一个徽标。
    const layerSchema: DomainField[] = [
        { key: "runMaxTurns", label: "Run Max Turns", type: "number" },
        {
            key: "runMaxTurnsCeiling",
            label: "Run Max Turns Ceiling",
            type: "number",
            instanceOnly: true,
        },
    ];

    it("TC10: instance layer badges only the instance-only key, using meta.overridable", async () => {
        const wrapper = mountPanel({
            schema: layerSchema,
            layer: "instance",
            entries: { runMaxTurns: "20", runMaxTurnsCeiling: "40" },
            // CP 的 meta 里 overridable=false 就是「只在实例层生效」（ConfigService:580-583）
            meta: {
                runMaxTurns: {
                    key: "runMaxTurns",
                    source: "instance",
                    locked: false,
                    writable: true,
                    reason: null,
                    instanceEligible: true,
                    defaultPresent: true,
                    overridable: true,
                },
                runMaxTurnsCeiling: {
                    key: "runMaxTurnsCeiling",
                    source: "instance",
                    locked: false,
                    writable: true,
                    reason: null,
                    instanceEligible: true,
                    defaultPresent: true,
                    overridable: false,
                },
            },
        });
        await expandPanel(wrapper);

        expect(
            wrapper.find('[data-testid="config-key-layer-badge-test-runMaxTurnsCeiling"]').exists(),
        ).toBe(true);
        expect(
            wrapper.find('[data-testid="config-key-layer-badge-test-runMaxTurns"]').exists(),
        ).toBe(false);
        // 实例层里实例专属键本身是可写的
        expect(
            wrapper
                .find('[data-testid="config-field-test-runMaxTurnsCeiling"] input')
                .attributes("disabled"),
        ).toBeUndefined();
    });

    it("TC11: lower layer keeps the instance-only row visible but disabled, and never saves it", async () => {
        const wrapper = mountPanel({
            schema: layerSchema,
            layer: "user",
            entries: { runMaxTurns: "20" },
        });
        await expandPanel(wrapper);

        const row = wrapper.find('[data-testid="config-field-test-runMaxTurnsCeiling"]');
        expect(row.exists()).toBe(true);
        expect(row.find("input").attributes("disabled")).toBeDefined();
        expect(
            row.find('[data-testid="config-key-layer-badge-test-runMaxTurnsCeiling"]').text(),
        ).toBe("Instance only");
        // 非徽标键在该层可编辑
        expect(
            wrapper
                .find('[data-testid="config-field-test-runMaxTurns"] input')
                .attributes("disabled"),
        ).toBeUndefined();

        await wrapper
            .findAll("button")
            .filter((button) => button.text() === "Save")[0]
            .trigger("click");
        // 草稿是字符串（数字在 CP 侧收敛），关键是**没有**把实例专属键带进保存体
        expect(wrapper.emitted("save")![0][0]).toEqual({ runMaxTurns: "20" });
    });

    it("TC12: no badge when the server says the key is overridable", async () => {
        const wrapper = mountPanel({
            schema: layerSchema.slice(0, 1),
            layer: "instance",
            entries: { runMaxTurns: "20" },
            meta: {
                runMaxTurns: {
                    key: "runMaxTurns",
                    source: "instance",
                    locked: false,
                    writable: true,
                    reason: null,
                    instanceEligible: true,
                    defaultPresent: true,
                    overridable: true,
                },
            },
        });
        await expandPanel(wrapper);
        expect(wrapper.findAll('[data-testid^="config-key-layer-badge-"]')).toHaveLength(0);
    });
});
