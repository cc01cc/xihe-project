import { expect, type APIRequestContext } from "@playwright/test";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const FAKE_LLM_PORT = process.env.XIHE_FAKE_LLM_PORT || "12680";
const FAKE_MODEL = "fake-m2d-probe";

/**
 * PLAN-0670 M2d 探针共用夹具：给新用户建 USER 作用域 `openai` 连接（指向 e2e-host 的
 * fake LLM、dummy key）→ verify READY → user 层 llm profile 指向它。
 * 这样 `POST /sessions` 能解析出可用 profile，而 Agent 侧由 e2e-host 的
 * `XIHE_API_BASE`/fake key 落在同一个 fake server 上。
 */
export async function ensureFakeUserProvider(
    request: APIRequestContext,
    auth: { accessToken: string; workspaceId: string },
): Promise<void> {
    const headers = {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
    };
    const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
        headers,
        data: {
            providerId: "openai",
            apiTypeId: "openai-chat-completions",
            apiTypeVersion: 1,
            apiKey: "sk-fake-openai-key",
            connectionKey: FAKE_MODEL,
            label: "PLAN-0670 M2d probe fake LLM",
            scope: "USER",
            modelDiscovery: "manual",
            manualModels: [FAKE_MODEL],
            baseUrl: `http://127.0.0.1:${FAKE_LLM_PORT}/openai/v1`,
        },
    });
    expect(
        created.ok(),
        `provider connection create ${created.status()}: ${await created.text()}`,
    ).toBe(true);
    const connection = (await created.json()) as { id: string };
    const verified = await request.post(
        `${CP_URL}/api/v1/provider-connections/${connection.id}/verify`,
        { headers },
    );
    expect(verified.ok(), `provider connection verify: ${await verified.text()}`).toBe(true);
    const profile = await request.put(`${CP_URL}/api/v1/config/user/llm-provider`, {
        headers,
        data: {
            profile: JSON.stringify({
                providerId: "openai",
                connectionKey: FAKE_MODEL,
                model: FAKE_MODEL,
            }),
        },
    });
    expect(profile.status(), `user llm profile write: ${await profile.text()}`).toBe(200);
}
