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
    // 夹具路由指向**真实**资源路径 `/resources/knowledge`（`router/index.ts` 的
    // `resources-knowledge`）：设置区时代的知识库路由已随 PLAN-0772 M2 决策 10 直接删除（不留 redirect），
    // 夹具若继续写旧路径，下一个人会以为它还活着（task-298）。
    routes: [
        {
            path: "/resources/knowledge",
            name: "resources-knowledge",
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
        router.push("/resources/knowledge");
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

/**
 * task-209（D-1019）：工作区「知识库」tab 被撤掉之后，`KnowledgeBaseView` **暂时没有任何可达页面**
 * （它是那条 tab 的唯一挂载点）。原 `e2e/mock/knowledge-base.spec.ts` 里有 4 条用例守着
 * 「列表 / 删除 / 上传」三条行为，随改装无法再走路由 ⇒ 在这里**按组件级补回同样的断言**，
 * 而不是把 e2e 删干净了事：能力暂时没有入口，行为却仍然必须被钉住，否则下次接回来时
 * 没人知道它原来还能上传和删除。
 */
describe("KnowledgeBaseView 列表 / 删除 / 上传（task-209 从 e2e 降级到组件级）", () => {
    const DOCS = [
        { id: "d1", filename: "requirements.pdf", chunks: 12 },
        { id: "d2", filename: "architecture.md", chunks: 7 },
    ];

    function mockRagFetch(): void {
        vi.mocked(globalThis.fetch).mockImplementation((input, init) => {
            const url = typeof input === "string" ? input : input.url;
            const method = init?.method ?? "GET";
            if (url.includes("/api/v1/rag/stats")) {
                return Promise.resolve(
                    new Response(JSON.stringify({ documents: DOCS }), { status: 200 }),
                );
            }
            if (url.includes("/api/v1/rag/documents/")) {
                if (method !== "DELETE") throw new Error(`unexpected ${method} ${url}`);
                return Promise.resolve(new Response(null, { status: 204 }));
            }
            if (url.includes("/api/v1/rag/ingest")) {
                return Promise.resolve(
                    new Response(JSON.stringify({ accepted: 1 }), { status: 200 }),
                );
            }
            throw new Error(`unexpected request ${method} ${url}`);
        });
    }

    it("lists every document with its own delete button", async () => {
        mockRagFetch();
        const wrapper = mountKnowledgeView();
        await flushPromises();

        expect(wrapper.text()).toContain("requirements.pdf");
        expect(wrapper.text()).toContain("architecture.md");
        // 断言到**每个文件名与 chunk 数**，不只断言"有列表"：否则空壳列表也能绿。
        expect(wrapper.text()).toContain("(12 chunks)");
        expect(wrapper.text()).toContain("(7 chunks)");
        const deleteButtons = wrapper.findAll("button").filter((b) => b.text() === "Delete");
        expect(deleteButtons).toHaveLength(DOCS.length);
    });

    it("deletes the clicked document by id and reloads the list", async () => {
        mockRagFetch();
        const wrapper = mountKnowledgeView();
        await flushPromises();

        const firstDelete = wrapper.findAll("button").find((b) => b.text() === "Delete");
        await firstDelete!.trigger("click");
        await flushPromises();

        const deleteCall = vi
            .mocked(globalThis.fetch)
            .mock.calls.map(([input, init]) => ({
                url: typeof input === "string" ? input : input.url,
                method: init?.method ?? "GET",
            }))
            .find((call) => call.method === "DELETE");
        expect(deleteCall?.url).toContain("/api/v1/rag/documents/d1");
        // 删完必须重新拉一次统计（否则界面会留着已删行 —— 原来 e2e 就是这么判的）。
        const statsCalls = vi.mocked(globalThis.fetch).mock.calls.filter(([input]) => {
            const url = typeof input === "string" ? input : input.url;
            return url.includes("/api/v1/rag/stats");
        });
        expect(statsCalls.length).toBeGreaterThanOrEqual(2);
    });

    it("uploads the selected file through POST /rag/ingest", async () => {
        mockRagFetch();
        const wrapper = mountKnowledgeView();
        await flushPromises();

        const file = new File(["# doc"], "notes.md", { type: "text/markdown" });
        wrapper.vm.files = [file];
        await wrapper.vm.$nextTick();

        const uploadButton = wrapper.findAll("button").find((b) => b.text() === "Upload");
        expect(uploadButton).toBeTruthy();
        await uploadButton!.trigger("click");
        await flushPromises();

        const ingestCall = vi.mocked(globalThis.fetch).mock.calls.find(([input]) => {
            const url = typeof input === "string" ? input : input.url;
            return url.includes("/api/v1/rag/ingest");
        });
        expect(ingestCall).toBeTruthy();
        const body = ingestCall![1]?.body;
        expect(body).toBeInstanceOf(FormData);
        const uploaded = (body as FormData).get("file");
        expect(uploaded).toBeInstanceOf(File);
        expect((uploaded as File).name).toBe("notes.md");
    });
});
