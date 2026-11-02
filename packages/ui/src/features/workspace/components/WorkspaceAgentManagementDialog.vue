<script setup lang="ts">
import { useI18n } from "vue-i18n";
import BaseModal from "../../../components/shared/BaseModal.vue";
import WorkspaceAgentsPanel from "./WorkspaceAgentsPanel.vue";

/**
 * PLAN-0626 M3 (D26-05): mobile-only shell for the workspace Agent management panel.
 *
 * Desktops render the panel in the dock's `agents` tab; a <768 viewport has no dock, so the
 * same body (`WorkspaceAgentsPanel`, the single implementation) is hosted in a modal there.
 * This mirrors M2, where the mobile chat sheet renders the same `SessionContextPanel`.
 *
 * `WorkspaceView` mounts this component only while `isMobileViewport` is true — a desktop
 * page therefore never holds a second copy beside the dock's. That is the rule the
 * 2026-11-02 duplicate-mount incident taught: two elements per testid cause Playwright
 * strict-mode violations and long-lived false passes.
 *
 * There is no desktop entry that opens this dialog any more: `WorkspaceToolbar`'s
 * "Agent management" button now opens the dock tab (`openDockTab("agents")`).
 */
defineProps<{
    open: boolean;
    workspaceId: string;
}>();

const emit = defineEmits<{
    close: [];
}>();

const { t } = useI18n();
</script>

<template>
    <BaseModal :show="open" :title="t('workspace.agentManagement')" @close="emit('close')">
        <!-- The bounded height belongs to the host: the panel body scrolls itself. -->
        <div class="flex max-h-[72vh] flex-col">
            <WorkspaceAgentsPanel :workspace-id="workspaceId" />
        </div>
    </BaseModal>
</template>
