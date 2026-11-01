/**
 * BL-172：选择面的回归护栏。
 *
 * 旧实现的 `onMounted` 在"tab 上下文已存在"时 `router.replace(...)` 后**直接 return**，
 * 而 `loading` 的唯一复位点在那条路径后面的 `finally` 里 ⇒ 一旦弹回选择面（WorkspaceView 收到
 * 400 WORKSPACE_CONTEXT_CONFLICT / 409 WORKSPACE_CONTEXT_REQUIRED 后按 PLAN-0608 C′ 回选择面），
 * 页面就永久停在"正在加载工作区…"，且没有任何可点击的条目 —— 而 `GET /workspaces` 其实完全正常。
 *
 * 这里把"tab 上下文指向一个打不开的工作区"这个场景固化成用例：最终必须落到列表（或错误），
 * 不能停在 loading。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const replace = vi.fn<(to: unknown) => Promise<void>>();
const push = vi.fn<(to: unknown) => Promise<void>>();
const listWorkspaces = vi.fn<() => Promise<unknown[]>>();

vi.mock<typeof import("vue-router")>("vue-router", () => ({
    useRouter: () => ({ replace, push }),
}));

vi.mock("../../composables/api", async () => {
    const actual =
        await vi.importActual<typeof import("../../composables/api")>("../../composables/api");
    return {
        ...actual,
        api: { listWorkspaces: (...args: unknown[]) => listWorkspaces(...args) },
    };
});

vi.mock<typeof import("../../lib/workspaceContext")>("../../lib/workspaceContext", () => ({
    readTabWorkspaceId: () => "11111111-1111-1111-1111-111111111111",
    writeTabWorkspace: vi.fn<(ws: unknown) => void>(),
    clearTabWorkspace: vi.fn<() => void>(),
}));

vi.mock<typeof import("vue-i18n")>("vue-i18n", () => ({
    useI18n: () => ({ t: (key: string) => key }),
}));

import WorkspacePicker from "../WorkspacePicker.vue";
import { clearTabWorkspace } from "../../lib/workspaceContext";

describe("WorkspacePicker (BL-172)", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        replace.mockReset().mockResolvedValue(undefined);
        push.mockReset().mockResolvedValue(undefined);
        listWorkspaces.mockReset();
        vi.mocked(clearTabWorkspace).mockReset();
    });

    it("clears the stale tab context before redirecting to it", async () => {
        listWorkspaces.mockResolvedValue([]);
        mount(WorkspacePicker);
        await flushPromises();

        expect(clearTabWorkspace).toHaveBeenCalled();
        expect(replace).toHaveBeenCalledWith({
            name: "workspace",
            params: { workspaceId: "11111111-1111-1111-1111-111111111111" },
        });
    });

    it("falls back to the workspace list instead of a permanent loading state", async () => {
        // The redirect target is unusable (bounce), so onMounted must continue and load.
        replace.mockRejectedValueOnce(new Error("bounced"));
        listWorkspaces.mockResolvedValue([
            { id: "22222222-2222-2222-2222-222222222222", name: "Second" },
        ]);

        const wrapper = mount(WorkspacePicker);
        await flushPromises();

        expect(listWorkspaces).toHaveBeenCalled();
        expect(wrapper.get('[data-testid="workspace-picker"]').text()).not.toContain(
            "workspacePicker.loading",
        );
        expect(
            wrapper
                .find('[data-testid="workspace-picker-item-22222222-2222-2222-2222-222222222222"]')
                .exists(),
        ).toBe(true);
    });
});
