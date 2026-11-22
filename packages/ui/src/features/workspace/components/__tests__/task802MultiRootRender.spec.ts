import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import FileTreePanel from "../FileTreePanel.vue";
import { i18n } from "../../../../i18n";
import { useAuthStore } from "../../../../stores/auth";
import { useWorkspaceStore } from "../../stores/workspace";
import type * as apiModule from "../../../../composables/api";
import { api } from "../../../../composables/api";

/**
 * task-802：多根工作区**渲染**判据（真组件 + 真 auth/workspace store；只 mock I/O）。
 *
 * <p>投影侧由 `task802MultiRootProjection.spec.ts` 钉住（roots 必须经 HTTP 刷新到 2）。
 * 本文件补最后一跳：投影确实是 2 时 `FileTreePanel` 必须渲染 **两个**根头；投影是 1 时
 * 保持单根平铺（不渲染组头）。两条一起才排除「投影对了但模板没接」。</p>
 */

const WORKSPACE_ID = "1a6cbc63-0000-4000-8000-000000000802";

const PRIMARY = { id: WORKSPACE_ID, alias: "alpha", position: 0, path: "mock/alpha" },
    SECONDARY = { id: "root-beta-802", alias: "beta", position: 1, path: "mock/beta" };

vi.mock("../../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            listDirectory: vi.fn<typeof apiModule.api.listDirectory>(),
            listWorkspaceNestedRepos: vi.fn<typeof apiModule.api.listWorkspaceNestedRepos>(),
            getWorkspaceGitStatus: vi.fn<typeof apiModule.api.getWorkspaceGitStatus>(),
        },
    };
});

const mockedApi = vi.mocked(api, true);

function patchWorkspace(roots: (typeof PRIMARY)[]) {
    useAuthStore().$patch({
        workspace: {
            id: WORKSPACE_ID,
            name: "多根工作区",
            ownerId: "owner-802",
            workspaceRole: "OWNER",
            canWrite: true,
            hostPath: "H:/mock/alpha",
            roots,
        },
    });
}

async function mountPanel() {
    const wrapper = mount(FileTreePanel, {
        global: { plugins: [i18n], stubs: { FileTree: true } },
    });
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
    mockedApi.listDirectory.mockResolvedValue({
        entries: [{ name: "alpha-root-a.md", type: "file", size: 5 }],
    });
    mockedApi.listWorkspaceNestedRepos.mockResolvedValue([]);
    mockedApi.getWorkspaceGitStatus.mockResolvedValue({ isRepository: false, entries: [] });
});

describe("task-802 多根渲染：投影决定平铺还是分组", () => {
    it("roots.length=2 ⇒ 渲染两个根头（主根 + 次根）", async () => {
        patchWorkspace([PRIMARY, SECONDARY]);
        const ws = useWorkspaceStore();
        expect(ws.workspaceRoots).toHaveLength(2);
        expect(ws.isMultiRoot).toBe(true);

        const wrapper = await mountPanel();
        expect(wrapper.find('[data-testid="workspace-tree-grouped"]').exists()).toBe(true);
        const headers = wrapper.findAll('[data-testid="workspace-tree-root-header"]');
        expect(headers).toHaveLength(2);
        expect(headers[0]!.text()).toContain("mock/alpha");
        expect(headers[1]!.text()).toContain("mock/beta");
        expect(wrapper.findAll('[data-testid="workspace-tree-root-group"]')).toHaveLength(2);
    });

    it("roots.length=1 ⇒ 单根平铺，不渲染任何根头", async () => {
        patchWorkspace([PRIMARY]);
        const ws = useWorkspaceStore();
        expect(ws.isMultiRoot).toBe(false);

        const wrapper = await mountPanel();
        expect(wrapper.find('[data-testid="workspace-tree-grouped"]').exists()).toBe(false);
        expect(wrapper.findAll('[data-testid="workspace-tree-root-header"]')).toHaveLength(0);
        expect(wrapper.find('[data-testid="workspace-empty-state"]').exists()).toBe(false);
    });
});
