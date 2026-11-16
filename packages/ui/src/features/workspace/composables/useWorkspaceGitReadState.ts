import { onScopeDispose, ref, watch, type Ref } from "vue";
import { api } from "../../../composables/api";
import { presentCauseError, type ErrorPresentation } from "../../../lib/errorMessages";
import type { WorkspaceGitStatus } from "../../../types";

/**
 * task-36 / RSI 缺口1：workspace 文件树面板的**只读**仓库状态。
 *
 * <p>这是单一共享 GET 的薄封装：数据来源仍是
 * `GET /api/v1/workspaces/{id}/git-status`（与 C2 MCP `git_status` 同一条
 * CP→Runtime 数据面，spec/protocol/mcp.md §3.5），不新增 API、不复制 git 逻辑、
 * 不开轮询、不建第二套 durable 状态源。`WorkspaceChangesPanel` 的「待提交」
 * tab 继续使用同一个 `api.getWorkspaceGitStatus`，两处消费者同源。</p>
 *
 * <p>generation guard：workspace 切换 / 组件卸载后的迟到响应不得覆盖当前读数
 * （同族先例：`WorkspaceChangesPanel.vue` 的 pendingGeneration）。</p>
 */
export interface WorkspaceGitReadState {
    status: Ref<WorkspaceGitStatus | null>;
    loading: Ref<boolean>;
    error: Ref<ErrorPresentation | null>;
    reload: () => Promise<void>;
}

export function useWorkspaceGitReadState(
    workspaceId: () => string | null | undefined,
    t: (key: string) => string,
): WorkspaceGitReadState {
    const status = ref<WorkspaceGitStatus | null>(null);
    const loading = ref(false);
    const error = ref<ErrorPresentation | null>(null);
    let generation = 0;
    let active = true;
    onScopeDispose(() => {
        active = false;
        generation += 1;
    });

    async function reload() {
        const id = workspaceId();
        if (!id) return;
        const mine = ++generation;
        loading.value = true;
        error.value = null;
        try {
            const next = await api.getWorkspaceGitStatus(id);
            if (!active || mine !== generation || workspaceId() !== id) return;
            status.value = next;
        } catch (cause) {
            if (!active || mine !== generation || workspaceId() !== id) return;
            status.value = null;
            error.value = presentCauseError(t, cause, t("workspace.gitReadfaceLoadFailed"));
        } finally {
            if (active && mine === generation) loading.value = false;
        }
    }

    watch(workspaceId, (id) => {
        status.value = null;
        error.value = null;
        if (id) void reload();
    });

    void reload();
    return { status, loading, error, reload };
}
