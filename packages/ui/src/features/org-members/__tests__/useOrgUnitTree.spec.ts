import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../composables/api";
import {
    classifyOrgTreeError,
    ORG_TREE_EXPANDED_KEY,
    useOrgUnitTree,
} from "../composables/useOrgUnitTree";

/**
 * PLAN-0773 M3-1/3（task-240）状态机的机器判据。卡面 ① 的语义本体是**请求计数**
 * （不看 DOM）：首屏恰好 1 个 GET /org-units，展开一个 hasChildren 节点才出现第 2 个；
 * hasChildren=false / 重复展开 / 已拉取节点都不许再发请求。
 */

const ROOT = {
    id: "u-root",
    name: "研发部",
    parentId: null,
    depth: 0,
    hasChildren: true,
};
const CHILD = {
    id: "u-child",
    name: "平台组",
    parentId: "u-root",
    depth: 1,
    hasChildren: false,
};

/** 可编排的 fetch 替身：按 URL 分发响应，全部调用都进 calls（判据 ① 的计数器）。 */
let calls: string[] = [];

function mockFetch(handler: (url: URL) => { status: number; body: unknown }) {
    calls = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const raw = typeof input === "string" ? input : input.url;
        const url = new URL(raw, "http://localhost");
        calls.push(url.pathname + url.search);
        const { status, body } = handler(url);
        return Promise.resolve(
            new Response(JSON.stringify(body), {
                status,
                headers: { "content-type": "application/json" },
            }),
        );
    });
}

function orgUnitsHandler(url: URL) {
    if (url.searchParams.get("q") === "平台") {
        return { status: 200, body: { nodes: [CHILD] } };
    }
    if (url.searchParams.get("parentId") === "u-root") {
        return { status: 200, body: { nodes: [CHILD] } };
    }
    if (url.searchParams.get("parentId")) {
        return { status: 200, body: { nodes: [] } };
    }
    return { status: 200, body: { nodes: [ROOT] } };
}

beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
});

describe("useOrgUnitTree：懒加载（卡面 ① = 请求计数，不看 DOM）", () => {
    it("首屏只发 1 个 GET /org-units；展开 hasChildren 节点才有第 2 个", async () => {
        mockFetch(orgUnitsHandler);
        const tree = useOrgUnitTree();

        await tree.loadRoots();
        expect(calls).toEqual(["/api/v1/org-units"]);

        // hasChildren=false 的节点：展开无请求。
        await tree.ensureChildren("u-child");
        expect(calls).toHaveLength(1);

        // hasChildren=true：第一次展开拉子级（第 2 个请求）。
        await tree.ensureChildren("u-root");
        expect(calls).toHaveLength(2);
        expect(calls[1]).toBe("/api/v1/org-units?parentId=u-root");

        // 重复展开 / 已拉取节点：无新请求。
        await tree.ensureChildren("u-root");
        await tree.ensureChildren("u-child");
        expect(calls).toHaveLength(2);
    });

    it("q 是子树内搜索：带 q 的请求不带 parentId（不许发成全局/层级搜索）", async () => {
        mockFetch(orgUnitsHandler);
        const tree = useOrgUnitTree();
        await tree.loadRoots();

        await tree.search("平台");
        expect(calls).toHaveLength(2);
        const searchCall = calls[1];
        expect(searchCall).toContain("q=");
        expect(searchCall).not.toContain("parentId=");
        expect(searchCall).toContain(encodeURIComponent("平台"));

        // 清空搜索：退出搜索态，不再发请求（树状态原样保留）。
        await tree.search("");
        expect(calls).toHaveLength(2);
        expect(tree.searchResults.value).toBeNull();
    });

    it("展开集写进 localStorage（M3-1 记住展开），新实例读回", async () => {
        mockFetch(orgUnitsHandler);
        const first = useOrgUnitTree();
        first.rememberExpanded(["u-root", "u-other"]);
        expect(JSON.parse(localStorage.getItem(ORG_TREE_EXPANDED_KEY) ?? "[]")).toEqual([
            "u-root",
            "u-other",
        ]);

        const second = useOrgUnitTree();
        expect(second.expandedIds.value).toEqual(["u-root", "u-other"]);
    });
});

describe("classifyOrgTreeError：404 与 403 不许混（卡面 ⑤ 的纯函数判据）", () => {
    it("404 ORG_UNIT_NOT_FOUND ⇒ not-found（非成员/不存在，不许说成「没权限」）", () => {
        expect(
            classifyOrgTreeError(
                new ApiError({
                    status: 404,
                    code: "ORG_UNIT_NOT_FOUND",
                    detail: "d",
                    requestId: "r",
                }),
            ),
        ).toBe("not-found");
    });

    it("403 FORBIDDEN ⇒ forbidden（缺 READ_ORG_UNIT_MEMBERS 原子）", () => {
        expect(
            classifyOrgTreeError(
                new ApiError({ status: 403, code: "FORBIDDEN", detail: "d", requestId: "r" }),
            ),
        ).toBe("forbidden");
    });

    it("非 ApiError / 其它状态 ⇒ other（走重试路径）", () => {
        expect(classifyOrgTreeError(new Error("network"))).toBe("other");
        expect(
            classifyOrgTreeError(
                new ApiError({ status: 500, code: "INTERNAL", detail: "d", requestId: "r" }),
            ),
        ).toBe("other");
    });
});
