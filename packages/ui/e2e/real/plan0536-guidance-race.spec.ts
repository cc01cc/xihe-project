import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
    CP_URL,
    closeApprovalModal,
    registerAndCreateGuidanceSession,
} from "./helpers/guidance-session";
import { actionableErrors, collectPageErrors } from "./helpers/console";

/**
 * PLAN-0536: the one ordering PLAN-0530 V7a could not produce.
 *
 * A real Guidance POST leaves the browser and is held inside CP; the real cancel
 * endpoint then moves the Run to `cancelling`; the barrier releases and the
 * unchanged production validation answers the frozen
 * `409 GUIDANCE_RUN_NOT_ACTIVE`. Nothing here fakes the 409 — only the ordering.
 */
const SERVICE_TOKEN = process.env.XIHE_CP_API_TOKEN ?? "",
    E2E_RUN_ID = process.env.XIHE_E2E_RUN_ID ?? "";

const evidenceDir = path.resolve(process.cwd(), "../../.local/evidence");

async function captureEvidence(page: Page, name: string): Promise<string> {
    await mkdir(evidenceDir, { recursive: true });
    const target = `${evidenceDir}/${name}`;
    await page.screenshot({ scale: "css", path: target, fullPage: true });
    return target;
}

async function control(
    request: APIRequestContext,
    method: "GET" | "POST",
    urlPath: string,
    data?: unknown,
) {
    return request.fetch(`${CP_URL}${urlPath}`, {
        method,
        headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, "Content-Type": "application/json" },
        data: data as never,
    });
}

async function armBarrier(request: APIRequestContext, runId: string, holdMs: number) {
    const response = await control(
        request,
        "POST",
        `/internal/v1/e2e/guidance-barrier/${runId}/arm`,
        {
            e2eRunId: E2E_RUN_ID,
            holdMs,
        },
    );
    expect(response.status(), await response.text()).toBe(200);
}

async function releaseBarrier(request: APIRequestContext, runId: string) {
    const response = await control(
        request,
        "POST",
        `/internal/v1/e2e/guidance-barrier/${runId}/release?e2eRunId=${encodeURIComponent(E2E_RUN_ID)}`,
    );
    // 404 is acceptable teardown noise: a timeout may already have dropped it.
    expect([200, 404]).toContain(response.status());
}

async function waitForReached(request: APIRequestContext, runId: string) {
    await expect
        .poll(
            async () => {
                const response = await control(
                    request,
                    "GET",
                    `/internal/v1/e2e/guidance-barrier/${runId}?e2eRunId=${encodeURIComponent(E2E_RUN_ID)}`,
                );
                if (!response.ok()) return `HTTP ${response.status()}`;
                return ((await response.json()) as { state: string }).state;
            },
            {
                timeout: 30_000,
                intervals: [50, 100, 250, 500],
                message: "Guidance barrier never reached",
            },
        )
        .toBe("reached");
}

test.describe.configure({ mode: "serial", retries: 0 });

test("@host Guidance race: a held POST returns the frozen 409 after a real cancel", async ({
    page,
    request,
}) => {
    // PLAN-0536 / DEV-020 §3.2: the race needs the approval lane so the
    // guidance POST can be held behind the approval modal; a mock-mode batch
    // never renders that modal and would time out. Gate instead of failing.
    test.skip(
        process.env.XIHE_E2E_LLM_MODE !== "approval",
        "requires the approval lane (node scripts/e2e-host.mjs --llm-mode=approval e2e/real/plan0536-guidance-race.spec.ts); current mode=" +
            (process.env.XIHE_E2E_LLM_MODE ?? "unset"),
    );
    test.skip(
        !SERVICE_TOKEN || !E2E_RUN_ID,
        "requires the owned host run (service token + run id)",
    );
    test.setTimeout(180_000);

    const errors = collectPageErrors(page);
    const { authHeaders, runId } = await registerAndCreateGuidanceSession(page, request);

    const panel = page.locator('[data-testid="guidance-panel"]');
    await expect(panel).toBeVisible({ timeout: 10_000 });
    const input = page.locator('[data-testid="guidance-input"]');
    await expect(input).toBeVisible();
    await closeApprovalModal(page);

    await armBarrier(request, runId, 60_000);
    try {
        await input.fill("race guidance: keep the diff minimal");
        const held = page.waitForResponse(
            (response) =>
                response.url().includes(`/api/v1/chat/runs/${runId}/guidance`) &&
                response.request().method() === "POST",
            { timeout: 60_000 },
        );
        await page.locator('[data-testid="guidance-submit"]').click();

        // Ordering proof 1: CP has the POST inside the barrier.
        await waitForReached(request, runId);

        // Ordering proof 2: the real cancel endpoint wins the race.
        const cancel = await request.post(`${CP_URL}/api/v1/chat/runs/${runId}/cancel`, {
            headers: authHeaders,
            data: { reason: "plan0536_guidance_race" },
        });
        expect(cancel.status(), await cancel.text()).toBe(200);

        // Ordering proof 3: release, then the production validation answers.
        await releaseBarrier(request, runId);
        const response = await held;
        expect(response.status(), await response.text()).toBe(409);
        const body = await response.json();
        expect(JSON.stringify(body)).toContain("GUIDANCE_RUN_NOT_ACTIVE");
    } finally {
        await releaseBarrier(request, runId);
    }

    // V4: visible banner, no phantom list item, input no longer offered.
    const banner = page.locator('[data-testid="guidance-banner-error"]');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText("Run 已结束或不再接受指导");
    await expect(page.locator('[data-testid="guidance-list"] li')).toHaveCount(0);
    await expect(input).toBeHidden({ timeout: 20_000 });

    const snapshot = await request.get(`${CP_URL}/api/v1/chat/runs/${runId}/guidance`, {
        headers: authHeaders,
    });
    expect(snapshot.status(), await snapshot.text()).toBe(200);
    const snapshotBody = (await snapshot.json()) as { items: unknown[] };
    expect(snapshotBody.items, "CP must not store the rejected submission").toHaveLength(0);

    const shot = await captureEvidence(page, "guidance-ui-race-409.png");
    expect(shot).toContain("guidance-ui-race-409.png");

    // The deliberate 409 always logs one browser resource error; anything else is real noise.
    const unexpected = actionableErrors(errors).filter(
        (entry) => !/Failed to load resource.*409/.test(entry),
    );
    expect(unexpected, errors.join("\n")).toEqual([]);
});

test("@host Guidance race: an unreleased barrier fails explicitly and leaves no latch", async ({
    page,
    request,
}) => {
    // Same approval-lane gate as the case above.
    test.skip(
        process.env.XIHE_E2E_LLM_MODE !== "approval",
        "requires the approval lane (node scripts/e2e-host.mjs --llm-mode=approval e2e/real/plan0536-guidance-race.spec.ts); current mode=" +
            (process.env.XIHE_E2E_LLM_MODE ?? "unset"),
    );
    test.skip(
        !SERVICE_TOKEN || !E2E_RUN_ID,
        "requires the owned host run (service token + run id)",
    );
    test.setTimeout(180_000);

    const { runId } = await registerAndCreateGuidanceSession(page, request);
    await expect(page.locator('[data-testid="guidance-panel"]')).toBeVisible({ timeout: 10_000 });
    await closeApprovalModal(page);

    // A 1ms hold guarantees the timeout path without waiting on the test clock.
    await armBarrier(request, runId, 1);
    const timedOut = page.waitForResponse(
        (response) =>
            response.url().includes(`/api/v1/chat/runs/${runId}/guidance`) &&
            response.request().method() === "POST",
        { timeout: 60_000 },
    );
    await page.locator('[data-testid="guidance-input"]').fill("never released");
    await page.locator('[data-testid="guidance-submit"]').click();
    const response = await timedOut;
    expect(response.status(), await response.text()).toBe(503);

    // The barrier dropped itself: a second arm succeeds, proving no stale latch.
    await armBarrier(request, runId, 5_000);
    const status = await control(
        request,
        "GET",
        `/internal/v1/e2e/guidance-barrier/${runId}?e2eRunId=${encodeURIComponent(E2E_RUN_ID)}`,
    );
    expect(((await status.json()) as { state: string }).state).toBe("armed");
    await releaseBarrier(request, runId);
});
