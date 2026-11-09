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
    await wrapper.find("button").trigger("click");
}

describe("ConfigDomainPanel", () => {
    it("TC1: renders all schema fields when entries is empty", async () => {
        const wrapper = mountPanel({ entries: {} });
        await expandPanel(wrapper);

        const labels = wrapper.findAll(String.raw`.text-muted-foreground.w-1\/3`);
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
        const wrapper = mountPanel({ admin: true });
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
        const wrapper = mountPanel({ admin: true, entries: { model: "db-model" } });
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
        expect(emitted![0][0]).toEqual({ apiKey: "sk-old", maxTokens: 8192 });
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
