import { generateE2EPassword } from "./helpers/password";
import { ACTION_TIMEOUT_MS } from "../timeouts";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
import { test, expect } from "@playwright/test";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

test.describe("Cross-Module — Knowledge Base RAG", () => {
    test("knowledge settings page loads with correct heading", async ({ page }) => {
        const email = `rag-${Date.now()}@test.com`;
        const reg = await fetch(`${CP_URL}/api/v1/auth/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password: SHARED_PASSWORD, name: "RAGTest" }),
        });
        const { accessToken } = await reg.json();

        await page.addInitScript((token) => {
            localStorage.setItem("xihe-token", token);
        }, accessToken);

        // PLAN-0772 M2：`/settings/knowledge` 直接删除（决策 10 不留 redirect）。知识库在 CP 侧是
        // 后端缺口（G3：无库实体），所以资源区的落点是**缺口说明页** —— 本用例改为验证这个落点
        // 真的存在且不再把人送回旧路径。
        await page.goto("/resources/knowledge");
        await expect(page.getByTestId("resources-knowledge-gap")).toBeVisible({
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(page.getByRole("heading", { name: /知识库|Knowledge/i })).toBeVisible({
            timeout: ACTION_TIMEOUT_MS,
        });
        expect(page.url()).toContain("/resources/knowledge");
    });
});
