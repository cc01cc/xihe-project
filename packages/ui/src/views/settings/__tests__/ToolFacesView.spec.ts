import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import { i18n } from "../../../i18n";
import { setSelectValue } from "../../../test-utils/select";
import { ApiError, api } from "../../../composables/api";
import { useAuthStore } from "../../../stores/auth";
import type * as apiModule from "../../../composables/api";
import type { PolicyToolFaceView } from "../../../types";

vi.mock("vue-router", () => ({
    createRouter: () => ({
        push: vi.fn<() => void>(),
        replace: vi.fn<() => void>(),
        beforeEach: vi.fn<() => void>(),
        afterEach: vi.fn<() => void>(),
        isReady: () => Promise.resolve(),
        currentRoute: { value: {} },
    }),
    createWebHistory: () => ({}),
    useRoute: () =>
        ({
            name: "settings-tool-faces",
            path: "/settings/tool-faces",
            params: {},
            query: {},
            hash: "",
            fullPath: "/settings/tool-faces",
            matched: [],
            redirectedFrom: undefined,
            meta: {},
        }) as RouteLocationNormalizedLoaded,
    useRouter: () => ({
        push: vi.fn<(location: unknown) => Promise<void>>(),
        replace: vi.fn<(location: unknown) => Promise<void>>(),
    }),
    RouterLink: { template: "<a><slot /></a>" },
}));

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message?: unknown) => string | number>(),
        error: vi.fn<(message?: unknown) => string | number>(),
        warning: vi.fn<(message?: unknown) => string | number>(),
    },
}));

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listPolicyToolFaces: vi.fn<typeof apiModule.api.listPolicyToolFaces>(),
            upsertPolicyToolFace: vi.fn<typeof apiModule.api.upsertPolicyToolFace>(),
        },
    };
});

const FACE_ID = "88888888-8888-4888-8888-888888888888",
    USER_ID = "user-1",
    WORKSPACE_ID = "workspace-1";

const builtinFace: PolicyToolFaceView = {
    id: null,
    scope: "builtin",
    ownerId: null,
    tool: "read_file",
    actionClass: "read",
    shape: "structured",
};

const unclassifiedFace: PolicyToolFaceView = {
    id: FACE_ID,
    scope: "workspace",
    ownerId: WORKSPACE_ID,
    tool: "mcp__third_party__do",
    actionClass: "unclassified",
    shape: "opaque",
};

/**
 * PLAN-0610 W5a: instance administration is the capability projection, not a role string.
 *
 * task-74：工具面的 instance scope 对端是 `MANAGE_WORKSPACE_POLICY` **动作原子**
 * （`policy/PolicyController.java:166-168` 的 `isAdmin()` 就是它），不是 `cap:instance:admin`。
 * `atoms` 默认跟随 `admin` 开关（本 spec 不测判据轴，只测页面行为）；给 `atoms` 单独赋值才测轴。
 *
 * task-416 补（归因：task-414 `58a57c9e3` 漏改的消费方）：`canManageWorkspace` 已改为
 * **只认 `workspace:admin` 能力位 / 工作区投影**，不再由 `ownerId` 推断属主。
 * CP 的 `CapabilityProjectionService` 对属主本就下发 `workspaceAdminOf` ⇒ 真实属主一定带这一位。
 * 旧夹具只写 `ownerId`、`workspaceAdminOf: []`，那是**现实中不存在的属主**；三条用例因此变红。
 * 修法是让夹具与 CP 投影一致（属主 ⇒ 带 `workspaceAdminOf`），不是放宽产品判据。
 */
function seedIdentity(
    options: { admin?: boolean; workspaceOwner?: boolean; atoms?: string[] } = {},
) {
    localStorage.setItem(
        "xihe-user",
        JSON.stringify({
            id: USER_ID,
            email: "test@xihe.local",
            capabilities: {
                isInstanceAdmin: options.admin === true,
                isInstanceSuper: false,
                // 属主 ⇒ CP 投影里必带 workspace:admin（见上方 task-416 注）
                workspaceAdminOf: options.workspaceOwner === false ? [] : [WORKSPACE_ID],
            },
        }),
    );
    sessionStorage.setItem(
        "xihe-workspace",
        JSON.stringify({
            id: WORKSPACE_ID,
            name: "Mock Workspace",
            ownerId: options.workspaceOwner === false ? "someone-else" : USER_ID,
        }),
    );
    const atoms = options.atoms ?? (options.admin === true ? ["MANAGE_WORKSPACE_POLICY"] : []);
    useAuthStore().$patch({
        selfPermissions: {
            userId: USER_ID,
            instanceCapabilities: [],
            instancePermissions: atoms.map((actionClass) => ({ actionClass, resource: "*" })),
            workspaces: [],
        },
    });
}

async function mountView() {
    const { default: ToolFacesView } = await import("../ToolFacesView.vue"),
        wrapper = mount(ToolFacesView, { global: { plugins: [i18n] } });
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
    vi.mocked(api.listPolicyToolFaces).mockResolvedValue([builtinFace, unclassifiedFace]);
});

describe("ToolFacesView", () => {
    it("renders built-in and persisted rows with their source and shape", async () => {
        seedIdentity();
        const wrapper = await mountView();

        expect(api.listPolicyToolFaces).toHaveBeenCalledWith("workspace");
        expect(wrapper.find('[data-testid="settings-tool-face-read_file"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-tool-face-source-read_file"]').text()).toBe(
            "内置",
        );
        expect(wrapper.find('[data-testid="settings-tool-face-shape-read_file"]').text()).toContain(
            "结构化",
        );
        expect(
            wrapper.find('[data-testid="settings-tool-face-source-mcp__third_party__do"]').text(),
        ).toBe("工作区");
    });

    it("highlights unclassified rows with the default ask label", async () => {
        seedIdentity();
        const wrapper = await mountView(),
            highlight = wrapper.find(
                '[data-testid="settings-tool-face-unclassified-mcp__third_party__do"]',
            );
        expect(highlight.text()).toContain("默认 ask");
        expect(highlight.text()).toContain("未分类");
    });

    it("offers classification to workspace owners and saves the explicit choice", async () => {
        seedIdentity({ workspaceOwner: true });
        vi.mocked(api.upsertPolicyToolFace).mockResolvedValue({
            ...unclassifiedFace,
            actionClass: "exec",
            shape: "interpreter",
        });
        const wrapper = await mountView();

        await wrapper
            .find('[data-testid="settings-tool-face-classify-mcp__third_party__do"]')
            .trigger("click");
        expect(
            wrapper
                .find('[data-testid="settings-tool-face-classify-form-mcp__third_party__do"]')
                .exists(),
        ).toBe(true);

        await wrapper
            .find('[data-testid="settings-tool-face-classify-action-class-mcp__third_party__do"]')
            .setValue("exec");
        await setSelectValue(
            wrapper,
            '[data-testid="settings-tool-face-classify-shape-mcp__third_party__do"]',
            "interpreter",
        );
        await wrapper
            .find('[data-testid="settings-tool-face-classify-form-mcp__third_party__do"]')
            .trigger("submit");
        await flushPromises();

        expect(api.upsertPolicyToolFace).toHaveBeenCalledWith({
            scope: "workspace",
            tool: "mcp__third_party__do",
            actionClass: "exec",
            shape: "interpreter",
        });
        expect(api.listPolicyToolFaces).toHaveBeenLastCalledWith("workspace");
    });

    it("shows classification copy instead of an entry for non-owners", async () => {
        seedIdentity({ workspaceOwner: false });
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="settings-tool-faces-forbidden"]').text()).toContain(
            "OWNER",
        );
        expect(
            wrapper
                .find('[data-testid="settings-tool-face-classify-mcp__third_party__do"]')
                .exists(),
        ).toBe(false);
        expect(wrapper.find('[data-testid="settings-tool-face-classify-read_file"]').exists()).toBe(
            false,
        );
    });

    it("never offers a workspace override for built-in classifications", async () => {
        seedIdentity({ workspaceOwner: true });
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="settings-tool-face-classify-read_file"]').exists()).toBe(
            false,
        );
        expect(
            wrapper
                .find('[data-testid="settings-tool-face-classify-mcp__third_party__do"]')
                .exists(),
        ).toBe(true);
    });

    it("keeps the instance scope for admins and reloads the catalog for that scope", async () => {
        seedIdentity({ admin: true });
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="settings-tool-faces-scope-instance"]').exists()).toBe(
            true,
        );
        await wrapper.find('[data-testid="settings-tool-faces-scope-instance"]').trigger("click");
        await flushPromises();

        expect(api.listPolicyToolFaces).toHaveBeenLastCalledWith("instance");
    });

    /**
     * task-74 判据轴：instance scope 由 `MANAGE_WORKSPACE_POLICY` 原子决定
     * （`policy/PolicyController.java:166-168`），能力位既不能替代它、也不该拦它。
     */
    it("gates the instance scope on the MANAGE_WORKSPACE_POLICY atom, not the instance capability", async () => {
        // 有能力位、无原子 ⇒ 不给 instance scope（UI 不比 CP 宽）。
        seedIdentity({ admin: true, atoms: [] });
        const withoutAtom = await mountView();
        expect(
            withoutAtom.find('[data-testid="settings-tool-faces-scope-instance"]').exists(),
        ).toBe(false);
        withoutAtom.unmount();

        // 有原子、无能力位 ⇒ 照给（UI 不比 CP 严）。
        seedIdentity({ admin: false, atoms: ["MANAGE_WORKSPACE_POLICY"] });
        const withAtom = await mountView();
        expect(withAtom.find('[data-testid="settings-tool-faces-scope-instance"]').exists()).toBe(
            true,
        );
        withAtom.unmount();
    });

    it("surfaces a server 403 from classification without pretending success", async () => {
        seedIdentity({ workspaceOwner: true });
        vi.mocked(api.upsertPolicyToolFace).mockRejectedValue(
            new ApiError({
                status: 403,
                code: "FORBIDDEN",
                detail: "workspace-scope faces require workspace OWNER or ADMIN",
                requestId: "test",
            }),
        );
        const wrapper = await mountView();

        await wrapper
            .find('[data-testid="settings-tool-face-classify-mcp__third_party__do"]')
            .trigger("click");
        await wrapper
            .find('[data-testid="settings-tool-face-classify-action-class-mcp__third_party__do"]')
            .setValue("exec");
        await wrapper
            .find('[data-testid="settings-tool-face-classify-form-mcp__third_party__do"]')
            .trigger("submit");
        await flushPromises();

        expect(
            wrapper
                .find('[data-testid="settings-tool-face-classify-validation-mcp__third_party__do"]')
                .text(),
        ).toContain("FORBIDDEN");
        expect(wrapper.find('[data-testid="settings-tool-faces-error"]').text()).toContain(
            "FORBIDDEN",
        );
    });

    it("renders the empty state when the catalog has no rows", async () => {
        seedIdentity();
        vi.mocked(api.listPolicyToolFaces).mockResolvedValue([]);
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="settings-tool-faces-empty"]').exists()).toBe(true);
    });
});
