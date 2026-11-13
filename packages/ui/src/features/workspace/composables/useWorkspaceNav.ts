import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
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
export function useWorkspaceNav() {
    const route = useRoute();
    const router = useRouter();

    const workspaceId = computed(() => String(route.params.workspaceId ?? ""));

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
     * 根页（工作台本身）只有两段，不出现「工作台 › 工作台」这种同义重复。
     */
    const trail = computed(() => {
        const rootPath = router.resolve({
            name: "workspace",
            params: { workspaceId: workspaceId.value },
        }).href;
        const container = { label: workspaceId.value, path: rootPath, clickable: true };
        const current = active.value;
        return {
            rootPath,
            container,
            page: current,
        };
    });

    return { workspaceId, items, active, trail };
}
