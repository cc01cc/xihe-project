import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import { setActivePinia, createPinia } from "pinia";
import CredentialsPanel from "../CredentialsPanel.vue";
import { api } from "../../../../composables/api";
import type * as apiModule from "../../../../composables/api";
import { i18n } from "../../../../i18n";
import type { CredentialSummary } from "../../../../types";

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string) => void>(),
    },
}));

vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listCredentials: vi.fn<typeof apiModule.api.listCredentials>(),
            createCredential: vi.fn<typeof apiModule.api.createCredential>(),
            replaceCredential: vi.fn<typeof apiModule.api.replaceCredential>(),
            deleteCredential: vi.fn<typeof apiModule.api.deleteCredential>(),
            getCredentialReferences: vi.fn<typeof apiModule.api.getCredentialReferences>(),
            listWorkspaces: vi.fn<typeof apiModule.api.listWorkspaces>(),
            getSelfPermissions: vi.fn<typeof apiModule.api.getSelfPermissions>(),
        },
    };
});

const mockedApi = vi.mocked(api, true);

/** PLAN-0752 T4.4：写操作按 atom 门控；默认给「已授予」，各用例按需收回。 */
function selfPermissions(atoms: string[]) {
    return {
        userId: "user-1",
        instanceCapabilities: [] as string[],
        instancePermissions: atoms.map((actionClass) => ({ actionClass, resource: "*" })),
        workspaces: [],
    };
}

function credential(overrides: Partial<CredentialSummary> = {}): CredentialSummary {
    return {
        id: "11111111-2222-3333-4444-555555555555",
        label: "OpenAI key",
        kind: "token",
        deliveryTier: "lease",
        ownerType: "USER",
        ownerId: "user-1",
        status: "active",
        fingerprint: "abcdef0123456789abcdef0123456789",
        revision: 2,
        createdAt: "2026-10-13T00:00:00Z",
        replacedAt: null,
        referenceCount: 1,
        ...overrides,
    };
}

let wrappers: VueWrapper[] = [];

async function mountPanel(props: Record<string, unknown> = {}): Promise<VueWrapper> {
    const wrapper = mount(CredentialsPanel, {
        attachTo: document.body,
        props,
        global: { plugins: [i18n] },
    });
    wrappers.push(wrapper);
    await flushPromises();
    return wrapper;
}

function bodyEl<T extends Element>(selector: string): T | null {
    return document.body.querySelector(selector) as T | null;
}

async function clickBody(selector: string) {
    const el = bodyEl<HTMLElement>(selector);
    expect(el).toBeTruthy();
    el!.click();
    await nextTick();
}

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    // auth store 的 token 取自 localStorage；没有 token 时 ensureSelfPermissions() 直接 fail-closed。
    localStorage.setItem("xihe-token", "test-token");
    setActivePinia(createPinia());
    // 默认：这台开发机的账号被授予凭据管理（V87:145 给默认角色的 credential_manage@credential:*）。
    mockedApi.getSelfPermissions.mockResolvedValue(
        selfPermissions(["credential_manage", "credential_reveal"]) as never,
    );
});

afterEach(() => {
    for (const wrapper of wrappers) wrapper.unmount();
    wrappers = [];
});

describe("CredentialsPanel (PLAN-0498 T1.1/T1.3)", () => {
    it("renders sanitized list metadata without any plaintext", async () => {
        mockedApi.listCredentials.mockResolvedValue({
            credentials: [credential()],
            count: 1,
        });

        const wrapper = await mountPanel();
        const html = wrapper.html();
        expect(wrapper.text()).toContain("OpenAI key");
        expect(wrapper.text()).toContain("abcdef01234");
        expect(wrapper.text()).not.toContain("abcdef0123456789abcdef0123456789");
        expect(html).not.toContain("sk-test-value");
        expect(bodyEl('[data-testid="credentials-empty"]')).toBeNull();
    });

    it("shows the empty state when the owner has no credentials", async () => {
        mockedApi.listCredentials.mockResolvedValue({ credentials: [], count: 0 });

        await mountPanel();
        expect(bodyEl('[data-testid="credentials-empty"]')?.textContent).toContain("暂无凭据");
    });

    it("localizes a failed load and reissues the request from the error surface (task-189)", async () => {
        mockedApi.listCredentials.mockRejectedValue(new Error("API error 404"));

        const wrapper = await mountPanel();
        const errorBox = wrapper.get('[data-testid="credentials-error"]');
        // 原始 message 不得直渲；统一错误面给本地化文案 + 重试出口。
        expect(errorBox.text()).toContain(i18n.global.t("credentials.loadFailed"));
        expect(errorBox.text()).not.toContain("API error 404");
        expect(wrapper.find('[data-testid="settings-error-panel"]').exists()).toBe(true);

        const before = mockedApi.listCredentials.mock.calls.length;
        await wrapper.get('[data-testid="settings-error-retry"]').trigger("click");
        await flushPromises();
        // 重试必须真的重发（不是只换文案）。
        expect(mockedApi.listCredentials.mock.calls.length).toBeGreaterThan(before);
        const { toast } = await import("vue-sonner");
        expect(toast.error).toHaveBeenCalledWith(i18n.global.t("credentials.refreshFailed"));
    });

    it("opens the detail dialog from a row and shows the delete reference report", async () => {
        mockedApi.listCredentials.mockResolvedValue({
            credentials: [credential()],
            count: 1,
        });
        mockedApi.getCredentialReferences.mockResolvedValue({
            references: [
                {
                    source: "grant",
                    subjectType: "agent_principal",
                    subjectId: "principal-1",
                    actionClass: "credential_use",
                    resource: "credential:11111111-2222-3333-4444-555555555555",
                },
            ],
        });

        await mountPanel();
        await clickBody('[data-testid="credentials-row-11111111-2222-3333-4444-555555555555"]');
        await flushPromises();
        expect(bodyEl('[data-testid="credentials-detail-dialog"]')).toBeTruthy();

        await clickBody('[data-testid="credentials-detail-delete"]');
        await flushPromises();
        const refs = bodyEl('[data-testid="credentials-delete-references"]');
        expect(refs?.textContent).toContain("principal-1");
    });

    it("deletes after confirmation and refreshes the list", async () => {
        mockedApi.listCredentials.mockResolvedValue({
            credentials: [credential()],
            count: 1,
        });
        mockedApi.getCredentialReferences.mockResolvedValue({ references: [] });
        mockedApi.deleteCredential.mockResolvedValue({
            id: "11111111-2222-3333-4444-555555555555",
            deleted: true,
            references: [],
        });

        await mountPanel();
        await clickBody('[data-testid="credentials-row-11111111-2222-3333-4444-555555555555"]');
        await flushPromises();
        await clickBody('[data-testid="credentials-detail-delete"]');
        await flushPromises();
        expect(bodyEl('[data-testid="credentials-delete-no-refs"]')).toBeTruthy();

        await clickBody('[data-testid="credentials-delete-submit"]');
        await flushPromises();

        expect(mockedApi.deleteCredential).toHaveBeenCalledWith(
            "11111111-2222-3333-4444-555555555555",
        );
        expect(mockedApi.listCredentials.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("shows the reveal entry only for reveal-tier credentials", async () => {
        mockedApi.listCredentials.mockResolvedValue({
            credentials: [credential({ deliveryTier: "reveal" })],
            count: 1,
        });

        await mountPanel();
        await clickBody('[data-testid="credentials-row-11111111-2222-3333-4444-555555555555"]');
        await flushPromises();
        expect(bodyEl('[data-testid="credentials-detail-reveal"]')).toBeTruthy();

        await clickBody('[data-testid="credentials-detail-reveal"]');
        await flushPromises();
        expect(bodyEl('[data-testid="credentials-reveal-dialog"]')).toBeTruthy();
        expect(bodyEl('[data-testid="credentials-reveal-password"]')).toBeTruthy();
    });

    // PLAN-0752 T4.4：有 atom ⇒ 出「新建」按钮（正常路径）；没 atom ⇒ 403 说明 + **无按钮**，
    // 但列表照旧加载（列表在 CP 侧没有 atom，整页 403 会骗人）。
    it("shows the create entry when credential_manage is granted", async () => {
        mockedApi.listCredentials.mockResolvedValue({ credentials: [], count: 0 });

        await mountPanel();
        await flushPromises();

        expect(bodyEl('[data-testid="credentials-create-button"]')).toBeTruthy();
        expect(bodyEl('[data-testid="settings-atom-denied"]')).toBeNull();
    });

    it("replaces the create entry with a 403 explanation when credential_manage is missing", async () => {
        mockedApi.getSelfPermissions.mockResolvedValue(selfPermissions([]) as never);
        mockedApi.listCredentials.mockResolvedValue({ credentials: [], count: 0 });

        await mountPanel();
        await flushPromises();

        expect(bodyEl('[data-testid="credentials-create-button"]')).toBeNull();
        const denied = bodyEl<HTMLElement>('[data-testid="settings-atom-denied"]');
        expect(denied?.textContent).toContain("credential_manage");
        // PLAN-0772 M2 / Lead 裁定 a：**先判权限再判错误** —— 没有 atom 时连列表请求都不发，
        // 页面上也就不会同时出现「权限不足」卡片与「无法加载凭据列表」错误条（一件事说两遍）。
        expect(mockedApi.listCredentials).not.toHaveBeenCalled();
        expect(bodyEl('[data-testid="credentials-error"]')).toBeNull();
        expect(mockedApi.createCredential).not.toHaveBeenCalled();
    });

    // PLAN-0752 T4.2：工作区层把同一份面板限定到 owner_type=WORKSPACE（凭据只有 USER/WORKSPACE
    // 两档，实例层没有承载 ⇒ 外层左栏走缺口说明，不进这个面板）。
    it("scopes the list and the create flow to WORKSPACE when mounted for the workspace layer", async () => {
        mockedApi.listCredentials.mockResolvedValue({
            credentials: [credential({ ownerType: "WORKSPACE", ownerId: "ws-1", label: "ws key" })],
            count: 1,
        });

        const wrapper = await mountPanel({ ownerType: "WORKSPACE" });

        expect(mockedApi.listCredentials).toHaveBeenCalledWith({ ownerType: "WORKSPACE" });
        expect(bodyEl('[data-testid="credentials-scope-note"]')?.textContent).toContain(
            "owner_type=WORKSPACE",
        );
        expect(wrapper.text()).toContain("ws key");
    });

    it("keeps the unscoped view (both owner types) when no layer is pinned", async () => {
        mockedApi.listCredentials.mockResolvedValue({ credentials: [], count: 0 });

        await mountPanel();

        expect(mockedApi.listCredentials).toHaveBeenCalledWith({});
        expect(bodyEl('[data-testid="credentials-scope-note"]')).toBeNull();
    });

    it("hides the reveal entry for lease-tier credentials", async () => {
        mockedApi.listCredentials.mockResolvedValue({
            credentials: [credential()],
            count: 1,
        });

        await mountPanel();
        await clickBody('[data-testid="credentials-row-11111111-2222-3333-4444-555555555555"]');
        await flushPromises();
        expect(bodyEl('[data-testid="credentials-detail-reveal"]')).toBeNull();
    });
});
