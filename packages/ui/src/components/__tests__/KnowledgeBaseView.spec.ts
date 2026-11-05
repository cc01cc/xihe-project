import { describe, it, expect, vi, beforeEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createRouter, createWebHistory } from "vue-router";
import { createPinia, setActivePinia } from "pinia";
import { logger } from "../../lib/logger";
import KnowledgeBaseView from "../../views/settings/KnowledgeBaseView.vue";

const i18n = createI18n({
    legacy: false,
    locale: "en",
    messages: {
        en: {
            settings: {
                knowledgeBase: "Knowledge Base",
                noDocuments: "No documents yet",
                model: "Model",
                theme: "Theme",
                mcp: "MCP",
                dataControls: "Data",
            },
            common: { upload: "Upload", uploading: "Uploading...", delete: "Delete" },
        },
    },
});

const router = createRouter({
    history: createWebHistory(),
    routes: [
        {
            path: "/settings/knowledge",
            name: "settings-knowledge",
            component: { template: "<div />" },
        },
    ],
});

beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));
    vi.spyOn(logger, "warn");
});

function mountKnowledgeView() {
    return mount(KnowledgeBaseView, { global: { plugins: [i18n, router] } });
}

describe("KnowledgeBaseView", () => {
    it("renders the heading", async () => {
        router.push("/settings/knowledge");
        await router.isReady();
        const wrapper = mountKnowledgeView();
        expect(wrapper.text()).toContain("Knowledge Base");
    });

    it("shows loading state on mount", async () => {
        const wrapper = mountKnowledgeView();
        wrapper.vm.loading = true;
        await wrapper.vm.$nextTick();
        expect(wrapper.text()).toContain("Loading");
    });

    it("shows error state with retry when fetch fails and logs warning", async () => {
        const wrapper = mountKnowledgeView();
        // BL-359：本用例原先依赖同文件兄弟用例的副作用（`beforeEach` 里 spy 的 `logger.warn`
        // 只由"挂载后 fetch 失败"触发，而这里没等它跑完就断言 ⇒ 顺序一变就红）。
        // 改为**本用例自触发**：等挂载期的失败请求走完，让 warn 由本用例自己触发。
        await flushPromises();
        wrapper.vm.loading = false;
        wrapper.vm.loadError = "HTTP 500";
        await wrapper.vm.$nextTick();
        expect(wrapper.text()).toContain("HTTP 500");
        expect(wrapper.text()).toContain("Retry");
        expect(logger.warn).toHaveBeenCalled();
    });

    it("shows empty state when no documents", async () => {
        const wrapper = mountKnowledgeView();
        wrapper.vm.loading = false;
        wrapper.vm.documents = [];
        await wrapper.vm.$nextTick();
        expect(wrapper.text()).toContain("No documents yet");
    });
});
