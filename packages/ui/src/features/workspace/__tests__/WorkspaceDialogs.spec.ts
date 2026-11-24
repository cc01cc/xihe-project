import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import type { toast } from "vue-sonner";
import { api, ApiError } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";
import type { WorkspaceDirectAttachExecutionMode } from "../../../types";
import WorkspaceCreateDialog from "../components/WorkspaceCreateDialog.vue";
import { i18n } from "../../../i18n";
import { expectModalDialog } from "../../../test-utils/modalDialog";

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            createWorkspace: vi.fn<typeof apiModule.api.createWorkspace>(),
            updateWorkspace: vi.fn<typeof apiModule.api.updateWorkspace>(),
            deleteWorkspace: vi.fn<typeof apiModule.api.deleteWorkspace>(),
            listImportSources: vi.fn<typeof apiModule.api.listImportSources>(),
            listImportSourceRoots: vi.fn<typeof apiModule.api.listImportSourceRoots>(),
            preflightDirectAttach: vi.fn<typeof apiModule.api.preflightDirectAttach>(),
        },
    };
});

vi.mock("vue-sonner", () => ({
    toast: {
        success: vi.fn<typeof toast.success>(),
        error: vi.fn<typeof toast.error>(),
    },
}));

const { workspaceMock } = vi.hoisted(() => ({
    workspaceMock: { value: null as null | { id: string; name: string } },
}));

vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({
        get workspace() {
            return workspaceMock.value;
        },
        set workspace(v: null | { id: string; name: string }) {
            workspaceMock.value = v;
        },
        currentWorkspaceId: workspaceMock.value?.id ?? null,
        canWriteWorkspace: true,
    }),
}));

const mockedApi = vi.mocked(api, true);

interface Entry {
    name: string;
    kind: string;
    readable: boolean;
    size: number;
    gitRepo?: boolean;
}

function problemError(status: number, code: string): ApiError {
    return new ApiError({ status, code, detail: code, requestId: "test" });
}

function preflightResult(
    executionMode: WorkspaceDirectAttachExecutionMode,
    available: boolean,
    reason?: string,
) {
    return {
        contractVersion: "v1",
        backendKind: executionMode,
        backendRevision: "builtin",
        maturity: executionMode === "windows-mxc" ? "experimental" : "stable",
        executionMode,
        available,
        reason: reason ?? null,
        checkedAt: "2026-09-21T00:00:00Z",
    } as const;
}

/**
 * R48/task-980：系统根由 CP `listImportSourceRoots` 提供；本 helper 同时模拟每根下的目录读取。
 * 默认 POSIX：根列表只有 `/`。
 */
function mockSystemRoots(
    listings: Record<string, Entry[]>,
    roots: { drives?: string[]; posix?: boolean } = { posix: true },
) {
    const drives = new Set(roots.drives ?? []);
    const discovered =
        roots.drives && roots.drives.length > 0
            ? roots.drives.map((path) => ({
                  path,
                  label: path.replace(/[\\/]$/, "") || "/",
                  kind: path.match(/^[A-Za-z]:/) ? "drive" : "root",
              }))
            : roots.posix === false
              ? []
              : [{ path: "/", label: "/", kind: "root" }];
    mockedApi.listImportSourceRoots.mockResolvedValue(discovered);
    mockedApi.listImportSources.mockImplementation((path: string) => {
        if (drives.has(path) || (roots.posix !== false && path === "/") || path in listings) {
            return Promise.resolve({ path, entries: listings[path] ?? [] });
        }
        return Promise.reject(problemError(400, "IMPORT_SOURCE_REQUIRED"));
    });
}

async function bodyEl<T extends Element>(selector: string): Promise<T> {
    await vi.waitFor(() => {
        expect(document.body.querySelector(selector)).toBeTruthy();
    });
    return document.body.querySelector(selector) as T;
}

async function clickBody(selector: string) {
    const el = await bodyEl<HTMLElement>(selector);
    el.click();
    await nextTick();
}

async function setBodyValue(selector: string, value: string) {
    const input = await bodyEl<HTMLInputElement>(selector);
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
}

function submitDisabled(): boolean {
    const btn = document.body.querySelector(
        '[data-testid="workspace-create-submit"]',
    ) as HTMLButtonElement | null;
    return !btn || btn.disabled;
}

async function mountCreateDialog(wrappers: VueWrapper[]) {
    const wrapper = mount(WorkspaceCreateDialog, {
        props: { open: true },
        attachTo: document.body,
        global: { plugins: [i18n] },
    });
    wrappers.push(wrapper);
    await bodyEl('[data-testid="workspace-create-dialog"]');
    return wrapper;
}

/** 手输路径并提交（`change` 是 R48 保留的手动入口；不再需要「读取」按钮）。 */
async function setRootPath(path: string, index = 0) {
    const inputs = document.body.querySelectorAll<HTMLInputElement>(
        '[data-testid="workspace-root-path"]',
    );
    const input = inputs[index]!;
    input.value = path;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    await nextTick();
}

function browserEntry(name: string): HTMLElement | null {
    return document.body.querySelector(`[data-entry-name="${name}"]`);
}

describe("WorkspaceCreateDialog (task-957)", () => {
    let wrappers: VueWrapper[] = [];
    beforeEach(() => {
        vi.clearAllMocks();
        mockedApi.createWorkspace.mockResolvedValue({ id: "ws-default", name: "Default" });
        mockedApi.preflightDirectAttach.mockImplementation(({ executionMode }) =>
            Promise.resolve(preflightResult(executionMode, true)),
        );
        mockSystemRoots({ "/": [] });
    });
    afterEach(() => {
        wrappers.forEach((w) => w.unmount());
        wrappers = [];
        workspaceMock.value = null;
        localStorage.clear();
        document.body.innerHTML = "";
    });

    it("同页向导：所有字段在同一页，只有 1 个 workspace-step- 页面（反证：改回四步即红）", async () => {
        await mountCreateDialog(wrappers);

        const stepPages = document.body.querySelectorAll('[data-testid^="workspace-step-"]');
        expect(stepPages).toHaveLength(1);
        expect(stepPages[0]!.getAttribute("data-testid")).toBe("workspace-step-config");

        // 单页内前面字段仍在：存储方式、目录、执行后端、名称/描述、摘要、提交。
        expect(
            document.body.querySelector('[data-testid="workspace-config-storage"]'),
        ).toBeTruthy();
        expect(document.body.querySelector('[data-testid="workspace-roots"]')).toBeTruthy();
        expect(
            document.body.querySelector('[data-testid="workspace-execution-section"]'),
        ).toBeTruthy();
        expect(
            document.body.querySelector('[data-testid="workspace-config-identity"]'),
        ).toBeTruthy();
        expect(
            document.body.querySelector('[data-testid="workspace-create-summary"]'),
        ).toBeTruthy();
    });

    it("does not offer the frozen managed_import backend and presets direct_attach in one line", async () => {
        await mountCreateDialog(wrappers);

        // PLAN-0612 M4.3: the Docker execution backend is frozen, so the managed card is hidden
        // (not just disabled) and a frozen explanation replaces it.
        expect(document.body.querySelector('[data-testid="workspace-storage-managed"]')).toBeNull();
        expect(
            document.body.querySelector('[data-testid="workspace-storage-managed-frozen"]'),
        ).toBeTruthy();
        expect(document.body.textContent).toContain(
            i18n.global.t("workspace.managedImportFrozenHint"),
        );
        // R42 #5: the single legal mode is preset and explained in one footer line.
        expect(
            document.body.querySelector('[data-testid="workspace-storage-single-option"]')
                ?.textContent,
        ).toContain(i18n.global.t("workspace.directAttachDesc"));
    });

    it("R48：进入向导无需点击，系统根与目录项已自动加载，且没有「读取」按钮", async () => {
        mockSystemRoots({
            "/": [{ name: "work", kind: "directory", readable: true, size: 0 }],
        });
        await mountCreateDialog(wrappers);

        await vi.waitFor(() => {
            expect(
                document.body.querySelector('[data-testid="workspace-system-root"]'),
            ).toBeTruthy();
            expect(browserEntry("work")).toBeTruthy();
        });
        // R48 explicitly removes the "read first" gate.
        expect(document.body.querySelector('[data-testid="workspace-source-read"]')).toBeNull();
        expect(document.body.querySelector('[data-testid="workspace-root-path"]')).toBeTruthy();
    });

    it("R48/R44：Windows 只列真实存在的盘符；目录项带 Runtime 提供的 git 徽标", async () => {
        mockSystemRoots(
            {
                "C:\\": [
                    { name: "repo", kind: "directory", readable: true, size: 0, gitRepo: true },
                    { name: "plain", kind: "directory", readable: true, size: 0 },
                ],
            },
            { drives: ["C:\\"] },
        );
        await mountCreateDialog(wrappers);

        await vi.waitFor(() => {
            const chips = document.body.querySelectorAll('[data-testid="workspace-system-root"]');
            expect(chips).toHaveLength(1);
            expect(chips[0]!.textContent?.trim()).toBe("C:");
            expect(browserEntry("repo")).toBeTruthy();
        });
        const repoRow = browserEntry("repo")!;
        expect(repoRow.getAttribute("data-git")).toBe("true");
        expect(repoRow.querySelector('[data-testid="workspace-entry-git"]')).toBeTruthy();
        expect(browserEntry("plain")!.getAttribute("data-git")).toBe("false");
        expect(
            browserEntry("plain")!.querySelector('[data-testid="workspace-entry-git"]'),
        ).toBeNull();
    });

    it("R46/task-980：系统根来自 CP 根枚举端点，不再并行探测 26 个盘符", async () => {
        mockSystemRoots(
            {
                "C:\\": [{ name: "repo", kind: "directory", readable: true, size: 0 }],
            },
            { drives: ["C:\\"] },
        );
        await mountCreateDialog(wrappers);

        await vi.waitFor(() => {
            const chip = document.body.querySelector('[data-testid="workspace-system-root"]');
            expect(chip?.textContent?.trim()).toBe("C:");
            expect(browserEntry("repo")).toBeTruthy();
        });
        // 反证：把 discoverSystemRoots 改回 26 盘符探测时, 下面的调用次数断言会红。
        expect(mockedApi.listImportSourceRoots).toHaveBeenCalledTimes(1);
        expect(mockedApi.listImportSources).toHaveBeenCalledTimes(1);
        expect(mockedApi.listImportSources).toHaveBeenCalledWith("C:\\");
    });

    it("R46/task-980：根枚举失败时回落到手输路径并给出可读提示", async () => {
        mockedApi.listImportSourceRoots.mockRejectedValue(
            problemError(502, "RUNTIME_SOURCE_UNAVAILABLE"),
        );
        await mountCreateDialog(wrappers);

        const error = await bodyEl<HTMLElement>('[data-testid="workspace-system-roots-error"]');
        expect(error.textContent).toContain(i18n.global.t("workspace.sourceReadFailed"));
        expect(
            document.body.querySelectorAll('[data-testid="workspace-system-root"]'),
        ).toHaveLength(0);
        expect(document.body.querySelector('[data-testid="workspace-root-path"]')).toBeTruthy();
    });

    it("R43 字段联动：选目录前执行后端不可用，选目录后按 preflight 结果解禁", async () => {
        mockSystemRoots({
            "/": [{ name: "work", kind: "directory", readable: true, size: 0 }],
            "/work": [],
        });
        await mountCreateDialog(wrappers);

        const mxcBefore = document.body.querySelector(
            '[data-testid="workspace-execution-mode-mxc"]',
        ) as HTMLButtonElement;
        expect(mxcBefore.disabled).toBe(true);

        await setRootPath("/work");
        await vi.waitFor(() => {
            const mxc = document.body.querySelector(
                '[data-testid="workspace-execution-mode-mxc"]',
            ) as HTMLButtonElement;
            expect(mxc.disabled).toBe(false);
        });
        expect(mockedApi.preflightDirectAttach).toHaveBeenCalledWith({
            hostPath: "/work",
            executionMode: "windows-mxc",
        });
        expect(mockedApi.preflightDirectAttach).toHaveBeenCalledWith({
            hostPath: "/work",
            executionMode: "windows-host",
        });
    });

    it("R13/R24：名称即时校验（全空格 ⇒ 红字 + 禁提交），不需要 blur", async () => {
        await mountCreateDialog(wrappers);
        await setBodyValue('[data-testid="workspace-create-name"]', "   ");
        expect(
            document.body.querySelector('[data-testid="workspace-name-error"]')?.textContent,
        ).toContain(i18n.global.t("validation.principalNameRequired"));
        expect(submitDisabled()).toBe(true);

        await setBodyValue('[data-testid="workspace-create-name"]', "Demo");
        expect(document.body.querySelector('[data-testid="workspace-name-error"]')).toBeNull();
    });

    it("R48 纯鼠标逐级下钻 + 手输路径都可用，并提交 roots[]", async () => {
        mockSystemRoots({
            "/": [{ name: "work", kind: "directory", readable: true, size: 0 }],
            "/work": [{ name: "projects", kind: "directory", readable: true, size: 0 }],
            "/work/projects": [{ name: "demo", kind: "directory", readable: true, size: 0 }],
            "/work/projects/demo": [],
        });
        mockedApi.createWorkspace
            .mockRejectedValueOnce(problemError(409, "WORKSPACE_ALREADY_EXISTS"))
            .mockResolvedValueOnce({ id: "ws-direct", name: "Direct" });

        await mountCreateDialog(wrappers);
        await vi.waitFor(() => expect(browserEntry("work")).toBeTruthy());
        browserEntry("work")!.click();
        await vi.waitFor(() => expect(browserEntry("projects")).toBeTruthy());
        browserEntry("projects")!.click();
        await vi.waitFor(() => expect(browserEntry("demo")).toBeTruthy());
        browserEntry("demo")!.click();
        await vi.waitFor(() => expect(browserEntry("work")).toBeNull());
        await clickBody('[data-testid="workspace-source-use"]');

        await vi.waitFor(() => {
            const mxc = document.body.querySelector(
                '[data-testid="workspace-execution-mode-mxc"]',
            ) as HTMLButtonElement | null;
            expect(mxc && !mxc.disabled).toBe(true);
        });
        await setBodyValue('[data-testid="workspace-create-name"]', "Direct");
        expect(submitDisabled()).toBe(false);
        await clickBody('[data-testid="workspace-create-submit"]');
        await vi.waitFor(() => expect(mockedApi.createWorkspace).toHaveBeenCalledTimes(1));

        const first = mockedApi.createWorkspace.mock.calls[0]?.[0];
        expect(first).toEqual({
            name: "Direct",
            description: null,
            storageMode: "direct_attach",
            executionMode: "windows-mxc",
            roots: [{ path: "/work/projects/demo" }],
            idempotencyKey: expect.any(String),
        });

        // Retry reuses the same Idempotency-Key.
        await clickBody('[data-testid="workspace-create-submit"]');
        await vi.waitFor(() => expect(mockedApi.createWorkspace).toHaveBeenCalledTimes(2));
        expect(mockedApi.createWorkspace.mock.calls[1]?.[0].idempotencyKey).toBe(
            first?.idempotencyKey,
        );
    });

    it("R45/R49：可添加多个根，提交契约携带全部根且 preflight 覆盖每个根", async () => {
        mockSystemRoots({
            "/": [],
            "/a": [],
            "/b": [],
        });
        await mountCreateDialog(wrappers);

        await setRootPath("/a", 0);
        await clickBody('[data-testid="workspace-root-add"]');
        await setRootPath("/b", 1);
        await vi.waitFor(() => {
            expect(mockedApi.preflightDirectAttach).toHaveBeenCalledWith({
                hostPath: "/a",
                executionMode: "windows-mxc",
            });
            expect(mockedApi.preflightDirectAttach).toHaveBeenCalledWith({
                hostPath: "/b",
                executionMode: "windows-mxc",
            });
        });

        await setBodyValue('[data-testid="workspace-create-name"]', "Multi");
        expect(submitDisabled()).toBe(false);
        await clickBody('[data-testid="workspace-create-submit"]');
        await vi.waitFor(() => expect(mockedApi.createWorkspace).toHaveBeenCalledTimes(1));
        expect(mockedApi.createWorkspace.mock.calls[0]?.[0].roots).toEqual([
            { path: "/a" },
            { path: "/b" },
        ]);
    });

    /**
     * task-1019：系统根按钮必须是「点一下就出内容」，不是装饰。
     * 判据直接读目录项：切到 D: 后 D: 的内容出现、C: 的内容消失。
     */
    it("task-1019：盘符按钮可点选，点一下即列出该根目录内容", async () => {
        mockSystemRoots(
            {
                "C:\\": [{ name: "c-work", kind: "directory", readable: true, size: 0 }],
                "D:\\": [{ name: "d-work", kind: "directory", readable: true, size: 0 }],
            },
            { drives: ["C:\\", "D:\\"], posix: false },
        );
        await mountCreateDialog(wrappers);
        await vi.waitFor(() => expect(browserEntry("c-work")).toBeTruthy());

        const chips = Array.from(
            document.body.querySelectorAll<HTMLElement>('[data-testid="workspace-system-root"]'),
        );
        const dChip = chips.find((chip) => chip.textContent?.trim() === "D:");
        expect(dChip).toBeTruthy();
        dChip!.click();

        await vi.waitFor(() => expect(browserEntry("d-work")).toBeTruthy());
        expect(browserEntry("c-work")).toBeNull();
    });

    /**
     * task-1019：第二根与第一根各自独立；提交只发 `[{path}]` 列表，
     * 不引入「主根/次根」这种并未存在于契约里的概念。
     */
    it("task-1019：第二根独立编辑，提交是纯 path 列表（无主/次根字段）", async () => {
        mockSystemRoots({ "/": [], "/a": [], "/b": [] });
        await mountCreateDialog(wrappers);

        await setRootPath("/a", 0);
        await clickBody('[data-testid="workspace-root-add"]');
        await setRootPath("/b", 1);

        const inputs = Array.from(
            document.body.querySelectorAll<HTMLInputElement>('[data-testid="workspace-root-path"]'),
        );
        expect(inputs[0]?.value).toBe("/a");
        expect(inputs[1]?.value).toBe("/b");

        await setBodyValue('[data-testid="workspace-create-name"]', "Two roots");
        await vi.waitFor(() => expect(submitDisabled()).toBe(false));
        await clickBody('[data-testid="workspace-create-submit"]');
        await vi.waitFor(() => expect(mockedApi.createWorkspace).toHaveBeenCalled());

        const payload = mockedApi.createWorkspace.mock.calls[0]![0];
        expect(payload.roots).toEqual([{ path: "/a" }, { path: "/b" }]);
        expect(Object.keys(payload)).not.toContain("primaryRoot");
        expect(Object.keys(payload)).not.toContain("secondaryRoots");
    });

    /**
     * task-1019（冻结构建实测的 P0）：目录和名称都填了、后端也可用，按钮却恒灰且无解释。
     * 根因之一是「多点了一次添加目录」留下一个空行：它必填但未触碰 ⇒ 字段红字不显示，
     * 而 `submitDisabled` 已经为 true。这里钉住「禁用必须给原因」。
     */
    it("task-1019：空目录行会让创建禁用，并明确说是第几个目录缺路径", async () => {
        mockSystemRoots({ "/": [], "/demo": [] });
        await mountCreateDialog(wrappers);

        await setRootPath("/demo");
        await setBodyValue('[data-testid="workspace-create-name"]', "Blocked");
        await vi.waitFor(() => expect(submitDisabled()).toBe(false));

        await clickBody('[data-testid="workspace-root-add"]');
        await nextTick();
        expect(submitDisabled()).toBe(true);
        const reason =
            document.body.querySelector('[data-testid="workspace-submit-blocked"]')?.textContent ??
            "";
        expect(reason).toContain("第 2 个目录还没有填路径");

        // 补上第二根 ⇒ 阻塞消失、提示消失，并且可以创建。
        await setRootPath("/second", 1);
        await vi.waitFor(() => expect(submitDisabled()).toBe(false));
        expect(document.body.querySelector('[data-testid="workspace-submit-blocked"]')).toBeNull();
    });

    /**
     * task-1019：当前选中的后端不可用、另一个可用时，禁用原因要点名「当前」后端，
     * 而不是让用户对着一张灰按钮猜。
     */
    it("task-1019：选中的后端不可用时，禁用原因点名当前后端", async () => {
        mockSystemRoots({ "/": [], "/demo": [] });
        mockedApi.preflightDirectAttach.mockImplementation(({ executionMode }) =>
            Promise.resolve(
                executionMode === "windows-mxc"
                    ? preflightResult("windows-mxc", false, "MXC_EXECUTABLE_MISSING")
                    : preflightResult("windows-host", true),
            ),
        );

        await mountCreateDialog(wrappers);
        await setRootPath("/demo");
        await setBodyValue('[data-testid="workspace-create-name"]', "No backend");
        await bodyEl('[data-testid="workspace-mxc-guidance"]');

        expect(submitDisabled()).toBe(true);
        const reason =
            document.body.querySelector('[data-testid="workspace-submit-blocked"]')?.textContent ??
            "";
        expect(reason).toContain(i18n.global.t("workspace.executionModeMxc"));
        expect(reason).toContain(i18n.global.t("workspace.submitBlockedBackend").slice(0, 4));
    });

    it("disables the MXC card when preflight reports unavailable and never auto-falls back to host", async () => {
        mockSystemRoots({ "/": [], "/demo": [] });
        mockedApi.preflightDirectAttach.mockImplementation(({ executionMode }) =>
            Promise.resolve(
                executionMode === "windows-mxc"
                    ? preflightResult("windows-mxc", false, "MXC_EXECUTABLE_MISSING")
                    : preflightResult("windows-host", true),
            ),
        );

        await mountCreateDialog(wrappers);
        await setRootPath("/demo");
        await bodyEl('[data-testid="workspace-mxc-guidance"]');

        const mxc = document.body.querySelector(
            '[data-testid="workspace-execution-mode-mxc"]',
        ) as HTMLButtonElement;
        expect(mxc.disabled).toBe(true);
        const mxcStatus =
            document.body.querySelector('[data-testid="workspace-execution-mxc-status"]')
                ?.textContent ?? "";
        expect(mxcStatus).toContain("MXC_EXECUTABLE_MISSING");

        // No automatic fallback: submit stays blocked until the user explicitly switches.
        await setBodyValue('[data-testid="workspace-create-name"]', "Mxc");
        expect(submitDisabled()).toBe(true);

        await clickBody('[data-testid="workspace-switch-to-host"]');
        await nextTick();
        // Host execution still demands the explicit risk acknowledgement on the same page.
        expect(submitDisabled()).toBe(true);
        await clickBody('[data-testid="workspace-host-risk-ack"]');
        expect(submitDisabled()).toBe(false);
    });

    it("blocks submit until the host execution risk is acknowledged", async () => {
        mockSystemRoots({ "/": [], "/demo": [] });
        mockedApi.createWorkspace.mockResolvedValue({ id: "ws-host", name: "Host" });

        await mountCreateDialog(wrappers);
        await setRootPath("/demo");
        await vi.waitFor(() => {
            const host = document.body.querySelector(
                '[data-testid="workspace-execution-mode-host"]',
            ) as HTMLButtonElement | null;
            expect(host && !host.disabled).toBe(true);
        });

        await clickBody('[data-testid="workspace-execution-mode-host"]');
        await setBodyValue('[data-testid="workspace-create-name"]', "Host");
        expect(submitDisabled()).toBe(true);
        await clickBody('[data-testid="workspace-host-risk-ack"]');
        expect(submitDisabled()).toBe(false);

        await clickBody('[data-testid="workspace-create-submit"]');
        await vi.waitFor(() => expect(mockedApi.createWorkspace).toHaveBeenCalled());
        expect(mockedApi.createWorkspace.mock.calls[0]?.[0]).toEqual(
            expect.objectContaining({
                storageMode: "direct_attach",
                executionMode: "windows-host",
                roots: [{ path: "/demo" }],
            }),
        );
    });

    it("surfaces a structured reason when the capability preflight fails", async () => {
        mockSystemRoots({ "/": [], "/demo": [] });
        mockedApi.preflightDirectAttach.mockRejectedValue(problemError(502, "RUNTIME_UNAVAILABLE"));

        await mountCreateDialog(wrappers);
        await setRootPath("/demo");

        const error = await bodyEl('[data-testid="workspace-preflight-error"]');
        expect(error.textContent ?? "").toContain("Runtime 暂不可达");
        await setBodyValue('[data-testid="workspace-create-name"]', "Broken");
        expect(submitDisabled()).toBe(true);
    });

    /**
     * task-49：本弹窗是 vendor `DialogContent`（reka 只设 aria-labelledby/describedby，
     * 不产 `aria-modal`）⇒ 调用点显式补。缺了它读屏器仍能浏览到背景里的工作区列表与
     * 顶部导航（视觉被遮罩挡住，AT 不受遮罩影响）。
     */
    it("是真正的模态对话框：role/aria-modal/名字来自标题（task-49）", async () => {
        await mountCreateDialog(wrappers);

        expectModalDialog("workspace-create-dialog", "dialog", "添加 Workspace");
    });

    /**
     * task-75: the confirm summary rows must not let a long dd squeeze the dt label.
     *
     * Measured on the real page (mock lane 5199, .local/task75 harness, 1920x1080):
     *   the host-path dd (a real Windows path, 96 chars above) -> dt 17.31x38.38 (2 lines)
     *   with both guards -> dt 24x19.19, row height unchanged (only the dd wraps)
     *   the availability dd is "unavailable + reason" (CP/OS text, no length bound):
     *     a 120-char reason -> dt 12x76.75 (4 lines of one character each) at 1920x1080,
     *     and a 40-char reason already does it at 390x844
     *   with both guards -> dt 48x19.19 (1 line), dd wraps instead
     * The other three rows carry enums / a fixed maturity word, short by construction,
     *   so they are deliberately NOT guarded and asserted as such.
     */
    it("guards the roots and availability rows of the summary (task-75)", async () => {
        mockSystemRoots({ "/": [], "/demo": [] });
        await mountCreateDialog(wrappers);
        await setRootPath("/demo");
        await vi.waitFor(() => {
            const mxc = document.body.querySelector(
                '[data-testid="workspace-execution-mode-mxc"]',
            ) as HTMLButtonElement | null;
            expect(mxc && !mxc.disabled).toBe(true);
        });

        const summary = await bodyEl<HTMLElement>('[data-testid="workspace-create-summary"]');
        const rows = Array.from(summary.querySelectorAll("div")) as HTMLElement[];
        // 5 rows: storage mode, roots, execution mode, maturity, availability
        expect(rows).toHaveLength(5);

        // exact match: "目录" must not select the "目录方式" row
        const byLabel = (label: string) =>
            rows.find((row) => (row.querySelector("dt")?.textContent ?? "").trim() === label);

        // Guarded: the roots (user-controlled long input) and the availability reason
        // (CP/OS text with no length bound -- 120 chars already collapsed the dt to 12x76.75/4).
        for (const label of ["目录", "可用状态"]) {
            const row = byLabel(label);
            expect(row).toBeTruthy();
            expect(row!.className).toContain("items-start");
            expect(row!.querySelector("dt")!.className).toContain("shrink-0");
        }

        // Unguarded: the enum / fixed-word rows, whose dd is short by construction.
        for (const label of ["目录方式", "执行模式", "成熟度"]) {
            const row = byLabel(label);
            expect(row).toBeTruthy();
            expect(row!.className).not.toContain("items-start");
            expect(row!.querySelector("dt")!.className ?? "").not.toContain("shrink-0");
        }
    });
});
