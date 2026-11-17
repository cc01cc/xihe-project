import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";

import { api, ApiError } from "../../../composables/api";
import { i18n } from "../../../i18n";
import AgentPrincipalDetailDrawer, {
    type AgentPrincipalDetail,
} from "../AgentPrincipalDetailDrawer.vue";

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

        await setName("apd-model-provider", "anthropic");
        await setName("apd-model-name", "claude-x");
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

    it("Provider 与模型成对：半填时保存被挡住、不发请求", async () => {
        const update = vi.spyOn(api, "updateAgentPrincipal");
        mountDrawer();
        await flushPromises();

        await setName("apd-model-name", "");
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
        mountDrawer();
        await flushPromises();

        await setName("apd-model-name", "claude-x");
        await click("apd-model-save");

        const error = q('[data-testid="apd-model-error"]');
        expect(error.textContent).toContain(hint);
        expect(error.textContent).toContain(code);
        expect(error.textContent).not.toContain("control-plane said no");
        // 技术详情默认折叠（有触发器、无展开内容在 DOM 里可见）。
        expect(maybe('[data-testid="apd-model-error-detail-toggle"]')).not.toBeNull();
    });

    it("只读档（instance 层 Q2）：不给保存键、输入全部 disabled", async () => {
        mountDrawer({ readonly: true, editableSections: [] });
        await flushPromises();

        expect(maybe('[data-testid="apd-model-save"]')).toBeNull();
        expect(maybe('[data-testid="apd-delegation-save"]')).toBeNull();
        expect(maybe('[data-testid="apd-memory-save"]')).toBeNull();
        expect(maybe('[data-testid="apd-hooks-save"]')).toBeNull();
        expect(q<HTMLInputElement>('[data-testid="apd-model-provider"]').disabled).toBe(true);
        expect(maybe('[data-testid="apd-disable"]')).toBeNull();
    });

    it("未知分区（workspace 层不携带该字段）：显示「到用户层配置」而不是假默认值", async () => {
        mountDrawer({ editableSections: ["hooks"], unknownSections: ["model", "delegation"] });
        await flushPromises();

        expect(q('[data-testid="apd-model-unknown"]').textContent).toContain("用户层");
        expect(q('[data-testid="apd-delegation-unknown"]').textContent).toContain("用户层");
        expect(maybe('[data-testid="apd-model-save"]')).toBeNull();
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

        await setName("apd-model-name", "claude-x");
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
});
