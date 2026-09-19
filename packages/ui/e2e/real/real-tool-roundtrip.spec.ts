import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import {
    CP_URL,
    ensureAgentWorkspaceBinding,
    ensureChatReady,
    evidenceDir,
    registerJourneyUser,
    seedPage,
    sendChat,
} from "./helpers/journey";

// PLAN-0372 (BL-28) decision #B: real-lane workspace tool round-trip over the
// OpenAI-compatible MiMo connection. The runner imports the OpenAI-compatible
// provider config (same MiMo endpoint + the same real key) and hands the Agent
// `XIHE_OPENAI_API_KEY` only when `XIHE_E2E_REAL_ROUTE=openai-compat`; every
// other invocation skips this case, so no other spec is affected.
const REAL_ROUTE = process.env.XIHE_E2E_REAL_ROUTE ?? "native";
const MODEL_ID = process.env.XIHE_E2E_REAL_OPENAI_MODEL ?? "mimo-v2.5";
// The isolated host root is derived from the run id (e2e-host.mjs `hostRoot`);
// XIHE_WORKSPACE_HOST_ROOT is only injected into the runtime process.
const HOST_ROOT =
    process.env.XIHE_WORKSPACE_HOST_ROOT ??
    (process.env.XIHE_E2E_RUN_ID
        ? path.resolve(process.cwd(), "../../.tmp/e2e-host", process.env.XIHE_E2E_RUN_ID)
        : path.resolve(process.cwd(), "../../.xihe-workspaces"));
const EVIDENCE_DIR = evidenceDir("plan-0372-real-compat");

test.describe("@host PLAN-0372 real lane — OpenAI-compatible tool round-trip", () => {
    test.describe.configure({ mode: "serial" });
    test.setTimeout(300000);

    test("B: write_file round-trip over the OpenAI-compatible MiMo connection", async ({
        page,
        request,
    }) => {
        test.skip(
            !process.env.XIHE_E2E_REAL_XIAOMI_KEY,
            "requires a real provider key (XIHE_E2E_REAL_XIAOMI_KEY)",
        );
        test.skip(
            REAL_ROUTE !== "openai-compat",
            "requires XIHE_E2E_REAL_ROUTE=openai-compat (runner imports the OpenAI-compatible provider config)",
        );
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        const ctx = await registerJourneyUser(request, "real-compat");
        const wsId = ctx.workspaceId;
        const headers = ctx.headers;
        // PLAN-0372 (BL-28): per-run workspace binding; the restart contract in
        // this mode carries XIHE_OPENAI_API_KEY (same real key, never printed).
        await ensureAgentWorkspaceBinding(wsId);

        seedPage(page, { authToken: ctx.authToken, workspaceId: wsId, headers });
        await page.goto("/workspace/" + wsId, { waitUntil: "load" });
        await ensureChatReady(page);

        // Pin the canonical pair to the OpenAI-compatible route (in this mode the
        // catalog lists the MiMo models under provider `openai`).
        const trigger = page.getByTestId("model-popover-trigger");
        await expect(trigger).toBeVisible();
        await trigger.click();
        const modelSearch = page.getByTestId("model-popover-search");
        await modelSearch.fill(MODEL_ID);
        await expect(page.getByTestId(`model-item-openai/${MODEL_ID}`)).toBeVisible({
            timeout: 15000,
        });
        await modelSearch.press("Enter");

        // The session exists once the workspace chat is up; assert the pair.
        let sessionId = "";
        await expect
            .poll(
                async () => {
                    const res = await request.get(`${CP_URL}/api/v1/sessions`, { headers });
                    if (!res.ok()) return "";
                    const body = (await res.json()) as { sessions?: Array<{ id?: string }> };
                    sessionId = body.sessions?.[0]?.id ?? "";
                    return sessionId;
                },
                { timeout: 30000 },
            )
            .not.toBe("");
        await expect
            .poll(
                async () => {
                    const res = await request.get(`${CP_URL}/api/v1/sessions/${sessionId}`, {
                        headers,
                    });
                    if (!res.ok()) return "";
                    const body = (await res.json()) as {
                        modelProvider?: string;
                        modelName?: string;
                    };
                    return `${body.modelProvider ?? ""}/${body.modelName ?? ""}`;
                },
                { timeout: 15000 },
            )
            .toBe(`openai/${MODEL_ID}`);

        const fileName = `xh-real-compat-${Date.now().toString(36)}.txt`;
        const content = `openai-compat round trip ${fileName}`;
        const hostFile = path.join(HOST_ROOT, wsId, fileName);
        const modal = page.locator('[data-testid="modal-content"]');

        // The real model may answer with prose instead of calling the tool; one
        // deterministic nudge keeps the case trustworthy without faking the call.
        let landed = false;
        for (let attempt = 1; attempt <= 2 && !landed; attempt += 1) {
            await sendChat(
                page,
                attempt === 1
                    ? `请调用 write_file 工具在当前工作区创建文件 ${fileName}，内容为「${content}」。完成后只回复文件名。`
                    : `必须实际调用 write_file 工具创建文件 ${fileName}（内容「${content}」），不要只描述步骤。`,
            );
            const approved = await modal
                .waitFor({ state: "visible", timeout: 90000 })
                .then(() => true)
                .catch(() => false);
            if (approved) {
                await page.screenshot({
                    path: path.join(EVIDENCE_DIR, `b-approval-attempt${attempt}.png`),
                    fullPage: false,
                });
                await modal.locator('[data-testid="approval-approve"]').click();
                await expect(modal).toBeHidden({ timeout: 20000 });
            }
            try {
                await expect
                    .poll(
                        async () => {
                            try {
                                return readFileSync(hostFile, "utf8");
                            } catch {
                                return "";
                            }
                        },
                        {
                            message: `expected ${hostFile} to contain the requested content`,
                            timeout: approved ? 60000 : 15000,
                        },
                    )
                    .toContain(content);
                landed = true;
            } catch (error) {
                if (attempt === 2) throw error;
                // Wait for the first run to settle before the nudge (CHAT_IN_PROGRESS).
                await expect
                    .poll(
                        async () => {
                            const res = await request.get(`${CP_URL}/api/v1/operations?size=1`, {
                                headers,
                            });
                            const body = (await res.json()) as {
                                operations?: Array<{ status?: string }>;
                            };
                            return body.operations?.[0]?.status ?? "unknown";
                        },
                        { timeout: 120000, intervals: [2_000] },
                    )
                    .toBe("completed");
            }
        }

        // The operation must complete and the ledger must show a completed
        // write_file item — the real tool chain, not just file bytes on disk.
        await expect
            .poll(
                async () => {
                    const res = await request.get(`${CP_URL}/api/v1/operations?size=1`, {
                        headers,
                    });
                    const body = (await res.json()) as { operations?: Array<{ status?: string }> };
                    return body.operations?.[0]?.status ?? "unknown";
                },
                { timeout: 120000, intervals: [2_000] },
            )
            .toBe("completed");
        const opsRes = await request.get(`${CP_URL}/api/v1/operations?size=1`, { headers });
        expect(opsRes.ok(), `operations list ${opsRes.status()}`).toBeTruthy();
        const opId =
            ((await opsRes.json()) as { operations?: Array<{ id?: string }> }).operations?.[0]
                ?.id ?? "";
        expect(opId, "operation id resolvable").not.toBe("");
        const traceRes = await request.get(`${CP_URL}/api/v1/operations/${opId}`, { headers });
        const trace = (await traceRes.json()) as {
            items?: Array<{ toolName?: string; status?: string }>;
        };
        expect(
            (trace.items ?? []).some(
                (item) => item.toolName === "write_file" && item.status === "completed",
            ),
            "write_file must complete through the real tool chain",
        ).toBe(true);
        await page.screenshot({
            path: path.join(EVIDENCE_DIR, "b-roundtrip.png"),
            fullPage: false,
        });
    });
});
