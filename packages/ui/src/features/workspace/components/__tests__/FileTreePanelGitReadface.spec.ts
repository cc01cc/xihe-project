import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import FileTreePanel from "../FileTreePanel.vue";
import { i18n } from "../../../../i18n";
import type * as apiModule from "../../../../composables/api";
import { api } from "../../../../composables/api";

/** task-36：文件树面板「读现状」探针的单测形状（真组件 + mock API；不替代 mock E2E）。 */

const { wsStub, authStub, apiStub, toastStub } = vi.hoisted(() => ({
    wsStub: {
        workspaceId: "workspace-a",
        fileTree: [{ name: "README.md", path: "README.md", type: "file", size: 12 }],
        isMultiRoot: false,
        workspaceRoots: [] as { id: string; alias: string | null; position: number }[],
        rootTrees: new Map<string, { loaded: boolean; nodes: unknown[] }>(),
        rootTreeState: () => ({ loading: false, loaded: true, nodes: [], error: null }),
        isRootExpanded: () => false,
        primaryRootId: null as string | null,
        primaryRootPath: null as string | null,
        activeFilePath: null as string | null,
        activeDirPath: null as string | null,
        treeError: null as string | null,
        treeErrorKind: "other" as string,
        errorScope: null as string | null,
        fileOpError: null as unknown,
        loading: false,
        loadTree: vi.fn<() => Promise<void>>(async () => {}),
        refreshTree: vi.fn<() => Promise<void>>(async () => {}),
        createFile: vi.fn<(path: string, name: string) => Promise<null>>(async () => null),
        openImportDialog: vi.fn<() => void>(),
        loadRootTree: vi.fn<() => Promise<void>>(async () => {}),
        toggleRoot: vi.fn<(rootId: string) => void>(),
        clearFileOpError: vi.fn<() => void>(),
    },
    authStub: {
        canWriteWorkspace: true,
        currentWorkspaceId: "workspace-a",
        workspace: { name: "ws-a" },
        refreshWorkspace: vi.fn<() => Promise<void>>(async () => {}),
    },
    apiStub: {
        listWorkspaceNestedRepos: vi.fn<() => Promise<unknown[]>>(async () => []),
        addWorkspaceRoot: vi.fn<() => Promise<unknown>>(async () => ({})),
        getWorkspaceGitStatus: vi.fn<typeof apiModule.api.getWorkspaceGitStatus>(),
    },
    toastStub: {
        success: vi.fn<(message?: string) => void>(),
        error: vi.fn<(message?: string) => void>(),
    },
}));

vi.mock("../stores/workspace", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useWorkspaceStore: () => wsStub,
}));
vi.mock("../../../../stores/auth", () => ({ useAuthStore: () => authStub }));
vi.mock("vue-sonner", () => ({ toast: toastStub }));
vi.mock("../../../../composables/api", (importOriginal) => ({
    ...(importOriginal as Record<string, unknown>),
    api: apiStub,
    ApiError: class extends Error {},
}));

const mockedApi = vi.mocked(api, true);

beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    sessionStorage.clear();
    mockedApi.getWorkspaceGitStatus.mockResolvedValue({
        isRepository: true,
        entries: [
            { status: " M", path: "README.md" },
            { status: "??", path: "new.txt" },
        ],
    });
});

describe("task-36 文件树面板 git 读面", () => {
    it("脏文件数与摘要直接出现在树面板，HEAD 不伪造数字", async () => {
        const wrapper = mount(FileTreePanel, {
            global: { plugins: [i18n], stubs: { FileTree: true } },
        });
        await flushPromises();

        expect(mockedApi.getWorkspaceGitStatus).toHaveBeenCalledWith("workspace-a");
        expect(wrapper.find('[data-testid="workspace-git-readface"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="workspace-git-readface-count"]').text()).toContain("2");
        const entries = wrapper.find('[data-testid="workspace-git-readface-entries"]').text();
        expect(entries).toContain("README.md");
        expect(entries).toContain("new.txt");
        const head = wrapper.find('[data-testid="workspace-git-readface-head-hint"]').text();
        expect(head).toContain("HEAD");
        expect(head).toContain("checkpoint timeline");
        expect(head).not.toMatch(/[0-9a-f]{7,40}/);
    });

    it("加载失败只显示本地化文案，不直显英文 detail", async () => {
        mockedApi.getWorkspaceGitStatus.mockRejectedValue(new Error("API error 503"));
        const wrapper = mount(FileTreePanel, {
            global: { plugins: [i18n], stubs: { FileTree: true } },
        });
        await flushPromises();

        const copy = wrapper.get('[data-testid="workspace-git-readface-error-copy"]');
        expect(copy.attributes("role")).toBe("alert");
        expect(copy.text()).not.toContain("API error");
        expect(copy.text()).toBe(i18n.global.t("workspace.gitReadfaceLoadFailed"));
        // 无码（前端/网络层错误没有稳定码）⇒ 不渲染码标签，也不渲染空折叠区。
        expect(wrapper.find('[data-testid="workspace-git-readface-error-code"]').exists()).toBe(
            false,
        );
        expect(
            wrapper.find('[data-testid="workspace-git-readface-error-detail-toggle"]').exists(),
        ).toBe(false);
    });

    /**
     * task-78：本块是**诊断面**（持久在屏的树面板错误条）⇒ 必须给出**可复制**的码；
     *
     * <p>改前只渲染 `copy`，而 `presentCauseError` 对未登记码的 copy 就是
     * `errors.unknownCode`（"…请联系管理员并**提供错误码**"）—— 文案要求用户出示一个界面
     * 没提供的码，判据（"文案要求用户做一件事，界面就必须提供那件事的对应物"）因此不成立。
     * 裁 ②（总账 §十四 `fc327a318`）：码在折叠区内 ⇒ 折叠态**不渲染该节点**（不是 display:none），展开后才可看可复制。机器判据同 task-61：折叠态缺席 + 展开后出现并含码。
     * 这里钉四件事：折叠态码**不渲染**、展开后码在、码**选得中**（`select-all`）、原文同样默认折叠。</p>
     */
    it("在屏上给出可选中的错误码，原文收进默认折叠的诊断区", async () => {
        // 本 spec 的 module mock 把 `ApiError` 换成了裸 `class extends Error {}`（上面的
        // `vi.mock`），所以这里给 cause 一个 **problem 形状**直接把码喂进去：`presentCauseError`
        // 按结构化读 `cause.problem?.code`（lib 层刻意不用 `instanceof`，见 errorMessages.ts:236-245），
        // 真实链路上由 `apiErrorFromResponse` 填同一形状。用裸 Error 就永远测不到码那条分支。
        mockedApi.getWorkspaceGitStatus.mockRejectedValue({
            problem: {
                status: 500,
                code: "GIT_READFACE_UNAVAILABLE",
                detail: "API error 500",
                requestId: "request-1",
            },
        });
        const wrapper = mount(FileTreePanel, {
            global: { plugins: [i18n], stubs: { FileTree: true } },
        });
        await flushPromises();

        const copy = wrapper.get('[data-testid="workspace-git-readface-error-copy"]');
        expect(copy.text()).toBe(i18n.global.t("errors.unknownCode"));
        expect(copy.text()).not.toContain("GIT_READFACE_UNAVAILABLE");
        expect(copy.text()).not.toContain("API error");

        // 裁 ②（总账 §十四 `fc327a318`）：码在折叠区内 ⇒ 折叠态**不渲染该节点**（不是 display:none），展开后才可看可复制。机器判据同 task-61：折叠态缺席 + 展开后出现并含码。
        expect(wrapper.find('[data-testid="workspace-git-readface-error-code"]').exists()).toBe(
            false,
        );
        expect(
            wrapper.find('[data-testid="workspace-git-readface-error-code-value"]').exists(),
        ).toBe(false);
        expect(
            wrapper.find('[data-testid="workspace-git-readface-error-detail-body"]').exists(),
        ).toBe(false);
        await wrapper
            .get('[data-testid="workspace-git-readface-error-detail-toggle"]')
            .trigger("click");
        await flushPromises();
        const code = wrapper.get('[data-testid="workspace-git-readface-error-code"]');
        expect(code.text()).toContain(i18n.global.t("errors.errorCodeLabel"));
        const codeValue = wrapper.get('[data-testid="workspace-git-readface-error-code-value"]');
        expect(codeValue.element.tagName).toBe("CODE");
        expect(codeValue.classes()).toContain("select-all");
        expect(codeValue.text()).toBe("GIT_READFACE_UNAVAILABLE");
        expect(wrapper.get('[data-testid="workspace-git-readface-error-detail-body"]').text()).toBe(
            "API error 500",
        );
    });

    it("重试按钮复用 composable 的 reload，不自己再造一个取数通道", async () => {
        mockedApi.getWorkspaceGitStatus.mockRejectedValueOnce({
            problem: {
                status: 503,
                code: "GIT_READFACE_UNAVAILABLE",
                detail: "API error 503",
                requestId: "request-1",
            },
        });
        const wrapper = mount(FileTreePanel, {
            global: { plugins: [i18n], stubs: { FileTree: true } },
        });
        await flushPromises();

        mockedApi.getWorkspaceGitStatus.mockResolvedValue({
            isRepository: true,
            entries: [{ status: " M", path: "README.md" }],
        });
        await wrapper.get('[data-testid="workspace-git-readface-error-retry"]').trigger("click");
        await flushPromises();

        expect(wrapper.find('[data-testid="workspace-git-readface-error"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="workspace-git-readface-count"]').text()).toContain("1");
    });

    /**
     * task-89（触控目标，WCAG 2.2 SC 2.5.8 ≥24×24）：树头四个按钮改前 `p-1` + `size-3.5`
     * ⇒ **19.25×19.25**（3.5px 栅格：3.5 + 12.25 + 3.5；4px 栅格同一组类是 4 + 14 + 4 = 22，
     * 两值都 <24）；四者互相**矩形距 0**、圆心距 **22.75 < 24**（4px 栅格是 22），且都欠尺寸
     * ⇒ Spacing 例外不成立 ⇒ 真缺陷。补 `min-h-7 min-w-7` = 7 × **4px** = **28px** 达标
     * （本仓 `--spacing` = 4；3.5px 时代是 24.5px，旧注释「别按 4 算成 28」已随 D-1842 反转）；
     * 图标仍 `size-3.5`（今天 14px）不放大。
     * jsdom 不求值 Tailwind ⇒ 这里钉类名，真 rect 归 Playwright 复测。
     */
    it("task-89：树头四键命中盒 ≥24×24（min-h-7 min-w-7），图标档位不变", () => {
        const wrapper = mount(FileTreePanel, {
            global: { plugins: [i18n], stubs: { FileTree: true } },
        });

        for (const testid of [
            "workspace-file-create",
            "workspace-file-upload",
            "workspace-file-refresh",
            "workspace-toolbar-toggle-tree",
        ]) {
            const button = wrapper.get(`[data-testid="${testid}"]`);
            expect(button.classes(), testid).toEqual(
                expect.arrayContaining(["min-h-7", "min-w-7", "items-center", "justify-center"]),
            );
            expect(button.get("svg").classes(), testid).toContain("size-3.5");
        }
    });
});
