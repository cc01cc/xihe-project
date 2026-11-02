import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useChatStore } from "../stores/chat";

export interface SessionBranchOption {
    branchId: string;
    label: string;
}

/**
 * PLAN-0626 M2: the branch projection shared by the chat header and the dock's
 * `context` panel. Both surfaces must read the **same** resolver (N10: one semantic
 * per path) — before this the depth-indented labels lived inside `ChatPanel.vue` and a
 * second copy in the dock panel would have drifted.
 *
 * @param sessionId getter, so the composable follows session switches.
 */
export function useSessionBranches(sessionId: () => string) {
    const chatStore = useChatStore();
    const { t } = useI18n();

    const sessionBranches = computed(() => chatStore.getSessionBranches(sessionId()));
    const selectedBranchId = computed(() => chatStore.getSelectedBranchId(sessionId()) ?? "");
    const branchOptions = computed<SessionBranchOption[]>(() => {
        const byId = new Map(sessionBranches.value.map((branch) => [branch.branchId, branch])),
            depthOf = (branchId: string) => {
                let depth = 0,
                    parentId = byId.get(branchId)?.parentBranchId ?? null;
                while (parentId && byId.has(parentId) && depth < 8) {
                    depth += 1;
                    parentId = byId.get(parentId)?.parentBranchId ?? null;
                }
                return depth;
            };
        return sessionBranches.value.map((branch) => ({
            branchId: branch.branchId,
            label: `${"- ".repeat(depthOf(branch.branchId))}${
                branch.parentBranchId === null
                    ? t("chat.branchMainPath")
                    : `${t("chat.branchPathOption")} ${branch.branchId.slice(0, 8)}`
            }`,
        }));
    });
    const branchLabels = computed(() =>
        Object.fromEntries(
            branchOptions.value.map((branch) => [branch.branchId, branch.label] as const),
        ),
    );
    const mainBranchId = computed(
        () =>
            sessionBranches.value.find((branch) => branch.parentBranchId === null)?.branchId ??
            null,
    );

    /**
     * The two conditions both surfaces agree on. Chat-specific transients (a pending
     * send, a branch being created) stay in the chat surface that owns them.
     */
    const branchSelectionDisabled = computed(
        () =>
            !sessionId() || chatStore.isStreaming(sessionId()) || branchOptions.value.length === 0,
    );

    function selectBranch(branchId: string): void {
        if (!branchId || chatStore.isStreaming(sessionId())) return;
        chatStore.selectBranch(sessionId(), branchId);
    }

    return {
        sessionBranches,
        selectedBranchId,
        branchOptions,
        branchLabels,
        mainBranchId,
        branchSelectionDisabled,
        selectBranch,
    };
}
