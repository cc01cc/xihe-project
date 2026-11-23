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
 *
 * <p><b>task-945（收口 task-939 遗留）—— 当前零产品消费者，去留证据在这：</b>
 * 全仓没有任何 `import … useWorkspaceGitReadState`（`rg` 只命中本文件与 6 处注释/文档引用）；
 * `FileTreePanel` 自 task-939 / R76 起被静态门 FT1 **明确禁止**再消费本封装（文件页签只留文件树），
 * 而 `GET /git-status` 的唯一产品消费者是 `WorkspaceChangesPanel` 的「待提交」tab —— 它自己维护了
 * 同族 generation guard（`pendingGeneration`），没有走这里。</p>
 *
 * <p><b>复用场景</b>（唯一已具名的候选）：把 `WorkspaceChangesPanel` 的「待提交」inline 取数
 * 收敛到本封装，去掉同一份 generation guard + 错误呈现的第二实现。它要改
 * `WorkspaceChangesPanel.vue`，不在 task-945 写域 ⇒ 本卡不做。</p>
 *
 * <p><b>为什么不直接删</b>：删除本文件必须同批清理 6 处引用（`e2e/README.md`、
 * `e2e/mock/helpers/auth.ts`、`e2e/mock/helpers/git-readface.ts`、`src/preview/mock/api-server.ts`、
 * `src/preview/mock/data/scheduledTasks.ts`，以及 `src/i18n/index.ts` 里 `gitReadfaceLoadFailed`
 * 的说明）和 `check-filetree-ia.mjs` 的 FT1 反证样例 —— 全部在本卡写域之外。只删文件会留下指向
 * 不存在文件的注释与一条孤立 i18n 键 ⇒ 删除动作留给同时拥有这些文件的卡（已登记为 task-945 回执 blocker）。</p>
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
