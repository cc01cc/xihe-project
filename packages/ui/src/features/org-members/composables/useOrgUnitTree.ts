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

/** 登记一个已知单元名（整体替换 Map 保持模板读取的响应性）。 */
function rememberUnitName(unit: Pick<ApiOrgUnitNode, "id" | "name">): void {
    if (orgUnitNames.value.get(unit.id) === unit.name) return;
    orgUnitNames.value = new Map(orgUnitNames.value).set(unit.id, unit.name);
}

/**
 * 同一父级的子层请求去重（只去**进行中**的重复：完成后即移除，写后重取仍会拿到新数据）。
 * 树面板懒加载与成员表的名字解析可能同时要同一层，没有这张表就会发两份请求。
 */
const inflightChildren = new Map<string, Promise<ApiOrgUnitNode[]>>();

function fetchChildren(parentId: string): Promise<ApiOrgUnitNode[]> {
    const running = inflightChildren.get(parentId);
    if (running) return running;
    const request = api.listOrgUnits({ parentId }).finally(() => {
        if (inflightChildren.get(parentId) === request) inflightChildren.delete(parentId);
    });
    inflightChildren.set(parentId, request);
    return request;
}

/**
 * task-922 A：把成员行引用的单元名补进注册表。
 *
 * <p>读面契约（openapi `OrgUnitMemberView`）只给 `orgUnitId`，不带单元名；而树是**懒加载**的，
 * 未展开的单元从来没进过 `orgUnitNames` ⇒ 「所在单元」列会退回 UUID。这里只在**确有缺失**时，
 * 从当前选中单元起按 `parentId` 一层层补齐（拿到的名字立即登记，找齐即停）；不动树面板状态，
 * 也不做全树预取。失败静默（调用方保留 em dash 兜底，绝不把 UUID 当名字显示）。</p>
 */
export async function resolveOrgUnitNames(
    root: Pick<ApiOrgUnitNode, "id" | "name" | "hasChildren">,
    ids: Iterable<string>,
): Promise<void> {
    rememberUnitName(root);
    const missing = new Set<string>();
    for (const id of ids) {
        if (id && !orgUnitNames.value.has(id)) missing.add(id);
    }
    if (!missing.size) return;

    const queue: ApiOrgUnitNode[] = [];
    const visited = new Set<string>();
    /** 根只有 id/name/hasChildren；children 请求只需要 id。 */
    let cursor: { id: string; hasChildren: boolean } = root;
    while (cursor && missing.size) {
        if (!cursor.hasChildren) break;
        let children: ApiOrgUnitNode[];
        try {
            children = await fetchChildren(cursor.id);
        } catch {
            return;
        }
        for (const child of children) {
            rememberUnitName(child);
            missing.delete(child.id);
            if (child.hasChildren && !visited.has(child.id)) {
                visited.add(child.id);
                queue.push(child);
            }
        }
        const next = queue.shift();
        if (!next) break;
        cursor = next;
    }
}

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
        rememberUnitName(unit);
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
            const units = await fetchChildren(id);
            item.children = units.map(toItem);
            item.childrenLoaded = true;
        } catch (cause) {
            item.childrenError = classifyOrgTreeError(cause);
        } finally {
            item.childrenLoading = false;
        }
    }

    /**
     * 写后重取：把**已加载的子层全部作废**。
     *
     * <p>只调 `loadRoots()` 刷新不到子层 —— `ensureChildren` 对 `childrenLoaded` 的节点
     * 直接 return（懒加载的本意）。而写操作会改 `name` / `depth` / `hasChildren` / 成员归属，
     * 这些都在子层里 ⇒ 必须先作废再按展开态重拉（task-136 J5，禁乐观更新）。</p>
     */
    function invalidateChildren(): void {
        const walk = (items: OrgTreeItem[]): void => {
            for (const item of items) {
                item.childrenLoaded = false;
                item.childrenError = "";
                item.children = [];
                walk(item.children);
            }
        };
        walk(roots.value);
        if (searchResults.value) walk(searchResults.value);
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
        invalidateChildren,
        rememberExpanded,
        search,
    };
}
