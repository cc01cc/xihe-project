import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../../../i18n";
import WorkspaceConfigPanel from "../WorkspaceConfigPanel.vue";
import ConfigLayerPanels from "../../../../components/settings/ConfigLayerPanels.vue";

/**
 * task-472（D-1367 健壮性/潜在缺陷）：面板的只读判据来自 `/me/permissions` 投影。
 *
 * <p>**受影响的不是「非实例管理员的工作区 OWNER」**（WS_OWNER 种子含 `workspace:admin`
 * ⇒ 任何真 OWNER 都会被 CP 的 `workspaceAdminOf` 列进去，无投影也能管理）；真正的判别条件是
 * **`user.capabilities` 缺失或过期**（cached pre-upgrade / `/me` 取不到且无缓存）。
 * 本 spec 的用户夹具**故意不带 capabilities**，正是那一类。</p>
 *
 * <p>断言落在 **`ConfigLayerPanels` 收到的 `readonly` prop** 上，而不是某个下游 DOM 细节：
 * 那是这个面板真正产出给下层的判据。</p>
 */

const WORKSPACE_ID = "77777777-7777-4777-8777-777777777777";

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
}

/** 默认：所有配置域读面返回空层；`/me/permissions` 交给用例自己定。 */
function mockFetch(projection: { status: number; body?: unknown }) {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("/me/permissions")) {
            return Promise.resolve(
                projection.status === 200
                    ? jsonResponse(projection.body ?? {})
                    : jsonResponse({}, projection.status),
            );
        }
        return Promise.resolve(
            jsonResponse({ domain: "instance-models", entries: {}, envOverridden: {} }),
        );
    });
}

async function mountPanel() {
    const wrapper = mount(WorkspaceConfigPanel, {
        global: {
            plugins: [i18n],
            stubs: { ConfigLayerPanels: true },
        },
    });
    await flushPromises();
    return wrapper;
}

function projectionRequests(fetchSpy: ReturnType<typeof vi.spyOn>): number {
    return (fetchSpy.mock.calls as unknown[][]).filter((call) => {
        const arg = call[0] as string | Request;
        return String(typeof arg === "string" ? arg : arg.url).includes("/me/permissions");
    }).length;
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
    localStorage.setItem("xihe-token", "test-token");
    // 故意不带 capabilities：这就是受影响的「capabilities 缺失」主体。
    localStorage.setItem("xihe-user", JSON.stringify({ id: "u1", email: "owner@xihe.local" }));
    localStorage.setItem("xihe-workspace", JSON.stringify({ id: WORKSPACE_ID, name: "Workspace" }));
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("WorkspaceConfigPanel 投影加载（task-472 / D-1367）", () => {
    it("请求能力投影恰好一次（单飞），并把受影响的只读判据算成只读", async () => {
        mockFetch({ status: 200, body: {} });
        const wrapper = await mountPanel();

        expect(projectionRequests(globalThis.fetch as unknown as ReturnType<typeof vi.spyOn>)).toBe(
            1,
        );
        expect(wrapper.find('[data-testid="ws-settings-config"]').exists()).toBe(true);
        expect(wrapper.findComponent(ConfigLayerPanels).props("readonly")).toBe(true);
    });

    it("投影给该工作区 admin 时，面板转为可写（这一条在修前必红：没人请求投影）", async () => {
        mockFetch({
            status: 200,
            body: {
                userId: "u1",
                instanceCapabilities: [],
                instancePermissions: [],
                workspaces: [{ workspaceId: WORKSPACE_ID, workspaceAdmin: true }],
            },
        });
        const wrapper = await mountPanel();

        expect(wrapper.findComponent(ConfigLayerPanels).props("readonly")).toBe(false);
    });

    it("投影 500 时面板仍然渲染，只是保持只读（fail-closed 不是白屏）", async () => {
        mockFetch({ status: 500 });
        const wrapper = await mountPanel();

        expect(wrapper.find('[data-testid="ws-settings-config"]').exists()).toBe(true);
        // 配置域读面本身成功 ⇒ 不该进错误态；只有投影失败。
        expect(wrapper.find('[data-testid="ws-settings-config-error"]').exists()).toBe(false);
        expect(wrapper.findComponent(ConfigLayerPanels).props("readonly")).toBe(true);
    });
});
