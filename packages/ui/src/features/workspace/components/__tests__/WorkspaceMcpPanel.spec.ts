import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import WorkspaceMcpPanel from "../WorkspaceMcpPanel.vue";
import type * as apiModule from "../../../../composables/api";

// PLAN-0759 / BL-548: the OAuth block must survive the CP round-trip so the
// authorize entry renders. Before the fix PUT dropped oauth and GET rebuilt
// {url,type} only, so getRemoteServers() always returned [] and the entry was
// unreachable. These tests pin the UI-side contract (field names + rendering).
const { getMcpConfig, saveMcpConfig, startOAuthSession, completeOAuthSession } = vi.hoisted(() => ({
    getMcpConfig: vi.fn<typeof apiModule.api.getMcpConfig>(),
    saveMcpConfig: vi.fn<typeof apiModule.api.saveMcpConfig>(),
    startOAuthSession: vi.fn<typeof apiModule.api.startOAuthSession>(),
    completeOAuthSession: vi.fn<typeof apiModule.api.completeOAuthSession>(),
}));
vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            getMcpConfig,
            saveMcpConfig,
            startOAuthSession,
            completeOAuthSession,
        },
    };
});

const i18n = createI18n({
    legacy: false,
    locale: "zh",
    messages: {
        zh: {
            common: { loading: "加载中", save: "保存", saved: "已保存", cancel: "取消" },
            settings: {
                domainMcp: "MCP",
                mcpJsonPlaceholder: "MCP 配置 JSON",
                invalidJson: "JSON 格式无效",
                saveFailed: "保存失败",
                authorizationFailed: "授权失败",
                authorize: "授权",
                authorized: "已授权",
                mcpOAuthHint: "配置 OAuth 后可在此授权",
            },
        },
    },
});

function remoteConfig() {
    return {
        mcpServers: {
            "remote-demo": {
                url: "https://example.com/mcp",
                type: "http",
                oauth: {
                    clientId: "client-123",
                    authorizationEndpoint: "https://auth.example.com/authorize",
                    tokenEndpoint: "https://auth.example.com/token",
                    redirectUri: "http://localhost:5173/oauth/callback",
                    scope: "mcp:read",
                },
            },
        },
    };
}

function mountPanel() {
    return mount(WorkspaceMcpPanel, {
        props: { workspaceId: "ws-1" },
        global: { plugins: [i18n] },
    });
}

describe("WorkspaceMcpPanel remote OAuth (PLAN-0759)", () => {
    beforeEach(() => {
        getMcpConfig.mockReset();
        saveMcpConfig.mockReset();
        startOAuthSession.mockReset();
        completeOAuthSession.mockReset();
        window.history.replaceState({}, "", "/workspace/ws-1");
    });

    it("renders the authorize entry for a remote server with a complete oauth block", async () => {
        getMcpConfig.mockResolvedValue(remoteConfig());
        const wrapper = mountPanel();
        await flushPromises();
        const entry = wrapper.find('[data-testid="remote-mcp-remote-demo"]');
        expect(entry.exists()).toBe(true);
        expect(entry.text()).toContain("remote-demo");
        // The authorize button sits inside the entry row (no dedicated testid); assert
        // its presence via the row's button element.
        expect(entry.find("button").exists()).toBe(true);
    });

    it("keeps the oauth block when saving the edited JSON", async () => {
        getMcpConfig.mockResolvedValue(remoteConfig());
        saveMcpConfig.mockResolvedValue({ status: "ok" });
        const wrapper = mountPanel();
        await flushPromises();
        const textarea = wrapper.find('[data-testid="mcp-config-textarea"]');
        await textarea.setValue(JSON.stringify(remoteConfig().mcpServers));
        await wrapper.find('[data-testid="mcp-config-save"]').trigger("click");
        await flushPromises();
        expect(saveMcpConfig).toHaveBeenCalled();
        // saveMcpConfig(wsId, mcpServersJsonString) — the panel must serialize the
        // parsed object itself; api.ts wraps it in { mcpServers }.
        const sent = saveMcpConfig.mock.calls[0][1] as string;
        expect(typeof sent).toBe("string");
        expect(JSON.parse(sent)).toEqual(remoteConfig().mcpServers);
    });
});
