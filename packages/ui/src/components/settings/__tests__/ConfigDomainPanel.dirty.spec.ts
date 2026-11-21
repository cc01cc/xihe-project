import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import ConfigDomainPanel, { type DomainField } from "../ConfigDomainPanel.vue";
import { i18n } from "../../../i18n";
import type { ConfigKeyMeta } from "../../../stores/config";

/**
 * task-190 J1：面板把**本域**草稿状态暴露成 `dirty` 事件 + `data-draft-dirty`。
 *
 * <p>这是整页离开守卫的唯一 dirty 源的上游：如果面板这里判错（改回原值仍 true、掩码串一挂载就 true），
 * 守卫会拦下没有改动的导航 —— 用户看到「有未保存的改动」却找不到改了什么，比不拦更糟。
 * 判据本身的边界（数组/对象/掩码占位）由 `configDraft.spec.ts` 逐条钉住，这里只钉「DOM 编辑 ⇒ 信号」
 * 与「改回原值 ⇒ 信号回落」「卸载 ⇒ 信号归零」。</p>
 */

const schema: DomainField[] = [
    { key: "logLevel", label: "日志级别", type: "text" },
    { key: "llmApiKey", label: "密钥", type: "password" },
];

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

const TEXT = '[data-testid="config-text-logging-logLevel"]';
const SECRET = '[data-testid="config-text-logging-llmApiKey"]';
const ROOT = '[data-testid="config-domain-logging"]';

async function mountPanel(entries: Record<string, string> = { logLevel: "INFO", llmApiKey: "" }) {
    const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: "/settings/:layer/:domain", component: { template: "<div />" } }],
    });
    const wrapper = mount(ConfigDomainPanel, {
        props: {
            domain: "logging",
            title: "日志",
            entries,
            schema,
            meta: { logLevel: meta("logLevel"), llmApiKey: meta("llmApiKey") },
            layer: "instance",
        },
        global: { plugins: [i18n, router] },
    });
    if (!wrapper.find('[data-testid^="config-field-"]').exists()) {
        await wrapper.find("button").trigger("click");
    }
    return wrapper;
}

function draftFlag(wrapper: Awaited<ReturnType<typeof mountPanel>>): string | undefined {
    return wrapper.get(ROOT).attributes("data-draft-dirty");
}

describe("ConfigDomainPanel · 草稿 dirty 信号（task-190）", () => {
    it("初始态不 dirty，且已向父组件广播 false", async () => {
        const wrapper = await mountPanel();
        expect(draftFlag(wrapper)).toBe("false");
        expect(wrapper.emitted("dirty")?.at(-1)).toEqual([false]);
        wrapper.unmount();
    });

    it("编辑一个字段 ⇒ dirty=true 且广播 true", async () => {
        const wrapper = await mountPanel();
        await wrapper.get(TEXT).setValue("DEBUG");
        expect(draftFlag(wrapper)).toBe("true");
        expect(wrapper.emitted("dirty")?.at(-1)).toEqual([true]);
        wrapper.unmount();
    });

    it("改回原值 ⇒ dirty 回落 false（不是「动过就永远脏」）", async () => {
        const wrapper = await mountPanel();
        await wrapper.get(TEXT).setValue("DEBUG");
        expect(draftFlag(wrapper)).toBe("true");
        await wrapper.get(TEXT).setValue("INFO");
        expect(draftFlag(wrapper)).toBe("false");
        expect(wrapper.emitted("dirty")?.at(-1)).toEqual([false]);
        wrapper.unmount();
    });

    it("掩码字段输入新值算 dirty，空着不算", async () => {
        const wrapper = await mountPanel();
        expect(draftFlag(wrapper)).toBe("false");
        await wrapper.get(SECRET).setValue("sk-new-secret");
        expect(draftFlag(wrapper)).toBe("true");
        wrapper.unmount();
    });

    it("带未保存编辑卸载时向父组件归零（聚合表不留残影）", async () => {
        const wrapper = await mountPanel();
        await wrapper.get(TEXT).setValue("DEBUG");
        expect(draftFlag(wrapper)).toBe("true");
        wrapper.unmount();
        expect(wrapper.emitted("dirty")?.at(-1)).toEqual([false]);
    });

    it("卸载不是保存 —— 面板自身不因 dirty 触发保存（丢弃 = 真不保存）", async () => {
        const wrapper = await mountPanel();
        await wrapper.get(TEXT).setValue("DEBUG");
        wrapper.unmount();
        // 保存只能来自用户点「保存」（emit save）；dirty 变化与卸载都不许自己发保存。
        expect(wrapper.emitted("save")).toBeUndefined();
    });
});
