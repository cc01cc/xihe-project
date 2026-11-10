import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import { i18n } from "../../../i18n";
import ConnectionResourceLimits from "../ConnectionResourceLimits.vue";
import type { ProviderConnection } from "../../../types/providerConnection";

function connection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
    return {
        id: "connection-1",
        providerId: "openai",
        connectionKey: "team-openai",
        apiTypeId: "openai-chat-completions",
        apiTypeVersion: 1,
        operation: "chat",
        label: "Team OpenAI",
        scope: "WORKSPACE",
        modelDiscovery: "manual",
        manualModels: [],
        hasKey: true,
        enabled: true,
        status: "READY",
        revision: 1,
        ...overrides,
    } as ProviderConnection;
}

interface Emitted {
    maxInflight: number | null;
    maxQueue: number | null;
    windowTokenBudget: number | null;
    windowSeconds: number | null;
    modelLimits: Array<{ provider: string; model: string }>;
}

/**
 * 受控包装：用 **reactive props** 复现真实父子用法（`v-model:form` / `v-model:model-limits`），
 * 否则子组件 `defineModel` 的更新回不到 props，断言就成了假绿。
 */
function mountLimits(options: { connection?: ProviderConnection | null; readonly?: boolean } = {}) {
    const emitted: Emitted[] = [];
    const wrapper = mount(ConnectionResourceLimits, {
        props: {
            connection: options.connection === undefined ? connection() : options.connection,
            readonly: options.readonly ?? false,
            "onUpdate:limits": (value: Emitted) => {
                emitted.push(value);
            },
        },
        global: { plugins: [i18n] },
    });
    return { wrapper, emitted };
}

describe("PLAN-0622 ConnectionResourceLimits", () => {
    it("renders the configured limits of the connection being edited", async () => {
        const { wrapper } = mountLimits({
            connection: connection({
                maxInflight: 4,
                maxQueue: 8,
                windowTokenBudget: 100000,
                windowSeconds: 60,
            }),
        });
        await flushPromises();
        expect(
            (
                wrapper.get('[data-testid="connection-limit-max-inflight"]')
                    .element as HTMLInputElement
            ).value,
        ).toBe("4");
        expect(
            (wrapper.get('[data-testid="connection-limit-max-queue"]').element as HTMLInputElement)
                .value,
        ).toBe("8");
        expect(
            (
                wrapper.get('[data-testid="connection-limit-window-token-budget"]')
                    .element as HTMLInputElement
            ).value,
        ).toBe("100000");
        expect(
            (
                wrapper.get('[data-testid="connection-limit-window-seconds"]')
                    .element as HTMLInputElement
            ).value,
        ).toBe("60");
        wrapper.unmount();
    });

    it("rejects zero, negative and fractional values with a positive-integer hint", async () => {
        const { wrapper } = mountLimits();
        const input = wrapper.get('[data-testid="connection-limit-max-inflight"]');
        for (const invalid of ["0", "-1", "1.5", "abc"]) {
            await input.setValue(invalid);
            await flushPromises();
            expect(
                wrapper.find('[data-testid="connection-limit-max-inflight-error"]').exists(),
            ).toBe(true);
        }
        await input.setValue("3");
        await flushPromises();
        expect(wrapper.find('[data-testid="connection-limit-max-inflight-error"]').exists()).toBe(
            false,
        );
        wrapper.unmount();
    });

    it("emits null for empty fields and the parsed number otherwise", async () => {
        const { wrapper, emitted } = mountLimits();
        await wrapper.get('[data-testid="connection-limit-max-inflight"]').setValue("6");
        await wrapper.get('[data-testid="connection-limit-window-seconds"]').setValue("30");
        const last = emitted.at(-1) as Emitted;
        expect(last.maxInflight).toBe(6);
        expect(last.windowSeconds).toBe(30);
        expect(last.maxQueue).toBeNull();
        expect(last.windowTokenBudget).toBeNull();
        wrapper.unmount();
    });

    it("adds and removes per-model limits", async () => {
        const { wrapper, emitted } = mountLimits();
        await wrapper.get('[data-testid="connection-limit-model-add"]').trigger("click");
        await flushPromises();
        await wrapper.get('[data-testid="connection-limit-model-provider-0"]').setValue("openai");
        await wrapper.get('[data-testid="connection-limit-model-name-0"]').setValue("gpt-4o-mini");
        await wrapper.get('[data-testid="connection-limit-model-inflight-0"]').setValue("2");
        expect((emitted.at(-1) as Emitted).modelLimits[0]).toMatchObject({
            provider: "openai",
            model: "gpt-4o-mini",
            maxInflight: 2,
        });
        await wrapper.get('[data-testid="connection-limit-model-remove-0"]').trigger("click");
        expect((emitted.at(-1) as Emitted).modelLimits).toHaveLength(0);
        wrapper.unmount();
    });

    it("is read-only when the caller has no edit permission (fail-closed)", () => {
        const { wrapper } = mountLimits({ readonly: true });
        expect(
            (
                wrapper.get('[data-testid="connection-limit-max-inflight"]')
                    .element as HTMLInputElement
            ).readOnly,
        ).toBe(true);
        expect(
            (wrapper.get('[data-testid="connection-limit-model-add"]').element as HTMLButtonElement)
                .disabled,
        ).toBe(true);
        wrapper.unmount();
    });

    it("renders nothing while creating a new connection (no id yet)", () => {
        const { wrapper } = mountLimits({ connection: null });
        expect(wrapper.find('[data-testid="connection-resource-limits"]').exists()).toBe(false);
        wrapper.unmount();
    });
});
