import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuthStore } from "../../../stores/auth";
import {
    workspacePageOfMeta,
    type WorkspaceNavItem,
    type WorkspacePageMeta,
} from "../../../lib/workspacePages";

/**
 * 工作区二级导航的**派生**（PLAN-0773 `M4-4` / `task-190`）：导航项全部来自路由表
 * （`router.getRoutes()` 里带 `meta.workspacePage` 的记录），本 composable 不持有页面清单。
 *
 * <p><b>地址由谁生成</b>：`router.resolve({ name, params })` —— 这样导航路径与路由表**同源**，
 * 改路由段只改路由表一处；手拼字符串是「清单分叉」的第一步，这里不做。</p>
 *
 * <p><b>激活态判什么</b>：判 `route.name`（不判路径前缀）。判路径前缀会让 `/workspace/:id`
 * 把 `settings` 也点亮成「工作台」（前缀包含），而 name 是路由表自己的稳定标识。</p>
 */
export function useWorkspaceNav(fallbackWorkspaceId?: () => string) {
    const route = useRoute();
    const router = useRouter();
    const auth = useAuthStore();

    /**
     * `task-365` C-1：全局 rail 也要派生工作区面板项，但它渲染在**所有**路由上 ——
     * 在 `/settings` 这类路由里没有 `params.workspaceId`。因此允许调用方给一个回退
     * （rail 传 tab 上下文的 `auth.currentWorkspaceId`）。**路由参数优先**：切工作区的
     * 那一帧里，地址栏才是当前容器，tab 上下文可能还没跟上。
     */
    const workspaceId = computed(
        () => String(route.params.workspaceId ?? "") || (fallbackWorkspaceId?.() ?? ""),
    );

    /**
     * 当前工作区的**人读名**（task-297）：面包屑中间段要用它，不能让用户看 UUID。
     *
     * <p>来源优先级与 `FileTreePanel.vue:53` 一致（`auth.workspace?.name` 优先），
     * 区别只在回退：面板标题回退成常量「工作区」，而面包屑的中间段**本来就紧跟在常量
     * 「工作区」后面**，回退成同一个词会读成「工作区 › 工作区」，所以这里回退成 id
     * （id 不好看但**有信息量**，能区分两个工作区）。</p>
     *
     * <p>判据：`auth.workspace` 是**当前 tab 选中**的工作区，与路由参数可能短暂不一致
     * （切换工作区的那一帧）。因此只有在 id 对得上时才采用它的 name，否则一律用路由参数
     * ——否则会出现「地址栏是 A、面包屑写 B」的错误读数。</p>
     */
    const workspaceName = computed(() => {
        const current = auth.workspace;
        if (current && current.id === workspaceId.value) return current.name || current.id;
        return workspaceId.value;
    });

    /** 路由表里所有工作区二级页，按 `meta.workspacePage.order` 排序。 */
    const pages = computed(() =>
        router
            .getRoutes()
            .filter((record) => workspacePageOfMeta(record.meta) !== undefined)
            .map((record) => {
                const page = workspacePageOfMeta(record.meta) as WorkspacePageMeta;
                return { record, page };
            })
            .sort((a, b) => a.page.order - b.page.order),
    );

    const items = computed<WorkspaceNavItem[]>(() =>
        pages.value.map(({ record, page }) => ({
            id: page.id,
            labelKey: page.labelKey,
            name: String(record.name),
            path: router.resolve({ name: record.name, params: { workspaceId: workspaceId.value } })
                .href,
            icon: page.icon,
        })),
    );

    const active = computed(() => items.value.find((item) => item.name === route.name));

    /**
     * 面包屑三段：`工作区`（根，可点）→ `<工作区名或 id>`（不可点，是当前容器）→ `<页>`（当前页）。
     * 无独立页名的路由（如聊天页）只有两段，不出现「工作台 › 工作台」这种同义重复。
     *
     * <p><b>task-297 修的是「三段只渲染两段」</b>：本函数一直算 `container`，但
     * `WorkspaceSecondaryNav.vue` 的模板只渲染常量「工作区」+ 当前页 ⇒ `container`
     * 是**死字段**，面包屑永远读作「工作区 › 会话」、不含是哪个工作区。
     * 判据：面包屑必须能读出「在哪个工作区的哪一页」，所以 `container` 必须被渲染。</p>
     */
    const trail = computed(() => {
        const rootPath = router.resolve({
            name: "workspace",
            params: { workspaceId: workspaceId.value },
        }).href;
        const container = { label: workspaceName.value, path: rootPath, clickable: true };
        const current = active.value;
        return {
            rootPath,
            container,
            page: current,
        };
    });

    return { workspaceId, workspaceName, items, active, trail };
}
