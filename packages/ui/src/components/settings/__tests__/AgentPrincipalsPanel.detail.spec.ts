import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

import { api, type AgentPrincipalSummary } from "../../../composables/api";
import { i18n } from "../../../i18n";
import AgentPrincipalsPanel from "../AgentPrincipalsPanel.vue";

/**
 * task-191 · **入口可达性**：user 层列表行上的「配置」必须能把详情抽屉打开，且带的就是这一行。
 *
 * <p>为什么单列这件：抽屉自身的行为在 `AgentPrincipalDetailDrawer.spec.ts` 里咬；这里只证明
 * 「新面有可达入口」—— 静态可约束但没人量的入口，等于交给用户盲点（D-1811 口径）。
 * 同时咬住一条不变量：**入口对每一行都在**（不能只在某些行渲染，那样用户以为某主体不可配）。</p>
 */

function row(overrides: Partial<AgentPrincipalSummary> = {}): AgentPrincipalSummary {
    return {
        principalId: "p-1",
        name: "ResearchAgent",
        templateId: null,
        templateName: "Researcher",
        createdAt: "2026-11-01T02:03:04Z",
        disabled: false,
        ownership: "USER",
        hooks: null,
        contextPolicy: null,
        delegationPolicy: { maxCount: 8, maxDepth: 3 },
        allowedModels: null,
        defaultModelProvider: "openai",
        defaultModelName: "gpt-4o-mini",
        ...overrides,
    } as AgentPrincipalSummary;
}

function q<T extends Element = HTMLElement>(selector: string): T {
    const node = document.body.querySelector<T>(selector);
    if (!node) throw new Error("missing node: " + selector);
    return node;
}

beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.spyOn(api, "getSelfPermissions").mockResolvedValue({
        instancePermissions: [],
        workspaces: [],
    } as never);
    vi.spyOn(api, "listWorkspaces").mockResolvedValue([]);
    vi.spyOn(api, "getAgentRoles").mockResolvedValue([]);
});

describe("AgentPrincipalsPanel · 详情入口", () => {
    it("每行都有「配置」入口；点击后抽屉带该行打开（ownership/delegation 随行进入）", async () => {
        vi.spyOn(api, "listMyAgentPrincipals").mockResolvedValue([
            row(),
            row({ principalId: "p-2", name: "SecondAgent" }),
        ]);

        mount(AgentPrincipalsPanel, {
            global: { plugins: [i18n] },
            attachTo: document.body,
        });
        await flushPromises();

        expect(
            document.body.querySelectorAll('[data-testid="agent-principals-configure-p-1"]').length,
        ).toBe(1);
        expect(
            document.body.querySelectorAll('[data-testid="agent-principals-configure-p-2"]').length,
        ).toBe(1);
        // 未点击前不渲染抽屉内容（不是渲染了再隐藏 —— 那会白读一次角色接口）。
        expect(
            document.body.querySelector('[data-testid="agent-principal-detail-title"]'),
        ).toBeNull();

        q('[data-testid="agent-principals-configure-p-1"]').click();
        await flushPromises();

        expect(q('[data-testid="agent-principal-detail-title"]').textContent).toContain(
            "ResearchAgent",
        );
        // 行字段贯通：user 层列表带 delegationPolicy ⇒ 抽屉委派区是真值而不是「未知分区」。
        expect(document.body.querySelector('[data-testid="apd-delegation-unknown"]')).toBeNull();
        expect(q<HTMLInputElement>('[data-testid="delegation-policy-max-count"]').value).toBe("8");
        expect(q('[data-testid="apd-ownership"]').textContent?.trim().length).toBeGreaterThan(0);
    });

    it("列表加载失败时不出「配置」入口（没有行就没有目标，不渲染空抽屉）", async () => {
        vi.spyOn(api, "listMyAgentPrincipals").mockRejectedValue(new Error("boom"));

        mount(AgentPrincipalsPanel, {
            global: { plugins: [i18n] },
            attachTo: document.body,
        });
        await flushPromises();

        expect(
            document.body.querySelector('[data-testid="agent-principals-error"]'),
        ).not.toBeNull();
        expect(
            document.body.querySelector('[data-testid^="agent-principals-configure-"]'),
        ).toBeNull();
    });
});
