import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../../i18n";
import { makeWorkspace } from "../../../tests/workspaceFixture";
import { api } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";

/**
 * task-51 / batch-02（P1）：**「设置页的物理目录」必须等于「环境页的宿主机目录」**。
 *
 * <p>为什么这条要用**一个 spec 同时挂两页**：这两个读数的缺陷形态就是「两处各读各的字段」——
 * 设置页读 `storageRef`（工作区 UUID）、环境页读 `hostPath`（`h:/zeotmp/…`），各自都对
 * 自己的输入「正确」，只有把它们**并排比**才会红。分成两个 spec 各断言各的，改回
 * `storageRef` 时两份都照绿（它们从没约定过同一个值）。</p>
 *
 * <p>承重点（谁改哪一行会红）：<br>
 * ① 设置页把值换回 `auth.workspace?.storageRef`（= 本次修复前的写法）⇒ 第一例红
 *    （`h:/mock/ws` ≠ 工作区 UUID）；<br>
 * ② 设置页换成自己的「管理员/owner 判断」而不复用 `lib/hostPathDisclosure` ⇒ 第三例
 *    （普通成员的可见性）有极大概率红，因为两页的判据会比出分歧；<br>
 * ③ 任一页自己拼路径（没有服务端 `hostPath` 也渲染）⇒ 第二例红（`null` 安全投影）。</p>
 */

const WORKSPACE_ID = "ws-consistency";
const OWNER_ID = "owner-1";
const HOST_PATH = "h:/mock/ws";
const STORAGE_REF = "8b0d1c6e-0000-4000-8000-000000000000";

const routeState = vi.hoisted(() => ({
    workspaceId: "ws-consistency",
    path: "/workspace/ws-consistency/environment",
}));

vi.mock("vue-router", () => ({
    useRoute: () => ({
        name: "workspace-environment",
        path: routeState.path,
        fullPath: routeState.path,
        params: { workspaceId: routeState.workspaceId },
        query: {},
        hash: "",
        matched: [],
        redirectedFrom: undefined,
        meta: {},
    }),
    useRouter: () => ({
        push: vi.fn<() => Promise<void>>(() => Promise.resolve()),
        replace: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    }),
    createRouter: () => ({
        beforeEach: vi.fn<() => void>(),
        push: vi.fn<() => void>(),
        replace: vi.fn<() => void>(),
    }),
    createWebHistory: () => ({}),
}));

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<(message?: unknown) => string | number>(),
        error: vi.fn<(message?: unknown) => string | number>(),
        warning: vi.fn<(message?: unknown) => string | number>(),
        info: vi.fn<(message?: unknown) => string | number>(),
    },
}));

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            getWorkspace: vi.fn<typeof apiModule.api.getWorkspace>(),
            getSelfPermissions: vi.fn<typeof apiModule.api.getSelfPermissions>(),
            getWorkspaceEnvironment: vi.fn<typeof apiModule.api.getWorkspaceEnvironment>(),
            getWorkspaceJobs: vi.fn<typeof apiModule.api.getWorkspaceJobs>(),
        },
    };
});

const mockedApi = vi.mocked(api, true);

/** 两页拿到的是**同一份服务端投影**：同一 `hostPath`、同一 `storageRef`。 */
function workspace(hostPath: string | null) {
    return makeWorkspace({
        id: WORKSPACE_ID,
        name: "Workspace",
        ownerId: OWNER_ID,
        storageRef: STORAGE_REF,
        hostPath,
        workspaceRole: "OWNER",
    });
}

function environment(hostPath: string | null) {
    return {
        workspaceId: WORKSPACE_ID,
        status: "ready",
        storageBackend: "host_directory",
        storageRef: STORAGE_REF,
        storageMode: "direct_attach" as const,
        hostPath,
        executionMode: "windows-host" as const,
        // 环境页模板会读 `environment.runtime.status` 等字段；缺了它渲染直接抛 TypeError，
        // 页面停在「正在加载环境...」—— 那时红的是本判据（元素找不到），不是产品缺陷。
        runtime: {
            status: "up",
            deviceId: "device-1",
            lastHeartbeatAt: "2026-11-16T00:00:00Z",
        },
    };
}

function seedPrincipal(user: { id: string; isInstanceAdmin?: boolean }) {
    localStorage.setItem(
        "xihe-user",
        JSON.stringify({
            id: user.id,
            email: `${user.id}@xihe.local`,
            capabilities: {
                isInstanceAdmin: user.isInstanceAdmin === true,
                isInstanceSuper: false,
                workspaceAdminOf: [],
            },
        }),
    );
    // 逐 tab 缓存**故意不带 hostPath**（真实缓存形态就是这样：id/name/role 三样），
    // 这样设置页必须自己去取一次真实工作区，而不是"碰巧"从缓存里读到。
    sessionStorage.setItem(
        "xihe-workspace",
        JSON.stringify({ id: WORKSPACE_ID, name: "Workspace", ownerId: OWNER_ID }),
    );
}

async function mountSettings(): Promise<VueWrapper> {
    const { default: WorkspaceSettingsView } = await import("../pages/WorkspaceSettingsView.vue");
    const wrapper = mount(WorkspaceSettingsView, { global: { plugins: [i18n] } });
    await flushPromises();
    return wrapper;
}

async function mountEnvironment(): Promise<VueWrapper> {
    const { default: WorkspaceEnvironmentView } =
        await import("../pages/WorkspaceEnvironmentView.vue");
    const wrapper = mount(WorkspaceEnvironmentView, { global: { plugins: [i18n] } });
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
    localStorage.setItem("xihe-token", "mock-token");
    seedPrincipal({ id: OWNER_ID });
    mockedApi.getWorkspace.mockImplementation((() =>
        Promise.resolve(workspace(HOST_PATH))) as never);
    mockedApi.getSelfPermissions.mockResolvedValue({} as never);
    mockedApi.getWorkspaceEnvironment.mockResolvedValue(environment(HOST_PATH) as never);
    mockedApi.getWorkspaceJobs.mockResolvedValue([] as never);
});

describe("workspace host path consistency (task-51)", () => {
    it("设置页「宿主机目录」与环境页「宿主机目录」是同一个值，且都不是 storageRef", async () => {
        const settings = await mountSettings();
        const environmentView = await mountEnvironment();

        const settingsRow = settings.find('[data-testid="ws-settings-host-path"]');
        // 环境页的 testid 挂在**整行**（dt 标签 + dd 值），值本身在行内的 `dd` 上 ——
        // 与 `WorkspaceEnvironmentView.spec.ts` 的读法一致（那里用 `.text()).toContain`）。
        const environmentRow = environmentView.find('[data-testid="workspace-host-path"]');
        expect(settingsRow.exists(), "设置页必须真的渲染出宿主目录这一行").toBe(true);
        expect(environmentRow.exists()).toBe(true);

        const settingsText = settingsRow.text();
        const environmentText = environmentRow.find("dd").text();
        expect(settingsText).toBe(HOST_PATH);
        expect(environmentText).toBe(HOST_PATH);
        // 承重：两页读同一个服务端字段 ⇒ 值必须**逐字节相同**（不是"各自含有一半"）。
        expect(settingsText).toBe(environmentText);
        // 反向守卫：`storageRef` 是随机 UUID，出现在这一行就说明又绑错了字段。
        expect(settingsText).not.toContain(STORAGE_REF);
        expect(environmentText).not.toContain(STORAGE_REF);
        expect(settings.text()).not.toContain(STORAGE_REF);

        settings.unmount();
        environmentView.unmount();
    });

    it("服务端给 null 安全投影时两页都不渲染路径，且不拿缓存/本地值补", async () => {
        mockedApi.getWorkspace.mockImplementation((() =>
            Promise.resolve(workspace(null))) as never);
        mockedApi.getWorkspaceEnvironment.mockResolvedValue(environment(null) as never);

        const settings = await mountSettings();
        const environmentView = await mountEnvironment();

        expect(settings.find('[data-testid="ws-settings-host-path"]').exists()).toBe(false);
        expect(environmentView.find('[data-testid="workspace-host-path"]').exists()).toBe(false);
        expect(settings.text()).not.toContain(HOST_PATH);
        expect(environmentView.text()).not.toContain(HOST_PATH);
        // 同样不得退化成显示 `storageRef` 或 `—` 假装有值。
        expect(settings.text()).not.toContain(STORAGE_REF);

        settings.unmount();
        environmentView.unmount();
    });

    it("普通成员两页都看不到原始宿主路径（同一套披露规则）", async () => {
        seedPrincipal({ id: "member-1" });
        const settings = await mountSettings();
        const environmentView = await mountEnvironment();

        expect(settings.find('[data-testid="ws-settings-host-path"]').exists()).toBe(false);
        expect(environmentView.find('[data-testid="workspace-host-path"]').exists()).toBe(false);
        expect(settings.text()).not.toContain(HOST_PATH);
        expect(environmentView.text()).not.toContain(HOST_PATH);

        settings.unmount();
        environmentView.unmount();
    });

    it("实例管理员即使不是 owner 也能看到（两页一致）", async () => {
        seedPrincipal({ id: "admin-1", isInstanceAdmin: true });
        const settings = await mountSettings();
        const environmentView = await mountEnvironment();

        expect(settings.get('[data-testid="ws-settings-host-path"]').text()).toBe(HOST_PATH);
        expect(environmentView.get('[data-testid="workspace-host-path"]').find("dd").text()).toBe(
            HOST_PATH,
        );

        settings.unmount();
        environmentView.unmount();
    });
});
