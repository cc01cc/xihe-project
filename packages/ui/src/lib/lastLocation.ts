/**
 * task-111 / D-1754 ①（裁② A 案）：跨 tab 的「上一跳」记录。
 *
 * 与 `workspaceContext.ts`（**逐 tab**，sessionStorage）成对：本模块是**跨 tab**
 * （localStorage）的最后落点记录，唯一用途是「冷启进入 /workbench 且本 tab 没有
 * 上下文时，回到上次停下的地方」。
 *
 * 四条不变式（卡面已裁，不许改）：
 *  1. **键形**：`xihe-last-location` = `{ kind, workspaceId, sessionId, at }`。
 *     `kind` 是页面种类判别字段 —— 新增可恢复页面种类 = 加一个 kind，不动键形。
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
    standaloneChatPath,
    workspaceChatPath,
    workspacePath,
    WORKSPACE_PICKER_PATH,
} from "./routes";

export const LAST_LOCATION_KEY = "xihe-last-location";

/**
 * kind 是页面种类注册表：加种类 = 加一行映射（`lastLocationForRoute`）+
 * 一个恢复分支（`resolveLastLocationTarget`），键形不变（裁② ①）。
 * 读方对未知 kind **fail-closed**（不恢复、顺手清键）—— 旧前端读到新前端写的
 * 新种类不会 crash，只是不恢复。
 */
export type LastLocationKind = "workspace" | "standalone";

const KNOWN_KINDS: readonly LastLocationKind[] = ["workspace", "standalone"];

/** 失效判据：超过该年龄的记录不再恢复。`at` 的唯一用途。 */
export const LAST_LOCATION_MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000;

/** 时钟 skew 容忍：`at` 来自「未来」超过 5 分钟视为坏数据（fail-closed）。 */
const LAST_LOCATION_FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface LastLocation {
    kind: LastLocationKind;
    /** null = 独立会话 / 不适用。 */
    workspaceId: string | null;
    /** null = 裸工作区（停在 `/workspace/<id>`，绝不编造会话）。 */
    sessionId: string | null;
    /** ISO 8601 UTC；读方仅用于判失效。 */
    at: string;
}

/** 写入口的入参（`at` 由写方盖时间戳，不接受外部时间）。 */
export interface LastLocationInput {
    kind: LastLocationKind;
    workspaceId: string | null;
    sessionId: string | null;
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
 * 校验键形（不含 `at` 时效）。不合格返回 `undefined`（无法区分「缺字段」与
 * 「字段类型错」，两种都不写/不恢复）。standalone 的 `workspaceId` 一律归 null。
 */
function normalizeEntry(raw: unknown): LastLocationInput | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const v = raw as Record<string, unknown>;
    if (typeof v.kind !== "string" || !KNOWN_KINDS.includes(v.kind as LastLocationKind)) {
        return undefined;
    }
    const workspaceId = asNullableString(v.workspaceId);
    const sessionId = asNullableString(v.sessionId);
    if (workspaceId === undefined || sessionId === undefined) return undefined;
    if (v.kind === "standalone") {
        // 独立会话没有工作区段；没有 sessionId 的 standalone 无可恢复目标。
        return sessionId ? { kind: "standalone", workspaceId: null, sessionId } : undefined;
    }
    // workspace：必须有 workspaceId（裸工作区 = sessionId null，不是 workspaceId null）。
    return workspaceId ? { kind: "workspace", workspaceId, sessionId } : undefined;
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
 * 路由名 → 上一跳条目（H2 写点的取值来源）。只登记**可恢复**的三种页面；
 * picker（workspace-home）/设置/登录等一律不记 —— 上一跳回答的是「上次停在哪个
 * 会话/工作区」，一个非会话页面不该覆盖这份记忆。
 */
export function lastLocationForRoute(
    to: Pick<RouteLocationNormalized, "name" | "params">,
): LastLocationInput | null {
    const workspaceId = typeof to.params.workspaceId === "string" ? to.params.workspaceId : null;
    const sessionId = typeof to.params.sessionId === "string" ? to.params.sessionId : null;
    switch (to.name) {
        case "workspace-chat":
            return { kind: "workspace", workspaceId, sessionId };
        case "workspace":
            return { kind: "workspace", workspaceId, sessionId: null };
        case "standalone-chat":
            return { kind: "standalone", workspaceId: null, sessionId };
        default:
            return null;
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
            ? workspaceChatPath(last.workspaceId, last.sessionId)
            : workspacePath(last.workspaceId);
    }
    return workspacePath(last.workspaceId);
}

/**
 * **H4-c（Lead 2026-11-17 裁定）：显式导航到 picker 路由不是一个恢复入口。**
 *
 * <p>恢复的用途只有一条：**冷启进 `/workbench` 且本 tab 没有上下文 ⇒ 回到上次停下的地方**。
 * 用户显式去 picker（`/workspace` 这个旧模块入口 → 路由表 redirect → `workspace-home`）时，
 * 他要的就是选择面；这时恢复等于**劫持他的显式意图**（上一跳随手把他拖回某个会话，picker 不出现）。</p>
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
 * （该文件只读，**不许编辑**）。</p>
 */
export function isExplicitPickerEntry(to: { redirectedFrom?: { path: string } | null }): boolean {
    const origin = to.redirectedFrom;
    if (!origin || typeof origin.path !== "string") return false;
    return comparablePath(origin.path) === WORKSPACE_PICKER_PATH;
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
