import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { i18n } from "../../../i18n";
import { api, type VersionInfo } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";
import MonitoringView from "../MonitoringView.vue";

/**
 * BL-530（task-103）：版本卡片原先只守 `v-if="versionInfo"`，而 `{}` 也是真值 ⇒
 * 直接读 `versionInfo.modules.cp.version` 抛
 * `TypeError: Cannot read properties of undefined (reading 'cp')`（真栈实测 34s 8 条 pageerror，
 * 卡片永久停在「加载中」）。
 *
 * 这里锁两件事：
 * 1. **200 但缺 modules** ⇒ 挂载不抛错，卡片走既有 `settings.versionUnavailable`；
 * 2. **半形状**（modules 在但某模块缺）⇒ 逐项走既有 `versionNotReported` / `commitNotInjected`。
 */
vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            getServiceStatus: vi.fn<typeof apiModule.api.getServiceStatus>(),
            getVersionInfo: vi.fn<typeof apiModule.api.getVersionInfo>(),
        },
    };
});

const mockedApi = vi.mocked(api, true);

const STATUS: Awaited<ReturnType<typeof api.getServiceStatus>> = {
    status: "healthy",
    timestamp: 1762700000000,
    services: [],
};

const FULL_VERSION: VersionInfo = {
    stackId: "stack-1",
    releaseChannel: "dev",
    startedAt: "2026-11-10T03:00:00Z",
    commit: "7d644340abc123456",
    modules: {
        cp: { version: "1.0.0-SNAPSHOT", commit: "7d644340abc123456" },
        agent: { version: "0.4.0", commit: "a1b2c3d4e5f67890", framework: "langgraph" },
        runtime: { version: "0.3.0", commit: "0f1e2d3c4b5a6789" },
    },
};

let wrapper: VueWrapper | null = null;

async function mountView() {
    wrapper = mount(MonitoringView, { global: { plugins: [i18n] } });
    await flushPromises();
    return wrapper;
}

function cardText(w: VueWrapper) {
    return w.find('[data-testid="settings-version-card"]').text();
}

beforeEach(() => {
    mockedApi.getServiceStatus.mockResolvedValue(STATUS);
    mockedApi.getVersionInfo.mockResolvedValue(FULL_VERSION);
});

afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
});

describe("MonitoringView 版本卡片（BL-530）", () => {
    it("完整响应：三层版本与 commit 截断照常渲染", async () => {
        const w = await mountView();
        const text = cardText(w);
        expect(text).toContain("stack-1");
        expect(text).toContain("1.0.0-SNAPSHOT");
        expect(text).toContain("0.4.0");
        expect(text).toContain("0.3.0");
        // commit 只显示前 12 位（formatCommit）
        expect(text).toContain("7d644340abc1");
        expect(text).not.toContain(i18n.global.t("settings.versionUnavailable"));
    });

    it("200 但缺 modules：不抛错，走既有「版本信息不可用」降级", async () => {
        // 真栈 shape 缺口（旧 CP / 网关空 JSON / 字段裁剪）——修复前这里必抛
        // TypeError: Cannot read properties of undefined (reading 'cp')
        mockedApi.getVersionInfo.mockResolvedValue({} as VersionInfo);
        const w = await mountView();
        const text = cardText(w);
        expect(text).toContain(i18n.global.t("settings.versionUnavailable"));
        expect(text).not.toContain(i18n.global.t("common.loading"));
    });

    it("半形状（modules 在但缺 cp/agent/runtime）：逐项走既有「未上报」降级", async () => {
        mockedApi.getVersionInfo.mockResolvedValue({
            ...FULL_VERSION,
            modules: { agent: FULL_VERSION.modules.agent } as VersionInfo["modules"],
        });
        const w = await mountView();
        const text = cardText(w);
        // cp 与 runtime 缺失 ⇒ 版本显示「未上报」、commit 显示「未注入 commit」，且不崩
        expect(text).toContain(i18n.global.t("settings.versionNotReported"));
        expect(text).toContain(i18n.global.t("settings.commitNotInjected"));
        expect(text).toContain("0.4.0");
    });

    it("取版本失败（如 401）：仍走既有错误分支，不影响服务列表渲染", async () => {
        mockedApi.getVersionInfo.mockRejectedValue(new Error("401"));
        const w = await mountView();
        expect(cardText(w)).toContain(i18n.global.t("settings.versionUnavailable"));
        // 监控页另一块（服务状态）照常可用
        expect(w.text()).toContain(i18n.global.t("settings.allHealthy"));
    });
});
