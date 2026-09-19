import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { generateE2EPassword } from "./helpers/password";
import { ensureAgentWorkspaceBinding } from "./helpers/journey";
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * PLAN-0339 T0.4 — workspace checkpoint slice restore, real host stack.
 *
 * Scenarios (all assertions are request/response/persistence/visible-result):
 *   S1  L1 write_file  : approve → file on host → capture → workspace list → UI preview (no raw
 *                        contents in the payload) → UI revert → 已恢复到此前 marker + ledger item.
 *   S2  L2 exec/shell  : command writes through the shell; captured change set includes the file.
 *   S3  post-slice edit: the file is edited through the UI file panel after the run; preview
 *                        lists the restore action and the target slice replaces the edit.
 *   S4  non-git        : asserts `HOST_ROOT/<ws>/.git` is absent, reruns the S1 flow.
 *   S5  no slice       : a read-only run gets no workspace slice row; restore answers 409.
 *   S6  concurrency    : revert while the run is active is rejected; back-to-back executes are
 *                        idempotent (second all-noop) and the ledger keeps two revert attempts.
 *   S7  dual diff      : this-run (shadow) and pending-commit (git status) render separately.
 *
 * Documented runner invocations (scripts/e2e-host.mjs starts the isolated stack; the fake-LLM
 * mode selects which scenarios run — the others self-skip). The flag form is the runner's own
 * documented usage (e2e-host.mjs:859); `XIHE_E2E_LLM_MODE=<mode>` works the same and takes
 * precedence, so use one form at a time:
 *   node scripts/e2e-host.mjs --llm-mode=write_file   --retries=0 e2e/real/checkpoint-rollback.spec.ts
 *   node scripts/e2e-host.mjs --llm-mode=exec_command --retries=0 e2e/real/checkpoint-rollback.spec.ts
 *   node scripts/e2e-host.mjs --llm-mode=read_file    --retries=0 e2e/real/checkpoint-rollback.spec.ts
 *
 * Constraints baked into the helpers:
 *  - One registered user/workspace per process — the Agent keeps ONE MCP workspace binding and
 *    retries would re-register (host specs run with --retries=0).
 *  - A terminal run is required before the next send (CHAT_IN_PROGRESS 409 otherwise); every
 *    send first waits for the latest operation to reach a terminal state.
 *  - No screenshot baselines (spec/testing §7): assertions are DOM/request/server-value based.
 */

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
// e2e-host passes XIHE_WORKSPACE_HOST_ROOT to its native services only; the Playwright env
// carries XIHE_E2E_RUN_ID and the runner root is <project>/.tmp/e2e-host/<run-id> (e2e-host.mjs:54).
const HOST_ROOT =
    process.env.XIHE_WORKSPACE_HOST_ROOT ??
    (process.env.XIHE_E2E_RUN_ID
        ? path.resolve(process.cwd(), "../../.tmp/e2e-host", process.env.XIHE_E2E_RUN_ID)
        : path.resolve(process.cwd(), "../../.xihe-workspaces"));
const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "mock";
const EVIDENCE_DIR = path.resolve(process.cwd(), "../../.local/evidence/checkpoint-rollback");
// PLAN-0369: workspace this file's Agent binding was ensured for.
let agentBindingWorkspaceId = "";
const BASELINE_FILE = ".xihe-checkpoint-rollback-baseline.txt";
const BASELINE_CONTENT = "checkpoint rollback baseline\n";

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "partial", "ambiguous", "cancelled"] as const;
const TERMINAL_RUN_PATTERN = new RegExp(`^(${TERMINAL_RUN_STATUSES.join("|")})$`);
const TERMINAL_OPERATION_STATUSES = [
    "completed",
    "failed",
    "cancelled",
    "interrupted",
    "ambiguous",
];
// A fresh user has an empty operation ledger until the first send — the send gate
// must treat "no operation yet" as ready instead of polling for a terminal status.
const NO_OPERATION_STATUS = "none";
const TERMINAL_OPERATION_PATTERN_OR_NONE = new RegExp(
    `^(${[NO_OPERATION_STATUS, ...TERMINAL_OPERATION_STATUSES].join("|")})$`,
);

interface OperationSummary {
    id: string;
    runId: string | null;
    kind?: string;
    status?: string;
}

interface OperationItemView {
    kind: string;
    toolName: string | null;
    status: string;
    toolCallId: string | null;
}

interface CheckpointChangedFile {
    status: string;
    path: string;
}

interface CheckpointView {
    id: string;
    sliceRef: string | null;
    capturedAt: string | null;
    sourceRunId: string | null;
    sourceSessionId: string | null;
    predecessorRef: string | null;
    state: string;
    changedCount: number;
    changedFiles: CheckpointChangedFile[];
    opaqueNestedRepos: string[];
    truncated: boolean;
    unrollableReason: string | null;
    revert: {
        state: string;
        at: string | null;
        counts: Record<string, number> | null;
        ref: string | null;
    } | null;
}

interface RevertPreviewBody {
    sliceRef: string;
    counts: { restore: number; delete: number; typeConflict: number };
    entries: Array<{ path: string; action: string; state: string; reason?: string }>;
    truncated: boolean;
}

interface RevertResultBody {
    sliceRef: string;
    counts: { restored: number; deleted: number; failed: number };
    entries: Array<{ path: string; outcome: string; reason?: string }>;
    durationMs: number;
    suspects: string[];
}

interface ProblemBody {
    code?: string;
    detail?: string;
    reason?: string;
    paths?: string[];
    [key: string]: unknown;
}

interface WriteFlow {
    runId: string;
    hostFile: string;
    view: CheckpointView;
}

// ── Browser helpers ─────────────────────────────────────────────────────────

function seedPage(page: Page, token: string, wsId: string): void {
    page.addInitScript((t) => localStorage.setItem("xihe-token", t), token);
    page.addInitScript(
        (raw) => localStorage.setItem("xihe-user", raw),
        JSON.stringify({ workspaceId: wsId }),
    );
    page.addInitScript((ws) => localStorage.setItem("xihe-workspace", JSON.stringify(ws)), {
        id: wsId,
        name: "Default Workspace",
    });
}

function listSliceRefs(workspaceId: string): string[] {
    const gitDir = path.join(HOST_ROOT, ".xihe-shadow", `${workspaceId}.git`);
    const result = spawnSync(
        "git",
        ["--git-dir", gitDir, "for-each-ref", "--format=%(refname)", "refs/xihe/slices"],
        { encoding: "utf8" },
    );
    if (result.status !== 0) return [];
    return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

/**
 * Send a chat message and wait for the real request plus visible user bubble.
 */
async function sendChat(page: Page, text: string): Promise<void> {
    // PLAN-0369: workspace-tool chats need the Agent bound to THIS spec's
    // workspace (single-binding product rule); no-op when already bound.
    if (agentBindingWorkspaceId) await ensureAgentWorkspaceBinding(agentBindingWorkspaceId);
    const input = page.locator('[data-testid="chat-input"]');
    const send = page.locator('[data-testid="chat-send-button"]');
    await input.fill(text);
    await expect(send).toBeEnabled({ timeout: 15000 });
    const response = page.waitForResponse(
        (item) => item.url().endsWith("/api/v1/chat") && item.request().method() === "POST",
        { timeout: 30000 },
    );
    await send.click();
    const chatResponse = await response;
    expect(chatResponse.ok(), `chat request failed with ${chatResponse.status()}`).toBeTruthy();
    await expect(page.locator('[data-slot="message"][data-align="end"]').first()).toBeVisible({
        timeout: 30000,
    });
}

async function openWorkspace(page: Page, token: string, wsId: string): Promise<void> {
    seedPage(page, token, wsId);
    await page.goto(`/workspace/${wsId}`, { waitUntil: "load" });
    await expect(page.locator('[data-testid="chat-input"]'), "workspace chat input").toBeVisible({
        timeout: 30000,
    });
}

/** Last checkpoint marker in the timeline (its message is the latest run). */
function latestMarker(page: Page): Locator {
    return page.locator('[data-testid="run-checkpoint-marker"]').last();
}

// ── API helpers ─────────────────────────────────────────────────────────────

/** Wait until the newest operation of this user is terminal (the run send gate). */
async function awaitLatestOperationTerminal(
    request: APIRequestContext,
    headers: Record<string, string>,
): Promise<void> {
    await expect
        .poll(
            async () => {
                const res = await request.get(`${CP_URL}/api/v1/operations?size=1`, { headers });
                const body = (await res.json()) as { operations?: Array<{ status?: string }> };
                return body.operations?.[0]?.status ?? NO_OPERATION_STATUS;
            },
            { timeout: 180000, intervals: [2000] },
        )
        .toMatch(TERMINAL_OPERATION_PATTERN_OR_NONE);
}

/** The newest operation that carries a runId — i.e. the run just started. */
async function currentRunId(
    request: APIRequestContext,
    headers: Record<string, string>,
): Promise<string> {
    let runId = "";
    await expect
        .poll(
            async () => {
                const res = await request.get(`${CP_URL}/api/v1/operations?size=5`, { headers });
                const body = (await res.json()) as { operations?: OperationSummary[] };
                const op = body.operations?.find((entry) => entry.runId);
                if (!op?.runId) return "pending";
                runId = op.runId;
                return "found";
            },
            { timeout: 60000, intervals: [1000] },
        )
        .toBe("found");
    return runId;
}

async function awaitChatRunTerminal(
    request: APIRequestContext,
    headers: Record<string, string>,
    runId: string,
): Promise<string> {
    await expect
        .poll(
            async () => {
                const res = await request.get(`${CP_URL}/api/v1/chat/runs/${runId}`, { headers });
                const body = (await res.json()) as { status?: string };
                return body.status ?? "unknown";
            },
            { timeout: 180000, intervals: [2000] },
        )
        .toMatch(TERMINAL_RUN_PATTERN);
    const res = await request.get(`${CP_URL}/api/v1/chat/runs/${runId}`, { headers });
    return ((await res.json()) as { status: string }).status;
}

async function checkpointView(
    request: APIRequestContext,
    headers: Record<string, string>,
    workspaceId: string,
    runId: string,
): Promise<CheckpointView> {
    const rows = await workspaceCheckpointList(request, headers, workspaceId);
    const view = rows.find((row) => row.sourceRunId === runId);
    if (!view) throw new Error(`no workspace checkpoint for run ${runId}`);
    return view;
}

async function workspaceCheckpointList(
    request: APIRequestContext,
    headers: Record<string, string>,
    workspaceId: string,
): Promise<CheckpointView[]> {
    const res = await request.get(`${CP_URL}/api/v1/workspaces/${workspaceId}/checkpoints`, {
        headers,
    });
    expect(res.ok(), `workspace checkpoint GET ${res.status()} ${await res.text()}`).toBeTruthy();
    return (await res.json()) as CheckpointView[];
}

/** Capture is asynchronous after the terminal transition — poll the durable workspace list. */
async function awaitCheckpointCaptured(
    request: APIRequestContext,
    headers: Record<string, string>,
    workspaceId: string,
    runId: string,
): Promise<CheckpointView> {
    let view: CheckpointView | undefined;
    await expect
        .poll(
            async () => {
                const res = await request.get(
                    `${CP_URL}/api/v1/workspaces/${workspaceId}/checkpoints`,
                    { headers },
                );
                if (!res.ok()) return `http-${res.status()}`;
                const rows = (await res.json()) as CheckpointView[];
                view = rows.find((row) => row.sourceRunId === runId);
                return view?.state ?? "missing";
            },
            { timeout: 120000, intervals: [1000, 2000] },
        )
        .toBe("captured");
    if (!view) throw new Error(`checkpoint never became readable for run ${runId}`);
    return view;
}

async function previewRevert(
    request: APIRequestContext,
    headers: Record<string, string>,
    workspaceId: string,
    sliceRef: string,
): Promise<{ status: number; body: RevertPreviewBody & ProblemBody }> {
    const res = await request.post(
        `${CP_URL}/api/v1/workspaces/${workspaceId}/checkpoints/revert/preview`,
        { headers, data: { sliceRef } },
    );
    return { status: res.status(), body: (await res.json()) as RevertPreviewBody & ProblemBody };
}

async function executeRevert(
    request: APIRequestContext,
    headers: Record<string, string>,
    workspaceId: string,
    sliceRef: string,
    acknowledgeTypeChanges: string[] = [],
): Promise<{ status: number; body: RevertResultBody & ProblemBody }> {
    const res = await request.post(
        `${CP_URL}/api/v1/workspaces/${workspaceId}/checkpoints/revert`,
        { headers, data: { sliceRef, acknowledgeTypeChanges } },
    );
    return { status: res.status(), body: (await res.json()) as RevertResultBody & ProblemBody };
}

/** Ledger items of the durable operation behind one run (kind/toolName are part of the projection). */
async function operationItems(
    request: APIRequestContext,
    headers: Record<string, string>,
    runId: string,
): Promise<OperationItemView[]> {
    const listRes = await request.get(`${CP_URL}/api/v1/operations?size=50`, { headers });
    const list = (await listRes.json()) as { operations?: OperationSummary[] };
    const operation = list.operations?.find((entry) => entry.runId === runId);
    if (!operation) throw new Error(`no durable operation found for run ${runId}`);
    const detailRes = await request.get(`${CP_URL}/api/v1/operations/${operation.id}`, { headers });
    expect(detailRes.ok(), `operation detail ${detailRes.status()}`).toBeTruthy();
    const detail = (await detailRes.json()) as { items?: OperationItemView[] };
    return detail.items ?? [];
}

// ── Run drivers ─────────────────────────────────────────────────────────────

/** Gate on the previous run, send the marker message and wait for the approval modal. */
async function beginApprovalRun(
    page: Page,
    request: APIRequestContext,
    headers: Record<string, string>,
    markerText: string,
): Promise<Locator> {
    await awaitLatestOperationTerminal(request, headers);
    const modal = page.locator('[data-testid="modal-content"]');
    await sendChat(page, markerText);
    await expect(modal, "approval modal").toBeVisible({ timeout: 120000 });
    return modal;
}

async function approveModal(modal: Locator): Promise<void> {
    await modal.locator('[data-testid="approval-approve"]').click();
    await expect(modal).toBeHidden({ timeout: 30000 });
}

/** Poll the host file until the approved run's write is visible (or the writer times out). */
async function awaitHostFile(hostFile: string, expected: string): Promise<void> {
    await expect
        .poll(
            () => {
                try {
                    return readFileSync(hostFile, "utf8");
                } catch {
                    return "";
                }
            },
            { message: `expected ${hostFile} to contain the approved content`, timeout: 60000 },
        )
        .toContain(expected);
}

/** S1/S4 core: marker → approve → host file → terminal → captured workspace slice. */
async function writeFileRunThroughUi(
    page: Page,
    request: APIRequestContext,
    headers: Record<string, string>,
    workspaceId: string,
    hostDir: string,
    fileName: string,
    content: string,
): Promise<WriteFlow> {
    const modal = await beginApprovalRun(
        page,
        request,
        headers,
        `XIHE-E2E-WRITE ${fileName} ${content}`,
    );
    const runId = await currentRunId(request, headers);
    await approveModal(modal);
    const hostFile = path.join(hostDir, fileName);
    await awaitHostFile(hostFile, content);
    const status = await awaitChatRunTerminal(request, headers, runId);
    expect(status, "run terminal status").toBe("succeeded");
    const view = await awaitCheckpointCaptured(request, headers, workspaceId, runId);
    return { runId, hostFile, view };
}

/**
 * S1/S4 shared UI revert: drives the preview dialog on the LIVE timeline marker (counts +
 * conservative default focus), executes and returns the visible markers to assert on.
 * `previewBodies` collects the raw preview responses so callers can prove payload purity.
 *
 * No page reload here: the workspace chat surface does not hydrate persisted messages on
 * load (only `/chat/:sessionId` does, ChatView.vue:64-118), so a reload drops the whole
 * timeline including the marker (reported as a product gap; see the batch evidence).
 */
async function revertThroughUi(
    page: Page,
    flow: WriteFlow,
    hostDir: string,
): Promise<{ previewBodies: string[]; resultBodies: string[] }> {
    const previewBodies: string[] = [];
    const resultBodies: string[] = [];
    page.on("response", (response) => {
        const url = response.url();
        if (url.includes("/checkpoints/revert/preview")) {
            void response
                .text()
                .then((body) => previewBodies.push(body))
                .catch(() => {});
        }
        if (url.endsWith("/checkpoints/revert")) {
            void response
                .text()
                .then((body) => resultBodies.push(body))
                .catch(() => {});
        }
    });
    const marker = latestMarker(page);
    await expect(marker).toHaveAttribute("data-checkpoint-kind", "captured", { timeout: 30000 });
    await expect(marker.getByTestId("run-checkpoint-summary")).toContainText(
        String(flow.view.changedCount),
    );
    const extraFileName = `.xihe-checkpoint-extra-${Date.now()}.txt`;
    const extraPath = path.join(hostDir, extraFileName);
    writeFileSync(extraPath, "this file must be deleted by restoring the captured slice\n");

    await marker.getByTestId("run-checkpoint-revert-entry").click();
    const dialog = page.getByTestId("checkpoint-dialog");
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("revert-preview-delete-count")).toHaveText(
        String(flow.view.changedCount),
    );
    await expect(page.getByTestId("revert-preview-restore-count")).toHaveText("0");
    await expect(page.getByTestId("revert-preview-type-conflict-count")).toHaveText("0");
    await expect(page.getByTestId("revert-preview-paths")).toContainText(extraFileName);
    // U2: the conservative default holds focus and no acknowledgement is required without conflicts.
    await expect(page.getByTestId("revert-preview-cancel")).toBeFocused();
    await expect(page.getByTestId("revert-preview-confirm")).toBeEnabled();

    await page.getByTestId("revert-preview-confirm").click();
    await expect(page.getByTestId("revert-result-counts")).toBeVisible({ timeout: 60000 });
    await expect(page.getByTestId("revert-result-group-deleted")).toContainText(extraFileName);
    await expect(page.getByTestId("revert-result-ref")).toContainText(flow.view.sliceRef ?? "");
    await page.getByTestId("revert-result-dismiss").click();
    await expect.poll(() => existsSync(extraPath)).toBe(false);

    await expect(
        page
            .locator('[data-testid="run-checkpoint-marker"][data-checkpoint-kind="captured"]')
            .last(),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("run-checkpoint-reverted").last()).toContainText("已恢复到此前");
    return { previewBodies, resultBodies };
}

// ── Spec ────────────────────────────────────────────────────────────────────

test.describe("@host PLAN-0328 M3 checkpoint rollback (real Runtime + CP)", () => {
    test.describe.configure({ mode: "serial" });
    test.setTimeout(240000);

    let sharedAuth: string;
    let sharedWs: string;
    let sharedHeaders: Record<string, string>;
    let hostDir: string;

    test.beforeAll(async ({ request }) => {
        const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
        const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `checkpoint-rollback-${Date.now()}@test.com`,
                password,
                name: "CheckpointRollback",
            },
        });
        expect([200, 201], `register failed: ${reg.status()} ${await reg.text()}`).toContain(
            reg.status(),
        );
        const auth = (await reg.json()) as { accessToken: string; workspaceId: string };
        sharedAuth = auth.accessToken;
        sharedWs = auth.workspaceId;
        agentBindingWorkspaceId = auth.workspaceId;
        sharedHeaders = {
            Authorization: `Bearer ${auth.accessToken}`,
            "Content-Type": "application/json",
        };
        hostDir = path.join(HOST_ROOT, sharedWs);
    });

    test("W: materialize the workspace and establish the C0 slice baseline", async ({
        request,
    }) => {
        mkdirSync(hostDir, { recursive: true });
        writeFileSync(path.join(hostDir, BASELINE_FILE), BASELINE_CONTENT);

        const response = await request.post(`${CP_URL}/api/v1/workspaces/${sharedWs}/materialize`, {
            headers: sharedHeaders,
        });
        expect(
            [200, 202],
            `materialize failed: ${response.status()} ${await response.text()}`,
        ).toContain(response.status());
        await expect
            .poll(() => listSliceRefs(sharedWs).length, {
                message: "C0 baseline slice ref must appear before rollback scenarios",
                timeout: 180000,
                intervals: [1000, 2000, 3000],
            })
            .toBeGreaterThan(0);
        expect(existsSync(path.join(hostDir, BASELINE_FILE))).toBe(true);
    });

    // S1 ─ L1 write_file happy path ────────────────────────────────────────────
    test("S1: write_file capture previews without contents and restores through the UI", async ({
        page,
        request,
    }) => {
        test.skip(LLM_MODE !== "write_file", "requires XIHE_E2E_LLM_MODE=write_file");
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        const nonce = Date.now();
        const fileName = `s1-note-${nonce}.md`;
        const content = `S1-ROW-${nonce}-preview-payloads-must-not-carry-this-content`;

        await openWorkspace(page, sharedAuth, sharedWs);
        const flow = await writeFileRunThroughUi(
            page,
            request,
            sharedHeaders,
            sharedWs,
            hostDir,
            fileName,
            content,
        );
        expect(existsSync(flow.hostFile), "approved write_file lands on the host").toBe(true);

        // Request/persistence: the durable projection is the captured change set of exactly this file.
        const view = await checkpointView(request, sharedHeaders, sharedWs, flow.runId);
        expect(view.state).toBe("captured");
        expect(
            view.changedCount,
            "only the run file is in the seal change set (xihe infra paths are excluded)",
        ).toBe(1);
        expect(view.changedFiles.map((file) => file.path)).toContain(fileName);
        expect(view.changedFiles.find((file) => file.path === fileName)?.status).toBe("A");

        const { previewBodies } = await revertThroughUi(page, flow, hostDir);
        await page.screenshot({ path: path.join(EVIDENCE_DIR, "s1-reverted-marker.png") });

        // Restoring the captured slice preserves its original file; the extra file created
        // immediately before the dialog was deleted by revertThroughUi.
        await expect.poll(() => existsSync(flow.hostFile), { timeout: 30000 }).toBe(true);
        const after = await checkpointView(request, sharedHeaders, sharedWs, flow.runId);
        expect(after.revert?.state).toBe("rolled_back");
        expect(after.revert?.counts?.deleted).toBe(1);
        expect(after.revert?.ref).toBeTruthy();

        // Payload purity: neither the API response nor the browser preview carries file contents.
        const apiPreview = await previewRevert(
            request,
            sharedHeaders,
            sharedWs,
            flow.view.sliceRef!,
        );
        // The second preview is legitimate (read-only) and still carries paths/counts only.
        expect(apiPreview.status).toBe(200);
        expect(JSON.stringify(apiPreview.body)).not.toContain(content);
        await expect.poll(() => previewBodies.length, { timeout: 15000 }).toBeGreaterThan(0);
        expect(
            previewBodies.join("\n"),
            "preview payloads carry no raw file contents",
        ).not.toContain(content);

        // Ledger: the user revert is a checkpoint/revert_checkpoint item owned by CP.
        const items = await operationItems(request, sharedHeaders, flow.runId);
        const revertItems = items.filter(
            (item) => item.kind === "checkpoint" && item.toolName === "revert_checkpoint",
        );
        expect(revertItems.length, "one ledger item per executed revert").toBe(1);
        expect(revertItems[0].status).toBe("completed");
        expect(
            items.some((item) => item.kind === "checkpoint" && item.toolName === "run_checkpoint"),
        ).toBe(true);
    });

    // S2 ─ L2 exec/shell coverage ──────────────────────────────────────────────
    test("S2: shell-written change is part of the captured change set and the preview delete count", async ({
        page,
        request,
    }) => {
        test.skip(LLM_MODE !== "exec_command", "requires XIHE_E2E_LLM_MODE=exec_command");
        const fileName = `s2-shell-${Date.now()}.txt`;
        const content = `S2-SHELL-${Date.now()}`;

        await openWorkspace(page, sharedAuth, sharedWs);
        const modal = await beginApprovalRun(
            page,
            request,
            sharedHeaders,
            `XIHE-E2E-EXEC echo ${content} > ${fileName}`,
        );
        const runId = await currentRunId(request, sharedHeaders);
        await approveModal(modal);
        const hostFile = path.join(hostDir, fileName);
        await awaitHostFile(hostFile, content);
        const status = await awaitChatRunTerminal(request, sharedHeaders, runId);
        expect(status).toBe("succeeded");

        // L2: the shell write is inside the same shadow checkpoint (no per-tool manifest).
        const view = await awaitCheckpointCaptured(request, sharedHeaders, sharedWs, runId);
        expect(view.changedCount, "the shell-created file is the only change").toBe(1);
        expect(view.changedFiles.map((file) => file.path)).toContain(fileName);

        const preview = await previewRevert(request, sharedHeaders, sharedWs, view.sliceRef!);
        expect(preview.status).toBe(200);
        expect(preview.body.counts.delete, "a run-created file is deleted on revert").toBe(1);
        expect(preview.body.entries.find((entry) => entry.path === fileName)?.action).toBe(
            "delete",
        );

        const revert = await executeRevert(request, sharedHeaders, sharedWs, view.sliceRef!);
        expect(revert.status).toBe(200);
        expect(revert.body.counts.deleted).toBe(1);
        expect(revert.body.counts.failed).toBe(0);
        await expect.poll(() => existsSync(hostFile), { timeout: 30000 }).toBe(false);
    });

    // S3 ─ post-slice edits ────────────────────────────────────────────────────
    test("S3: post-slice edits are listed and the target slice is restored explicitly", async ({
        page,
        request,
    }) => {
        test.skip(LLM_MODE !== "write_file", "requires XIHE_E2E_LLM_MODE=write_file");
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        const nonce = Date.now();
        const fileName = `s3-conflict-${nonce}.md`;
        const agentContent = `S3-AGENT-${nonce}`;
        const userContent = `S3-USER-EDIT-${nonce} replaced by the target slice`;

        await openWorkspace(page, sharedAuth, sharedWs);
        const flow = await writeFileRunThroughUi(
            page,
            request,
            sharedHeaders,
            sharedWs,
            hostDir,
            fileName,
            agentContent,
        );

        // Mutate the file through the UI file panel (code panel → tree → markdown source → save).
        // No reload: the workspace chat keeps the live timeline (persisted history is not hydrated
        // on this surface, so a reload would drop the run's marker — reported product gap).
        const treeRefresh = page.getByRole("button", { name: "Refresh" }).first();
        if (await treeRefresh.isVisible().catch(() => false)) await treeRefresh.click();
        const codeToggle = page.getByTestId("workspace-toolbar-code");
        await codeToggle.click();
        await expect(codeToggle).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByTestId("workspace-aux-panel")).toBeVisible();
        const fileButton = page.getByRole("button", { name: fileName, exact: true });
        await expect(fileButton).toBeVisible({ timeout: 30000 });
        await fileButton.click();
        await page.getByRole("button", { name: "源码" }).click();
        await page.getByTestId("workspace-markdown-source").fill(userContent);
        await page.getByRole("button", { name: "保存", exact: true }).click();
        await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible({
            timeout: 15000,
        });

        // Preview via the timeline entry: the post-slice edit is listed as a restore action.
        const marker = latestMarker(page);
        await expect(marker).toHaveAttribute("data-checkpoint-kind", "captured", {
            timeout: 30000,
        });
        await marker.getByTestId("run-checkpoint-revert-entry").click();
        await expect(page.getByTestId("checkpoint-dialog")).toBeVisible({ timeout: 15000 });
        await expect(page.getByTestId("revert-preview-type-conflict-count")).toHaveText("0");
        await expect(page.getByTestId("revert-preview-restore-count")).toHaveText("1");
        await expect(page.getByTestId("revert-preview-paths")).toContainText(fileName);
        await page.screenshot({ path: path.join(EVIDENCE_DIR, "s3-conflict-preview.png") });

        const confirm = page.getByTestId("revert-preview-confirm");
        await expect(confirm).toBeEnabled();
        await confirm.click();
        await expect(page.getByTestId("revert-result-counts")).toBeVisible({ timeout: 60000 });
        await expect(page.getByTestId("revert-result-group-restored")).toContainText(fileName);
        await page.getByTestId("revert-result-dismiss").click();

        // The target slice content replaces the post-slice edit.
        expect(readFileSync(flow.hostFile, "utf8")).toContain(agentContent);
        const after = await checkpointView(request, sharedHeaders, sharedWs, flow.runId);
        expect(after.revert?.counts?.restored).toBe(1);
    });

    // S4 ─ non-git workspace ───────────────────────────────────────────────────
    test("S4: non-git workspace has no user repo, keeps the shadow outside and reruns the S1 flow", async ({
        page,
        request,
    }) => {
        test.skip(LLM_MODE !== "write_file", "requires XIHE_E2E_LLM_MODE=write_file");
        // V8: the shadow checkpoint works on a plain directory — no `.git` is created in the workspace.
        expect(existsSync(path.join(hostDir, ".git")), "non-git workspace has no user repo").toBe(
            false,
        );

        const nonce = Date.now();
        const fileName = `s4-nongit-${nonce}.md`;
        const content = `S4-ROW-${nonce}-non-git-workspace`;
        await openWorkspace(page, sharedAuth, sharedWs);
        const flow = await writeFileRunThroughUi(
            page,
            request,
            sharedHeaders,
            sharedWs,
            hostDir,
            fileName,
            content,
        );
        expect(existsSync(path.join(hostDir, ".git")), "still no user repo after the run").toBe(
            false,
        );
        // Isolation positive control: the object store lives outside the work tree (spec §6.1).
        expect(
            existsSync(path.join(HOST_ROOT, ".xihe-shadow", `${sharedWs}.git`)),
            "shadow lives under hostRoot/.xihe-shadow",
        ).toBe(true);

        const { previewBodies } = await revertThroughUi(page, flow, hostDir);
        expect(previewBodies.join("\n")).not.toContain(content);
        await expect.poll(() => existsSync(flow.hostFile), { timeout: 30000 }).toBe(true);
        const after = await checkpointView(request, sharedHeaders, sharedWs, flow.runId);
        expect(after.revert?.state).toBe("rolled_back");
    });

    // S5 ─ no captured slice ───────────────────────────────────────────────────
    test("S5: a read-only run has no slice row and an unknown slice is rejected", async ({
        page,
        request,
    }) => {
        test.skip(LLM_MODE !== "read_file", "requires XIHE_E2E_LLM_MODE=read_file");
        // Seed a real host file for the read tool (no CP registry needed for tool reads).
        mkdirSync(hostDir, { recursive: true });
        const seeded = `s5-seed-${Date.now()}.md`;
        writeFileSync(path.join(hostDir, seeded), "seed content for the read-only run\n");

        await openWorkspace(page, sharedAuth, sharedWs);
        await awaitLatestOperationTerminal(request, sharedHeaders);
        await sendChat(page, `XIHE-E2E-READ ${seeded}`);
        const runId = await currentRunId(request, sharedHeaders);
        // read_file is auto-allowed: no approval modal may appear, the run goes straight to terminal.
        const status = await awaitChatRunTerminal(request, sharedHeaders, runId);
        expect(status).toBe("succeeded");

        const rows = await workspaceCheckpointList(request, sharedHeaders, sharedWs);
        expect(
            rows.find((row) => row.sourceRunId === runId),
            "read-only run has no captured slice row",
        ).toBeUndefined();
        const missingSliceRef = "refs/xihe/slices/0-0000000000000000000000000000000000000000";
        const preview = await previewRevert(request, sharedHeaders, sharedWs, missingSliceRef);
        expect(preview.status).toBe(409);
        expect(preview.body.code).toBe("CHECKPOINT_NOT_AVAILABLE");
        expect(preview.body.detail).toContain("MISSING");
        const revert = await executeRevert(request, sharedHeaders, sharedWs, missingSliceRef);
        expect(revert.status).toBe(409);
        expect(revert.body.code).toBe("CHECKPOINT_NOT_AVAILABLE");

        // Visible result: the timeline stays honest — no restore entry for this run.
        // Asserted on the live timeline (a reload would drop it — workspace chat does not hydrate
        // persisted messages; reported product gap).
        const marker = page
            .locator('[data-testid="run-checkpoint-marker"][data-checkpoint-kind="degraded"]')
            .last();
        await expect(marker).toBeVisible({ timeout: 30000 });
        await expect(marker.getByTestId("run-checkpoint-unavailable")).toBeVisible();
        await expect(page.getByTestId("run-checkpoint-revert-entry")).toHaveCount(0);
    });

    // S6 ─ concurrency / idempotency ───────────────────────────────────────────
    test("S6: revert during an active run is rejected; back-to-back executes are idempotent", async ({
        page,
        request,
    }) => {
        test.skip(LLM_MODE !== "write_file", "requires XIHE_E2E_LLM_MODE=write_file");
        const nonce = Date.now();
        const fileName = `s6-idem-${nonce}.md`;
        const content = `S6-ROW-${nonce}`;

        await openWorkspace(page, sharedAuth, sharedWs);
        const modal = await beginApprovalRun(
            page,
            request,
            sharedHeaders,
            `XIHE-E2E-WRITE ${fileName} ${content}`,
        );
        const runId = await currentRunId(request, sharedHeaders);

        // The run is awaiting approval (non-terminal): both revert routes must refuse.
        const activeSliceRef = "refs/xihe/slices/0-0000000000000000000000000000000000000000";
        const activePreview = await previewRevert(request, sharedHeaders, sharedWs, activeSliceRef);
        expect(activePreview.status, "revert during an active run is rejected").toBe(409);
        expect(activePreview.body.code).toBe("RUN_ACTIVE");
        const activeExecute = await executeRevert(request, sharedHeaders, sharedWs, activeSliceRef);
        expect(activeExecute.status).toBe(409);
        expect(activeExecute.body.code).toBe("RUN_ACTIVE");

        await approveModal(modal);
        const hostFile = path.join(hostDir, fileName);
        await awaitHostFile(hostFile, content);
        expect(await awaitChatRunTerminal(request, sharedHeaders, runId)).toBe("succeeded");
        const view = await awaitCheckpointCaptured(request, sharedHeaders, sharedWs, runId);

        // Two sequential executes exercise idempotency; a concurrent restore is fail-fast.
        const first = await executeRevert(request, sharedHeaders, sharedWs, view.sliceRef!);
        expect(first.status).toBe(200);
        expect(first.body.counts.deleted).toBe(1);
        expect(first.body.counts.failed).toBe(0);
        const second = await executeRevert(request, sharedHeaders, sharedWs, view.sliceRef!);
        expect(second.status).toBe(200);
        expect(second.body.counts.restored).toBe(0);
        expect(second.body.counts.deleted).toBe(0);
        expect(second.body.counts.failed).toBe(0);
        expect(second.body.suspects).toEqual([]);

        // Persistence: the projection carries the last (noop) summary and the file stays deleted.
        const after = await checkpointView(request, sharedHeaders, sharedWs, runId);
        expect(after.revert?.state).toBe("rolled_back");
        expect(existsSync(hostFile)).toBe(false);

        // Attempt count: each successful execution owns one ledger item (toolCallId carries the attempt).
        const items = await operationItems(request, sharedHeaders, runId);
        const revertItems = items.filter(
            (item) => item.kind === "checkpoint" && item.toolName === "revert_checkpoint",
        );
        expect(revertItems.length, "two recorded revert attempts").toBe(2);
        expect(new Set(revertItems.map((item) => item.toolCallId)).size).toBe(2);

        // Final state is stable across a re-read.
        const stable = await checkpointView(request, sharedHeaders, sharedWs, runId);
        expect(stable).toEqual(after);
        expect(existsSync(hostFile)).toBe(false);
    });

    // S7 ─ dual diff separation ────────────────────────────────────────────────
    test("S7: slice timeline and pending-commit render as separate views with the difference copy", async ({
        page,
        request,
    }) => {
        test.skip(LLM_MODE !== "write_file", "requires XIHE_E2E_LLM_MODE=write_file");
        const nonce = Date.now();
        const repoFile = `repo-tracked-${nonce}.txt`;
        const runFile = `run-created-${nonce}.txt`;
        const content = `S7-ROW-${nonce}`;

        // User repository fixture (real host git, same workspace); S7 is ordered after S4's non-git check.
        mkdirSync(hostDir, { recursive: true });
        const git = (args: string[]) => {
            const result = spawnSync("git", ["-c", "core.autocrlf=false", ...args], {
                cwd: hostDir,
                encoding: "utf8",
            });
            expect(result.status, `git ${args.join(" ")} stderr=${result.stderr}`).toBe(0);
        };
        git(["init"]);
        git(["config", "user.name", "checkpoint-e2e"]);
        git(["config", "user.email", "checkpoint-e2e@test.local"]);
        writeFileSync(path.join(hostDir, repoFile), "committed baseline\n");
        git(["add", "--", repoFile]);
        git(["commit", "--no-gpg-sign", "-m", "init"]);

        await openWorkspace(page, sharedAuth, sharedWs);
        const flow = await writeFileRunThroughUi(
            page,
            request,
            sharedHeaders,
            sharedWs,
            hostDir,
            runFile,
            content,
        );

        // A manual edit after the run: present in `待提交`, absent from `本轮变更`.
        writeFileSync(
            path.join(hostDir, repoFile),
            "committed baseline\nuser edit after the run\n",
        );

        await page.getByTestId("workspace-toolbar-changes").click();
        const panel = page.getByTestId("workspace-changes-panel");
        await expect(panel).toBeVisible();

        // Slice timeline: authoritative workspace projection of the latest capture.
        await panel.getByTestId(`workspace-checkpoint-select-${flow.view.id}`).click();
        await expect(panel.getByTestId("workspace-checkpoint-timeline")).toContainText(
            String(flow.view.changedCount),
            { timeout: 30000 },
        );
        const runList = panel.getByTestId("workspace-checkpoint-files");
        await expect(runList).toContainText(runFile);
        await expect(runList).not.toContainText(repoFile);
        await expect(panel.getByTestId("workspace-diff-difference-note")).toContainText(
            "可能不一致",
        );

        // Pending-commit tab: user git status only — never merged with the shadow diff.
        await panel.getByTestId("workspace-diff-tab-pending").click();
        await expect(panel.getByTestId("workspace-diff-tab-pending")).toHaveAttribute(
            "aria-selected",
            "true",
        );
        await expect(panel.getByTestId("workspace-diff-tab-timeline")).toHaveAttribute(
            "aria-selected",
            "false",
        );
        const pendingList = panel.getByTestId("workspace-diff-pending-list");
        await expect(pendingList).toContainText(repoFile);
        await expect(pendingList).toContainText(runFile);
        await expect(panel.getByTestId("workspace-diff-difference-note")).toBeVisible();
    });
});
