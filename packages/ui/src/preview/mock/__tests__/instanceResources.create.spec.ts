import { beforeEach, describe, expect, it } from "vitest";

/**
 * task-430：实例智能体**创建面**的 mock 判定必须照契约，不能比契约宽。
 *
 * <p>为什么补这份：真 HTTP 探针（stack-1，2026-11-14 02:35）照出 UI 发 `description` ⇒ CP 400
 * `INVALID_REQUEST`（detail 原文「Body must contain name plus optional templateId,
 * defaultModelProvider, defaultModelName, allowedModels, hooks and roleIds only」），而夹具此前
 * 照单全收 ⇒ **mock 绿掩盖真栈 400**。名字格式同理（带连字符 ⇒ 400 `INVALID_NAME_FORMAT`）。
 * 这里把两条判定钉在夹具上，让 mock 车道再也不能替 UI 圆这个谎。</p>
 */
import { handleInstanceResource, resetInstanceResourceFixtures } from "../data/instanceResources";

const PATH = "/instance/agent-principals";

function bodyOf(value: Record<string, unknown>): () => Promise<Record<string, unknown>> {
    return async () => value;
}

async function create(body: Record<string, unknown>) {
    const result = await handleInstanceResource("POST", PATH, bodyOf(body));
    if (!result) throw new Error("handler declined " + PATH);
    return result as { status: number; body: Record<string, unknown> };
}

beforeEach(() => {
    resetInstanceResourceFixtures();
});

describe("mock 实例智能体创建面契约（task-430）", () => {
    it("合法创建 ⇒ 201；description 恒 null（契约不收），模型三键按 body 承载", async () => {
        const result = await create({
            name: "评审助手",
            defaultModelProvider: "anthropic",
            defaultModelName: "claude-sonnet-4-5",
            allowedModels: [{ provider: "anthropic", model: "claude-sonnet-4-5" }],
        });
        expect(result.status).toBe(201);
        expect(result.body.name).toBe("评审助手");
        // task-430 A：读面也没有 description（契约 AgentPrincipalView 无此字段）⇒ 键根本不该出现。
        expect(result.body).not.toHaveProperty("description");
        expect(result.body.defaultModelProvider).toBe("anthropic");
        expect(result.body.allowedModels).toEqual([
            { provider: "anthropic", model: "claude-sonnet-4-5" },
        ]);
    });

    it("多带 description ⇒ 400 INVALID_REQUEST（与真 CP 同口径，不再照单全收）", async () => {
        const result = await create({ name: "评审助手", description: "一段说明" });
        expect(result.status).toBe(400);
        expect(result.body.code).toBe("INVALID_REQUEST");
    });

    it("多带任意未知键 ⇒ 400（白名单是闭合的，不是「认识的就收」）", async () => {
        const result = await create({ name: "评审助手", scopeType: "instance" });
        expect(result.status).toBe(400);
        expect(result.body.code).toBe("INVALID_REQUEST");
    });

    it("名字格式照契约：连字符 / 空格 / 数字开头 ⇒ 400 INVALID_NAME_FORMAT", async () => {
        for (const bad of ["task-402-probe", "评审 助手", "1号助手", "a_b"]) {
            const result = await create({ name: bad });
            expect(result.status, bad).toBe(400);
            expect(result.body.code, bad).toBe("INVALID_NAME_FORMAT");
        }
    });

    it("汉字与字母数字名字合法；空名字仍走必填码（两条判据不互相冒充）", async () => {
        expect((await create({ name: "评审助手2" })).status).toBe(201);
        expect((await create({ name: "Reviewer" })).status).toBe(201);
        const empty = await create({ name: "   " });
        expect(empty.status).toBe(400);
        expect(empty.body.code).toBe("NAME_REQUIRED");
    });
});
