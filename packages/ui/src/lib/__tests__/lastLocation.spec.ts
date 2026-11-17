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
import { WORKSPACE_PICKER_PATH } from "../routes";

const WS = "11111111-1111-4111-8111-111111111111",
    WS_OTHER = "22222222-2222-4222-8222-222222222222",
    SESS = "33333333-3333-4333-8333-333333333333",
    NOW = Date.parse("2026-11-17T08:00:00.000Z");

function seed(raw: unknown): void {
    localStorage.setItem(LAST_LOCATION_KEY, JSON.stringify(raw));
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
});

describe("lastLocation 键形与读写（task-111 / 裁② A 案）", () => {
    it("写读回环：四字段原样落盘（kind/workspaceId/sessionId/at）", () => {
        const written = writeLastLocation({ kind: "workspace", workspaceId: WS, sessionId: SESS });
        expect(written).not.toBeNull();
        const raw = localStorage.getItem(LAST_LOCATION_KEY);
        expect(raw).not.toBeNull();
        const parsed = JSON.parse(raw as string) as LastLocation;
        expect(parsed.kind).toBe("workspace");
        expect(parsed.workspaceId).toBe(WS);
        expect(parsed.sessionId).toBe(SESS);
        expect(Number.isFinite(Date.parse(parsed.at))).toBe(true);
        expect(readLastLocation()).toEqual(parsed);
    });

    it("nullable 不编造：裸工作区 sessionId = null；standalone 的 workspaceId 归 null", () => {
        writeLastLocation({ kind: "workspace", workspaceId: WS, sessionId: null });
        expect(readLastLocation()?.sessionId).toBeNull();
        writeLastLocation({ kind: "standalone", workspaceId: WS, sessionId: SESS });
        expect(readLastLocation()).toMatchObject({
            kind: "standalone",
            workspaceId: null,
            sessionId: SESS,
        });
    });

    it("fail-closed 不写：workspace 缺 workspaceId / standalone 缺 sessionId", () => {
        expect(
            writeLastLocation({ kind: "workspace", workspaceId: null, sessionId: SESS }),
        ).toBeNull();
        expect(localStorage.getItem(LAST_LOCATION_KEY)).toBeNull();
        expect(
            writeLastLocation({ kind: "standalone", workspaceId: null, sessionId: null }),
        ).toBeNull();
        expect(localStorage.getItem(LAST_LOCATION_KEY)).toBeNull();
    });

    it("失效判据：at 超龄（21d）读时丢弃并清键；新鲜记录保留", () => {
        seed({
            kind: "workspace",
            workspaceId: WS,
            sessionId: SESS,
            at: "2026-10-20T08:00:00.000Z",
        });
        expect(readLastLocation(NOW)).toBeNull();
        expect(localStorage.getItem(LAST_LOCATION_KEY)).toBeNull();
        seed({
            kind: "workspace",
            workspaceId: WS,
            sessionId: SESS,
            at: "2026-11-16T08:00:00.000Z",
        });
        expect(readLastLocation(NOW)?.workspaceId).toBe(WS);
        // 边界：正好 MAX_AGE 算新鲜（age == TTL 不丢）
        const atBoundary = new Date(NOW - LAST_LOCATION_MAX_AGE_MS).toISOString();
        seed({ kind: "workspace", workspaceId: WS, sessionId: SESS, at: atBoundary });
        expect(readLastLocation(NOW)?.workspaceId).toBe(WS);
    });

    it("fail-closed 读：未知 kind（未来扩展）与坏 JSON 都丢弃并清键", () => {
        seed({
            kind: "workspace-timeline",
            workspaceId: WS,
            sessionId: SESS,
            at: new Date(NOW).toISOString(),
        });
        expect(readLastLocation(NOW)).toBeNull();
        expect(localStorage.getItem(LAST_LOCATION_KEY)).toBeNull();
        localStorage.setItem(LAST_LOCATION_KEY, "{not json");
        expect(readLastLocation(NOW)).toBeNull();
        expect(localStorage.getItem(LAST_LOCATION_KEY)).toBeNull();
    });

    it("clearLastLocation 幂等清除", () => {
        seed({
            kind: "workspace",
            workspaceId: WS,
            sessionId: SESS,
            at: new Date(NOW).toISOString(),
        });
        clearLastLocation();
        expect(localStorage.getItem(LAST_LOCATION_KEY)).toBeNull();
        clearLastLocation(); // 再清一次不炸
        expect(localStorage.getItem(LAST_LOCATION_KEY)).toBeNull();
    });
});

describe("resolveLastLocationTarget（守卫恢复的唯一读法）", () => {
    it("三种形状 → 对应路径", () => {
        expect(
            resolveLastLocationTarget({
                kind: "workspace",
                workspaceId: WS,
                sessionId: SESS,
                at: "",
            }),
        ).toBe(`/workspace/${WS}/chat/${SESS}`);
        expect(
            resolveLastLocationTarget({
                kind: "workspace",
                workspaceId: WS,
                sessionId: null,
                at: "",
            }),
        ).toBe(`/workspace/${WS}`);
        expect(
            resolveLastLocationTarget({
                kind: "standalone",
                workspaceId: null,
                sessionId: SESS,
                at: "",
            }),
        ).toBe(`/chat/${SESS}`);
    });

    it("fail-closed：非 UUID workspaceId 不恢复（防 invalid-workspace 反弹死循环）", () => {
        expect(
            resolveLastLocationTarget({
                kind: "workspace",
                workspaceId: "not-a-uuid",
                sessionId: SESS,
                at: "",
            }),
        ).toBeNull();
        expect(
            resolveLastLocationTarget({
                kind: "workspace",
                workspaceId: "",
                sessionId: SESS,
                at: "",
            }),
        ).toBeNull();
        expect(
            resolveLastLocationTarget({
                kind: "standalone",
                workspaceId: null,
                sessionId: "not-a-uuid",
                at: "",
            }),
        ).toBeNull();
    });

    it("sessionId 非 UUID 退一格回裸工作区（不编造、不进死路）", () => {
        expect(
            resolveLastLocationTarget({
                kind: "workspace",
                workspaceId: WS,
                sessionId: "not-a-uuid",
                at: "",
            }),
        ).toBe(`/workspace/${WS}`);
    });

    it("其它 tab 的落点不影响本 tab 判定（WS_OTHER 只是另一个值）", () => {
        expect(
            resolveLastLocationTarget({
                kind: "workspace",
                workspaceId: WS_OTHER,
                sessionId: null,
                at: "",
            }),
        ).toBe(`/workspace/${WS_OTHER}`);
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
                redirectedFrom: { path: `/workspace/${WS}/chat/${SESS}` },
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
        writeLastLocation({ kind: "workspace", workspaceId: WS, sessionId: SESS });
        expect(forgetLastLocationForWorkspace(WS)).toBe(true);
        expect(localStorage.getItem(LAST_LOCATION_KEY)).toBeNull();
        expect(readLastLocation()).toBeNull();
    });

    it("未命中/无条目/坏数据一律不动（跨 tab：别把另一个 tab 的健康落点抹掉）", () => {
        // 指向另一个工作区 ⇒ 保留（无条件 clearLastLocation 会误伤）。
        writeLastLocation({ kind: "workspace", workspaceId: WS_OTHER, sessionId: SESS });
        const kept = localStorage.getItem(LAST_LOCATION_KEY);
        expect(forgetLastLocationForWorkspace(WS)).toBe(false);
        expect(localStorage.getItem(LAST_LOCATION_KEY)).toBe(kept);
        // standalone 上一跳没有工作区段 ⇒ 与工作区失效无关。
        writeLastLocation({ kind: "standalone", workspaceId: null, sessionId: SESS });
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
    it("三种可恢复页面映射到条目", () => {
        expect(
            lastLocationForRoute({
                name: "workspace-chat",
                params: { workspaceId: WS, sessionId: SESS },
            }),
        ).toEqual({ kind: "workspace", workspaceId: WS, sessionId: SESS });
        expect(lastLocationForRoute({ name: "workspace", params: { workspaceId: WS } })).toEqual({
            kind: "workspace",
            workspaceId: WS,
            sessionId: null,
        });
        expect(
            lastLocationForRoute({ name: "standalone-chat", params: { sessionId: SESS } }),
        ).toEqual({
            kind: "standalone",
            workspaceId: null,
            sessionId: SESS,
        });
    });

    it("picker / 登录 / 设置等不可恢复页面不记（null，不覆盖已有上一跳）", () => {
        for (const name of [
            "workspace-home",
            "login",
            "register",
            "workspace-settings",
            "standalone-chat",
        ]) {
            const params = name === "standalone-chat" ? {} : { workspaceId: WS };
            const entry = lastLocationForRoute({ name, params });
            if (name === "standalone-chat") {
                expect(entry).toEqual({ kind: "standalone", workspaceId: null, sessionId: null });
                // 无 sessionId 的 standalone 无可恢复目标 ⇒ 写方 fail-closed 不落盘
                expect(
                    writeLastLocation({ kind: "standalone", workspaceId: null, sessionId: null }),
                ).toBeNull();
            } else {
                expect(entry).toBeNull();
            }
        }
    });
});
