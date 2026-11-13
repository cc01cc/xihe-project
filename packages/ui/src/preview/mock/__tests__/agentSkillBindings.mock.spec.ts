import { beforeEach, describe, expect, it } from "vitest";

/**
 * task-402 / `D-1243 G2`：mock lane 的 agent 主体技能绑定判定。
 *
 * <p>为什么夹具也要单测：mock 绿不等于真链路，但**夹具自己照契约实现**才有资格当 UI 的替身。
 * 这里的判据全部来自真 HTTP 实测（stack-1，2026-11-14 02:35，`.tmp/xh/task-402/probe-report.json`）
 * 与 CP 源码（`AgentPrincipalSkillBindingService`）：不带 workspaceId ⇒ instance 行、
 * body 白名单只收 skillId、实例档绑不到工作区私有定义（404 不泄露存在性）、同 scope 重复 409、
 * 实例档可删任意 scope 行而工作区档只能删本工作区行。</p>
 */
import {
    handleAgentSkillBinding,
    resetAgentSkillBindingFixtures,
} from "../data/agentSkillBindings";

const PRINCIPAL = "a1f0c4d2-7b3e-4c55-8f10-5d2c9b000001";
const COLLECTION = "/agent-principals/" + PRINCIPAL + "/skills";
const INSTANCE_SKILL = "skill-0002-instance-ui-review";
const WORKSPACE_SKILL = "skill-ws01-repo-conventions";
const SEEDED_INSTANCE_BINDING = "b1f0c4d2-7b3e-4c55-8f10-5d2c9b000101";
const SEEDED_WORKSPACE_BINDING = "b1f0c4d2-7b3e-4c55-8f10-5d2c9b000102";

function urlOf(query: string): URL {
    return new URL("http://mock.local/api/v1" + COLLECTION + query);
}

function bodyOf(value: Record<string, unknown>): () => Promise<Record<string, unknown>> {
    return async () => value;
}

const NO_BODY = bodyOf({});

async function call(method: string, path: string, query = "", body: Record<string, unknown> = {}) {
    const result = await handleAgentSkillBinding(method, path, urlOf(query), bodyOf(body));
    if (!result) throw new Error("handler declined path: " + path);
    return result as { status: number; body: Record<string, unknown> };
}

beforeEach(() => {
    resetAgentSkillBindingFixtures();
});

describe("mock agent skill bindings（task-402）", () => {
    it("GET 回该 principal 的全部行，两种 scope 都在（不按 workspaceId 过滤）", async () => {
        const result = await call("GET", COLLECTION);
        expect(result.status).toBe(200);
        const items = result.body.items as Array<Record<string, unknown>>;
        expect(items).toHaveLength(2);
        expect(items.map((item) => item.scopeType).sort()).toEqual(["instance", "workspace"]);
        // 契约 required 字段一个不少（少给会让 UI 的解析路径与真栈分叉）。
        for (const key of [
            "bindingId",
            "principalId",
            "skillId",
            "name",
            "scopeType",
            "tokenEstimate",
            "createdAt",
        ]) {
            expect(items[0]).toHaveProperty(key);
        }
    });

    it("POST 不带 workspaceId ⇒ 201 且 scopeType=instance / scopeId=null（真 HTTP 同口径）", async () => {
        const result = await call("POST", COLLECTION, "", { skillId: INSTANCE_SKILL });
        expect(result.status).toBe(201);
        expect(result.body.scopeType).toBe("instance");
        expect(result.body.scopeId).toBeNull();
        expect(result.body.sourceType).toBe("instance");
        expect(result.body.principalId).toBe(PRINCIPAL);
        expect(result.body.name).toBe("ui-review");
        expect(typeof result.body.createdAt).toBe("string");
    });

    it("POST body 多带一键 ⇒ 400 INVALID_REQUEST（scope 不许客户端 smuggle）", async () => {
        const result = await call("POST", COLLECTION, "", {
            skillId: INSTANCE_SKILL,
            scopeType: "instance",
        });
        expect(result.status).toBe(400);
        expect(result.body.code).toBe("INVALID_REQUEST");
    });

    it("POST 缺 skillId ⇒ 400；未知 skillId ⇒ 404 SKILL_NOT_FOUND", async () => {
        expect((await call("POST", COLLECTION, "", {})).status).toBe(400);
        const missing = await call("POST", COLLECTION, "", { skillId: "skill-nope" });
        expect(missing.status).toBe(404);
        expect(missing.body.code).toBe("SKILL_NOT_FOUND");
    });

    it("实例档绑工作区私有定义 ⇒ 404（固定顺序可见性，不泄露存在性）", async () => {
        const result = await call("POST", COLLECTION, "", { skillId: WORKSPACE_SKILL });
        expect(result.status).toBe(404);
        expect(result.body.code).toBe("SKILL_NOT_FOUND");
    });

    it("同 scope 重复绑 ⇒ 409 SKILL_BINDING_EXISTS", async () => {
        const first = await call("POST", COLLECTION, "", { skillId: INSTANCE_SKILL });
        expect(first.status).toBe(201);
        const again = await call("POST", COLLECTION, "", { skillId: INSTANCE_SKILL });
        expect(again.status).toBe(409);
        expect(again.body.code).toBe("SKILL_BINDING_EXISTS");
    });

    it("带 workspaceId ⇒ workspace 行，且可绑该工作区私有定义", async () => {
        // 种子里这条工作区定义已经绑过（同 scope 重复会 409）⇒ 先解绑再绑，判据才落在 201 上。
        await call(
            "DELETE",
            COLLECTION + "/" + SEEDED_WORKSPACE_BINDING,
            "?workspaceId=workspace-1",
        );
        const result = await call("POST", COLLECTION, "?workspaceId=workspace-1", {
            skillId: WORKSPACE_SKILL,
        });
        expect(result.status).toBe(201);
        expect(result.body.scopeType).toBe("workspace");
        expect(result.body.scopeId).toBe("workspace-1");
        expect(result.body.sourceType).toBe("workspace");
    });

    it("实例档可删**任意** scope 行（含工作区档行）⇒ 204，列表随之少一行", async () => {
        const result = await call("DELETE", COLLECTION + "/" + SEEDED_WORKSPACE_BINDING);
        expect(result.status).toBe(204);
        const listed = await call("GET", COLLECTION);
        expect((listed.body.items as unknown[]).length).toBe(1);
    });

    it("工作区档删不到实例档行 ⇒ 404 SKILL_BINDING_NOT_FOUND", async () => {
        const result = await call(
            "DELETE",
            COLLECTION + "/" + SEEDED_INSTANCE_BINDING,
            "?workspaceId=workspace-1",
        );
        expect(result.status).toBe(404);
        expect(result.body.code).toBe("SKILL_BINDING_NOT_FOUND");
    });

    it("删别人的 binding 或未知 binding ⇒ 404（principal 归属也要核）", async () => {
        const foreign = await handleAgentSkillBinding(
            "DELETE",
            "/agent-principals/another-principal/skills/" + SEEDED_INSTANCE_BINDING,
            urlOf(""),
            NO_BODY,
        );
        expect(foreign!.status).toBe(404);
        const unknown = await call("DELETE", COLLECTION + "/binding-nope");
        expect(unknown.status).toBe(404);
    });

    it("不归本模块的路径回 null（交回 api-server 其余分支）", async () => {
        const result = await handleAgentSkillBinding(
            "GET",
            "/agent-principals",
            urlOf(""),
            NO_BODY,
        );
        expect(result).toBeNull();
    });

    it("reset 把内存集合还原成种子（用例之间不串状态）", async () => {
        await call("DELETE", COLLECTION + "/" + SEEDED_INSTANCE_BINDING);
        expect(((await call("GET", COLLECTION)).body.items as unknown[]).length).toBe(1);
        resetAgentSkillBindingFixtures();
        expect(((await call("GET", COLLECTION)).body.items as unknown[]).length).toBe(2);
    });
});
