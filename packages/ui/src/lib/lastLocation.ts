/**
 * task-111 / D-1754 ①（裁② A 案）：跨 tab 的「上一跳」记录。
 *
 * 与 `workspaceContext.ts`（**逐 tab**，sessionStorage）成对：本模块是**跨 tab**
 * （localStorage）的最后落点记录，唯一用途是「进入 /workbench 时回到上次停下的地方」。
 *
 * <p><b>task-34 / D1472 ② 的分工</b>（用户 m01702：「会记录上一次落在的路由，进入工作台默认
 * 进入之前落的路由上；没有的话则是工作台的空态页面」）：本模块负责**停在哪一页**（页级，
 * 含 6 个工作区二级页与缩放后的 sessionId），`workspaceContext.ts` 负责**本 tab 属于哪个
 * 工作区**。守卫里的合成判据：tab 上下文存在且与上一跳同工作区 ⇒ 按上一跳恢复页级；属于
 * 别的工作区 ⇒ 上下文优先（落本工作区会话页，不把用户拖进别的工作区）。</p>
 *
 * **恢复只有一个入口：冷启**（task-145 ①）。站内到达 `workspace-home` 的任何导航都是
 * 显式意图（删工作区/无权/上下文冲突的回弹也在此列）—— 判据点见
 * `isColdEntryNavigation`。冷启**直接打开 `/workspace`**（旧模块入口 → redirect）不算，
 * 那时用户要的就是选择面（H4-c，`isExplicitPickerEntry`）。
 *
 * 四条不变式（卡面已裁，不许改）：
 *  1. **键形**：`xihe-last-location` = `{ kind, workspaceId, sessionId, page, at }`。
 *     `kind` 是页面种类判别字段 —— 新增可恢复页面种类 = 加一个 kind，不动键形。
 *     `page` 是**工作区二级页 id**（`meta.workspacePage.id`，task-34 / D1472 ②）：裸工作区
 *     必须指名停在哪一页；会话页的位置由 `sessionId` 表达、独立会话没有页维度 ⇒ 两者恒 `null`。
 *     **旧键形（无 `page` 键）按 fail-closed 丢弃，不做迁移** —— 用户 m01702 ① 已裁「不做任何
 *     旧形态兼容」，迁移等于把旧语义猜一遍写回去。
 *  2. **单一写点**：`router/index.ts` 的 `router.afterEach`（H2 —— redirect 目标
 *     不会被写进去）。本模块不提供「路由触发」之外的写入口。
 *  3. **nullable，不编造**：`workspaceId`/`sessionId` 可为 null（裸工作区）；
 *     没有 sessionId 就绝不造一个。
 *  4. **`at` 只用于失效**：超过 `LAST_LOCATION_MAX_AGE_MS` 的记录读时丢弃并清键
 *     （避免「回到三周前的会话」）。
 *
 * 安全边界（H3）：上一跳随账号留在 localStorage，登出换账号后若不清，会把**上一个
 * 账号**的会话恢复回来（跨账号信息泄漏）⇒ 清理点在 `stores/auth.ts` 的
 * `clearAuthState()` **内部**（不是调用侧），与本模块无关的登出路径不需要知道它存在。
 */

import type { RouteLocationNormalized } from "vue-router";
import { isUuid } from "./uuid";
import {
    isWorkspacePageId,
    standaloneChatPath,
    workspacePagePath,
    workspaceSessionPath,
    WORKSPACE_PICKER_PATH,
    type WorkspacePageId,
} from "./routes";
import { workspacePageOfMeta } from "./workspacePages";

export const LAST_LOCATION_KEY = "xihe-last-location";

/**
 * kind 是页面种类注册表：加种类 = 加一行映射（`lastLocationForRoute`）+
 * 一个恢复分支（`resolveLastLocationTarget`），键形不变（裁② ①）。
 * 读方对未知 kind **fail-closed**（不恢复、顺手清键）—— 旧前端读到新前端写的
 * 新种类不会 crash，只是不恢复。
 */
export type LastLocationKind = "workspace" | "standalone";

const KNOWN_KINDS = new Set<LastLocationKind>(["workspace", "standalone"]);

/** 失效判据：超过该年龄的记录不再恢复。`at` 的唯一用途。 */
export const LAST_LOCATION_MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000;

/** 时钟 skew 容忍：`at` 来自「未来」超过 5 分钟视为坏数据（fail-closed）。 */
const LAST_LOCATION_FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface LastLocation {
    kind: LastLocationKind;
    /** null = 独立会话 / 不适用。 */
    workspaceId: string | null;
    /** null = 裸工作区（停在某个工作区页，绝不编造会话）。 */
    sessionId: string | null;
    /**
     * 工作区二级页 id（`meta.workspacePage.id`，task-34 / D1472 ②）。
     * 恒 null 的两种情形：会话页（位置由 `sessionId` 表达）、独立会话（无工作区段）。
     */
    page: WorkspacePageId | null;
    /** ISO 8601 UTC；读方仅用于判失效。 */
    at: string;
}

/** 写入口的入参（`at` 由写方盖时间戳，不接受外部时间）。 */
export interface LastLocationInput {
    kind: LastLocationKind;
    workspaceId: string | null;
    sessionId: string | null;
    page: WorkspacePageId | null;
}

function storage(): Storage | null {
    try {
        return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
        return null;
    }
}

function asNullableString(value: unknown): string | null | undefined {
    if (value === null || value === undefined) return null;
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 校验 `page`（task-34）：返回值 `undefined` = 这条数据不合规，读/写两侧都 fail-closed。
 *
 * <p>三种合规形状，其余一律拒：① 会话页 / 独立会话 ⇒ `page === null`（位置由 sessionId 表达）；
 * ② 裸工作区 ⇒ `page` 是已登记的工作区页 id。**缺 `page` 键 = 旧键形**（task-34 之前的记录只有
 * kind/workspaceId/sessionId）⇒ 拒，且**不迁移**（用户 m01702 ①：不做任何旧形态兼容；迁移等于
 * 把旧语义猜一遍写回去）。</p>
 */
function normalizePage(
    v: Record<string, unknown>,
    kind: LastLocationKind,
    sessionId: string | null,
): WorkspacePageId | null | undefined {
    if (!("page" in v)) return undefined;
    const raw = v.page;
    const isSessionPosition = kind !== "workspace" || sessionId !== null;
    if (raw === null || raw === undefined) {
        // 会话页/独立会话没有页维度；裸工作区必须指名页（否则就是旧形态的「裸工作区」）。
        return isSessionPosition ? null : undefined;
    }
    if (!isWorkspacePageId(raw)) return undefined;
    // 页维度只属于裸工作区：会话页带 page 是自相矛盾的数据。
    return isSessionPosition ? undefined : raw;
}

/**
 * 校验键形（不含 `at` 时效）。不合格返回 `undefined`（无法区分「缺字段」与
 * 「字段类型错」，两种都不写/不恢复）。standalone 的 `workspaceId` 一律归 null。
 */
function normalizeEntry(raw: unknown): LastLocationInput | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const v = raw as Record<string, unknown>;
    if (typeof v.kind !== "string" || !KNOWN_KINDS.has(v.kind as LastLocationKind)) {
        return undefined;
    }
    const kind = v.kind as LastLocationKind;
    const workspaceId = asNullableString(v.workspaceId);
    const sessionId = asNullableString(v.sessionId);
    if (workspaceId === undefined || sessionId === undefined) return undefined;
    const page = normalizePage(v, kind, sessionId);
    if (page === undefined) return undefined;
    if (kind === "standalone") {
        // 独立会话没有工作区段；没有 sessionId 的 standalone 无可恢复目标。
        if (page !== null) return undefined;
        return sessionId
            ? { kind: "standalone", workspaceId: null, sessionId, page: null }
            : undefined;
    }
    // workspace：必须有 workspaceId（裸工作区 = sessionId null，不是 workspaceId null）。
    return workspaceId ? { kind: "workspace", workspaceId, sessionId, page } : undefined;
}

export function readLastLocation(now: number = Date.now()): LastLocation | null {
    const store = storage();
    if (!store) return null;
    let raw: string | null;
    try {
        raw = store.getItem(LAST_LOCATION_KEY);
    } catch {
        return null;
    }
    if (!raw) return null;
    const drop = () => {
        try {
            store.removeItem(LAST_LOCATION_KEY);
        } catch {
            /* storage 不可用 —— 读方尽力而为 */
        }
        return null;
    };
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return drop();
    }
    const entry = normalizeEntry(parsed);
    if (!entry) return drop();
    const atMs = Date.parse((parsed as Record<string, unknown>).at as string);
    if (!Number.isFinite(atMs)) return drop();
    const age = now - atMs;
    if (age > LAST_LOCATION_MAX_AGE_MS || age < -LAST_LOCATION_FUTURE_SKEW_MS) return drop();
    return { ...entry, at: (parsed as Record<string, unknown>).at as string };
}

export function writeLastLocation(input: LastLocationInput): LastLocation | null {
    const store = storage();
    if (!store) return null;
    const entry = normalizeEntry(input);
    if (!entry) return null; // fail-closed：坏数据宁可不写
    const at = new Date().toISOString();
    try {
        store.setItem(LAST_LOCATION_KEY, JSON.stringify({ ...entry, at }));
    } catch {
        return null;
    }
    return { ...entry, at };
}

export function clearLastLocation(): void {
    try {
        storage()?.removeItem(LAST_LOCATION_KEY);
    } catch {
        /* 同 workspaceContext：清理尽力而为 */
    }
}

/**
 * 路由名 → 上一跳条目（H2 写点的取值来源）。
 *
 * <p><b>task-34 / D1472 ②：记到页级。</b>可恢复面 = 会话页 + 独立会话 + **全部带
 * `meta.workspacePage` 的工作区二级页**（sessions / environment / scheduled-tasks /
 * resources / members / settings）。页 id **从 meta 取**（路由表是唯一来源），只有裸工作区那条
 * （`name === "workspace"`）额外保留一个按名字的显式分支 —— 它既是会话列表页、又是
 * 「进工作区」的落地路由，靠名字直读比依赖 meta 更稳（meta 缺失时也照样记得住）。</p>
 *
 * <p>picker（`workspace-home`）/登录/设置区/独立会话之外的一切**不记**：上一跳回答的是
 * 「上次停在哪个工作区的哪一页」，一个非工作区页面不该覆盖这份记忆。</p>
 */
export function lastLocationForRoute(
    to: Pick<RouteLocationNormalized, "name" | "params"> & {
        meta?: RouteLocationNormalized["meta"];
    },
): LastLocationInput | null {
    const workspaceId = typeof to.params.workspaceId === "string" ? to.params.workspaceId : null;
    const sessionId = typeof to.params.sessionId === "string" ? to.params.sessionId : null;
    switch (to.name) {
        case "workspace-session":
            return { kind: "workspace", workspaceId, sessionId, page: null };
        case "workspace":
            // 裸工作区 = 「会话」页（`meta.workspacePage.id === "sessions"`，无独立路径段）。
            return { kind: "workspace", workspaceId, sessionId: null, page: "sessions" };
        case "standalone-chat":
            return { kind: "standalone", workspaceId: null, sessionId, page: null };
        default: {
            // 其余工作区二级页：页 id 一律从路由 meta 取（本文件不持有第二份页面清单）。
            const page = workspacePageOfMeta(to.meta)?.id;
            if (!page || !workspaceId) return null;
            return { kind: "workspace", workspaceId, sessionId: null, page };
        }
    }
}

/**
 * 上一跳 → 恢复路径（beforeEach 的唯一读法）。**fail-closed**：非 UUID 一律不恢复。
 * workspaceId 非 UUID 必须在这里拦死 —— 否则会反弹进守卫的 invalid-workspace 分支
 * （清 tab 上下文回 picker）而上一跳没清 ⇒ 每次冷启无限弹回同一个坏目标。
 * sessionId 非 UUID 退一格回裸工作区（不编造、不进死路）。
 */
export function resolveLastLocationTarget(last: LastLocation | null): string | null {
    if (!last) return null;
    if (last.kind === "standalone") {
        return last.sessionId && isUuid(last.sessionId) ? standaloneChatPath(last.sessionId) : null;
    }
    if (!last.workspaceId || !isUuid(last.workspaceId)) return null;
    if (last.sessionId) {
        return isUuid(last.sessionId)
            ? workspaceSessionPath(last.workspaceId, last.sessionId)
            : workspacePagePath(last.workspaceId, "sessions");
    }
    // 裸工作区：页 id 必填（`normalizeEntry` 已保证）；手搓的坏对象退一格回会话列表页，
    // 不抛也不编造新页（与 sessionId 非 UUID 退一格同一条「不进行死路」原则）。
    return workspacePagePath(last.workspaceId, last.page ?? "sessions");
}

/**
 * **H4-c（Lead 2026-11-17 裁定）：显式导航到 picker 路由不是一个恢复入口。**
 *
 * <p>恢复的用途只有一条：**冷启进 `/workbench` 且本 tab 没有上下文 ⇒ 回到上次停下的地方**。
 * 用户显式去 picker（`/workspace` 这个旧模块入口 → 路由表 redirect → `workspace-home`）时，
 * 他要的就是选择面；这时恢复等于**劫持他的显式意图**（上一跳随手把他拖回某个会话，picker 不出现）。</p>
 *
 * <p><b>与 `isColdEntryNavigation` 的分工（task-145 ①补全全集）</b>：站内到达 `workspace-home`
 * 已经由冷启判据整体挡掉，本函数只剩**冷启那一次**要判 —— 冷启直接打开 `/workspace` 是站外的、
 * 带 `redirectedFrom` 的显式 picker 意图。两者不是替代关系：删了本函数，冷启打开 `/workspace`
 * 就会被恢复劫持（H4-c）；删了冷启判据，删工作区的回弹就会被劫持（task-145 ①）。</p>
 *
 * <p><b>判据怎么来的</b>：vue-router 5 在跑守卫前把「这次导航是从哪来的」挂在目标位置上 ——
 * `pushWithRedirect` 里 `toLocation.redirectedFrom = redirectedFrom`（`[源码]`
 * `node_modules/vue-router/dist/vue-router.js:1309`，重定向链上保留**最初**那个位置）。所以
 * `/workspace` 落地成 `/workbench` 时，守卫看到的 `to.redirectedFrom.path` 就是
 * `WORKSPACE_PICKER_PATH`。</p>
 *
 * <p><b>反例必须留在恢复侧（原语义不许跟着废掉）</b>：`/workbench` 冷启（直接开 URL 或
 * 站内导航，没有 `redirectedFrom`）、`/` 与兜底路由的 redirect（来源不是 picker 入口）
 * 都**不是**显式 picker 意图 ⇒ 照旧恢复。哨兵：
 * `e2e/real/plan-0608-browser.spec.ts` test 3 第二个 tab `goto("/workspace")` 必须出 picker
 * —— **这处旧入口不许跟着「入口改名」一起被替换掉**（`D-1792`：批量替换是「同一个字符串有两个
 * 语义」时最危险的自动化；同文件另有 4 处 `/workspace/<id>` 是容器 URL，也不动）。</p>
 *
 * <p><b>编辑边界（`task-146` 更正）</b>：本文件曾写「该文件只读，不许编辑」—— 那句话的作用是保护
 * 上面这处哨兵不被顺手改掉，不是「哨兵永远不许动」。`task-146` 迁了同文件 `:147`/`:187` 的
 * **落点判据**（`/workspace` → `WORKBENCH_PATH`，因为入口搬走了），test 3 的 `goto` 原样保留。</p>
 */
export function isExplicitPickerEntry(to: { redirectedFrom?: { path: string } | null }): boolean {
    const origin = to.redirectedFrom;
    if (!origin || typeof origin.path !== "string") return false;
    return comparablePath(origin.path) === WORKSPACE_PICKER_PATH;
}

/**
 * **task-145 ①（Lead 2026-11-17 裁定）：上一跳只在「冷启」生效。**
 *
 * <p>判据 = `from.matched.length === 0`：vue-router 的首次导航 `from` 是 `START_LOCATION`
 * （`matched: []`，`[文档/源码] node_modules/vue-router/dist/vue-router.js` 的
 * `START_LOCATION_NORMALIZED`）；此后任何一次导航的 `from` 都有匹配记录。</p>
 *
 * <p><b>为什么不能只认 `/workspace` redirect</b>：那是**一种**显式入口，被当成了全集
 * （D-1785 同族：拿能识别的那一种冒充应有的全集）。站内主动去 `workspace-home` 的真实路径
 * 有三处 —— 删工作区（`WorkspaceSettingsView.vue:322-326`）、工作区不可访问
 * （`:231`）、上下文冲突回弹（`WorkspaceView.vue:368`）—— 它们在回弹前都会清掉 tab 上下文
 * （前两处显式 `clearTabWorkspace()`；`WorkspaceView.vue:310` 那条由 `auth.selectWorkspace`
 * 的 catch 内部清），所以守卫会走到「无 tab 上下文」这一段。旧判据（只认 redirect）对它们全部
 * 失效 ⇒ 上一跳把用户**送回刚被判死的那个工作区**（见 task-145 卡面实测读数）。</p>
 */
export function isColdEntryNavigation(from: { matched: readonly unknown[] }): boolean {
    return from.matched.length === 0;
}

/**
 * **task-145 ②（Lead 2026-11-17 裁定）：指向「已判死工作区」的上一跳要被忘掉。**
 *
 * <p>① 只保证站内回弹不被劫持；键本身还指着那个已删除/无权的工作区 ⇒ **下一次冷启**
 * 仍会被送过去（一次必然失败的请求 + 一次回弹）。所以回弹时顺手清。</p>
 *
 * <p><b>为什么是「条件清」而不是无条件 `clearLastLocation()`</b>：本键是**跨 tab** 的
 * （localStorage）。A tab 从死工作区回弹时，B tab 可能正健康地停在另一个工作区 —— 无条件清会把
 * B tab 的有效记忆一起抹掉。只清 `workspaceId` 命中的条目，语义是「这个落点已失效」，
 * 不是「上一跳整体作废」。</p>
 *
 * @returns 是否真的清掉了（没有条目 / 指向别的工作区 / 坏数据都是 `false`，调用方无需分支）。
 */
export function forgetLastLocationForWorkspace(workspaceId: string): boolean {
    if (!workspaceId) return false;
    const store = storage();
    if (!store) return false;
    let raw: string | null;
    try {
        raw = store.getItem(LAST_LOCATION_KEY);
    } catch {
        return false;
    }
    if (!raw) return false;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return false;
    }
    const entry = normalizeEntry(parsed);
    if (!entry || entry.kind !== "workspace" || entry.workspaceId !== workspaceId) return false;
    try {
        store.removeItem(LAST_LOCATION_KEY);
    } catch {
        return false;
    }
    return true;
}

/**
 * 路径归一，只为比较：vue-router 的 resolved `path` **保留尾斜杠**（非 strict 匹配时
 * `/workspace/` 与 `/workspace` 是同一条路由），不归一就会让「用户手打带斜杠的 URL」
 * 绕过 H4-c 判据 —— 那正是判据最需要生效的场景（书签/手输）。
 */
function comparablePath(path: string): string {
    const trimmed = path.replace(/\/+$/, "");
    return trimmed.length > 0 ? trimmed : "/";
}
