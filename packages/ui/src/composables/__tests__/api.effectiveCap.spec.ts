import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";

/**
 * task-469（417 P1-6）：live 生效权限客户端的 **fail-closed 解析**判据。
 *
 * <p>为什么单独立一份：面板 spec 把 `api` 整个 mock 掉了，**测不到解析层**；而「畸形响应怎么办」
 * 正是本面最容易出空断言的地方 —— 若解析静默补默认值或回落到 `permissionsSnapshot`，界面上
 * 「读了 live」与「显示快照」就分不开（D-1281）。这里用 fetch 替身打**真实客户端代码**。</p>
 */
const WS = "66666666-6666-4666-8666-666666666666";
const PID = "77777777-7777-4777-8777-777777777777";
const GRANT = "g1f0c4d2-7b3e-4c55-8f10-777777777777";

const VIEW = {
    principalId: PID,
    workspaceId: WS,
    effectiveCap: [{ actionClass: "file_read", resource: "workspace" }],
    capSource: { binding: "binding-snapshot" },
    provenance: { principalGrantIds: [GRANT], bindingGrantIds: [] },
    defaultGrants: { readFace: ["workspace-member"] },
    bound: true,
};

/** fetch 替身的最小形状（只实现被测路径用到的成员）。 */
interface StubResponse {
    ok: boolean;
    status: number;
    headers: { get: () => string | null };
    json: () => Promise<unknown>;
    text: () => Promise<string>;
}

function stubFetch(body: unknown, status = 200) {
    const fetchMock = vi.fn<() => Promise<StubResponse>>(async () => ({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        json: async () => body,
        text: async () => JSON.stringify(body),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

beforeEach(() => {
    // 没有 refresh token ⇒ 不触发 task-427 的预刷新分支，请求直接出门。
    localStorage.clear();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("api.getWorkspaceAgentEffectiveCap（task-469 fail-closed）", () => {
    it("合法视图逐字段投影，URL 按 workspace + principal 寻址", async () => {
        const fetchMock = stubFetch(VIEW);
        const view = await api.getWorkspaceAgentEffectiveCap(WS, PID);
        expect(view).toEqual(VIEW);
        expect(String(fetchMock.mock.calls[0][0])).toContain(
            `/workspaces/${WS}/agents/${PID}/effective-cap`,
        );
    });

    it("resource 缺省的原子不补字段（CP 只在存在时给 resource）", async () => {
        stubFetch({ ...VIEW, effectiveCap: [{ actionClass: "tool_execute" }] });
        const view = await api.getWorkspaceAgentEffectiveCap(WS, PID);
        expect(view.effectiveCap).toEqual([{ actionClass: "tool_execute" }]);
    });

    // 7 个 required 逐条抽掉/改坏都必须抛错 —— **不是返回快照、不是补默认值**。
    it.each([
        ["缺 bound", { ...VIEW, bound: undefined }],
        ["bound 非 boolean", { ...VIEW, bound: "true" }],
        ["缺 principalId", { ...VIEW, principalId: undefined }],
        ["缺 workspaceId", { ...VIEW, workspaceId: undefined }],
        ["缺 effectiveCap", { ...VIEW, effectiveCap: undefined }],
        [
            "binding 是非法枚举（baseline 是 capSource 的另一套词表）",
            { ...VIEW, capSource: { binding: "baseline" } },
        ],
        ["缺 capSource", { ...VIEW, capSource: undefined }],
        ["缺 provenance", { ...VIEW, provenance: undefined }],
        ["缺 bindingGrantIds", { ...VIEW, provenance: { principalGrantIds: [GRANT] } }],
        [
            "grant id 非字符串",
            { ...VIEW, provenance: { principalGrantIds: [1], bindingGrantIds: [] } },
        ],
        ["缺 defaultGrants.readFace", { ...VIEW, defaultGrants: {} }],
        ["原子缺 actionClass", { ...VIEW, effectiveCap: [{ resource: "workspace" }] }],
        ["原子不是对象", { ...VIEW, effectiveCap: ["file_read"] }],
    ])("%s ⇒ 抛错，不静默降级", async (_label, body) => {
        stubFetch(body);
        await expect(api.getWorkspaceAgentEffectiveCap(WS, PID)).rejects.toThrow(/malformed/);
    });
});
