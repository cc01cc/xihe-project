import type { DockTabId } from "../../../composables/useWorkspaceLayout";

/** A dock tab as rendered by `WorkspaceDock` (label already localized). */
export interface DockTab {
    /** Tab id; the dock stays string-generic so tests and future panels can inject. */
    id: string;
    label: string;
}

/** i18n key per dock panel; the workbench localizes them before passing down. */
export const DOCK_TAB_LABEL_KEYS: Record<DockTabId, string> = {
    code: "workspace.panelCode",
    changes: "workspace.panelChanges",
    monitor: "workspace.panelMonitor",
};
