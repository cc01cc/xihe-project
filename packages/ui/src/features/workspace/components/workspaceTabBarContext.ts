import { computed, ref, watch, type ComputedRef } from "vue";

/**
 * task-174（S2b）：页签行的**数据源与渲染位置分离** —— 一份进程内单例总线。
 *
 * 为什么不是 provide/inject：页签行在 `AppLayout` 里，容器在工作台里，两者是**兄弟**
 * （工作台是 `AppLayout` 的 slot 内容），provide 的注入链到不了 ⇒ 实测 `inject` 恒 null
 * （`w16` 读数：`containerRows:1 / containers:["main"] / main.tabs:0`）。
 * 总线是显式的：`WorkspaceTabBar` 注册（**唯一 writer**，路由仍由它 push/replace），
 * 容器页签行只读快照 + 回调。
 *
 * **认领（claim）**：容器行挂载时 claim，计数 > 0 ⇒ `WorkspaceTabBar` 不渲染顶部全局行；
 * 不在工作台里的路由（成员页/设置页等）没有消费方 ⇒ 行为与重构前一致。
 */

export interface WorkspacePageTab {
    id: string;
    label: string;
    closable: boolean;
    testid: string;
}

export interface WorkspaceTabBarRegistration {
    tabs: ComputedRef<WorkspacePageTab[]>;
    activeId: ComputedRef<string | null>;
    select: (tabId: string) => void;
    close: (tabId: string) => void;
}

const tabs = ref<WorkspacePageTab[]>([]);
const activeId = ref<string | null>(null);
const claims = ref(0);
let registration: WorkspaceTabBarRegistration | null = null;

/** `WorkspaceTabBar` 在 setup 里注册（唯一 writer）；返回注销函数。 */
export function registerWorkspaceTabBar(next: WorkspaceTabBarRegistration): () => void {
    registration = next;
    const stopTabs = watch(next.tabs, (value) => (tabs.value = value), { immediate: true });
    const stopActive = watch(next.activeId, (value) => (activeId.value = value), {
        immediate: true,
    });
    return () => {
        stopTabs();
        stopActive();
        if (registration === next) registration = null;
    };
}

/** 容器行读这份快照（只读 + 认领计数）。 */
export function workspaceTabBarState() {
    return {
        tabs: computed(() => tabs.value),
        activeId: computed(() => activeId.value),
        claims,
        claim: () => {
            claims.value += 1;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                claims.value = Math.max(0, claims.value - 1);
            };
        },
    };
}

export function selectWorkspaceTab(tabId: string): void {
    registration?.select(tabId);
}

export function closeWorkspaceTab(tabId: string): void {
    registration?.close(tabId);
}
