import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { createPinia, setActivePinia } from "pinia";
import ConfigLayerPanels from "../ConfigLayerPanels.vue";
import { i18n } from "../../../i18n";
import { useConfigStore } from "../../../stores/config";
import { jsonDocText, setJsonDoc } from "./jsonEditorAsserts";

/**
 * task-156 / D-1001：`approval-policy.askActionClasses` 是 `type: "json"` 字段，
 * **PUT body 的值必须是 JSON 字符串**（`"[\"CREATE_TEMPLATE\"]"`），不是数组对象。
 *
 * 为什么这条是跨层契约而不是页面细节：
 * - CP 侧 `ConfigController.putInstanceConfig(@RequestBody Map<String, String> body)`
 *   （`ConfigController.java:344-351`）把整域值当**字符串**接收；传数组/对象会在 Jackson 绑定阶段
 *   抛 `HttpMessageNotReadableException`，由 `ProblemDetailsHandler:228-247` 映射成
 *   **400 INVALID_REQUEST**（不是静默存成对象）。
 * - 语义层 `config-schemas/approval-policy.json` 声明的是 `array<string>`，CP 读侧
 *   `DbPolicyContextProvider` 解析的是**JSON 文本** ⇒ 字符串里装的是 JSON 数组文本，两侧一致。
 * - 后果不是"报错就完了"：`validateJsonFields()` 若放行非字符串，写出去的 body 会变成对象，
 *   CP 直接 400；而"存下去了但读回形状不同"这一支在 CP 侧被绑定挡住，所以**唯一可接受的形状只有字符串**。
 *
 * 本 spec 只锁形状契约（死页 `ConfigSettings.spec.ts:204-232` 的等价断言随死页消失，故在此重建）；
 * 面板的展开/折叠/只读规则见 `ConfigLayerPanels.*.spec.ts` 其余四份。
 */
vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message?: unknown) => string | number>(),
        error: vi.fn<(message?: unknown) => string | number>(),
        warning: vi.fn<(message?: unknown) => string | number>(),
        info: vi.fn<(message?: unknown) => string | number>(),
    },
}));

type FetchCall = { url: string; init: RequestInit | undefined };

/** `ConfigDomainPanel` 的展开态读 `useRoute().hash`（深链锚点）⇒ 必须给 router，否则 500 级报错。 */
function makeRouter() {
    return createRouter({
        history: createMemoryHistory(),
        routes: [{ path: "/settings/:layer/:domain", component: { template: "<div />" } }],
    });
}

async function mountApprovalPanel() {
    const calls: FetchCall[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        calls.push({ url: typeof input === "string" ? input : input.url, init });
        return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    });
    const pinia = createPinia();
    setActivePinia(pinia);
    const config = useConfigStore();
    // 只要 PUT；层的 GET（含 meta）不参与本断言，避免把 mock 网络噪音混进读数。
    vi.spyOn(config, "loadLayerDomains").mockResolvedValue(undefined);
    const router = makeRouter();
    await router.push("/settings/instance/approval-policy");
    await router.isReady();
    const wrapper = mount(ConfigLayerPanels, {
        props: { layer: "instance", domain: "approval-policy" },
        global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();
    return { wrapper, calls };
}

/** 展开卡片 → 填 json 文本 → 点保存 → 等 PUT 落地。 */
async function saveAskActionClasses(
    wrapper: Awaited<ReturnType<typeof mountApprovalPanel>>["wrapper"],
) {
    // task-225 起域卡默认展开 ⇒ 字段行已在 DOM 里（只在旧形态下兜底点一次）。
    if (!wrapper.find('[data-testid^="config-field-"]').exists()) {
        await wrapper.find('[data-testid="config-domain-toggle-approval-policy"]').trigger("click");
        await flushPromises();
    }

    // task-286 断言翻面：该 json 字段已从 `<textarea>` 换成 CodeMirror 6，
    // testid 也从 `config-field-*` 变为 `config-json-*`。
    // 原断言依赖 `textarea.value`，CodeMirror 无该属性 ⇒ 改为断言编辑器文档文本。
    // 语义不变：仍是「写进这个字段的值」—— 只是入口从 DOM 属性换成 `EditorState.doc`。
    const jsonTestId = "config-json-approval-policy-askActionClasses";
    expect(wrapper.find(`[data-testid="${jsonTestId}"]`).exists()).toBe(true);
    setJsonDoc(wrapper, jsonTestId, '["CREATE_TEMPLATE"]');
    expect(jsonDocText(wrapper, jsonTestId)).toBe('["CREATE_TEMPLATE"]');

    const saveLabel = i18n.global.t("common.save"),
        saveButton = wrapper.findAll("button").find((button) => button.text() === saveLabel);
    expect(saveButton).toBeTruthy();
    await saveButton!.trigger("click");
    await flushPromises();
}

function putCalls(calls: FetchCall[]): FetchCall[] {
    return calls.filter(
        (call) =>
            call.url.includes("/config/instance/approval-policy") && call.init?.method === "PUT",
    );
}

describe("ConfigLayerPanels approval-policy askActionClasses 保存形状（task-156 / D-1001）", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("PUT body 的 askActionClasses 是 JSON 字符串，不是数组对象", async () => {
        const { wrapper, calls } = await mountApprovalPanel();
        await saveAskActionClasses(wrapper);

        const puts = putCalls(calls);
        expect(puts).toHaveLength(1);

        // 实际发出的 wire body（脱敏：只有这一个键，无凭据）。
        const rawBody = String(puts[0].init?.body);
        const body = JSON.parse(rawBody) as Record<string, unknown>;

        // 形状判据：字符串，且内容是 JSON 数组文本 —— 不是 `["CREATE_TEMPLATE"]` 数组本身。
        expect(typeof body.askActionClasses).toBe("string");
        expect(Array.isArray(body.askActionClasses)).toBe(false);
        expect(body.askActionClasses).toBe('["CREATE_TEMPLATE"]');
        expect(JSON.parse(String(body.askActionClasses))).toEqual(["CREATE_TEMPLATE"]);

        // 防"顺手把对象塞进去"的另一种写法：整个 body 的值集合里不允许出现非字符串。
        for (const value of Object.values(body)) expect(typeof value).toBe("string");

        // 与死页 `ConfigSettings.spec.ts:204-232` 等价：只填了一个字段 ⇒ body 就这一个键。
        // （若将来实例层开始附带默认键，这条会红 —— 那时先复核"多出来的键该不该发"，别直接改期望。）
        expect(body).toEqual({ askActionClasses: '["CREATE_TEMPLATE"]' });
        expect(rawBody).toBe('{"askActionClasses":"[\\"CREATE_TEMPLATE\\"]"}');

        wrapper.unmount();
    });

    it("非法 JSON 文本不发出 PUT（本地先挡，而不是让 CP 回 400）", async () => {
        const { wrapper, calls } = await mountApprovalPanel();
        if (!wrapper.find('[data-testid^="config-field-"]').exists()) {
            await wrapper
                .find('[data-testid="config-domain-toggle-approval-policy"]')
                .trigger("click");
            await flushPromises();
        }
        // task-286 断言翻面：同上 —— 原断言依赖 `textarea.value`，CodeMirror 无该属性
        // ⇒ 改为 `setJsonDoc` 写文档文本。本用例判的是「非法 JSON 不发 PUT」，
        // 写入口换了但判据（PUT 次数为 0）一字未动。
        const jsonTestId = "config-json-approval-policy-askActionClasses";
        setJsonDoc(wrapper, jsonTestId, "[not json");
        expect(jsonDocText(wrapper, jsonTestId)).toBe("[not json");

        const saveLabel = i18n.global.t("common.save"),
            saveButton = wrapper.findAll("button").find((button) => button.text() === saveLabel);
        expect(saveButton).toBeTruthy();
        await saveButton!.trigger("click");
        await flushPromises();

        expect(putCalls(calls)).toHaveLength(0);
        wrapper.unmount();
    });
});
