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
        expect(secondary[0].text()).toContain("workspace");
        expect(secondary[0].text()).toContain("windows-host");
        expect(secondary[0].text()).toContain("清理中");
        expect(secondary[0].text()).not.toContain("用户取消");
        expect(statuses[0].text()).toBe("运行中");

        // Terminal job: mapped cancel reason plus the raw error code.
        expect(secondary[1].text()).toContain("run");
        expect(secondary[1].text()).toContain("docker");
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
        expect(hint.text()).toContain("windows-host");
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
        expect(hint.text()).toContain("windows-mxc");
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
        expect(fixed.text()).toContain("docker");
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
        expect(fixed.text()).toContain("windows-mxc");
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
            "docker",
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
