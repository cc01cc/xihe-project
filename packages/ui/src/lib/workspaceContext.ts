import { ref } from "vue";

export interface TabWorkspace {
    id: string;
    name?: string;
    workspaceRole?: "OWNER" | "EDITOR" | "VIEWER" | null;
    canWrite?: boolean;
}

const STORAGE_KEY = "xihe-workspace";
const LEGACY_KEY = "xihe-workspace";

/**
 * `task-188` / `D-1565`：**失效信号**（不是值的镜像）。
 *
 * <p>为什么不是镜像：镜像会与 storage 分叉 —— 测试、E2E 播种、以及任何直接写
 * `sessionStorage` 的调用方都绕过本模块，镜像读到的就是旧值。所以这里只保留一个
 * 「变过没有」的计数器：**每次求值仍然读 storage**（真值只有一个），计数器只负责让
 * 依赖它的 `computed`/`watch` 失效。</p>
 *
 * <p>背景：`readTabWorkspaceId()` 读 `sessionStorage`，**不是响应式依赖** ⇒ 直接用它的
 * `computed` 只在其它响应式依赖变化时才重算（`workspace.ts` 里表现为「切到 B 后仍拿 A」：
 * 文件树请求带旧头、切工作区不重载、陈旧丢弃守卫自我比较恒等）。</p>
 */
const tabWorkspaceRevision = ref(0);

/** 供 Vue 侧订阅「逐 tab 上下文变过」；读值仍请用 `readTabWorkspaceId()`。 */
export function tabWorkspaceRevisionRef() {
    return tabWorkspaceRevision;
}

function bumpTabWorkspaceRevision(): void {
    tabWorkspaceRevision.value += 1;
}

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
    if (store) {
        if (workspace?.id) store.setItem(STORAGE_KEY, JSON.stringify(workspace));
        else store.removeItem(STORAGE_KEY);
    }
    bumpTabWorkspaceRevision();
}

/** Update only the id while preserving a cached display name/role, if any. */
export function writeTabWorkspaceId(id: string): void {
    const current = readTabWorkspace();
    writeTabWorkspace({ ...(current ?? {}), id });
}

export function clearTabWorkspace(): void {
    storage()?.removeItem(STORAGE_KEY);
    bumpTabWorkspaceRevision();
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
                bumpTabWorkspaceRevision();
            }
        }
        localStorage.removeItem(LEGACY_KEY);
    } catch {
        localStorage.removeItem(LEGACY_KEY);
    }
}
