import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import WorkspaceEnvironmentView from "../pages/WorkspaceEnvironmentView.vue";
import { api, ApiError } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";
import { i18n } from "../../../i18n";
import { applyLocale } from "../../../i18n/locale";
import type {
    WorkspaceJobCancelReason,
    WorkspaceJobCleanupStatus,
    WorkspaceJobStatus,
} from "../../../types";
import { toast } from "vue-sonner";
import {
    openSelectAt,
    selectItemComponents,
    selectItemValues,
    selectModelValue,
    setSelectValue,
} from "../../../test-utils/select";

vi.mock("vue-router", () => ({
    useRoute: () => ({
        params: { workspaceId: "workspace-1" },
        path: "/workspace/workspace-1/environment",
        query: {},
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
    },
}));

vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            getWorkspaceEnvironment: vi.fn<typeof apiModule.api.getWorkspaceEnvironment>(),
            getWorkspaceJobs: vi.fn<typeof apiModule.api.getWorkspaceJobs>(),
            releaseWorkspaceRuntime: vi.fn<typeof apiModule.api.releaseWorkspaceRuntime>(),
            updateWorkspaceExecutionMode:
                vi.fn<typeof apiModule.api.updateWorkspaceExecutionMode>(),
        },
    };
});

const mockedApi = vi.mocked(api, true);

function environment(executionMode: "docker" | "windows-mxc" | "windows-host") {
    return {
        workspaceId: "workspace-1",
        status: "ready",
        storageBackend: "local",
        storageRef: "workspace-1",
        storageMode: "managed_import" as const,
        hostPath: null,
        executionMode,
        runtime: {
            status: "up",
            deviceId: "device-1",
            lastHeartbeatAt: "2026-09-21T00:00:00Z",
        },
    };
}

/** PLAN-0610: the instance-admin projection is `capabilities.isInstanceAdmin` (no role string). */
function setPrincipal(user: { id: string; isInstanceAdmin?: boolean }, ownerId: string) {
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
    sessionStorage.setItem(
        "xihe-workspace",
        JSON.stringify({ id: "workspace-1", name: "Workspace", ownerId }),
    );
}

function job(overrides: Record<string, unknown>) {
    return {
        runtimeJobId: null,
        workspaceId: "workspace-1",
        sessionId: null,
        runId: null,
        source: "ui",
        scope: "session",
        status: "running",
        jobId: "job-1",
        startedAt: "2026-09-21T00:00:00Z",
        endedAt: null,
        exitCode: null,
        timeoutSecs: 60,
        cancelReason: null,
        backendKind: "docker",
        executionMode: "docker",
        actorType: "user",
        createdAt: "2026-09-21T00:00:00Z",
        cleanupStatus: "running",
        errorCode: null,
        ...overrides,
    };
}

async function mountView(): Promise<VueWrapper> {
    const wrapper = mount(WorkspaceEnvironmentView, {
        global: { plugins: [i18n] },
    });
    await flushPromises();
    return wrapper;
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("xihe-token", "mock-token");
    setActivePinia(createPinia());
    // BL-359：清掉**调用记录**（`mockResolvedValue` 不清调用历史）。否则断言
    // `expect(updateWorkspaceExecutionMode).not.toHaveBeenCalled()` 会看到前一条用例的调用，
    // 用例顺序一变就红（`--sequence.shuffle.tests` 可稳定复现）。
    mockedApi.updateWorkspaceExecutionMode.mockClear();
    mockedApi.releaseWorkspaceRuntime.mockClear();
    mockedApi.getWorkspaceEnvironment.mockResolvedValue(environment("docker") as never);
    mockedApi.getWorkspaceJobs.mockResolvedValue([] as never);
    mockedApi.updateWorkspaceExecutionMode.mockResolvedValue(undefined as never);
    vi.mocked(toast.error).mockClear();
    mockedApi.releaseWorkspaceRuntime.mockResolvedValue({
        releaseOperationId: "op-1",
        workspaceId: "workspace-1",
        status: "accepted",
        reason: null,
        errorCode: null,
        createdAt: null,
        endedAt: null,
    } as never);
});

describe("WorkspaceEnvironmentView job projection", () => {
    it("renders scope, backend kind, status label and the terminal / cleanup detail per job", async () => {
        mockedApi.getWorkspaceJobs.mockResolvedValue([
            job({
                jobId: "job-run",
                status: "running",
                scope: "workspace",
                backendKind: "windows-host",
                cleanupStatus: "running",
            }),
            job({
                jobId: "job-done",
                status: "cancelled",
                scope: "run",
                backendKind: "docker",
                cleanupStatus: "completed",
                cancelReason: "user_cancel",
                errorCode: "RUNTIME_UNAVAILABLE",
            }),
        ] as never);

        const wrapper = await mountView(),
            secondary = wrapper.findAll('[data-testid="workspace-job-secondary"]'),
            statuses = wrapper.findAll('[data-testid="workspace-job-status"]');
        expect(secondary).toHaveLength(2);
        expect(statuses).toHaveLength(2);

        // Non-terminal job: scope + backend kind + cleanup status, never a cancel reason.
        // task-59：这三个字段的可见文本都是人话（原值只在 title/data-value 上）。
        expect(secondary[0].text()).toContain("工作区");
        expect(secondary[0].text()).toContain("Windows 宿主直跑");
        expect(secondary[0].text()).toContain("清理中");
        expect(secondary[0].text()).not.toContain("用户取消");
        expect(statuses[0].text()).toBe("运行中");

        // Terminal job: mapped cancel reason plus the raw error code.
        expect(secondary[1].text()).toContain("单次运行");
        expect(secondary[1].text()).toContain("Docker 容器");
        expect(secondary[1].text()).toContain("用户取消");
        expect(wrapper.get('[data-testid="workspace-job-error"]').text()).toContain(
            "RUNTIME_UNAVAILABLE",
        );
        expect(wrapper.get('[data-testid="workspace-job-error"]').text()).toContain("Runtime");
        expect(statuses[1].text()).toBe("已取消");
    });

    it("does not surface a not_started cleanup status as job detail", async () => {
        mockedApi.getWorkspaceJobs.mockResolvedValue([
            job({
                jobId: "job-pending",
                status: "pending",
                cleanupStatus: "not_started",
            }),
        ] as never);

        const wrapper = await mountView();

        expect(wrapper.get('[data-testid="workspace-job-secondary"]').text()).not.toContain(
            "清理未开始",
        );
        expect(wrapper.get('[data-testid="workspace-job-status"]').text()).toBe("等待中");
    });
});

describe("WorkspaceEnvironmentView job-start capability (PLAN-0396)", () => {
    it("disables start with an explicit reason when the runtime never reported", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue(environment("windows-host") as never);

        const wrapper = await mountView(),
            hint = wrapper.get('[data-testid="workspace-job-start-hint"]');
        expect(hint.attributes("aria-disabled")).toBe("true");
        expect(hint.text()).toContain("能力未知");
    });

    it("disables start and shows the runtime reason when unavailable", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("windows-mxc"),
            jobCapability: {
                backendKind: "windows-mxc",
                canStart: true,
                available: false,
                unavailableReason: "RUNTIME_UNREACHABLE",
            },
        } as never);

        const wrapper = await mountView(),
            hint = wrapper.get('[data-testid="workspace-job-start-hint"]');
        expect(hint.attributes("aria-disabled")).toBe("true");
        expect(hint.text()).toContain("RUNTIME_UNREACHABLE");
        expect(hint.text()).not.toContain("尚无启动器");
    });

    it("enables start and marks the unrestricted host backend", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("windows-host"),
            jobCapability: {
                backendKind: "windows-host",
                canStart: true,
                canCancel: true,
                canStreamOutput: true,
                canIsolateFilesystem: false,
                available: true,
            },
        } as never);

        const wrapper = await mountView(),
            hint = wrapper.get('[data-testid="workspace-job-start-hint"]');
        expect(hint.attributes("aria-disabled")).toBe("false");
        expect(hint.text()).toContain("Windows 宿主直跑");
        expect(hint.text()).toContain("无隔离");
    });

    it("enables start and marks the sandboxed mxc backend", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("windows-mxc"),
            jobCapability: {
                backendKind: "windows-mxc",
                canStart: true,
                canIsolateFilesystem: true,
                available: true,
            },
        } as never);

        const wrapper = await mountView(),
            hint = wrapper.get('[data-testid="workspace-job-start-hint"]');
        expect(hint.attributes("aria-disabled")).toBe("false");
        expect(hint.text()).toContain("Windows MXC 沙箱");
        expect(hint.text()).toContain("沙盒隔离");
    });

    it("does not claim unrestricted access when isolation capability is omitted", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("windows-mxc"),
            jobCapability: {
                backendKind: "windows-mxc",
                canStart: true,
                available: true,
            },
        } as never);

        const wrapper = await mountView();

        expect(wrapper.get('[data-testid="workspace-job-start-hint"]').text()).toContain(
            "隔离能力未知",
        );
        expect(wrapper.get('[data-testid="workspace-job-start-hint"]').text()).not.toContain(
            "无隔离",
        );
    });
});

describe("WorkspaceEnvironmentView frozen execution backend (PLAN-0612 M4.3)", () => {
    it("shows the freeze banner for a docker-execution workspace", async () => {
        const wrapper = await mountView();

        const banner = wrapper.get('[data-testid="workspace-execution-backend-frozen"]');
        expect(banner.text()).toContain(i18n.global.t("workspace.executionBackendFrozenTitle"));
        expect(banner.text()).toContain(i18n.global.t("workspace.executionBackendFrozenHint"));
        // The banner must name the way out (create a direct_attach workspace).
        expect(banner.text()).toContain("直接挂载");
    });

    it("shows the banner for a managed workspace even when the mode value is legacy", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("windows-mxc"),
            storageMode: "managed_import",
        } as never);

        const wrapper = await mountView();
        expect(wrapper.find('[data-testid="workspace-execution-backend-frozen"]').exists()).toBe(
            true,
        );
    });

    it("does not show the banner for a direct-attach MXC/host workspace", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("windows-mxc"),
            storageMode: "direct_attach",
        } as never);

        const wrapper = await mountView();
        expect(wrapper.find('[data-testid="workspace-execution-backend-frozen"]').exists()).toBe(
            false,
        );
    });
});

describe("WorkspaceEnvironmentView execution mode entry (PLAN-0551)", () => {
    it("shows a managed workspace as read-only docker with a reason", async () => {
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="workspace-execution-mode"]').exists()).toBe(false);
        const fixed = wrapper.get('[data-testid="workspace-execution-mode-fixed"]');
        expect(fixed.text()).toContain("Docker 容器");
        expect(fixed.text()).toContain("固定");
        expect(wrapper.get('[data-testid="workspace-execution-mode-hint"]').text()).toContain(
            "只能使用 Docker",
        );
        expect(mockedApi.updateWorkspaceExecutionMode).not.toHaveBeenCalled();
    });

    it("does not disguise a managed legacy non-docker value as docker", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("windows-mxc"),
            storageMode: "managed_import",
        } as never);

        const wrapper = await mountView(),
            fixed = wrapper.get('[data-testid="workspace-execution-mode-fixed"]');
        expect(fixed.text()).toContain("Windows MXC 沙箱");
        expect(fixed.text()).toContain("历史配置");
        expect(fixed.text()).not.toContain("固定");
    });

    it("treats a missing storageMode as managed", async () => {
        const missing = { ...environment("docker") } as Record<string, unknown>;
        delete missing.storageMode;
        mockedApi.getWorkspaceEnvironment.mockResolvedValue(missing as never);

        const wrapper = await mountView();
        expect(wrapper.find('[data-testid="workspace-execution-mode"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="workspace-execution-mode-fixed"]').text()).toContain(
            "Docker 容器",
        );
        expect(mockedApi.updateWorkspaceExecutionMode).not.toHaveBeenCalled();
    });

    it("offers only MXC and host for a direct-attach workspace", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("windows-mxc"),
            storageMode: "direct_attach",
        } as never);

        const wrapper = await mountView();
        await openSelectAt(wrapper, 0);
        expect(selectItemValues(wrapper)).toEqual(["windows-mxc", "windows-host"]);
        expect(wrapper.find('[data-testid="workspace-execution-mode-fixed"]').exists()).toBe(false);
    });

    it("switches a direct-attach workspace between MXC and host", async () => {
        mockedApi.getWorkspaceEnvironment
            .mockResolvedValueOnce({
                ...environment("windows-mxc"),
                storageMode: "direct_attach",
            } as never)
            .mockResolvedValueOnce({
                ...environment("windows-host"),
                storageMode: "direct_attach",
            } as never);

        const wrapper = await mountView();
        await setSelectValue(wrapper, '[data-testid="workspace-execution-mode"]', "windows-host");
        await flushPromises();

        expect(mockedApi.updateWorkspaceExecutionMode).toHaveBeenCalledWith(
            "workspace-1",
            "windows-host",
        );
        expect(selectModelValue(wrapper, '[data-testid="workspace-execution-mode"]')).toBe(
            "windows-host",
        );
    });

    it("shows a legacy direct-attach docker value as a disabled option", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("docker"),
            storageMode: "direct_attach",
        } as never);

        const wrapper = await mountView();
        await openSelectAt(wrapper, 0);
        expect(selectItemValues(wrapper)).toEqual(["docker", "windows-mxc", "windows-host"]);
        const legacy = selectItemComponents(wrapper).find(
            (item) => item.attributes("data-testid") === "workspace-execution-mode-legacy",
        );
        expect(legacy?.props("disabled")).toBe(true);
        expect(legacy?.text()).toContain("历史配置");
    });

    it("labels an empty direct-attach execution mode as unknown", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("windows-host"),
            executionMode: "",
            storageMode: "direct_attach",
        } as never);

        const wrapper = await mountView();
        await openSelectAt(wrapper, 0);
        const legacy = selectItemComponents(wrapper).find(
            (item) => item.attributes("data-testid") === "workspace-execution-mode-legacy",
        );
        expect(legacy?.text()).toContain("未知");
    });

    it("rolls back and explains when an active job blocks the switch", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("windows-mxc"),
            storageMode: "direct_attach",
        } as never);
        mockedApi.updateWorkspaceExecutionMode.mockRejectedValue(
            new ApiError({
                status: 409,
                code: "WORKSPACE_BUSY",
                detail: "workspace has running jobs",
            } as never),
        );

        const wrapper = await mountView();
        await setSelectValue(wrapper, '[data-testid="workspace-execution-mode"]', "windows-host");
        await flushPromises();

        expect(selectModelValue(wrapper, '[data-testid="workspace-execution-mode"]')).toBe(
            "windows-mxc",
        );
        expect(toast.error).toHaveBeenCalledWith("有运行中的 Job，请先停止运行中的 Job 后重试");
    });
});

describe("WorkspaceEnvironmentView hostPath disclosure", () => {
    it("hides a raw host path from a regular member", async () => {
        setPrincipal({ id: "member-1" }, "owner-1");
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("windows-host"),
            storageMode: "direct_attach",
            hostPath: "C:\\private\\repo",
        } as never);

        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="workspace-host-path"]').exists()).toBe(false);
        expect(wrapper.text()).not.toContain("C:\\private\\repo");
    });

    it("shows a raw host path to the workspace owner", async () => {
        setPrincipal({ id: "owner-1" }, "owner-1");
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("windows-host"),
            storageMode: "direct_attach",
            hostPath: "C:\\private\\repo",
        } as never);

        const wrapper = await mountView();

        expect(wrapper.get('[data-testid="workspace-host-path"]').text()).toContain(
            "C:\\private\\repo",
        );
    });

    it("shows a raw host path to an instance admin", async () => {
        setPrincipal({ id: "admin-1", isInstanceAdmin: true }, "owner-1");
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("windows-host"),
            storageMode: "direct_attach",
            hostPath: "C:\\private\\repo",
        } as never);

        const wrapper = await mountView();

        expect(wrapper.get('[data-testid="workspace-host-path"]').text()).toContain(
            "C:\\private\\repo",
        );
    });

    it("does not invent a host path when the server sends a safe null projection", async () => {
        setPrincipal({ id: "owner-1" }, "owner-1");
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("windows-host"),
            storageMode: "direct_attach",
            hostPath: null,
        } as never);

        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="workspace-host-path"]').exists()).toBe(false);
    });
});

describe("WorkspaceEnvironmentView runtime release (PLAN-0391)", () => {
    it("offers the release entry while the runtime holds resources", async () => {
        const wrapper = await mountView();
        expect(wrapper.find('[data-testid="workspace-runtime-release"]').exists()).toBe(true);
    });

    it("hides the release entry when the workspace is unbound", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("docker"),
            status: "unbound",
        } as never);

        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="workspace-runtime-release"]').exists()).toBe(false);
    });

    it("confirms then calls the release API with a non-empty idempotency key", async () => {
        const wrapper = await mountView();
        await wrapper.get('[data-testid="workspace-runtime-release"]').trigger("click");
        expect(wrapper.find('[data-testid="workspace-release-confirm"]').exists()).toBe(true);
        await wrapper.get('[data-testid="workspace-release-confirm-button"]').trigger("click");
        await flushPromises();

        expect(mockedApi.releaseWorkspaceRuntime).toHaveBeenCalledTimes(1);
        const [wsId, key] = mockedApi.releaseWorkspaceRuntime.mock.calls[0];
        expect(wsId).toBe("workspace-1");
        expect(typeof key).toBe("string");
        expect((key as string).length).toBeGreaterThan(0);
    });

    it("disables release and explains why while an active Job blocks it", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("docker"),
            runtime: {
                status: "up",
                deviceId: "device-1",
                lastHeartbeatAt: "2026-09-21T00:00:00Z",
                activeJobCount: 2,
            },
        } as never);

        const wrapper = await mountView(),
            button = wrapper.get('[data-testid="workspace-runtime-release"]');
        expect(button.attributes("disabled")).toBeDefined();
        expect(wrapper.get('[data-testid="workspace-runtime-release-status"]').text()).toContain(
            "2",
        );
    });

    it("surfaces the release origin reason from the environment projection", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("docker"),
            runtime: {
                status: "unbound",
                deviceId: "device-1",
                lastHeartbeatAt: "2026-09-21T00:00:00Z",
                reason: "USER_RELEASED",
            },
        } as never);

        const wrapper = await mountView();

        expect(wrapper.get('[data-testid="workspace-runtime-reason"]').text()).toContain(
            "已手动释放",
        );
    });
});

// ---------------------------------------------------------------------------
// task-49：WorkspaceJob 三个枚举（状态 / 取消原因 / 清理状态）的展示文案必须走 i18n。
// 此前三张表把中文写死 ⇒ en-US 界面照样显示中文（不是"切语言不重算"，是根本没有译文）。
//
// 值域与 `docs/api/openapi.yaml` 的 `WorkspaceJob` 逐项一致：
//   status 7 值（yaml `:8055`）· cancelReason 7 值（`:8060`）· cleanupStatus 4 值（`:8065`）。
// 这里用 union 类型标注 —— 契约删值 ⇒ 本文件 TS 红；契约加值 ⇒ 组件侧 `Record<…>` 红。
// ---------------------------------------------------------------------------
const JOB_STATUS_VALUES: WorkspaceJobStatus[] = [
    "pending",
    "running",
    "succeeded",
    "cancelled",
    "timeout",
    "orphaned",
    "interrupted",
];
const CANCEL_REASON_VALUES: WorkspaceJobCancelReason[] = [
    "user_cancel",
    "scope_run_end",
    "scope_session_stop",
    "workspace_destroy",
    "runtime_restart",
    "destroy_orphan",
    "job_missing",
];
const CLEANUP_STATUS_VALUES: WorkspaceJobCleanupStatus[] = [
    "not_started",
    "running",
    "completed",
    "failed",
];

/** 从指定 locale 的 message 树取原串（不经全局 locale，避免断言依赖"当前语言"）。 */
function messageIn(locale: string, key: string): string {
    const messages = i18n.global.getLocaleMessage(locale) as Record<string, unknown>;
    const value = key
        .split(".")
        .reduce<unknown>(
            (acc, part) => (acc as Record<string, unknown> | undefined)?.[part],
            messages,
        );
    return typeof value === "string" ? value : "";
}

/** 枚举 wire 值 → i18n key 的末段（`user_cancel` → `userCancel`，与组件键表同一命名约定）。 */
function camel(value: string): string {
    return value.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
}

/** CJK 判据：en-US 下这三个字段出现任何一条即"没译文"。 */
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

/** 覆盖三套枚举值的 job 列表（每个值至少一条）。 */
function jobsCoveringEnums() {
    const terminal = new Set(["succeeded", "cancelled", "timeout", "orphaned", "interrupted"]),
        startedCleanup = CLEANUP_STATUS_VALUES.filter((value) => value !== "not_started"),
        rows = JOB_STATUS_VALUES.map((status, index) =>
            job({
                jobId: `job-status-${status}`,
                status,
                cancelReason: terminal.has(status)
                    ? CANCEL_REASON_VALUES[index % CANCEL_REASON_VALUES.length]
                    : null,
                cleanupStatus: terminal.has(status)
                    ? null
                    : startedCleanup[index % startedCleanup.length],
            }),
        );
    rows.push(
        ...CANCEL_REASON_VALUES.map((reason) =>
            job({
                jobId: `job-reason-${reason}`,
                status: "cancelled",
                cancelReason: reason,
                cleanupStatus: null,
            }),
        ),
    );
    rows.push(
        ...startedCleanup.map((cleanupStatus) =>
            job({
                jobId: `job-cleanup-${cleanupStatus}`,
                status: "running",
                cancelReason: null,
                cleanupStatus,
            }),
        ),
    );
    return rows;
}

describe("WorkspaceEnvironmentView job enum i18n (task-49)", () => {
    it("en-US 界面：三个枚举字段都不得出现 CJK", async () => {
        applyLocale("en-US");
        mockedApi.getWorkspaceJobs.mockResolvedValue(jobsCoveringEnums() as never);

        const wrapper = await mountView(),
            statuses = wrapper.findAll('[data-testid="workspace-job-status"]').map((n) => n.text()),
            secondary = wrapper
                .findAll('[data-testid="workspace-job-secondary"]')
                .map((n) => n.text());

        // 每行 job 都有状态位（17 行：7 状态 + 7 取消原因 + 3 清理状态）
        expect(statuses).toHaveLength(jobsCoveringEnums().length);
        for (const text of statuses) expect(text).not.toMatch(CJK);
        for (const text of secondary) expect(text).not.toMatch(CJK);

        // 期望集合由 i18n 键现算（不写死文案）
        const expected = new Set(
            JOB_STATUS_VALUES.map((value) =>
                messageIn("en-US", `workspace.environmentJobStatus.${camel(value)}`),
            ),
        );
        expect(expected.size).toBe(JOB_STATUS_VALUES.length);
        for (const text of statuses) expect(expected.has(text)).toBe(true);
        expect(new Set(statuses).size).toBe(expected.size);
        for (const value of CANCEL_REASON_VALUES) {
            expect(
                messageIn("en-US", `workspace.environmentJobCancelReason.${camel(value)}`),
            ).toBeTruthy();
        }
        for (const value of CLEANUP_STATUS_VALUES) {
            expect(
                messageIn("en-US", `workspace.environmentJobCleanupStatus.${camel(value)}`),
            ).toBeTruthy();
        }
    });

    it("zh-CN 界面：同一批 job 用中文文案，且与英文文案不同（证明真的翻译过）", async () => {
        applyLocale("zh-CN");
        mockedApi.getWorkspaceJobs.mockResolvedValue(jobsCoveringEnums() as never);

        const wrapper = await mountView(),
            statuses = wrapper.findAll('[data-testid="workspace-job-status"]').map((n) => n.text());

        const zhExpected = JOB_STATUS_VALUES.map((value) =>
            messageIn("zh-CN", `workspace.environmentJobStatus.${camel(value)}`),
        );
        expect([...new Set(statuses)].sort()).toEqual([...new Set(zhExpected)].sort());

        for (const value of JOB_STATUS_VALUES) {
            const key = `workspace.environmentJobStatus.${camel(value)}`;
            expect(messageIn("zh-CN", key)).not.toBe(messageIn("en-US", key));
        }
    });
});

// ---------------------------------------------------------------------------
// task-52：整页 i18n（骨架 / 状态 / 原因 / 提示四块）。
// 此前页面骨架（eyebrow、副标题、加载态、三张卡的标题与字段名）与 recovery 文案、
// Job 启动原因都写死中文 ⇒ en-US 界面下只有枚举字段是英文，其余整片中文。
// 判据：①en-US 整页渲染文本**不得含 CJK**；②四块逐块与 `getLocaleMessage("en-US")` 现算值相等
// ③zh 与 en 每一条词条都不同（证明真的翻译过，而不是两侧复制同一串）。
// ---------------------------------------------------------------------------
/** 本卡新增/复用的全部 environment 词条键（50 个新键；不含 task-49 的三张枚举表）。 */
const ENVIRONMENT_MESSAGE_KEYS = [
    "environmentEyebrow",
    "environmentSubtitle",
    "environmentLoading",
    "environmentWorkspaceId",
    "environmentUnmaterializedTitle",
    "environmentUnmaterializedHint",
    "environmentPrepare",
    "environmentPreparePreparing",
    "environmentStorageTitle",
    "environmentExecutionTitle",
    "environmentRuntimeTitle",
    "environmentJobsTitle",
    "environmentFieldBackend",
    "environmentFieldStorageMode",
    "environmentFieldStorageRef",
    "environmentFieldHostPath",
    "environmentFieldStatus",
    "environmentFieldExecutionMode",
    "environmentFieldCapability",
    "environmentFieldGeneration",
    "environmentFieldSpecHash",
    "environmentFieldDevice",
    "environmentFieldLastHeartbeat",
    "environmentFieldReleaseStatus",
    "environmentValueUnknown",
    "environmentValueNone",
    "environmentValueNotObserved",
    "environmentCapabilityAvailable",
    "environmentCapabilityUnavailable",
    "environmentCapabilityReasonUnknown",
    "environmentBackendUnknown",
    // task-46：storageMode 未知值兜底词条（两侧都要有，否则未知模式会露出原值或空白）。
    "environmentStorageModeUnknown",
    "environmentJobCapabilityUnknown",
    "environmentJobCapabilityUnavailable",
    "environmentJobCapabilityReasonMissing",
    "environmentJobCapabilitySandboxed",
    "environmentJobCapabilityUnrestricted",
    "environmentJobCapabilityUnknownIsolation",
    "environmentJobCount",
    "environmentJobsEmpty",
    "environmentRecovery.ready",
    "environmentRecovery.materializing",
    "environmentRecovery.paused",
    "environmentRecovery.stopped",
    "environmentRecovery.destroying",
    "environmentRecovery.degraded",
    "environmentRecovery.blocked",
    "environmentRecovery.stale",
    "environmentRecovery.unbound",
    "environmentRecovery.pending",
    "environmentRecovery.unknown",
] as const;

/** 极简插值：把 `{name}` 换成入参（只用于断言期望值，不参与产品渲染）。 */
function interpolate(template: string, params: Record<string, string | number>): string {
    return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}

describe("WorkspaceEnvironmentView full-page i18n (task-52)", () => {
    it("en-US 界面：整页不得出现 CJK，且四块区域分别取 en-US 词条", async () => {
        applyLocale("en-US");
        // 带 jobCapability 的宿主后端工作区：让「原因」块落到可插值的那条文案上。
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("windows-host"),
            jobCapability: {
                available: true,
                canStart: true,
                canIsolateFilesystem: true,
                backendKind: "windows-mxc",
                unavailableReason: null,
            },
        } as never);
        mockedApi.getWorkspaceJobs.mockResolvedValue([] as never);

        const wrapper = await mountView();

        // ① 整页无 CJK —— 这是本卡的反向断言：漏一个键就会有一行中文漏出来。
        expect(wrapper.text()).not.toMatch(CJK);

        // ② 四块区域逐块与现算期望值对齐（不写死英文文案）。
        const heading = wrapper.get('[data-testid="workspace-environment-heading"]').text();
        expect(heading).toBe(messageIn("en-US", "workspace.environmentState"));

        const recovery = wrapper.get('[data-testid="workspace-environment-recovery"]').text();
        expect(recovery).toBe(messageIn("en-US", "workspace.environmentRecovery.ready"));

        const startHint = wrapper.get('[data-testid="workspace-job-start-hint"]').text();
        expect(startHint).toBe(
            interpolate(messageIn("en-US", "workspace.environmentJobCapabilitySandboxed"), {
                backend: messageIn("en-US", "workspace.environmentExecutionMode.windowsMxc"),
            }),
        );

        // 提示块：无 durable Job 时的空态文案
        expect(wrapper.get('[data-testid="workspace-jobs-panel"]').text()).toContain(
            messageIn("en-US", "workspace.environmentJobsEmpty"),
        );

        // 骨架标题逐个在场（证明模板真的走了 t()，而不是恰好没有中文）
        for (const key of [
            "environmentEyebrow",
            "environmentStorageTitle",
            "environmentExecutionTitle",
            "environmentRuntimeTitle",
        ]) {
            expect(wrapper.text()).toContain(messageIn("en-US", `workspace.${key}`));
        }
    });

    it("zh-CN 界面：每条 environment 词条都有中文译文，且与 en-US 不同", () => {
        for (const suffix of ENVIRONMENT_MESSAGE_KEYS) {
            const key = `workspace.${suffix}`,
                zh = messageIn("zh-CN", key),
                en = messageIn("en-US", key);

            expect(zh, key).not.toBe("");
            expect(en, key).not.toBe("");
            expect(zh, key).toMatch(CJK);
            expect(zh, key).not.toBe(en);
        }
    });
});

/**
 * task-46：**枚举直显改人话 + 机器判据**（用户实拍：环境页把后端枚举原样显示给用户）。
 *
 * <p>为什么单测要钉这一条：真实 e2e（`e2e/real/environment.spec.ts`）过去直接把
 * 「页面出现 host_directory」写成期望 —— 缺陷被断言养着，改对了反而变红。所以本组用例同时钉三件事：
 * ① 已知枚举 → 人话标签；② 未知枚举 → 「未知后端」兜底，**不透传原值**；③ 整页正文**不得**出现
 * `^[a-z]+_[a-z_]+$` 形态的裸标识符（数据字段直显的通用形态）。
 * 判据 ③ 的变异（把某个枚举值放回页面 ⇒ 必须红）在 `task-46` 的读里记录，见卡面。</p>
 */
/**
 * 判据形态：`^[a-z]+_[a-z_]+$` 的**裸标识符**。实现用 ASCII 边界前瞻/后顾而不是
 * `split(空白)` —— 实测首版 split 版本会漏：中文标签与枚举值紧贴渲染成
 * 「存储后端host_directory存储方式」（CJK 与 ASCII 之间没有空白），按空白切出来的是一个
 * 混排 token，正则匹配不到 ⇒ 门假绿。带 ASCII 边界的 lookaround 能抓这类紧贴渲染
 * （变异实测：把 `{{ storageBackendText }}` 换回 `{{ environment.storageBackend }}` ⇒ 本断言红）。
 */
const BARE_SNAKE_ENUM = /(?<![A-Za-z0-9_])[a-z]+_[a-z_]+(?![A-Za-z0-9_])/g;
function bareSnakeTokens(text: string): string[] {
    return [...text.matchAll(BARE_SNAKE_ENUM)].map((match) => match[0]);
}

describe("WorkspaceEnvironmentView 存储字段人话化（task-46）", () => {
    // 同文件前面的 i18n 用例会切到 en-US（applyLocale 是全局态），这里必须自钉 zh-CN，
    // 否则本组断言会跟着前一条用例的执行顺序漂（shuffle 下必红）。
    beforeEach(() => {
        applyLocale("zh-CN");
    });

    it("host_directory + direct_attach ⇒ 「宿主机目录」/「直接挂载」，且不出现冻结提示", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("windows-host"),
            storageBackend: "host_directory",
            storageMode: "direct_attach",
        } as never);

        const wrapper = await mountView();

        expect(wrapper.get('[data-testid="workspace-environment-storage-backend"]').text()).toBe(
            "宿主机目录",
        );
        expect(wrapper.get('[data-testid="workspace-environment-storage-mode"]').text()).toBe(
            "直接挂载",
        );
        expect(
            wrapper.find('[data-testid="workspace-environment-storage-mode-frozen"]').exists(),
        ).toBe(false);
    });

    it("managed_import ⇒ 「托管副本」+ 冻结提示（事实：Docker 后端已冻结，不是「尚未接通」）", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("docker"),
            storageBackend: "host_directory",
            storageMode: "managed_import",
        } as never);

        const wrapper = await mountView();

        expect(wrapper.get('[data-testid="workspace-environment-storage-mode"]').text()).toContain(
            "托管副本",
        );
        expect(
            wrapper.get('[data-testid="workspace-environment-storage-mode-frozen"]').text(),
        ).toBe("执行后端已冻结，暂不可用");
    });

    it("未知 storageBackend / storageMode ⇒ 「未知后端」/「未知存储方式」，不透传原值", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("windows-host"),
            storageBackend: "network_share",
            storageMode: "gluster_fuse",
        } as never);

        const wrapper = await mountView();

        expect(wrapper.get('[data-testid="workspace-environment-storage-backend"]').text()).toBe(
            "未知后端",
        );
        expect(wrapper.get('[data-testid="workspace-environment-storage-mode"]').text()).toBe(
            "未知存储方式",
        );
        // 原值一个字都不能出现在页面上（这就是「数据字段直显」的缺陷本体）。
        expect(wrapper.text()).not.toContain("network_share");
        expect(wrapper.text()).not.toContain("gluster_fuse");
    });

    it("机器判据：整页正文没有 snake_case 裸标识符，且三个已知枚举值都不出现", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("docker"),
            storageBackend: "host_directory",
            storageMode: "managed_import",
        } as never);

        const wrapper = await mountView();
        const text = wrapper.text();

        expect(bareSnakeTokens(text)).toEqual([]);
        for (const raw of ["host_directory", "direct_attach", "managed_import"]) {
            expect(text, raw).not.toContain(raw);
        }
    });
});

/**
 * task-59：**其余枚举字段也走「人话 + 未知兜底」**（task-46 只覆盖了 storage 两个字段）。
 *
 * <p>判据分两层，缺一不可：</p>
 * <ol>
 *   <li>**蛇形裸标识符**（`bareSnakeTokens`，ASCII 边界 lookaround）—— 只能抓 `host_directory` 这类；</li>
 *   <li>**白名单式负例**：`docker` / `windows-mxc` / `stable` / `agent` 这些**不是蛇形**，
 *       蛇形正则抓不到 ⇒ 必须逐值断言它们不出现。只写第 1 条会让判据「绿在没有蛇形标识符」，
 *       而屏幕上明明写着 `docker`（task-59 开工时点名的部分假绿形态）。</li>
 * </ol>
 */
describe("WorkspaceEnvironmentView 其余枚举字段人话化（task-59）", () => {
    beforeEach(() => {
        applyLocale("zh-CN");
    });

    it("状态徽标：已知值给人话，原值只留在 title / data-value 属性", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("windows-host"),
            status: "materializing",
        } as never);

        const wrapper = await mountView();
        const badge = wrapper.get('[data-testid="workspace-environment-status"]');

        expect(badge.text()).toBe("物化中");
        // 排障信息不丢：原值在属性上，不在可见文本里。
        expect(badge.attributes("title")).toBe("materializing");
        expect(badge.attributes("data-value")).toBe("materializing");
    });

    it("状态徽标：未知值 → 「未知状态」，且不透传原值到可见文本", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("windows-host"),
            status: "hibernating",
        } as never);

        const wrapper = await mountView();
        const badge = wrapper.get('[data-testid="workspace-environment-status"]');

        expect(badge.text()).toBe("未知状态");
        expect(badge.attributes("data-value")).toBe("hibernating");
        expect(wrapper.text()).not.toContain("hibernating");
    });

    it("runtime.status 与 executionSpec.status 同一套标签 + 未知兜底", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("windows-host"),
            status: "ready",
            runtime: { ...environment("windows-host").runtime, status: "degraded" },
        } as never);

        const wrapper = await mountView();

        expect(wrapper.get('[data-testid="workspace-runtime-status"]').text()).toBe("降级");
        // executionSpec 缺省时走同一兜底，不再输出硬编码英文 "unknown"
        expect(wrapper.text()).not.toContain("unknown");
    });

    it("执行模式给人话（docker / windows-mxc / windows-host 三个原值都不出现）", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("docker"),
            storageMode: "managed_import",
            storageBackend: "host_directory",
        } as never);

        const wrapper = await mountView();
        const fixed = wrapper.get('[data-testid="workspace-execution-mode-fixed"]');

        expect(fixed.text()).toContain("Docker 容器");
        expect(fixed.attributes("data-value")).toBe("docker");
        // 白名单式负例：这三个值是连字符/单词形态，蛇形正则抓不到。
        for (const raw of ["docker", "windows-mxc", "windows-host"]) {
            expect(wrapper.text(), raw).not.toMatch(new RegExp("\\b" + raw + "\\b"));
        }
    });

    it("capability.maturity 给人话，原值不进可见文本", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("windows-mxc"),
            capability: {
                contractVersion: "v1",
                backendKind: "windows-mxc",
                backendRevision: "rev-1",
                maturity: "stable",
                executionMode: "windows-mxc",
                available: true,
            },
        } as never);

        const wrapper = await mountView();

        expect(wrapper.text()).toContain("稳定");
        expect(wrapper.text()).not.toMatch(/\bstable\b/);
        expect(wrapper.text()).not.toMatch(/\bexperimental\b/);
    });

    it("job.source / job.scope 给人话；未知值走兜底且原值只在属性上", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("windows-host"),
            storageMode: "direct_attach",
            storageBackend: "host_directory",
        } as never);
        mockedApi.getWorkspaceJobs.mockResolvedValue([
            job({ source: "scheduled", scope: "workspace" }),
            job({ jobId: "job-2", source: "legacy_import", scope: "everything" }),
        ] as never);

        const wrapper = await mountView();
        const text = wrapper.text();

        expect(text).toContain("自动化任务");
        expect(text).toContain("工作区");
        expect(text).toContain("未知发起方");
        expect(text).toContain("未知作用域");
        expect(text).not.toContain("legacy_import");
        expect(text).not.toContain("everything");
        // 已映射的 source 原值同样不得出现在可见文本里
        expect(text).not.toMatch(/\bscheduled\b/);
    });

    it("机器判据：整页正文既无蛇形裸标识符，也无这些原值字面量", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue({
            ...environment("docker"),
            status: "ready",
            storageBackend: "host_directory",
            storageMode: "managed_import",
            capability: {
                contractVersion: "v1",
                backendKind: "docker",
                backendRevision: "rev-1",
                maturity: "experimental",
                executionMode: "docker",
                available: true,
            },
        } as never);
        mockedApi.getWorkspaceJobs.mockResolvedValue([
            job({ source: "agent", scope: "session" }),
        ] as never);

        const wrapper = await mountView();
        const text = wrapper.text();

        expect(bareSnakeTokens(text)).toEqual([]);
        // 白名单式负例（第 2 层判据）：这些原值不是蛇形，只有逐值断言才抓得住。
        for (const raw of [
            "docker",
            "windows-mxc",
            "windows-host",
            "managed_import",
            "direct_attach",
            "host_directory",
            "experimental",
            "agent",
            "session",
        ]) {
            expect(text, raw).not.toMatch(new RegExp("\\b" + raw + "\\b"));
        }
    });
});

/**
 * task-53 item 1/2/3（批次02 P2）—— 环境页三条体验细节的钉住用例。
 *
 * 为什么这三条值得各钉一条：它们都不是"好看不好看"，各自会造成**误读**：
 * - item 1：长摘要在字符串中间硬折 ⇒ 一个值看起来像两个；
 * - item 2：executionSpec.status 复用 workspace 状态词表 ⇒ 恒显示「未知状态」，
 *           与同页「能力探测：稳定/可用」自相矛盾（用户不知道该信哪个）；
 * - item 3：可逆动作配 destructive 视觉 ⇒ 用户以为「释放 = 删文件」而不敢点。
 */
describe("WorkspaceEnvironmentView 执行配置细节（task-53 item 1/2/3）", () => {
    function envWithSpec(overrides: Record<string, unknown> = {}) {
        return {
            ...environment("windows-host"),
            executionSpec: {
                status: "assigned",
                generation: 1,
                sandboxSpecHash: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            },
            ...overrides,
        };
    }

    it("item2: executionSpec.status=assigned 必须显示人话，不能落到「未知状态」", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue(envWithSpec() as never);
        const wrapper = await mountView();

        // 执行配置卡片里的状态值（不是左侧 environment.status 那一处）。
        const execCard = wrapper
            .findAll("article")
            .find((a) => a.text().includes(i18n.global.t("workspace.environmentExecutionTitle")));
        expect(execCard, "执行配置卡片必须存在").toBeTruthy();
        expect(execCard!.text()).not.toContain(i18n.global.t("workspace.environmentStatusUnknown"));
        expect(execCard!.text()).toContain(i18n.global.t("workspace.environmentStatus.assigned"));
    });

    it("item2: unassigned 同样走人话（不是未知）", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue(
            envWithSpec({
                executionSpec: { status: "unassigned", generation: 0, sandboxSpecHash: "" },
            }) as never,
        );
        const wrapper = await mountView();
        const execCard = wrapper
            .findAll("article")
            .find((a) => a.text().includes(i18n.global.t("workspace.environmentExecutionTitle")));
        expect(execCard!.text()).toContain(i18n.global.t("workspace.environmentStatus.unassigned"));
        expect(execCard!.text()).not.toContain(i18n.global.t("workspace.environmentStatusUnknown"));
    });

    it("item1: 摘要截断显示且完整值留在 title，并提供复制入口", async () => {
        mockedApi.getWorkspaceEnvironment.mockResolvedValue(envWithSpec() as never);
        const wrapper = await mountView();

        const digest = wrapper.find('[data-testid="workspace-spec-digest"]');
        expect(digest.exists()).toBe(true);
        // 完整值必须在 title 里 —— 「截断显示」不等于「丢失信息」。
        expect(digest.attributes("title")).toBe(
            "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
        );
        // 可见文本走 truncate 类（CSS 截断），不再 break-all（后者会在字符串中间折断）。
        expect(digest.classes()).toContain("truncate");
        expect(digest.classes()).not.toContain("break-all");
        expect(wrapper.find('[data-testid="workspace-spec-digest-copy"]').exists()).toBe(true);
    });

    it("item3: 释放运行资源是中性按钮，不是 destructive 描红", async () => {
        const wrapper = await mountView();
        const release = wrapper.get('[data-testid="workspace-runtime-release"]');
        // destructive 的视觉语言（text-destructive / border-destructive）不得出现在这里：
        // 该动作可逆（不删文件，下次自动重建），红色应留给真正不可逆的动作。
        expect(release.classes().join(" ")).not.toMatch(/destructive/);
    });
});
