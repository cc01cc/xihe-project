import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * task-165：实例层「凭据」面板。
 *
 * <p>锁三件事：①管理员看到的是**真列表**（渲染出行与计数，不是只有标题）；
 * ②非管理员拿到 **403 卡片**（`settings-atom-denied`）而**不是**信息条，且**一个请求都不发**；
 * ③空态有出口（`instance-credentials-empty-create`）——「空态没有出口」是用户点名的老毛病。</p>
 *
 * <p>task-69：鉴权面是**两件**——能力位（CP list 面的门，`InstanceCredentialController.java:61`）
 * 与动作原子（CP 写面的第二道门，`CredentialAdminService.java:277`）。桩按 CP 守卫的形状给，
 * 不按组件内部变量名给；挂真 store 只会引入与判据无关的 `/auth/me` 取数噪音。</p>
 */
const authState = vi.hoisted(() => ({
    isAdmin: true,
    atoms: new Set<string>(["credential_manage", "credential_reveal"]),
}));

vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({
        hasInstanceAdminCapability: authState.isAdmin,
        hasInstanceAtom: (atom: string) => authState.atoms.has(atom),
    }),
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
import SettingsLayerHeader from "../SettingsLayerHeader.vue";
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
    authState.atoms = new Set(["credential_manage", "credential_reveal"]);
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

    /**
     * 负例（Lead 指定口径：「无 atom ⇒ disabled 不隐藏」，先例 `ResourceLayerTabs.vue:74`）——
     * 有 `cap:instance:admin`（所以列表读得到），但**缺** `credential_manage` / `credential_reveal`：
     * 按钮必须在、点不动，并点名缺哪个原子。
     * 反向断言（隐藏按钮）会红：隐藏等于告诉用户「产品没这个能力」，而 CP 说的是「你没这个原子」。
     */
    it("有 cap 无动作原子：写与揭示按钮 disabled 不隐藏，且理由点名各自原子", async () => {
        authState.atoms = new Set<string>();
        mockedList.mockResolvedValue({
            credentials: [credential("cred-1", "内部 MCP 网关")],
            count: 1,
        });
        const wrapper = mountPanel();
        await flushPromises();

        expect(wrapper.find('[data-testid="instance-credentials-table"]').exists()).toBe(true);
        const create = wrapper.find('[data-testid="instance-credentials-create"]');
        const reveal = wrapper.find('[data-testid="instance-credential-reveal-cred-1"]');
        const del = wrapper.find('[data-testid="instance-credential-delete-cred-1"]');
        for (const button of [create, reveal, del]) {
            expect(button.exists()).toBe(true);
            expect(button.isVisible()).toBe(true);
            expect(button.attributes("disabled")).toBeDefined();
        }
        const notice = wrapper.find('[data-testid="instance-credentials-write-disabled"]');
        expect(notice.exists()).toBe(true);
        expect(notice.text()).toContain("credential_manage");

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
        // 机器判据（钉 reka 陷阱，D-1008/task-165 §vendor）：确认按钮**不能**是
        // vendor `AlertDialogAction` —— 它点下即无条件关闭，先派发 update:open(false) 把动作对象
        // 清空，再派发我们的 click ⇒ 异步删除永远打不出去。本断言用 data-slot 认人：
        // 若有人把普通 Button 换回 AlertDialogAction，这里立刻红（不必等到"点了没反应"）：
        // vendor Button 的 data-slot = "button"，AlertDialogAction 的是 "alert-dialog-action"。
        expect(
            wrapper
                .find('[data-testid="instance-credential-delete-confirm"]')
                .attributes("data-slot"),
        ).toBe("button");
        await wrapper.find('[data-testid="instance-credential-delete-confirm"]').trigger("click");
        await flushPromises();
        expect(mockedDelete).toHaveBeenCalledWith("cred-1");

        wrapper.unmount();
    });
    /**
     * task-176：**标题层级不跳级**。资源页不走域页的 `SettingsDomainView`（域页才渲染 `h2`），
     * 所以面板分节标题曾经是 `h3` ⇒ 屏幕/读屏读出来是 `h1（实例配置）→ h3（凭据）`，**跳过 h2**。
     * 判据用**整页序列**（层标题 h1 + 面板分节标题），不是"标题只有一个"：
     * 期望 `["H1", "H2"]`；改前是 `["H1", "H3"]` ⇒ 必红。
     */
    it("标题层级不跳级：页面标题序列是 h1 → h2", async () => {
        const Host = defineComponent({
            components: { SettingsLayerHeader, InstanceCredentialsPanel },
            template: `<div>
                <SettingsLayerHeader layer="instance" domain="凭据" />
                <InstanceCredentialsPanel />
            </div>`,
        });
        const wrapper = mount(Host, {
            global: { plugins: [i18n], stubs: { RouterLink: true } },
            attachTo: document.body,
        });
        await flushPromises();
        const tags = Array.from(wrapper.element.querySelectorAll("h1,h2,h3,h4")).map(
            (node) => node.tagName,
        );
        expect(tags).toEqual(["H1", "H2"]);
        wrapper.unmount();
    });
});
