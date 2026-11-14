import { describe, it, expect, afterEach, vi } from "vitest";
import {
    MOCK_ENV_STORAGE_MODE_FLAG,
    mockEnvStorageModeOverride,
    mockWorkspaceEnvironment,
    mockWorkspaceJobs,
} from "../data/workspaceEnvironment";

/**
 * task-54（D-1444）：环境页「托管副本冻结态」的 mock 开关。
 *
 * <p>为什么要给一个 mock 开关写覆盖测：它是**同一个 commit 能拍出两组不同外观的图**的唯一变量，
 * 而这个变量的证据面（manifest `env`）本身也需要有人钉住「默认态真的没被污染」。
 * 少了这条，把夹具默认值悄悄改成 managed_import 也能让所有测试绿 —— 那种改法会让预览图
 * 谎报产品默认态（PLAN-0618 后新建工作区只能 direct_attach）。</p>
 */
const WS = "9f8e7d6c-5b4a-4321-8fed-cba987654321";

describe("workspaceEnvironment 夹具（task-54）", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("默认态：storageMode = direct_attach（产品默认，未被开关污染）", () => {
        const env = mockWorkspaceEnvironment(WS);
        expect(env.storageBackend).toBe("host_directory");
        expect(env.storageMode).toBe("direct_attach");
        expect(mockEnvStorageModeOverride()).toBeNull();
    });

    it("XIHE_UI_MOCK_ENV_STORAGE_MODE=managed_import ⇒ 切到托管副本，且只动这一个字段", () => {
        const base = mockWorkspaceEnvironment(WS);
        vi.stubEnv(MOCK_ENV_STORAGE_MODE_FLAG, "managed_import");
        const frozen = mockWorkspaceEnvironment(WS);

        expect(frozen.storageMode).toBe("managed_import");
        // 「另一态」必须是同一条夹具的一个字段差异，不能悄悄变成第二条夹具数据。
        const { storageMode: baseMode, ...restBase } = base;
        const { storageMode: frozenMode, ...restFrozen } = frozen;
        expect(baseMode).toBe("direct_attach");
        expect(frozenMode).toBe("managed_import");
        expect(restFrozen).toEqual(restBase);
    });

    it("拼错/其它值（managed-import）⇒ 回落默认态，不静默接受", () => {
        vi.stubEnv(MOCK_ENV_STORAGE_MODE_FLAG, "managed-import");
        expect(mockEnvStorageModeOverride()).toBeNull();
        expect(mockWorkspaceEnvironment(WS).storageMode).toBe("direct_attach");
    });

    it("job 夹具不随该开关变化（开关只管环境投影）", () => {
        const before = mockWorkspaceJobs(WS);
        vi.stubEnv(MOCK_ENV_STORAGE_MODE_FLAG, "managed_import");
        expect(mockWorkspaceJobs(WS)).toEqual(before);
    });
});
