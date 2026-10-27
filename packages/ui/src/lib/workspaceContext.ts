export interface TabWorkspace {
    id: string;
    name?: string;
    workspaceRole?: "OWNER" | "EDITOR" | "VIEWER" | null;
    canWrite?: boolean;
}

const STORAGE_KEY = "xihe-workspace";
const LEGACY_KEY = "xihe-workspace";

function storage(): Storage | null {
    try {
        return typeof sessionStorage === "undefined" ? null : sessionStorage;
    } catch {
        return null;
    }
}

export function readTabWorkspace(): TabWorkspace | null {
    const store = storage();
    if (!store) return null;
    try {
        const raw = store.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<TabWorkspace> | null;
        return parsed?.id ? (parsed as TabWorkspace) : null;
    } catch {
        store.removeItem(STORAGE_KEY);
        return null;
    }
}

export function readTabWorkspaceId(): string | null {
    return readTabWorkspace()?.id ?? null;
}

export function writeTabWorkspace(workspace: TabWorkspace | null): void {
    const store = storage();
    if (!store) return;
    if (workspace?.id) store.setItem(STORAGE_KEY, JSON.stringify(workspace));
    else store.removeItem(STORAGE_KEY);
}

/** Update only the id while preserving a cached display name/role, if any. */
export function writeTabWorkspaceId(id: string): void {
    const current = readTabWorkspace();
    writeTabWorkspace({ ...(current ?? {}), id });
}

export function clearTabWorkspace(): void {
    storage()?.removeItem(STORAGE_KEY);
}

/**
 * PLAN-0559: the old build stored the selected workspace in localStorage, which
 * every tab shares. Seed the per-tab value once, then remove the legacy key so a
 * second tab can never be dragged back to the first tab's workspace.
 */
export function migrateLegacyWorkspace(): void {
    const store = storage();
    if (!store) return;
    try {
        const legacyRaw = localStorage.getItem(LEGACY_KEY);
        if (!legacyRaw) return;
        if (!store.getItem(STORAGE_KEY)) {
            const legacy = JSON.parse(legacyRaw) as Partial<TabWorkspace> | null;
            if (legacy?.id) {
                store.setItem(STORAGE_KEY, JSON.stringify({ id: legacy.id, name: legacy.name }));
            }
        }
        localStorage.removeItem(LEGACY_KEY);
    } catch {
        localStorage.removeItem(LEGACY_KEY);
    }
}
