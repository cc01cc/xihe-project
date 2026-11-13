import { ref } from "vue";
import { api, ApiError, type ApiOrgUnitNode } from "../../../composables/api";

/**
 * PLAN-0773 M3-1（task-240）：组织单元树的状态机。与渲染（reka-ui Tree）分离 ——
 * 懒加载的判据（卡面 ①）是**请求计数**，只有状态机能被单测直接驱动，DOM 断言证明不了
 * 「首屏只发一个请求」。
 *
 * <p>懒加载语义（openapi.yaml listOrgUnits）：无参 = 可见树顶；`parentId` = 直接子级；
 * `hasChildren` 是「展开是否值得发请求」的唯一依据，UI 不猜。`q` 是**子树内**名搜
 * （服务端忽略 parentId），`search()` 是 UI 侧唯一发 `q` 的地方 —— 不许把 q 发成全局搜索。</p>
 */
export const ORG_TREE_EXPANDED_KEY = "xihe-org-tree-expanded";

/**
 * 已加载单元节点的 id → 名称注册表（模块级单例）。成员行的「所在单元」列从这里解析
 * （contract 的 member 视图只带 orgUnitId 不带单元名）；没加载过的单元**显示 id 本身**，
 * 不编造名字。整体替换 Map 而不是原地 set，保持模板读取的响应性。
 */
export const orgUnitNames = ref<Map<string, string>>(new Map());

/** 404 / 403 / 其它 —— 404 与 403 是两种语义，文案不许混（卡面 ⑤）。 */
export type OrgTreeErrorKind = "not-found" | "forbidden" | "other";

export interface OrgTreeItem {
    key: string;
    label: string;
    unit: ApiOrgUnitNode;
    children: OrgTreeItem[];
    /** 子节点已拉取（hasChildren=false 时恒 true，无需请求）。 */
    childrenLoaded: boolean;
    childrenLoading: boolean;
    childrenError: OrgTreeErrorKind | "";
}

/**
 * 契约（openapi.yaml listOrgUnits/listOrgUnitMembers，顺序承载语义）：
 * `404 ORG_UNIT_NOT_FOUND` = 非成员或单元不存在（**不许说成"没权限"** —— 非成员无权得知
 * 单元是否存在）；`403 FORBIDDEN` = 有成员身份但缺 `READ_ORG_UNIT_MEMBERS` 原子。
 */
export function classifyOrgTreeError(error: unknown): OrgTreeErrorKind {
    if (error instanceof ApiError) {
        if (error.problem.code === "ORG_UNIT_NOT_FOUND" || error.problem.status === 404) {
            return "not-found";
        }
        if (error.problem.code === "FORBIDDEN" || error.problem.status === 403) {
            return "forbidden";
        }
    }
    return "other";
}

function readExpandedIds(): string[] {
    try {
        const raw = localStorage.getItem(ORG_TREE_EXPANDED_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed)
            ? parsed.filter((x): x is string => typeof x === "string")
            : [];
    } catch {
        return [];
    }
}

function writeExpandedIds(ids: readonly string[]): void {
    try {
        localStorage.setItem(ORG_TREE_EXPANDED_KEY, JSON.stringify(ids));
    } catch {
        // 持久化 best-effort：私密窗口/配额满时退化为不记住展开，不影响读面。
    }
}

export function useOrgUnitTree() {
    const roots = ref<OrgTreeItem[]>([]),
        loading = ref(false),
        error = ref<OrgTreeErrorKind | "">(""),
        errorDetail = ref(""),
        /** 搜索命中态：非 null 时渲染这份扁平列表（不再渲染树）。 */
        searchResults = ref<OrgTreeItem[] | null>(null),
        searching = ref(false),
        searchError = ref<OrgTreeErrorKind | "">(""),
        expandedIds = ref<string[]>(readExpandedIds());

    function toItem(unit: ApiOrgUnitNode): OrgTreeItem {
        orgUnitNames.value = new Map(orgUnitNames.value).set(unit.id, unit.name);
        return {
            key: unit.id,
            label: unit.name,
            unit,
            children: [],
            childrenLoaded: !unit.hasChildren,
            childrenLoading: false,
            childrenError: "",
        };
    }

    function findItem(items: readonly OrgTreeItem[], id: string): OrgTreeItem | null {
        for (const item of items) {
            if (item.key === id) return item;
            const hit = findItem(item.children, id);
            if (hit) return hit;
        }
        return null;
    }

    /** 首屏唯一请求：可见树顶（成员 = 自己的单元；实例级读者 = 全部根）。 */
    async function loadRoots(): Promise<void> {
        loading.value = true;
        error.value = "";
        errorDetail.value = "";
        try {
            roots.value = (await api.listOrgUnits()).map(toItem);
        } catch (cause) {
            error.value = classifyOrgTreeError(cause);
            errorDetail.value =
                cause instanceof ApiError ? (cause.problem.detail ?? cause.message) : String(cause);
            roots.value = [];
        } finally {
            loading.value = false;
        }
    }

    /** 懒加载：只有 hasChildren 且未拉取过的节点会发请求（卡面 ① 的语义本体）。 */
    async function ensureChildren(id: string): Promise<void> {
        const item =
            findItem(roots.value, id) ??
            (searchResults.value ? findItem(searchResults.value, id) : null);
        if (!item || item.childrenLoaded || item.childrenLoading) return;
        item.childrenLoading = true;
        item.childrenError = "";
        try {
            const units = await api.listOrgUnits({ parentId: id });
            item.children = units.map(toItem);
            item.childrenLoaded = true;
        } catch (cause) {
            item.childrenError = classifyOrgTreeError(cause);
        } finally {
            item.childrenLoading = false;
        }
    }

    function rememberExpanded(ids: string[]): void {
        expandedIds.value = ids;
        writeExpandedIds(ids);
    }

    /** 子树内名搜。`q` 清空 ⇒ 退出搜索态、回到树（不自动重拉，树状态还在）。 */
    async function search(q: string): Promise<void> {
        const query = q.trim();
        if (!query) {
            searchResults.value = null;
            searchError.value = "";
            return;
        }
        searching.value = true;
        searchError.value = "";
        try {
            searchResults.value = (await api.listOrgUnits({ q: query })).map(toItem);
        } catch (cause) {
            searchResults.value = null;
            searchError.value = classifyOrgTreeError(cause);
        } finally {
            searching.value = false;
        }
    }

    return {
        roots,
        loading,
        error,
        errorDetail,
        searchResults,
        searching,
        searchError,
        expandedIds,
        loadRoots,
        ensureChildren,
        rememberExpanded,
        search,
    };
}
