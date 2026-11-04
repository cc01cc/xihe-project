import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../../../../composables/api";

/**
 * PLAN-0655 T1.2 — delegation permission gate.
 *
 * The read side is REAL and capability-atom based: `GET /me/permissions` returns the caller's
 * effective atoms, and the button is enabled iff `SPAWN_AGENT` is among them for this workspace.
 * No role name appears anywhere in this file (permission red line): `AGENT_DELEGATOR` is only one
 * way a human earns that atom, never the test.
 *
 * Fail closed: an unreadable permission surface greys the button — it can never enable itself.
 * T1.4 wires the write side; the server re-evaluates the same atom, so this state decides only
 * grey vs. clickable, never authorization.
 *
 * @param workspaceId the workspace the composer is speaking in (the atom is workspace-scoped)
 */
export function useDelegationPermission(workspaceId: () => string) {
    const { t } = useI18n();

    const loading = ref(true),
        canDelegate = ref(false),
        /** i18n key explaining the disabled state (tooltip/title). */
        reasonKey = ref("chat.delegation.reasonUnknown");

    async function refresh() {
        const target = workspaceId();
        if (!target) {
            canDelegate.value = false;
            reasonKey.value = "chat.delegation.reasonUnknown";
            loading.value = false;
            return;
        }
        loading.value = true;
        try {
            const self = await api.getSelfPermissions(),
                workspace = self.workspaces?.find((row) => row.workspaceId === target),
                hasAtom = (workspace?.permissions ?? []).some(
                    (permission) => permission.actionClass === "SPAWN_AGENT",
                );
            canDelegate.value = hasAtom;
            reasonKey.value = hasAtom
                ? "chat.delegation.buttonHint"
                : "chat.delegation.reasonNoCapability";
        } catch {
            canDelegate.value = false;
            reasonKey.value = "chat.delegation.reasonUnknown";
        } finally {
            loading.value = false;
        }
    }

    watch(workspaceId, () => void refresh(), { immediate: true });

    // Re-read on window focus: granting SPAWN_AGENT happens in another route/tab (role bindings),
    // and the button must un-grey when the user comes back — not only on a full reload.
    const onFocus = () => void refresh();
    onMounted(() => window.addEventListener("focus", onFocus));
    onBeforeUnmount(() => window.removeEventListener("focus", onFocus));

    /** Resolved tooltip text for the current state. */
    function reason() {
        return t(reasonKey.value);
    }

    return { loading, canDelegate, refresh, reason };
}
