import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";

import { api, ApiError } from "../../../composables/api";
import { i18n } from "../../../i18n";
import AgentPrincipalDetailDrawer, {
    type AgentPrincipalDetail,
} from "../AgentPrincipalDetailDrawer.vue";
import { Select } from "../../ui/select";
import { selectModelValue, setSelectValue } from "../../../test-utils/select";

/**
 * task-138：模型段改成「连接 → 模型」三级选择（复用 AgentModelBindingFields），
 * 数据只来自既有 config store（连接 + /models 目录）。这里给同形替身，`chatModelNamesOf`
 * 保持真实现（目录优先/manual 回退的策略必须被真跑到）。
 */
const configState = vi.hoisted(() => ({
    providerConnections: [] as Array<Record<string, unknown>>,
    providerConnectionsError: false,
    modelError: null as string | null,
    modelCache: { providers: {} as Record<string, unknown> },
    loadProviderConnections: vi.fn<() => Promise<void>>(async () => {}),
    fetchModels: vi.fn<() => Promise<void>>(async () => {}),
}));

vi.mock("../../../stores/config", () => ({
    useConfigStore: () => configState,
}));

vi.mock("../../../services/providerConnectionService", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        listProviderCatalog: vi.fn<() => Promise<{ providers: unknown[] }>>(async () => ({
            providers: [],
        })),
    };
});

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string) => void>(),
    },
}));

/**
 * task-191 · 主体详情抽屉（user 层可写口径）。
 *
 * <p>要咬住的不是「字段渲没渲染」，而是四条会静默翻车的契约：</p>
 * <ol>
 *   <li><b>分区只发自己的键</b>：PATCH 是 `additionalProperties:false` + absent = 不触碰；
 *       多发一个键就会覆盖别的分区（尤其 `hooks`/`contextPolicy` 是整对象替换）；</li>
 *   <li><b>记忆是合并不是替换</b>：只翻 `memory.enabled`，`writeMode`/`types` 必须原样带回去；</li>
 *   <li><b>清空 = 显式 null</b>（不是省略、不是空对象）；</li>
 *   <li><b>授权/预设门在 CP</b>：403 `GUARD_*` / `AGENT_PRINCIPAL_OWNER_MISMATCH` 映射为可操作文案，
 *       页面不出现原始英文 detail（task-45 诊断面）。</li>
 * </ol>
 */

function principal(overrides: Partial<AgentPrincipalDetail> = {}): AgentPrincipalDetail {
    return {
        principalId: "p-1",
        name: "ResearchAgent",
        ownership: "USER",
        templateName: "Researcher",
        createdAt: "2026-11-01T02:03:04Z",
        disabled: false,
        defaultModelProvider: "openai",
        defaultModelName: "gpt-4o-mini",
        allowedModels: [{ provider: "openai", model: "gpt-4o-mini" }],
        hooks: { advisors: [{ kind: "guard", on: ["approval.ask"] }] },
        contextPolicy: { memory: { enabled: false, writeMode: "append", types: ["fact"] } },
        delegationPolicy: { maxCount: 8, maxDepth: 3 },
        ...overrides,
    };
}

function mountDrawer(props: Record<string, unknown> = {}) {
    return mount(AgentPrincipalDetailDrawer, {
        props: { open: true, principal: principal(), ...props } as never,
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
}

function q<T extends Element = HTMLElement>(selector: string): T {
    const node = document.body.querySelector<T>(selector);
    if (!node) throw new Error("missing node: " + selector);
    return node;
}

function maybe(selector: string): HTMLElement | null {
    return document.body.querySelector<HTMLElement>(selector);
}

async function setName(selector: string, value: string): Promise<void> {
    const input = q<HTMLInputElement>(`[data-testid="${selector}"]`);
    input.value = value;
    input.dispatchEvent(new Event("input"));
    await nextTick();
}

async function click(testid: string): Promise<void> {
    q(`[data-testid="${testid}"]`).click();
    await flushPromises();
    await nextTick();
}

type DrawerWrapper = ReturnType<typeof mountDrawer>;

/** 选中三段中的一段（reka Select 在 jsdom 里走 emit，与 test-utils/select 同口径）。 */
async function pick(wrapper: DrawerWrapper, testid: string, value: string): Promise<void> {
    await setSelectValue(wrapper as never, `[data-testid="${testid}"]`, value);
    await flushPromises();
    await nextTick();
}

/** 把默认模型改成 anthropic/claude-x（三段都要点，否则组件会判半组）。 */
async function pickAnthropic(wrapper: DrawerWrapper): Promise<void> {
    await pick(wrapper, "apd-model-binding-provider", "anthropic");
    await pick(wrapper, "apd-model-binding-connection", "conn-anthropic");
    await pick(wrapper, "apd-model-binding-model-name", "claude-x");
}

function forbidden(code: string): ApiError {
    return new ApiError({
        status: 403,
        code,
        detail: "control-plane said no",
        requestId: "req-1",
    });
}

beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.spyOn(api, "getAgentRoles").mockResolvedValue([]);
    configState.providerConnections = [
        {
            id: "conn-anthropic",
            providerId: "anthropic",
            connectionKey: "anthropic-main",
            operation: "chat",
            label: "Claude 主连接",
            enabled: true,
        },
        {
            id: "conn-openai",
            providerId: "openai",
            connectionKey: "openai-main",
            operation: "chat",
            label: "GPT 主连接",
            enabled: true,
        },
    ];
    configState.providerConnectionsError = false;
    configState.modelError = null;
    configState.modelCache = {
        providers: {
            "conn-anthropic": {
                providerId: "anthropic",
                connectionId: "conn-anthropic",
                status: "ready",
                models: [{ name: "claude-x", capabilities: { chat: true } }],
            },
            "conn-openai": {
                providerId: "openai",
                connectionId: "conn-openai",
                status: "ready",
                models: [{ name: "gpt-4o-mini", capabilities: { chat: true } }],
            },
        },
    };
});

describe("AgentPrincipalDetailDrawer", () => {
    it("身份/人设只读呈现：persona 显示模板名并说明创建时钉住", async () => {
        mountDrawer();
        await flushPromises();

        expect(q('[data-testid="agent-principal-detail-title"]').textContent).toContain(
            "ResearchAgent",
        );
        expect(q('[data-testid="apd-identity"]').textContent).toContain("ResearchAgent");
        expect(q('[data-testid="apd-persona"]').textContent).toContain("Researcher");
        // Q1：模板不可换 —— 文案必须显式说「创建时钉住」，不能只给个灰字。
        expect(q('[data-testid="apd-persona"]').textContent).toContain("钉住");
        // 人设区没有任何输入控件（只读不是靠 disabled 假装）。
        expect(q('[data-testid="apd-persona"]').querySelectorAll("input,button").length).toBe(0);
    });

    it("模型区只发自己改过的键（PATCH absent=不触碰）", async () => {
        const update = vi.spyOn(api, "updateAgentPrincipal").mockResolvedValue({
            principalId: "p-1",
            defaultModelProvider: "anthropic",
            defaultModelName: "claude-x",
            allowedModels: [{ provider: "openai", model: "gpt-4o-mini" }],
            hooks: null,
            contextPolicy: null,
            delegationPolicy: null,
        });
        const wrapper = mountDrawer();
        await flushPromises();

        await pickAnthropic(wrapper);
        await click("apd-model-save");

        expect(update).toHaveBeenCalledTimes(1);
        const body = update.mock.calls[0]![1] as Record<string, unknown>;
        expect(body).toEqual({
            defaultModelProvider: "anthropic",
            defaultModelName: "claude-x",
        });
        expect("allowedModels" in body).toBe(false);
        expect("hooks" in body).toBe(false);
        expect("contextPolicy" in body).toBe(false);
        // 回执通知宿主更新行（不整表重拉）。
        expect(wrapper.emitted("changed")?.at(-1)?.[0]).toMatchObject({
            principalId: "p-1",
            defaultModelProvider: "anthropic",
        });
    });

    it("Provider 与模型成对：只选 provider 不选模型时保存被挡住、不发请求", async () => {
        const update = vi.spyOn(api, "updateAgentPrincipal");
        const wrapper = mountDrawer();
        await flushPromises();

        await pick(wrapper, "apd-model-binding-provider", "anthropic");
        const save = q<HTMLButtonElement>('[data-testid="apd-model-save"]');
        expect(save.disabled).toBe(true);
        save.click();
        await flushPromises();
        expect(update).not.toHaveBeenCalled();
    });

    it("委派预算：只发 delegationPolicy；清空发显式 null", async () => {
        const update = vi.spyOn(api, "updateAgentPrincipal").mockResolvedValue({
            principalId: "p-1",
            defaultModelProvider: null,
            defaultModelName: null,
            allowedModels: null,
            hooks: null,
            contextPolicy: null,
            delegationPolicy: null,
        });
        mountDrawer();
        await flushPromises();

        await setName("delegation-policy-max-count", "");
        await setName("delegation-policy-max-depth", "");
        await click("apd-delegation-save");

        expect(update).toHaveBeenCalledTimes(1);
        const body = update.mock.calls[0]![1] as Record<string, unknown>;
        expect(Object.keys(body)).toEqual(["delegationPolicy"]);
        expect(body.delegationPolicy).toBeNull();
    });

    it("记忆：只翻 enabled，writeMode/types 原样带回去（整对象替换契约）", async () => {
        const update = vi.spyOn(api, "updateAgentPrincipal").mockResolvedValue({
            principalId: "p-1",
            defaultModelProvider: null,
            defaultModelName: null,
            allowedModels: null,
            hooks: null,
            contextPolicy: { memory: { enabled: true, writeMode: "append", types: ["fact"] } },
            delegationPolicy: null,
        });
        mountDrawer();
        await flushPromises();

        q('[data-testid="apd-memory-switch"]').click();
        // reka-ui Switch 的 modelValue 更新在微任务里落地 —— 不 flush 就点保存会点到 disabled 上。
        await flushPromises();
        await nextTick();
        await click("apd-memory-save");

        const body = update.mock.calls[0]![1] as Record<string, unknown>;
        expect(Object.keys(body)).toEqual(["contextPolicy"]);
        expect(body.contextPolicy).toEqual({
            memory: { enabled: true, writeMode: "append", types: ["fact"] },
        });
    });

    it("钩子：移除后保存；清空全部 ⇒ hooks 显式 null", async () => {
        const update = vi.spyOn(api, "updateAgentPrincipal").mockResolvedValue({
            principalId: "p-1",
            defaultModelProvider: null,
            defaultModelName: null,
            allowedModels: null,
            hooks: null,
            contextPolicy: null,
            delegationPolicy: null,
        });
        mountDrawer();
        await flushPromises();

        await click("apd-hooks-remove-0");
        await click("apd-hooks-save");

        const body = update.mock.calls[0]![1] as Record<string, unknown>;
        expect(Object.keys(body)).toEqual(["hooks"]);
        expect(body.hooks).toBeNull();
    });

    it.each([
        ["GUARD_MODEL_INTENT_IMMUTABLE", "预设托管"],
        ["GUARD_HOOKS_IMMUTABLE", "预设托管"],
        ["GUARD_CONTEXT_POLICY_IMMUTABLE", "预设托管"],
        ["AGENT_PRINCIPAL_OWNER_MISMATCH", "创建者"],
    ])("403 %s ⇒ 可操作文案 + 折叠技术详情（无原始英文 detail）", async (code, hint) => {
        vi.spyOn(api, "updateAgentPrincipal").mockRejectedValue(forbidden(code));
        const wrapper = mountDrawer();
        await flushPromises();

        await pickAnthropic(wrapper);
        await click("apd-model-save");

        const error = q('[data-testid="apd-model-error"]');
        expect(error.textContent).toContain(hint);
        expect(error.textContent).toContain(code);
        expect(error.textContent).not.toContain("control-plane said no");
        // 技术详情默认折叠（有触发器、无展开内容在 DOM 里可见）。
        expect(maybe('[data-testid="apd-model-error-detail-toggle"]')).not.toBeNull();
    });

    it("只读档（instance 层 Q2）：不给保存键、输入全部 disabled", async () => {
        const wrapper = mountDrawer({ readonly: true, editableSections: [] });
        await flushPromises();

        expect(maybe('[data-testid="apd-model-save"]')).toBeNull();
        expect(maybe('[data-testid="apd-delegation-save"]')).toBeNull();
        expect(maybe('[data-testid="apd-memory-save"]')).toBeNull();
        expect(maybe('[data-testid="apd-hooks-save"]')).toBeNull();
        // 三段选择器全部 disabled（不是靠隐藏假装只读）。
        expect(wrapper.findAllComponents(Select)[0]!.props("disabled")).toBe(true);
        expect(
            selectModelValue(wrapper as never, '[data-testid="apd-model-binding-provider"]'),
        ).toBe("openai");
        expect(maybe('[data-testid="apd-disable"]')).toBeNull();
    });

    it("未知分区（workspace 层不携带该字段）：显示「到用户层配置」而不是假默认值", async () => {
        mountDrawer({ editableSections: ["hooks"], unknownSections: ["model", "delegation"] });
        await flushPromises();

        expect(q('[data-testid="apd-model-unknown"]').textContent).toContain("用户层");
        expect(q('[data-testid="apd-delegation-unknown"]').textContent).toContain("用户层");
        expect(maybe('[data-testid="apd-model-save"]')).toBeNull();
    });

    it("已禁用主体：身份区显示「已禁用」徽标，且危险区不渲染（禁用是终态，不给第二个「禁用」键）", async () => {
        mountDrawer({ principal: principal({ disabled: true }), showDanger: true });
        await flushPromises();

        expect(q('[data-testid="apd-disabled-badge"]').textContent).toContain("已禁用");
        // showDanger=true 也不渲染：危险区的前提是「还能禁用」，已禁用行没有这个动作。
        expect(maybe('[data-testid="apd-disable"]')).toBeNull();
        expect(maybe('[data-testid="apd-danger"]')).toBeNull();
    });

    it("未禁用主体 + showDanger：危险区渲染出「禁用主体」键", async () => {
        mountDrawer({ showDanger: true });
        await flushPromises();

        expect(maybe('[data-testid="apd-disabled-badge"]')).toBeNull();
        expect(q('[data-testid="apd-danger"]')).toBeTruthy();
        expect(q('[data-testid="apd-disable"]').textContent).toContain("禁用主体");
    });

    it("await 后回填守卫：请求在途时抽屉已关 ⇒ 不回填、不 emit", async () => {
        let resolveUpdate: ((value: unknown) => void) | null = null;
        vi.spyOn(api, "updateAgentPrincipal").mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveUpdate = resolve;
                }) as never,
        );
        const wrapper = mountDrawer();
        await flushPromises();

        await pickAnthropic(wrapper);
        q('[data-testid="apd-model-save"]').click();
        await nextTick();

        await wrapper.setProps({ open: false, principal: null });
        resolveUpdate?.({
            principalId: "p-1",
            defaultModelProvider: "openai",
            defaultModelName: "claude-x",
            allowedModels: null,
            hooks: null,
            contextPolicy: null,
            delegationPolicy: null,
        });
        await flushPromises();

        expect(wrapper.emitted("changed")).toBeUndefined();
    });

    it("连接诊断 · 0 条：告警新建会话会失败，并点名后端 PROVIDER_REQUIRED", async () => {
        configState.providerConnections = configState.providerConnections.filter(
            (item) => item.providerId !== "openai",
        );
        mountDrawer();
        await flushPromises();

        const diagnostic = q('[data-testid="apd-model-diagnostic"]');
        expect(diagnostic.dataset.state).toBe("none");
        expect(diagnostic.textContent).toContain("新建会话会失败");
        // 与 SessionService.bindProviderConnection 的 400 PROVIDER_REQUIRED 同义。
        expect(diagnostic.textContent).toContain("PROVIDER_REQUIRED");
    });

    it("连接诊断 · 1 条：告知会绑定哪条连接", async () => {
        mountDrawer();
        await flushPromises();

        const diagnostic = q('[data-testid="apd-model-diagnostic"]');
        expect(diagnostic.dataset.state).toBe("single");
        expect(diagnostic.textContent).toContain("GPT 主连接");
    });

    it("连接诊断 · N 条：文案对齐后端 400 PROVIDER_CONNECTION_AMBIGUOUS 的后果", async () => {
        // 后端原文（SessionService.java:596-604）：
        // Multiple usable chat connections (N); pass providerConnectionId explicitly. Candidates: …
        configState.providerConnections = [
            ...configState.providerConnections,
            {
                id: "conn-openai-second",
                providerId: "openai",
                connectionKey: "openai-second",
                operation: "chat",
                label: "GPT 备连接",
                enabled: true,
            },
        ];
        mountDrawer();
        await flushPromises();

        const diagnostic = q('[data-testid="apd-model-diagnostic"]');
        expect(diagnostic.dataset.state).toBe("ambiguous");
        expect(diagnostic.textContent).toContain("PROVIDER_CONNECTION_AMBIGUOUS");
        expect(diagnostic.textContent).toContain("2");
        expect(diagnostic.textContent).toContain("新建会话会失败");
    });

    it("存量裸串：值不在任何已登记连接里 ⇒ 只警示、不清空、不改写", async () => {
        mountDrawer({
            principal: principal({
                defaultModelProvider: "legacy-provider",
                defaultModelName: "gpt-3.5-legacy",
                allowedModels: null,
            }),
        });
        await flushPromises();

        const legacy = q('[data-testid="apd-model-legacy"]');
        expect(legacy.textContent).toContain("legacy-provider");
        expect(legacy.textContent).toContain("gpt-3.5-legacy");
        // 原值仍在草稿里（选择器显示的就是它），没有被替换成空或自动改指某条连接。
        const wrapper = mountDrawer({
            principal: principal({
                defaultModelProvider: "legacy-provider",
                defaultModelName: "gpt-3.5-legacy",
                allowedModels: null,
            }),
        });
        await flushPromises();
        expect(
            selectModelValue(wrapper as never, '[data-testid="apd-model-binding-provider"]'),
        ).toBe("legacy-provider");
        expect(
            selectModelValue(wrapper as never, '[data-testid="apd-model-binding-model-name"]'),
        ).toBe("gpt-3.5-legacy");
    });

    it("白名单成对校验：新加的空行挡住保存、不发请求", async () => {
        const update = vi.spyOn(api, "updateAgentPrincipal");
        mountDrawer();
        await flushPromises();

        await click("apd-allowed-add");
        const save = q<HTMLButtonElement>('[data-testid="apd-model-save"]');
        expect(save.disabled).toBe(true);
        save.click();
        await flushPromises();
        expect(update).not.toHaveBeenCalled();
    });

    it("白名单落库：连接只用于挑模型，wire 仍是成对 {provider, model}", async () => {
        const update = vi.spyOn(api, "updateAgentPrincipal").mockResolvedValue({
            principalId: "p-1",
            defaultModelProvider: "openai",
            defaultModelName: "gpt-4o-mini",
            allowedModels: [
                { provider: "openai", model: "gpt-4o-mini" },
                { provider: "anthropic", model: "claude-x" },
            ],
            hooks: null,
            contextPolicy: null,
            delegationPolicy: null,
        });
        const wrapper = mountDrawer();
        await flushPromises();

        await click("apd-allowed-add");
        await pick(wrapper, "apd-allowed-1-provider", "anthropic");
        await pick(wrapper, "apd-allowed-1-connection", "conn-anthropic");
        await pick(wrapper, "apd-allowed-1-model-name", "claude-x");
        await click("apd-model-save");

        const body = update.mock.calls[0]![1] as Record<string, unknown>;
        expect(Object.keys(body)).toEqual(["allowedModels"]);
        expect(body.allowedModels).toEqual([
            { provider: "openai", model: "gpt-4o-mini" },
            { provider: "anthropic", model: "claude-x" },
        ]);
        // 连接 id 不上 wire（契约：主体不持有 provider connection）。
        expect(JSON.stringify(body.allowedModels)).not.toContain("conn-");
    });
});
