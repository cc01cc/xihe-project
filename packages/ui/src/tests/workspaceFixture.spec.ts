/**
 * `makeWorkspace()` 自身的契约守卫（task-172）。
 *
 * 为什么值得一条用例：工厂的价值全在「8 项必填一个都不少」—— 少一项，用它迁移的 spec 就退回
 * 「页面读 `generation` 拿到 `undefined` 也算过」的静默绿。而 `check-fixture-schema.mjs` 只认
 * **字面量**夹具，`makeWorkspace(...)` 是函数调用它看不见（task-172 实测：迁移后该文件从它的清单里
 * 直接消失，不是变绿）⇒ 这里补一条能看见的判据。
 */
import { describe, expect, it } from "vitest";
import { WORKSPACE_REQUIRED_FIELDS, makeWorkspace } from "./workspaceFixture";

describe("makeWorkspace：契约 required 8 项", () => {
    it("默认返回值含全部必填字段（openapi.yaml:6594 的 required）", () => {
        const workspace = makeWorkspace();
        expect(WORKSPACE_REQUIRED_FIELDS).toHaveLength(8);
        for (const field of WORKSPACE_REQUIRED_FIELDS) {
            expect(workspace).toHaveProperty(field);
            expect(workspace[field]).not.toBeUndefined();
        }
    });

    it("不替用例编造 roots（「没有 roots 投影」与「空 roots」必须仍可区分）", () => {
        expect(makeWorkspace()).not.toHaveProperty("roots");
        expect(makeWorkspace({ roots: [] }).roots).toEqual([]);
    });

    it("overrides 覆盖必填项，且契约可选字段原样透传", () => {
        const workspace = makeWorkspace({
            id: "ws-1",
            name: "多根工作区",
            generation: 7,
            hostPath: "H:/mock/alpha",
            workspaceRole: "OWNER",
        });
        expect(workspace.id).toBe("ws-1");
        expect(workspace.name).toBe("多根工作区");
        expect(workspace.generation).toBe(7);
        expect(workspace.hostPath).toBe("H:/mock/alpha");
        expect(workspace.workspaceRole).toBe("OWNER");
        // 未被覆盖的必填项仍由默认值兜住。
        expect(workspace.ownerId).toBe(makeWorkspace().ownerId);
    });
});
