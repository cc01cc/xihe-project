import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";

import { api, type AgentRoleBinding } from "../../../composables/api";
import { i18n } from "../../../i18n";
import AgentPrincipalDetailDrawer, {
    type AgentPrincipalDetail,
} from "../AgentPrincipalDetailDrawer.vue";

/**
 * task-994：实例层「允许执行」开关（WS_RUNNER @ instance scope）。
 *
 * <p>咬住四件事，全部是「会静默错」的类型：</p>
 * <ol>
 *   <li><b>权限禁用不是角色判断</b>：没有 `MANAGE_AGENT_PRINCIPALS` 时开关必须 disabled 并说明原因
 *       （不是隐藏、不是点下去 403）；</li>
 *   <li><b>开启 = 绑实例档预设</b>：调用 `bindAgentRole(null, principalId, WS_RUNNER)`；</li>
 *   <li><b>关闭 = 按读面给的 bindingId 解绑</b>：不猜 id、不本地翻转；</li>
 *   <li><b>只认实例档</b>：同一主体在某个工作区绑了 WS_RUNNER 不等于实例层已授予执行。</li>
 * </ol>
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

vi.mock("vue-router", () => ({
    useRoute: () => ({ params: {}, query: {} }),
    useRouter: () => ({
        replace: vi.fn<() => Promise<void>>(() => Promise.resolve()),
        push: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    }),
    onBeforeRouteLeave: () => {},
    onBeforeRouteUpdate: () => {},
}));

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string) => void>(),
    },
}));

const WS_RUNNER_ID = "00000000-0000-4000-8000-000000000011";

function principal(overrides: Partial<AgentPrincipalDetail> = {}): AgentPrincipalDetail {
    return {
        principalId: "p-1",
        name: "Lead",
        ownership: "INSTANCE",
        templateName: null,
        createdAt: "2026-11-24T00:00:00Z",
        disabled: false,
        defaultModelProvider: null,
        defaultModelName: null,
        hooks: null,
        contextPolicy: null,
        delegationPolicy: null,
        systemPrompt: null,
        ...overrides,
    };
}

function wsRunner(scopeType: string, bindingId = "b-ws-runner"): AgentRoleBinding {
    return {
        bindingId,
        roleId: WS_RUNNER_ID,
        name: "WS_RUNNER",
        displayName: "Workspace Runner",
        scopeType,
        scopeId: scopeType === "instance" ? null : "ws-1",
        scopeName: null,
        isSystem: false,
        grantedBy: null,
        atomSummary: ["执行", "使用工作区运行时"],
        atomCount: 2,
        atomsTruncated: false,
    };
}

function mountDrawer(props: Record<string, unknown> = {}) {
    return mount(AgentPrincipalDetailDrawer, {
        props: {
            open: true,
            principal: principal(),
            execToggle: true,
            execToggleEditable: true,
            ...props,
        } as never,
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

async function click(testid: string): Promise<void> {
    q(`[data-testid="${testid}"]`).click();
    await flushPromises();
    await nextTick();
}

beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.spyOn(api, "getAgentRoles").mockResolvedValue([]);
    vi.spyOn(api, "bindAgentRole").mockResolvedValue();
    vi.spyOn(api, "unbindAgentRole").mockResolvedValue();
});

describe("AgentPrincipalDetailDrawer · 执行权限（task-994）", () => {
    it("没有 MANAGE_AGENT_PRINCIPALS 时开关禁用并说明原因，而不是隐藏", async () => {
        mountDrawer({ execToggleEditable: false });
        await flushPromises();
        await nextTick();

        const sw = q<HTMLButtonElement>('[data-testid="apd-exec-switch"]');
        expect(sw.disabled).toBe(true);
        // 「还不知道/没权限」必须能读出来；把原因藏起来会让用户以为坏了。
        expect(maybe('[data-testid="apd-exec-denied"]')).not.toBeNull();
        expect(document.body.textContent).toContain("MANAGE_AGENT_PRINCIPALS");
    });

    it("有权限且未绑定时，开启调用实例档 bind（workspaceId=null）", async () => {
        mountDrawer();
        await flushPromises();
        await nextTick();

        const sw = q<HTMLButtonElement>('[data-testid="apd-exec-switch"]');
        expect(sw.disabled).toBe(false);
        expect(sw.getAttribute("aria-checked")).toBe("false");
        expect(maybe('[data-testid="apd-exec-denied"]')).toBeNull();

        await click("apd-exec-switch");

        expect(api.bindAgentRole).toHaveBeenCalledTimes(1);
        expect(api.bindAgentRole).toHaveBeenCalledWith(null, "p-1", WS_RUNNER_ID);
    });

    it("实例档已有 WS_RUNNER 时开关为开，关闭按读面 bindingId 解绑", async () => {
        vi.spyOn(api, "getAgentRoles").mockResolvedValue([wsRunner("instance", "b-instance")]);
        mountDrawer();
        await flushPromises();
        await nextTick();

        const sw = q<HTMLButtonElement>('[data-testid="apd-exec-switch"]');
        expect(sw.getAttribute("aria-checked")).toBe("true");

        await click("apd-exec-switch");

        expect(api.unbindAgentRole).toHaveBeenCalledTimes(1);
        expect(api.unbindAgentRole).toHaveBeenCalledWith(null, "p-1", "b-instance");
    });

    it("工作区档的 WS_RUNNER 不算实例层已授予执行", async () => {
        vi.spyOn(api, "getAgentRoles").mockResolvedValue([wsRunner("workspace", "b-workspace")]);
        mountDrawer();
        await flushPromises();
        await nextTick();

        const sw = q<HTMLButtonElement>('[data-testid="apd-exec-switch"]');
        expect(sw.getAttribute("aria-checked")).toBe("false");
    });

    it("绑定失败时显示可读错误并重读读面（不本地翻转）", async () => {
        vi.spyOn(api, "bindAgentRole").mockRejectedValue(new Error("boom"));
        mountDrawer();
        await flushPromises();
        await nextTick();

        await click("apd-exec-switch");

        expect(maybe('[data-testid="apd-exec-error"]')).not.toBeNull();
        const sw = q<HTMLButtonElement>('[data-testid="apd-exec-switch"]');
        expect(sw.getAttribute("aria-checked")).toBe("false");
    });
});
