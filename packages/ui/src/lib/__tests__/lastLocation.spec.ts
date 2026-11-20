import { beforeEach, describe, expect, it } from "vitest";
import {
    LAST_LOCATION_KEY,
    LAST_LOCATION_MAX_AGE_MS,
    clearLastLocation,
    forgetLastLocationForWorkspace,
    isColdEntryNavigation,
    isExplicitPickerEntry,
    lastLocationForRoute,
    readLastLocation,
    resolveLastLocationTarget,
    writeLastLocation,
    type LastLocation,
} from "../lastLocation";
import { WORKSPACE_PICKER_PATH, workspacePagePath, WORKSPACE_PAGE_IDS } from "../routes";

const WS = "11111111-1111-4111-8111-111111111111",
    WS_OTHER = "22222222-2222-4222-8222-222222222222",
    SESS = "33333333-3333-4333-8333-333333333333",
    NOW = Date.parse("2026-11-17T08:00:00.000Z");

function seed(raw: unknown): void {
    localStorage.setItem(LAST_LOCATION_KEY, JSON.stringify(raw));
}

/** 会话页条目（page 恒 null）。 */
function sessionEntry(workspaceId: string, sessionId: string | null, at = "") {
    return { kind: "workspace" as const, workspaceId, sessionId, page: null, at };
}

/** 裸工作区条目（必须指名页，task-34）。 */
function pageEntry(page: string, at = "", workspaceId = WS) {
    return { kind: "workspace" as const, workspaceId, sessionId: null, page, at };
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
});

describe("lastLocation 键形与读写（task-111 / 裁② A 案；task-34 加 page）", () => {
    it("写读回环：五字段原样落盘（kind/workspaceId/sessionId/page/at）", () => {
        const written = writeLastLocation({
            kind: "workspace",
            workspaceId: WS,
            sessionId: SESS,
            page: null,
        });
        expect(written).not.toBeNull();
        const raw = localStorage.getItem(LAST_LOCATION_KEY);
        expect(raw).not.toBeNull();
        const parsed = JSON.parse(raw as string) as LastLocation;
        expect(parsed.kind).toBe("workspace");
        expect(parsed.workspaceId).toBe(WS);
        expect(parsed.sessionId).toBe(SESS);
        expect(parsed.page, "会话页的页维度恒 null（位置由 sessionId 表达）").toBeNull();
        expect(Number.isFinite(Date.parse(parsed.at))).toBe(true);
        expect(readLastLocation()).toEqual(parsed);
    });

    it("裸工作区必须带页 id：写读回环保留 page（task-34 页级记录）", () => {
        const written = writeLastLocation({
            kind: "workspace",
            workspaceId: WS,
            sessionId: null,
            page: "scheduled-tasks",
        });
        expect(written?.page).toBe("scheduled-tasks");
        expect(readLastLocation()).toMatchObject({
            kind: "workspace",
            workspaceId: WS,
            sessionId: null,
            page: "scheduled-tasks",
        });
    });

    it("nullable 不编造：standalone 的 workspaceId 归 null 且 page 恒 null", () => {
        writeLastLocation({
            kind: "workspace",
            workspaceId: WS,
            sessionId: null,
            page: "sessions",
        });
        expect(readLastLocation()?.sessionId).toBeNull();
        writeLastLocation({ kind: "standalone", workspaceId: WS, sessionId: SESS, page: null });
        expect(readLastLocation()).toMatchObject({
            kind: "standalone",
            workspaceId: null,
            sessionId: SESS,
            page: null,
        });
    });

    it("fail-closed 不写：workspace 缺 workspaceId / 裸工作区缺页 / standalone 缺 sessionId", () => {
        for (const bad of [
            { kind: "workspace" as const, workspaceId: null, sessionId: SESS, page: null },
            // 裸工作区不指名页 = task-34 之前的旧语义（「停在工作区」），不猜。
            { kind: "workspace" as const, workspaceId: WS, sessionId: null, page: null },
            // 会话页带页维度 = 自相矛盾的数据。
            { kind: "workspace" as const, workspaceId: WS, sessionId: SESS, page: "settings" },
            { kind: "standalone" as const, workspaceId: null, sessionId: null, page: null },
            { kind: "standalone" as const, workspaceId: null, sessionId: SESS, page: "members" },
        ]) {
            expect(writeLastLocation(bad as never), JSON.stringify(bad)).toBeNull();
            expect(localStorage.getItem(LAST_LOCATION_KEY)).toBeNull();
        }
    });

    it("失效判据：at 超龄（21d）读时丢弃并清键；新鲜记录保留", () => {
        seed(pageEntry("sessions", "2026-10-20T08:00:00.000Z"));
        expect(readLastLocation(NOW)).toBeNull();
        expect(localStorage.getItem(LAST_LOCATION_KEY)).toBeNull();
        seed(pageEntry("environment", "2026-11-16T08:00:00.000Z"));
        expect(readLastLocation(NOW)?.workspaceId).toBe(WS);
        // 边界：正好 MAX_AGE 算新鲜（age == TTL 不丢）
        const atBoundary = new Date(NOW - LAST_LOCATION_MAX_AGE_MS).toISOString();
        seed(sessionEntry(WS, SESS, atBoundary));
        expect(readLastLocation(NOW)?.workspaceId).toBe(WS);
    });

    it("fail-closed 读：未知 kind（未来扩展）与坏 JSON 都丢弃并清键", () => {
        seed({
            ...sessionEntry(WS, SESS, new Date(NOW).toISOString()),
            kind: "workspace-timeline",
        });
        expect(readLastLocation(NOW)).toBeNull();
        expect(localStorage.getItem(LAST_LOCATION_KEY)).toBeNull();
        localStorage.setItem(LAST_LOCATION_KEY, "{not json");
        expect(readLastLocation(NOW)).toBeNull();
        expect(localStorage.getItem(LAST_LOCATION_KEY)).toBeNull();
    });

    it("task-34：旧键形（无 page 键）fail-closed 丢弃，不迁移（m01702 ①）", () => {
        // task-34 之前的落盘形状：三个位置字段 + at，没有 page。
        seed({
            kind: "workspace",
            workspaceId: WS,
            sessionId: SESS,
            at: new Date(NOW).toISOString(),
        });
        expect(() => readLastLocation(NOW), "读旧键不得抛").not.toThrow();
        expect(readLastLocation(NOW), "旧键形不得被猜成会话页").toBeNull();
        expect(localStorage.getItem(LAST_LOCATION_KEY), "读到即清，不留半新半旧的值").toBeNull();
        // 裸工作区的旧键形同样丢弃（旧语义只有「工作区」，没有「哪一页」）。
        seed({
            kind: "workspace",
            workspaceId: WS,
            sessionId: null,
            at: new Date(NOW).toISOString(),
        });
        expect(readLastLocation(NOW)).toBeNull();
    });

    it("task-34：未知 page id / page 类型错 一律丢弃并清键", () => {
        for (const page of ["workspace-home", "context", 42, { id: "settings" }]) {
            seed({ ...pageEntry("sessions", new Date(NOW).toISOString()), page });
            expect(readLastLocation(NOW), "page=" + JSON.stringify(page)).toBeNull();
            expect(localStorage.getItem(LAST_LOCATION_KEY)).toBeNull();
        }
    });

    it("task-34（D1476 ①）：6 个内容页 + 会话页逐一写读回环（页维度不丢、不串页）", () => {
        // 每个内容页：写入 ⇒ 读回 ⇒ 解析成地址，三处必须指向同一页。
        for (const page of WORKSPACE_PAGE_IDS) {
            const written = writeLastLocation({
                kind: "workspace",
                workspaceId: WS,
                sessionId: null,
                page,
            });
            expect(written?.page, "page=" + page).toBe(page);
            const restored = readLastLocation();
            expect(restored, "page=" + page + " 必须能读回").toMatchObject({
                kind: "workspace",
                workspaceId: WS,
                sessionId: null,
                page,
            });
            expect(resolveLastLocationTarget(restored!)).toBe(workspacePagePath(WS, page));
        }
        // 会话页：位置由 sessionId 表达，page 恒 null —— 与内容页并存时不许互相污染。
        writeLastLocation({ kind: "workspace", workspaceId: WS, sessionId: SESS, page: null });
        expect(readLastLocation()).toMatchObject({ sessionId: SESS, page: null });
        expect(resolveLastLocationTarget(readLastLocation()!)).toBe(
            `/workspace/${WS}/session/${SESS}`,
        );
    });

    it("clearLastLocation 幂等清除", () => {
        seed(sessionEntry(WS, SESS, new Date(NOW).toISOString()));
        clearLastLocation();
        expect(localStorage.getItem(LAST_LOCATION_KEY)).toBeNull();
        clearLastLocation(); // 再清一次不炸
        expect(localStorage.getItem(LAST_LOCATION_KEY)).toBeNull();
    });
});

describe("resolveLastLocationTarget（守卫恢复的唯一读法）", () => {
    it("会话页 / 独立会话 / 裸工作区 → 对应路径", () => {
        expect(resolveLastLocationTarget(sessionEntry(WS, SESS))).toBe(
            `/workspace/${WS}/session/${SESS}`,
        );
        expect(
            resolveLastLocationTarget({
                kind: "workspace",
                workspaceId: WS,
                sessionId: null,
                page: "sessions",
                at: "",
            }),
        ).toBe(`/workspace/${WS}`);
        expect(
            resolveLastLocationTarget({
                kind: "standalone",
                workspaceId: null,
                sessionId: SESS,
                page: null,
                at: "",
            }),
        ).toBe(`/chat/${SESS}`);
    });

    it("task-34：6 个工作区二级页各自还原成自己的地址（sessions 是裸工作区路径）", () => {
        const expected: Record<string, string> = {
            sessions: `/workspace/${WS}`,
            environment: `/workspace/${WS}/environment`,
            "scheduled-tasks": `/workspace/${WS}/scheduled-tasks`,
            resources: `/workspace/${WS}/resources`,
            members: `/workspace/${WS}/members`,
            settings: `/workspace/${WS}/settings`,
        };
        // 判据与清单同源：页清单只允许这 6 条（多一条就必须在这里与路由表各出现一次）。
        expect(Object.keys(expected).sort()).toEqual([...WORKSPACE_PAGE_IDS].sort());
        for (const [page, path] of Object.entries(expected)) {
            expect(
                resolveLastLocationTarget({
                    kind: "workspace",
                    workspaceId: WS,
                    sessionId: null,
                    page: page as (typeof WORKSPACE_PAGE_IDS)[number],
                    at: "",
                }),
                "page=" + page,
            ).toBe(path);
            expect(workspacePagePath(WS, page as (typeof WORKSPACE_PAGE_IDS)[number])).toBe(path);
        }
    });

    it("fail-closed：非 UUID workspaceId 不恢复（防 invalid-workspace 反弹死循环）", () => {
        expect(resolveLastLocationTarget(sessionEntry("not-a-uuid", SESS))).toBeNull();
        expect(resolveLastLocationTarget(pageEntry("settings", "", ""))).toBeNull();
        expect(
            resolveLastLocationTarget({
                kind: "standalone",
                workspaceId: null,
                sessionId: "not-a-uuid",
                page: null,
                at: "",
            }),
        ).toBeNull();
    });

    it("sessionId 非 UUID 退一格回会话列表页（不编造、不进死路）", () => {
        expect(resolveLastLocationTarget(sessionEntry(WS, "not-a-uuid"))).toBe(`/workspace/${WS}`);
    });

    it("其它 tab 的落点不影响本 tab 判定（WS_OTHER 只是另一个值）", () => {
        expect(resolveLastLocationTarget(pageEntry("members", "", WS_OTHER))).toBe(
            `/workspace/${WS_OTHER}/members`,
        );
    });
});

describe("isExplicitPickerEntry（H4-c 判据：显式进 picker 不是恢复入口）", () => {
    it("redirectedFrom 命中 picker 入口 ⇒ true（含尾斜杠：非 strict 匹配下两条 URL 是同一条路由）", () => {
        for (const origin of [
            WORKSPACE_PICKER_PATH,
            `${WORKSPACE_PICKER_PATH}/`,
            `${WORKSPACE_PICKER_PATH}//`,
        ]) {
            expect(
                isExplicitPickerEntry({ redirectedFrom: { path: origin } }),
                `origin=${origin} 必须判为显式 picker 入口`,
            ).toBe(true);
        }
    });

    it("反向：冷启 / 根路径 / 兜底路由 / 容器深链都不是显式 picker 意图 ⇒ false（恢复侧不许跟着废）", () => {
        // undefined = 直接开 /workbench（冷启）或站内导航：没有 redirect 来源。
        expect(isExplicitPickerEntry({})).toBe(false);
        expect(isExplicitPickerEntry({ redirectedFrom: null })).toBe(false);
        // 根路径与兜底路由的 redirect 来源不是 picker 入口。
        expect(isExplicitPickerEntry({ redirectedFrom: { path: "/" } })).toBe(false);
        expect(isExplicitPickerEntry({ redirectedFrom: { path: "/legacy/deep/link" } })).toBe(
            false,
        );
        // 工作台模块入口本身（namespace 前缀相同但不同路由）与容器深链。
        expect(isExplicitPickerEntry({ redirectedFrom: { path: "/workbench" } })).toBe(false);
        expect(
            isExplicitPickerEntry({
                redirectedFrom: { path: `/workspace/${WS}/session/${SESS}` },
            }),
        ).toBe(false);
        expect(isExplicitPickerEntry({ redirectedFrom: { path: "/workspaces" } })).toBe(false);
    });

    it("空/坏 path fail-closed ⇒ false（不把坏数据判成显式意图）", () => {
        expect(isExplicitPickerEntry({ redirectedFrom: { path: "" } })).toBe(false);
        expect(isExplicitPickerEntry({ redirectedFrom: {} as { path: string } })).toBe(false);
    });
});

describe("isColdEntryNavigation（task-145 ① 判据：只有冷启恢复）", () => {
    it("START_LOCATION（matched 为空）⇒ true；任何站内导航（matched 非空）⇒ false", () => {
        // vue-router 的首次导航 from = START_LOCATION（`matched: []`）。
        expect(isColdEntryNavigation({ matched: [] })).toBe(true);
        expect(isColdEntryNavigation({ matched: [{ path: "/workbench" }] })).toBe(false);
        expect(
            isColdEntryNavigation({
                matched: [{ path: "/workspace/:workspaceId" }, { path: "" }],
            }),
        ).toBe(false);
    });
});

describe("forgetLastLocationForWorkspace（task-145 ②：指向死工作区的上一跳）", () => {
    it("命中 ⇒ 清键并返回 true（下一次读取为空）", () => {
        writeLastLocation({ kind: "workspace", workspaceId: WS, sessionId: SESS, page: null });
        expect(forgetLastLocationForWorkspace(WS)).toBe(true);
        expect(localStorage.getItem(LAST_LOCATION_KEY)).toBeNull();
        expect(readLastLocation()).toBeNull();
    });

    it("命中裸工作区的页级记录同样清（task-34：页级不影响工作区归属判据）", () => {
        writeLastLocation({
            kind: "workspace",
            workspaceId: WS,
            sessionId: null,
            page: "resources",
        });
        expect(forgetLastLocationForWorkspace(WS)).toBe(true);
        expect(readLastLocation()).toBeNull();
    });

    it("未命中/无条目/坏数据一律不动（跨 tab：别把另一个 tab 的健康落点抹掉）", () => {
        // 指向另一个工作区 ⇒ 保留（无条件 clearLastLocation 会误伤）。
        writeLastLocation({
            kind: "workspace",
            workspaceId: WS_OTHER,
            sessionId: SESS,
            page: null,
        });
        const kept = localStorage.getItem(LAST_LOCATION_KEY);
        expect(forgetLastLocationForWorkspace(WS)).toBe(false);
        expect(localStorage.getItem(LAST_LOCATION_KEY)).toBe(kept);
        // standalone 上一跳没有工作区段 ⇒ 与工作区失效无关。
        writeLastLocation({ kind: "standalone", workspaceId: null, sessionId: SESS, page: null });
        expect(forgetLastLocationForWorkspace(WS)).toBe(false);
        expect(readLastLocation()).not.toBeNull();
        // 无条目 / 坏 JSON。
        clearLastLocation();
        expect(forgetLastLocationForWorkspace(WS)).toBe(false);
        localStorage.setItem(LAST_LOCATION_KEY, "{not json");
        expect(forgetLastLocationForWorkspace(WS)).toBe(false);
    });
});

describe("lastLocationForRoute（H2 写点的取值来源）", () => {
    it("会话页 / 会话列表页 / 独立会话映射到条目", () => {
        expect(
            lastLocationForRoute({
                name: "workspace-session",
                params: { workspaceId: WS, sessionId: SESS },
            }),
        ).toEqual({ kind: "workspace", workspaceId: WS, sessionId: SESS, page: null });
        expect(lastLocationForRoute({ name: "workspace", params: { workspaceId: WS } })).toEqual({
            kind: "workspace",
            workspaceId: WS,
            sessionId: null,
            page: "sessions",
        });
        expect(
            lastLocationForRoute({ name: "standalone-chat", params: { sessionId: SESS } }),
        ).toEqual({
            kind: "standalone",
            workspaceId: null,
            sessionId: SESS,
            page: null,
        });
    });

    it("task-34：带 meta.workspacePage 的工作区二级页逐页入账（页 id 从 meta 取，不靠路由名猜）", () => {
        for (const page of WORKSPACE_PAGE_IDS) {
            const entry = lastLocationForRoute({
                name: "workspace-" + page,
                params: { workspaceId: WS },
                meta: { workspacePage: { id: page, labelKey: "workspaceNav.x", order: 1 } },
            });
            expect(entry, "page=" + page).toEqual({
                kind: "workspace",
                workspaceId: WS,
                sessionId: null,
                page,
            });
        }
    });

    it("无 meta 的非裸工作区路由不记（本文件不持有第二份页面清单）", () => {
        expect(
            lastLocationForRoute({ name: "workspace-settings", params: { workspaceId: WS } }),
        ).toBeNull();
    });

    it("picker / 登录 / 设置区 / 无工作区 id 一律不记（null，不覆盖已有上一跳）", () => {
        for (const name of ["workspace-home", "login", "register", "settings-user-domain-config"]) {
            expect(lastLocationForRoute({ name, params: {} }), name).toBeNull();
        }
        // 带 meta 但路由里没有 workspaceId 段（不属于工作区容器）⇒ 不记。
        expect(
            lastLocationForRoute({
                name: "workspace-environment",
                params: {},
                meta: { workspacePage: { id: "environment", labelKey: "x", order: 1 } },
            }),
        ).toBeNull();
        // standalone 无 sessionId：条目形状合法但写方 fail-closed 不落盘。
        expect(lastLocationForRoute({ name: "standalone-chat", params: {} })).toEqual({
            kind: "standalone",
            workspaceId: null,
            sessionId: null,
            page: null,
        });
        expect(
            writeLastLocation({
                kind: "standalone",
                workspaceId: null,
                sessionId: null,
                page: null,
            }),
        ).toBeNull();
    });
});
