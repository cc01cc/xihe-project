import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";

const CP_URL = `http://127.0.0.1:${process.env.XIHE_CP_PORT || "12631"}`;
const AGENT_URL = `http://127.0.0.1:${process.env.XIHE_AGENT_PORT || "12632"}`;
const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "mock";
const ADMIN_EMAIL = "admin@xihe.local";

interface AgentHealth {
    llmReady?: string;
    llm?: { provider?: string; model?: string; readiness?: string };
}

async function agentHealth(): Promise<AgentHealth | null> {
    try {
        const response = await fetch(`${AGENT_URL}/internal/v1/agent/health`);
        if (!response.ok) return null;
        return (await response.json()) as AgentHealth;
    } catch {
        return null;
    }
}

/**
 * PLAN-0504 T3.3 / V5: the Agent re-polls config every 30s — wait until its
 * process-level snapshot reflects the expected provider/model and readiness.
 */
async function waitForAgentIdentity(
    predicate: (health: AgentHealth) => boolean,
    label: string,
    timeoutMs = 120000,
): Promise<AgentHealth> {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    while (Date.now() < deadline) {
        const health = await agentHealth();
        last = JSON.stringify(health);
        if (health && predicate(health)) return health;
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`agent never reached ${label}; last health: ${last.slice(0, 500)}`);
}

// PLAN-0504 V5/T3.3（真实进程链路）：CP 写 profile → Agent 进程级身份生效；
// 清空 profile → readiness fail-closed（LLM_NOT_CONFIGURED），不再 mock=ready。
// 跑法：node scripts/e2e-host.mjs --llm-mode=success e2e/real/plan-0504-profile-effective.spec.ts
test.describe.serial("@host PLAN-0504 profile reaches the Agent process", () => {
    test.skip(LLM_MODE !== "success", "requires XIHE_E2E_LLM_MODE=success (env fallback keys)");

    test("instance profile flows into the Agent snapshot; clearing fails closed", async ({
        request,
    }) => {
        test.setTimeout(240000);
        const password = process.env.XIHE_E2E_ADMIN_PASSWORD ?? "";
        expect(password, "XIHE_E2E_ADMIN_PASSWORD must be provided by e2e-host").not.toBe("");
        const login = await request.post(`${CP_URL}/api/v1/auth/login`, {
            data: { email: ADMIN_EMAIL, password },
        });
        expect(login.ok(), await login.text()).toBe(true);
        const auth = (await login.json()) as { accessToken: string };
        const headers = { Authorization: `Bearer ${auth.accessToken}` };

        const uniqueModel = `profile-effective-${randomUUID().slice(0, 8)}`;

        try {
            // 1. Write the instance-layer profile; the instance layer accepts it
            //    without a connection check (decision #11) and the Agent picks
            //    up provider/model from the parsed unit.
            const written = await request.put(`${CP_URL}/api/v1/config/instance/llm-provider`, {
                headers,
                data: {
                    profile: JSON.stringify({
                        providerId: "deepseek",
                        connectionKey: "default",
                        model: uniqueModel,
                    }),
                },
            });
            expect(written.status(), await written.text()).toBe(200);

            const applied = await waitForAgentIdentity(
                (health) =>
                    health.llm?.provider === "deepseek" &&
                    health.llm?.model === uniqueModel &&
                    health.llmReady === "ready",
                "deepseek profile identity",
            );
            expect(applied.llm?.readiness).toBe("ready");

            // 2. Clear the profile: the whole unit disappears and readiness fails
            //    closed (decision #10) instead of falling back to mock.
            const cleared = await request.put(`${CP_URL}/api/v1/config/instance/llm-provider`, {
                headers,
                data: { profile: "" },
            });
            expect(cleared.status(), await cleared.text()).toBe(200);

            const notReady = await waitForAgentIdentity(
                (health) =>
                    (health.llm?.provider ?? "") === "" &&
                    health.llmReady === "missing_credentials",
                "fail-closed readiness after clear",
            );
            expect(notReady.llm?.readiness).toBe("missing_credentials");
        } finally {
            // Restore the runner's lane profile so later specs in the batch keep
            // a ready Agent.
            const restored = await request.put(`${CP_URL}/api/v1/config/instance/llm-provider`, {
                headers,
                data: {
                    profile: JSON.stringify({
                        providerId: "openai",
                        connectionKey: "default",
                        model: "fake-openai",
                    }),
                },
            });
            expect(restored.status(), await restored.text()).toBe(200);
            await waitForAgentIdentity(
                (health) => health.llmReady === "ready",
                "restored ready state",
            );
        }
    });
});
