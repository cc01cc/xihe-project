/**
 * PLAN-0688 T2.2: Host-lane evidence for the dedicated command / patch / read
 * tool cards plus the generic fallback.
 *
 * The card projection is proven through the real UI -> CP -> Postgres read path:
 * the fixture writes a bounded `messages.tool_calls` snapshot (`{calls:[...]}`,
 * the same envelope `MessageReadService.putToolCalls` projects), then the SPA
 * renders it after a normal page load. No UI-only mock is involved.
 *
 * Why direct DB seeding instead of a fake-LLM run: the fake chain `wf1-coding`
 * only emits read/write/exec/text and has no `apply_patch` mode, so a host-only
 * command run cannot produce a patch card. The visual contract under test is
 * the projection, not the agent executor; the live-agent read/refresh path is
 * already covered by `plan0572-toolcalls-refresh.spec.ts`.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { captureEvidence } from "../helpers/evidence";
import {
    CP_URL,
    ensureChatReady,
    getRootBranchId,
    registerJourneyUser,
    seedPage,
} from "./helpers/journey";
import { seedUserGrant } from "./helpers/user-grants";

const MODEL_ID = process.env.XIHE_E2E_FAKE_MODEL ?? "fake-openai";

const ATTENTION_FILE_NAME = "t2.2-attention-budget.json";
const EVIDENCE_DIR =
    process.env.XIHE_EVIDENCE_DIR ?? path.resolve(process.cwd(), "../../.local/evidence/e2e-auto");
const ATTENTION_FILE = path.join(EVIDENCE_DIR, ATTENTION_FILE_NAME);

type ToolStatus = "running" | "completed" | "failed";

interface SeedCall {
    id: string;
    name: string;
    arguments: string;
    status: ToolStatus;
    startedAt: string;
    completedAt?: string;
    result?: string;
    truncated?: boolean;
}

interface SeedSnapshot {
    calls: SeedCall[];
    total: number;
    truncated: boolean;
}

interface SessionFixture {
    id: string;
    branchId: string;
}

interface AttentionRow {
    screen: string;
    viewport: string;
    l3: number;
    l4: number;
    l3Items: string[];
    l4Items: string[];
    tokens: {
        ring: string;
        muted20: string;
        border60: string;
        focusOutlineWidth: string;
        focusOutlineColor: string;
        focusTarget: string;
    };
}

function sqlLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/** Isolated host Postgres only; never the shared `stack-1` database. */
function queryIsolatedPostgres(sql: string): string {
    const container = process.env.XIHE_E2E_PG_CONTAINER,
        database = process.env.XIHE_E2E_PG_DATABASE,
        user = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !user) {
        throw new Error(
            "isolated Postgres fixture metadata is unavailable; run through scripts/e2e-host.mjs",
        );
    }
    return execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        ["exec", container, "psql", "-X", "-A", "-t", "-U", user, "-d", database, "-c", sql],
        { encoding: "utf8", timeout: 15_000, windowsHide: true },
    ).trim();
}

async function ensureAgentPrincipal(
    request: APIRequestContext,
    headers: Record<string, string>,
    workspaceId: string,
): Promise<string> {
    const me = await request.get(`${CP_URL}/api/v1/auth/me`, { headers });
    if (!me.ok()) throw new Error(`auth/me ${me.status()}: ${await me.text()}`);
    const userId = ((await me.json()) as { id: string }).id;
    seedUserGrant(userId, workspaceId, [{ actionClass: "write", resource: "*" }]);

    const roleId = randomUUID(),
        templateId = randomUUID();
    const templateWrite = await request.put(`${CP_URL}/api/v1/config/user/agent-templates`, {
        headers,
        data: {
            roles: JSON.stringify([
                {
                    id: roleId,
                    name: "PLAN-0688 Role",
                    permissions: [{ actionClass: "write", resource: "*" }],
                },
            ]),
            templates: JSON.stringify([
                {
                    id: templateId,
                    name: "PLAN0688Agent",
                    description: "Static tool-card fixture; no agent run is required.",
                    systemPrompt: "Use only the Workspace tools provided by CP.",
                    toolMode: "workspace",
                    provider: "openai",
                    model: MODEL_ID,
                    roleId,
                },
            ]),
        },
    });
    if (templateWrite.status() !== 200) {
        throw new Error(`template write ${templateWrite.status()}: ${await templateWrite.text()}`);
    }
    const principalWrite = await request.post(`${CP_URL}/api/v1/agent-principals`, {
        headers,
        data: { name: "PLAN0688Agent", templateId },
    });
    if (principalWrite.status() !== 201) {
        throw new Error(
            `principal create ${principalWrite.status()}: ${await principalWrite.text()}`,
        );
    }
    const principalId = ((await principalWrite.json()) as { principalId: string }).principalId;
    const bindWrite = await request.put(
        `${CP_URL}/api/v1/workspaces/${workspaceId}/agents/${principalId}`,
        {
            headers,
            data: { permissions: [{ actionClass: "write", resource: "*" }] },
        },
    );
    if (bindWrite.status() !== 200) {
        throw new Error(`principal bind ${bindWrite.status()}: ${await bindWrite.text()}`);
    }
    return principalId;
}

async function createSession(
    request: APIRequestContext,
    headers: Record<string, string>,
    title: string,
    agentPrincipalId: string,
): Promise<SessionFixture> {
    const response = await request.post(`${CP_URL}/api/v1/sessions`, {
        headers,
        data: { title, agentPrincipalId },
    });
    if (response.status() !== 201) {
        throw new Error(`session create ${response.status()}: ${await response.text()}`);
    }
    const body = (await response.json()) as { id: string };
    return { id: body.id, branchId: await getRootBranchId(request, body.id, headers) };
}

function insertMessage(
    fixture: SessionFixture,
    role: "USER" | "ASSISTANT",
    content: string,
    snapshot: SeedSnapshot | null,
    secondsAgo: number,
): string {
    const id = randomUUID();
    const toolCalls = snapshot ? `${sqlLiteral(JSON.stringify(snapshot))}::jsonb` : "NULL";
    queryIsolatedPostgres(
        `INSERT INTO messages (id, session_id, branch_id, role, content, tool_calls, created_at) ` +
            `VALUES (${sqlLiteral(id)}::uuid, ${sqlLiteral(fixture.id)}::uuid, ` +
            `${sqlLiteral(fixture.branchId)}::uuid, '${role}', ${sqlLiteral(content)}, ` +
            `${toolCalls}, NOW() - interval '${secondsAgo} seconds')`,
    );
    return id;
}

function seedToolMessage(
    fixture: SessionFixture,
    userText: string,
    assistantText: string,
    snapshot: SeedSnapshot,
): string {
    insertMessage(fixture, "USER", userText, null, 2);
    return insertMessage(fixture, "ASSISTANT", assistantText, snapshot, 0);
}

function updateSnapshot(messageId: string, snapshot: SeedSnapshot): void {
    queryIsolatedPostgres(
        `UPDATE messages SET tool_calls = ${sqlLiteral(JSON.stringify(snapshot))}::jsonb ` +
            `WHERE id = ${sqlLiteral(messageId)}::uuid`,
    );
}

function commandSnapshots(
    now: string,
    secondsLater: string,
): {
    running: SeedSnapshot;
    completed: SeedSnapshot;
} {
    const successId = randomUUID(),
        failedId = randomUUID();
    const runningCall: SeedCall = {
        id: successId,
        name: "execute_command",
        arguments: JSON.stringify({ command: "git status", args: ["--short"] }),
        status: "running",
        startedAt: now,
    };
    const completedSuccess: SeedCall = {
        ...runningCall,
        status: "completed",
        completedAt: secondsLater,
        result: JSON.stringify({
            stdout: "On branch task/0688-tool-card\nnothing to commit, working tree clean\n",
            stderr: "",
            exit_code: 0,
            success: true,
        }),
    };
    const failed: SeedCall = {
        id: failedId,
        name: "execute_command",
        arguments: JSON.stringify({ command: "git show", args: ["missing.txt"] }),
        status: "failed",
        startedAt: now,
        completedAt: secondsLater,
        result: JSON.stringify({
            stdout: "",
            stderr: "fatal: pathspec 'missing.txt' did not match any files\n",
            exit_code: 1,
            success: false,
        }),
    };
    return {
        running: {
            calls: [runningCall, failed],
            total: 2,
            truncated: false,
        },
        completed: {
            calls: [completedSuccess, failed],
            total: 2,
            truncated: false,
        },
    };
}

function patchSnapshot(): SeedSnapshot {
    const path = "packages/ui/src/features/workspace/chat/components/ToolCallCard.vue";
    return {
        calls: [
            {
                id: randomUUID(),
                name: "apply_patch",
                arguments: JSON.stringify({
                    patches: [
                        {
                            path,
                            expectedHash: "a".repeat(64),
                            hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }],
                        },
                    ],
                }),
                status: "completed",
                startedAt: "2026-11-07T06:00:00.000Z",
                completedAt: "2026-11-07T06:00:02.000Z",
                result: JSON.stringify({
                    changed: [path, "packages/ui/src/features/workspace/chat/types.ts"],
                    diff:
                        "--- a/" +
                        path +
                        "\n+++ b/" +
                        path +
                        "\n@@ -1,1 +1,2 @@\n-const fallback = true;\n+" +
                        "const dedicated = true;\n+const fallback = dedicated;\n",
                }),
            },
        ],
        total: 1,
        truncated: false,
    };
}

function readSnapshot(): SeedSnapshot {
    const path = "README.md";
    return {
        calls: [
            {
                id: randomUUID(),
                name: "read_file_range",
                arguments: JSON.stringify({ path, offset: 1, limit: 20 }),
                status: "completed",
                startedAt: "2026-11-07T06:00:00.000Z",
                completedAt: "2026-11-07T06:00:01.000Z",
                result: JSON.stringify({
                    content:
                        "1 | # Xihe\n2 |\n3 | Unified agent runtime platform.\n" +
                        "4 |\n5 | ## Packages\n6 | - control-plane\n7 | - agent\n8 | - runtime\n" +
                        "9 | - ui\n10 |\n11 | ## Host E2E\n12 | Run `mise run test:e2e:host`.\n",
                    total_lines: 120,
                    is_binary: false,
                }),
            },
        ],
        total: 1,
        truncated: false,
    };
}

function fallbackSnapshot(): SeedSnapshot {
    return {
        calls: [
            {
                id: randomUUID(),
                name: "mcp__dynamic__lookup",
                arguments: JSON.stringify({ query: "tool card fallback" }),
                status: "completed",
                startedAt: "2026-11-07T06:00:00.000Z",
                completedAt: "2026-11-07T06:00:01.000Z",
                result: "dynamic MCP result: tool card fallback is rendered by ToolCallCard",
            },
        ],
        total: 1,
        truncated: false,
    };
}

async function openChatSurface(page: Page): Promise<void> {
    const input = page.locator('[data-testid="chat-input"]');
    if (await input.isVisible({ timeout: 2_000 }).catch(() => false)) return;
    const openChat = page.getByRole("button", { name: "Open chat" });
    if (await openChat.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await openChat.click();
        await expect(page.getByTestId("mobile-chat-sheet")).toBeVisible({ timeout: 15_000 });
    }
    await ensureChatReady(page);
}

async function gotoSession(
    page: Page,
    workspaceId: string,
    fixture: SessionFixture,
): Promise<void> {
    await page.goto(`/workspace/${workspaceId}/chat/${fixture.id}`, { waitUntil: "load" });
    await openChatSurface(page);
    await expect(
        page.locator('[data-testid="tool-card"]').first(),
        "tool card visible",
    ).toBeVisible({ timeout: 30_000 });
}

async function expandAllCards(page: Page): Promise<void> {
    const toggles = page.locator('[data-testid="tool-card-toggle"]');
    const count = await toggles.count();
    for (let index = 0; index < count; index += 1) {
        const toggle = toggles.nth(index);
        if (!(await toggle.isVisible().catch(() => false))) continue;
        if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    }
}

async function assertCommandLayers(page: Page): Promise<void> {
    await expect(page.locator('[data-tool-card="command"]')).toHaveCount(2);
    await expect(
        page.locator('[data-tool-card="command"] [data-testid="process-row-summary"]').first(),
    ).not.toBeEmpty();
    await expect(
        page.locator('[data-tool-card="command"] [data-testid="command-result"]').first(),
    ).toBeVisible();
    await expect(
        page.locator('[data-tool-card="command"] [data-testid="command-stdout"]').first(),
    ).toContainText("nothing to commit");
    await expect(
        page.locator('[data-tool-card="command"] [data-testid="command-stderr"]').first(),
    ).toContainText("fatal: pathspec");
    await expect(page.locator('[data-tool-card="command"][data-failed="true"]')).toHaveCount(1);
    await expect(
        page.locator('[data-tool-card="command"] [data-testid="process-row-meta"]').first(),
    ).not.toBeEmpty();
}

async function assertPatchLayers(page: Page): Promise<void> {
    await expect(page.locator('[data-tool-card="patch"]')).toHaveCount(1);
    await expect(
        page.locator('[data-tool-card="patch"] [data-testid="process-row-summary"]').first(),
    ).toContainText("ToolCallCard.vue");
    await expect(
        page.locator('[data-tool-card="patch"] [data-testid="patch-changed-file"]'),
    ).toHaveCount(2);
    await expect(
        page.locator('[data-tool-card="patch"] [data-testid="patch-diff"]').first(),
    ).toContainText("+const dedicated");
    await expect(
        page.locator('[data-tool-card="patch"] [data-testid="process-row-meta"]').first(),
    ).not.toBeEmpty();
}

async function assertReadLayers(page: Page): Promise<void> {
    await expect(page.locator('[data-tool-card="read"]')).toHaveCount(1);
    await expect(
        page.locator('[data-tool-card="read"] [data-testid="process-row-summary"]').first(),
    ).toContainText("README.md");
    await expect(
        page.locator('[data-tool-card="read"] [data-testid="process-row-summary"]').first(),
    ).toContainText(/L1[–-]20/);
    await expect(
        page.locator('[data-tool-card="read"] [data-testid="read-meta"]').first(),
    ).toBeVisible();
    await expect(
        page.locator('[data-tool-card="read"] [data-testid="read-content"]').first(),
    ).toContainText("Unified agent runtime platform");
}

async function assertFallbackLayers(page: Page): Promise<void> {
    await expect(page.locator('[data-testid="tool-card"]')).toHaveCount(1);
    await expect(page.locator('[data-tool-card="command"]')).toHaveCount(0);
    await expect(page.locator('[data-tool-card="patch"]')).toHaveCount(0);
    await expect(page.locator('[data-tool-card="read"]')).toHaveCount(0);
    await expect(
        page.locator('[data-testid="tool-card"] [data-testid="process-row-summary"]').first(),
    ).not.toBeEmpty();
}

async function focusFirstToggleWithKeyboard(page: Page): Promise<void> {
    const firstToggle = page.locator('[data-testid="tool-card-toggle"]').first();
    await firstToggle.focus();
    // Return to the button through keyboard modality so Chrome applies
    // `*:focus-visible` (the global 2px ring), not the mouse-focus variant.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
}

async function collectAttentionRow(
    page: Page,
    screen: string,
    viewport: string,
): Promise<AttentionRow> {
    const counts = await page.evaluate(() => {
        const cards = [...document.querySelectorAll<HTMLElement>('[data-testid="tool-card"]')];
        const summarize = (card: HTMLElement): string => {
            const summary = card.querySelector<HTMLElement>('[data-testid="process-row-summary"]');
            return (summary?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
        };
        const l3 = cards.filter((card) => {
            const family = card.dataset.toolCard;
            return family === "command" || family === "patch";
        });
        const l4 = cards.filter((card) => card.dataset.failed === "true");
        return {
            l3: l3.length,
            l4: l4.length,
            l3Items: l3.map(summarize),
            l4Items: l4.map(summarize),
        };
    });
    await focusFirstToggleWithKeyboard(page);
    const tokens = await page.evaluate(() => {
        const card = document.querySelector<HTMLElement>('[data-testid="tool-card"]');
        const active = document.activeElement as HTMLElement | null;
        const cardStyle = card ? getComputedStyle(card) : null;
        const activeStyle = active ? getComputedStyle(active) : null;
        return {
            ring: getComputedStyle(document.documentElement).getPropertyValue("--ring").trim(),
            muted20: cardStyle?.backgroundColor ?? "",
            border60: cardStyle?.borderColor ?? "",
            focusOutlineWidth: activeStyle?.outlineWidth ?? "",
            focusOutlineColor: activeStyle?.outlineColor ?? "",
            focusTarget: active?.dataset.testid ?? "",
        };
    });
    return { screen, viewport, ...counts, tokens };
}

function appendAttentionRows(rows: AttentionRow[]): void {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    let existing: AttentionRow[] = [];
    if (existsSync(ATTENTION_FILE)) {
        existing = JSON.parse(readFileSync(ATTENTION_FILE, "utf8")) as AttentionRow[];
    }
    writeFileSync(ATTENTION_FILE, `${JSON.stringify([...existing, ...rows], null, 4)}\n`, "utf8");
}

function resetAttentionFile(): void {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(ATTENTION_FILE, "[]\n", "utf8");
}

async function runViewportCase(
    page: Page,
    request: APIRequestContext,
    options: {
        label: string;
        viewport: string;
        /** V1 file-name suffix: `desktop-1920x1080` / `mobile-390x844`. */
        suffix: string;
        captureRunning: boolean;
        captureFallback: boolean;
    },
): Promise<void> {
    if (options.captureRunning) resetAttentionFile();
    const ctx = await registerJourneyUser(request, options.label);
    const headers = { ...ctx.headers, "X-Workspace-Id": ctx.workspaceId };
    const agentPrincipalId = await ensureAgentPrincipal(request, headers, ctx.workspaceId);
    const command = await createSession(
        request,
        headers,
        "PLAN-0688 command card",
        agentPrincipalId,
    );
    const patch = await createSession(request, headers, "PLAN-0688 patch card", agentPrincipalId);
    const read = await createSession(request, headers, "PLAN-0688 read card", agentPrincipalId);
    const fallback = options.captureFallback
        ? await createSession(request, headers, "PLAN-0688 fallback card", agentPrincipalId)
        : null;

    const commandMessage = seedToolMessage(
        command,
        "T2.2 command card fixture",
        "Command cards: one running/completed success and one failed exit.",
        options.captureRunning
            ? commandSnapshots("2026-11-07T06:00:00.000Z", "2026-11-07T06:00:02.000Z").running
            : commandSnapshots("2026-11-07T06:00:00.000Z", "2026-11-07T06:00:02.000Z").completed,
    );
    seedToolMessage(
        patch,
        "T2.2 patch card fixture",
        "Patch card: two changed files and a unified diff.",
        patchSnapshot(),
    );
    seedToolMessage(
        read,
        "T2.2 read card fixture",
        "Read card: a bounded line range with metadata.",
        readSnapshot(),
    );
    if (fallback) {
        seedToolMessage(
            fallback,
            "T2.2 fallback fixture",
            "Unknown dynamic MCP call must stay on the generic card.",
            fallbackSnapshot(),
        );
    }

    seedPage(page, ctx);
    const attention: AttentionRow[] = [];

    await gotoSession(page, ctx.workspaceId, command);
    await expandAllCards(page);
    if (options.captureRunning) {
        await expect(
            page.locator('[data-tool-card="command"] [data-testid="process-row-summary"]').first(),
        ).not.toBeEmpty();
        await expect(page.locator('[data-tool-card="command"][data-failed="true"]')).toHaveCount(1);
        const toggleBox = await page
            .locator('[data-tool-card="command"] [data-testid="tool-card-toggle"]')
            .first()
            .boundingBox();
        await captureEvidence(page, "t2.2-command-running");
        attention.push(await collectAttentionRow(page, "t2.2-command-running", options.viewport));
        updateSnapshot(
            commandMessage,
            commandSnapshots("2026-11-07T06:00:00.000Z", "2026-11-07T06:00:02.000Z").completed,
        );
        await page.reload({ waitUntil: "load" });
        await openChatSurface(page);
        await expect(
            page.locator('[data-testid="tool-card"]').first(),
            "tool card after running -> completed reload",
        ).toBeVisible({ timeout: 30_000 });
        await expandAllCards(page);
        const completedBox = await page
            .locator('[data-tool-card="command"] [data-testid="tool-card-toggle"]')
            .first()
            .boundingBox();
        expect(toggleBox, "running toggle box exists").not.toBeNull();
        expect(completedBox, "completed toggle box exists").not.toBeNull();
        expect(
            Math.abs((toggleBox?.x ?? 0) - (completedBox?.x ?? 0)),
            "running -> completed row keeps horizontal alignment",
        ).toBeLessThanOrEqual(1);
        expect(
            Math.abs((toggleBox?.width ?? 0) - (completedBox?.width ?? 0)),
            "running -> completed row keeps width",
        ).toBeLessThanOrEqual(1);
    }

    await assertCommandLayers(page);
    await captureEvidence(page, `t2.2-command-${options.suffix}`);
    attention.push(
        await collectAttentionRow(page, `t2.2-command-${options.suffix}`, options.viewport),
    );

    await gotoSession(page, ctx.workspaceId, patch);
    await expandAllCards(page);
    await assertPatchLayers(page);
    await captureEvidence(page, `t2.2-patch-${options.suffix}`);
    attention.push(
        await collectAttentionRow(page, `t2.2-patch-${options.suffix}`, options.viewport),
    );

    await gotoSession(page, ctx.workspaceId, read);
    await expandAllCards(page);
    await assertReadLayers(page);
    await captureEvidence(page, `t2.2-read-${options.suffix}`);
    attention.push(
        await collectAttentionRow(page, `t2.2-read-${options.suffix}`, options.viewport),
    );

    if (fallback) {
        await gotoSession(page, ctx.workspaceId, fallback);
        await expandAllCards(page);
        await assertFallbackLayers(page);
        await captureEvidence(page, "t2.2-fallback-dynamic-mcp");
        attention.push(
            await collectAttentionRow(page, "t2.2-fallback-dynamic-mcp", options.viewport),
        );
    }

    if (options.viewport === "390x844") {
        const scrollWidth = await page.evaluate(
            () => document.scrollingElement?.scrollWidth ?? Number.NaN,
        );
        expect(scrollWidth, "mobile horizontal overflow").toBe(390);
    }
    appendAttentionRows(attention);
}

/** Six family screenshots + one dynamic-MCP fallback; desktop also proves a running row. */
test.describe("@host PLAN-0688 T2.2 tool card visual split", () => {
    test.describe.configure({ mode: "serial" });
    test.setTimeout(240_000);

    test.describe("desktop 1920x1080", () => {
        test.use({ viewport: { width: 1920, height: 1080 } });
        test("dedicated cards and fallback", async ({ page, request }) => {
            await runViewportCase(page, request, {
                label: "plan0688-tool-cards-desktop",
                viewport: "1920x1080",
                suffix: "desktop-1920x1080",
                captureRunning: true,
                captureFallback: true,
            });
        });
    });

    test.describe("mobile 390x844", () => {
        test.use({ viewport: { width: 390, height: 844 } });
        test("dedicated cards stay inside the mobile sheet", async ({ page, request }) => {
            await runViewportCase(page, request, {
                label: "plan0688-tool-cards-mobile",
                viewport: "390x844",
                suffix: "mobile-390x844",
                captureRunning: false,
                captureFallback: false,
            });
        });
    });
});
