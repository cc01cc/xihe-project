import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * task-165：实例层「凭据」面板。
 *
 * <p>锁三件事：①管理员看到的是**真列表**（渲染出行与计数，不是只有标题）；
 * ②非管理员拿到 **403 卡片**（`settings-atom-denied`）而**不是**信息条，且**一个请求都不发**；
 * ③空态有出口（`instance-credentials-empty-create`）——「空态没有出口」是用户点名的老毛病。</p>
 *
 * <p>auth 用一个只有 `isAdmin` 的桩：本面板对鉴权面的唯一依赖就是这个能力位投影
 * （`stores/auth.ts:70` 的 `isAdmin` = `capabilities.isInstanceAdmin`，不是角色字符串），
 * 挂真 store 只会引入与判据无关的 `/auth/me` 取数噪音。</p>
 */
const authState = vi.hoisted(() => ({ isAdmin: true }));

vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => authState,
}));

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string) => void>(),
    },
}));

vi.mock("../../../services/instanceResources", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../services/instanceResources")>();
    return {
        ...actual,
        listInstanceCredentials: vi.fn<typeof actual.listInstanceCredentials>(),
        createInstanceCredential: vi.fn<typeof actual.createInstanceCredential>(),
        deleteInstanceCredential: vi.fn<typeof actual.deleteInstanceCredential>(),
        revealInstanceCredential: vi.fn<typeof actual.revealInstanceCredential>(),
    };
});

import {
    deleteInstanceCredential,
    listInstanceCredentials,
    type InstanceCredential,
} from "../../../services/instanceResources";
import { i18n } from "../../../i18n";
import InstanceCredentialsPanel from "../InstanceCredentialsPanel.vue";

const mockedList = vi.mocked(listInstanceCredentials);
const mockedDelete = vi.mocked(deleteInstanceCredential);

function credential(id: string, label: string): InstanceCredential {
    return {
        id,
        label,
        kind: "token",
        deliveryTier: "lease",
        status: "active",
        fingerprint: "sha256:mock…0000",
        revision: 1,
        createdAt: "2026-11-02T09:05:00Z",
        replacedAt: null,
        referenceCount: 0,
    };
}

function mountPanel() {
    return mount(InstanceCredentialsPanel, {
        global: { plugins: [i18n] },
        attachTo: document.body,
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    authState.isAdmin = true;
    mockedList.mockResolvedValue({ credentials: [], count: 0 });
});

describe("InstanceCredentialsPanel", () => {
    it("管理员：列出实例凭据（行 + 计数），空态另有出口", async () => {
        mockedList.mockResolvedValue({
            credentials: [
                credential("cred-1", "内部 MCP 网关"),
                credential("cred-2", "观测平台读写"),
            ],
            count: 2,
        });
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="instance-credentials-heading"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="instance-credentials-table"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="instance-credential-row-cred-1"]').text()).toContain(
            "内部 MCP 网关",
        );
        expect(wrapper.find('[data-testid="instance-credential-row-cred-2"]').exists()).toBe(true);
        // 计数与可见行必须同源：2 行 ⇒ 文案里就是 2。
        expect(wrapper.text()).toContain("2 份凭据");
        expect(wrapper.find('[data-testid="settings-atom-denied"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="instance-credentials-empty"]').exists()).toBe(false);

        wrapper.unmount();
    });

    it("空列表：空态有出口（可点创建），不是只写一句「还没有」", async () => {
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="instance-credentials-empty"]').exists()).toBe(true);
        const cta = wrapper.find('[data-testid="instance-credentials-empty-create"]');
        expect(cta.exists()).toBe(true);
        await cta.trigger("click");
        expect(wrapper.find('[data-testid="instance-credentials-create-dialog"]').exists()).toBe(
            true,
        );

        wrapper.unmount();
    });

    it("非实例管理员：403 卡片，且不发列表请求", async () => {
        authState.isAdmin = false;
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-atom-denied"]').exists()).toBe(true);
        // 403 ≠ 缺口：这两张卡长得不一样，混用必须红。
        expect(wrapper.find('[data-testid="settings-atom-denied-not-gap"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-no-atom-notice"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="instance-credentials-panel"]').exists()).toBe(true);
        // 主体不挂载 ⇒ 不发无谓请求。
        expect(mockedList).not.toHaveBeenCalled();

        wrapper.unmount();
    });

    it("删除走确认弹窗，确认后才调用删除端点", async () => {
        mockedList.mockResolvedValue({
            credentials: [credential("cred-1", "内部 MCP 网关")],
            count: 1,
        });
        mockedDelete.mockResolvedValue(undefined);
        const wrapper = mountPanel();
        await flushPromises();

        await wrapper.find('[data-testid="instance-credential-delete-cred-1"]').trigger("click");
        expect(mockedDelete).not.toHaveBeenCalled();
        expect(wrapper.find('[data-testid="instance-credential-delete-dialog"]').exists()).toBe(
            true,
        );

        // 注意：vendor `AlertDialogAction` 点下即关闭（先 `update:open(false)` 再派发 click），
        // 所以这里断言的是「确认后端点被调用」，不依赖弹窗仍然开着。
        await wrapper.find('[data-testid="instance-credential-delete-confirm"]').trigger("click");
        await flushPromises();
        expect(mockedDelete).toHaveBeenCalledWith("cred-1");

        wrapper.unmount();
    });
});
