/**
 * PLAN-0338 M1 (T1.1–T1.3) @host matrix — Run checkpoint **slice model** on the
 * isolated real stack (native CP/Agent/Runtime + Docker Sandbox + fake LLM).
 *
 * Semantics under test (2026-09-16 slice model, spec/slice-model.md):
 *   - one slice per terminal capture: `refs/xihe/slices/<epochMs>-<hash>` in
 *     `<hostRoot>/.xihe-shadow/<workspaceId>.git`;
 *   - a no-change capture writes NO slice ref (host-side for-each-ref proof);
 *   - restore is git-native against the slice (`restore` for M/D, `delete` for
 *     A) with `acknowledgeTypeChanges`, per-path outcomes + `suspects`; excluded
 *     paths (`.env`, `node_modules/`, …) are never planned and never touched;
 *   - nested repositories are opaque gitlinks (mode 160000), their contents are
 *     not part of the slice.
 *
 * Runner invocations (the fake-LLM mode selects the runnable scenarios; the
 * others self-skip — `--llm-mode=`/`XIHE_E2E_LLM_MODE` are equivalent, the spec
 * path is relative to `packages/ui`, e2e-host.mjs documents the flag form):
 *   node scripts/e2e-host.mjs --llm-mode=write_file   --retries=0 e2e/real/checkpoint-slices.spec.ts
 *   node scripts/e2e-host.mjs --llm-mode=exec_command --retries=0 e2e/real/checkpoint-slices.spec.ts
 *   node scripts/e2e-host.mjs --llm-mode=read_file    --retries=0 e2e/real/checkpoint-slices.spec.ts
 *
 * Hard constraints (xh-host-e2e-pitfalls):
 *   - ONE registered user/workspace per process: retries would re-register and
 *     the Agent cannot rebind → serial mode + `retries: 0`;
 *   - a Run must be terminal before the next send (409 CHAT_IN_PROGRESS): every
 *     send first polls the operation ledger to a terminal state;
 *   - no fixed sleeps: readiness uses expect.poll / explicit timeouts only;
 *   - the C0 baseline is materialized explicitly (first test) so slice-count
 *     deltas per Run are deterministic — otherwise the first Run under test
 *     would capture C0 and its own slice in one go.
 *
 * Evidence: structured observations are appended to
 * `.local/evidence/checkpoint-slices/<llm-mode>.jsonl` (consumed by the
 * PLAN-0338 `evidence/t1.1-host-matrix.md` write-up).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { CP_URL, registerJourneyUser, seedPage, type JourneyContext } from "./helpers/journey";

const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "mock";
const RUN_ID = process.env.XIHE_E2E_RUN_ID ?? "";
const PROJECT_DIR = path.resolve(process.cwd(), "../..");
// e2e-host passes XIHE_WORKSPACE_HOST_ROOT to its native services only; the
// Playwright env carries XIHE_E2E_RUN_ID and the runner root is
// <project>/.tmp/e2e-host/<run-id> (e2e-host.mjs:54).
const HOST_ROOT =
    process.env.XIHE_WORKSPACE_HOST_ROOT ?? path.join(PROJECT_DIR, ".tmp", "e2e-host", RUN_ID);
const EVIDENCE_DIR = path.join(PROJECT_DIR, ".local", "evidence", "checkpoint-slices");

const NONCE = Date.now().toString(36);
const SEED_FILE = `s0-seed-${NONCE}.md`;
const SEED_CONTENT = `S0-SEED-${NONCE}-read-only-target\n`;

const TERMINAL_RUN_PATTERN = /^(succeeded|failed|partial|ambiguous|cancelled)$/;
// A fresh user has an empty operation ledger until the first send — "no
// operation yet" is a ready state, not a terminal one.
const TERMINAL_OPERATION_OR_NONE = /^(completed|failed|cancelled|interrupted|ambiguous|none)$/;
const SLICE_REF_PATTERN = /^refs\/xihe\/slices\/\d+-[0-9a-f]{40}$/;

interface CheckpointChangedFile {
    status: string;
    path: string;
}

interface WorkspaceCheckpointView {
    id: string;
    sliceRef: string | null;
    capturedAt: string | null;
    sourceRunId: string | null;
    sourceSessionId: string | null;
    predecessorRef: string | null;
    state: string;
    unrollableReason: string | null;
    changedCount: number;
    changedFiles: CheckpointChangedFile[];
    opaqueNestedRepos: string[];
    truncated: boolean;
    revert: {
        state: string;
        at: string | null;
        counts: Record<string, number> | null;
        ref: string | null;
        attemptCount?: number;
    } | null;
}

interface PreviewEntry {
    path: string;
    action: string;
    state: string;
    reason?: string;
}

interface PreviewBody {
    sliceRef: string;
    counts: { restore: number; delete: number; typeConflict: number };
    entries: PreviewEntry[];
    truncated: boolean;
}

interface RevertEntry {
    path: string;
    outcome: string;
    reason?: string;
}

interface RevertBody {
    sliceRef: string;
    counts: { restored: number; deleted: number; failed: number };
    entries: RevertEntry[];
    durationMs: number;
    suspects: string[];
}

interface ProblemBody {
    code?: string;
    detail?: string;
}

// ── Evidence recorder ───────────────────────────────────────────────────────

function record(scenario: string, observed: Record<string, unknown>): void {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const line = JSON.stringify({
        at: new Date().toISOString(),
        mode: LLM_MODE,
        scenario,
        observed,
    });
    appendFileSync(path.join(EVIDENCE_DIR, `${LLM_MODE}.jsonl`), `${line}\n`);
}

function sha256(input: string | Buffer): string {
    return createHash("sha256").update(input).digest("hex");
}

// ── Host shadow-git helpers ─────────────────────────────────────────────────

function shadowGitDir(workspaceId: string): string {
    return path.join(HOST_ROOT, ".xihe-shadow", `${workspaceId}.git`);
}

/** Strict git call inside the workspace shadow repo (asserts exit 0). */
function gitShadow(workspaceId: string, args: string[]): string {
    const result = spawnSync(
        "git",
        ["--git-dir", shadowGitDir(workspaceId), "-c", "core.quotepath=false", ...args],
        {
            encoding: "utf8",
        },
    );
    expect(result.status, `git ${args.join(" ")} failed: ${result.stderr}`).toBe(0);
    return (result.stdout ?? "").trim();
}

/** Slice refs of the workspace shadow repo; [] while the repo does not exist. */
function listSliceRefs(workspaceId: string): string[] {
    if (!existsSync(shadowGitDir(workspaceId))) return [];
    const result = spawnSync(
        "git",
        [
            "--git-dir",
            shadowGitDir(workspaceId),
            "for-each-ref",
            "--format=%(refname)",
            "refs/xihe/slices",
        ],
        {
            encoding: "utf8",
        },
    );
    if (result.status !== 0) return [];
    return (result.stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

function listAllRefs(workspaceId: string): string[] {
    if (!existsSync(shadowGitDir(workspaceId))) return [];
    const result = spawnSync(
        "git",
        ["--git-dir", shadowGitDir(workspaceId), "for-each-ref", "--format=%(refname)"],
        {
            encoding: "utf8",
        },
    );
    if (result.status !== 0) return [];
    return (result.stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

/** Plain git call in an arbitrary directory (nested-repo fixture). */
function gitIn(cwd: string, args: string[]): string {
    const result = spawnSync(
        "git",
        ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args],
        {
            cwd,
            encoding: "utf8",
        },
    );
    expect(result.status, `git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`).toBe(0);
    return (result.stdout ?? "").trim();
}

// ── CP API helpers ──────────────────────────────────────────────────────────

async function runStatus(
    request: APIRequestContext,
    headers: Record<string, string>,
    runId: string,
): Promise<string> {
    const res = await request.get(`${CP_URL}/api/v1/chat/runs/${runId}`, { headers });
    if (!res.ok()) return `http-${res.status()}`;
    return ((await res.json()) as { status?: string }).status ?? "unknown";
}

/** Same-session sends must wait for the previous Run's ledger row to settle. */
async function awaitPreviousRunSettled(
    request: APIRequestContext,
    headers: Record<string, string>,
): Promise<void> {
    await expect
        .poll(
            async () => {
                const res = await request.get(`${CP_URL}/api/v1/operations?size=1`, { headers });
                const body = (await res.json()) as { operations?: Array<{ status?: string }> };
                return body.operations?.[0]?.status ?? "none";
            },
            { timeout: 180000, intervals: [1000, 2000] },
        )
        .toMatch(TERMINAL_OPERATION_OR_NONE);
}

async function awaitRunTerminal(
    request: APIRequestContext,
    headers: Record<string, string>,
    runId: string,
): Promise<string> {
    await expect
        .poll(() => runStatus(request, headers, runId), {
            timeout: 180000,
            intervals: [1000, 2000],
        })
        .toMatch(TERMINAL_RUN_PATTERN);
    return runStatus(request, headers, runId);
}

/** The terminal capture is asynchronous after the Run's terminal transition. */
async function awaitCheckpointCaptured(
    request: APIRequestContext,
    headers: Record<string, string>,
    workspaceId: string,
    runId: string,
    timeoutMs: number,
): Promise<WorkspaceCheckpointView> {
    let view: WorkspaceCheckpointView | undefined;
    await expect
        .poll(
            async () => {
                const res = await request.get(
                    `${CP_URL}/api/v1/workspaces/${workspaceId}/checkpoints`,
                    {
                        headers,
                    },
                );
                if (!res.ok()) return `http-${res.status()}`;
                const rows = (await res.json()) as WorkspaceCheckpointView[];
                view = rows.find((row) => row.sourceRunId === runId);
                return view?.state ?? "pending";
            },
            { timeout: timeoutMs, intervals: [1000, 2000] },
        )
        .toBe("captured");
    if (!view) throw new Error(`checkpoint projection never became readable for run ${runId}`);
    return view;
}

/** Wait (bounded) until a projection row exists for the run; null = no row. */
async function awaitCheckpointSettledOrNone(
    request: APIRequestContext,
    headers: Record<string, string>,
    workspaceId: string,
    runId: string,
    timeoutMs: number,
): Promise<WorkspaceCheckpointView | null> {
    let view: WorkspaceCheckpointView | null = null;
    try {
        await expect
            .poll(
                async () => {
                    const res = await request.get(
                        `${CP_URL}/api/v1/workspaces/${workspaceId}/checkpoints`,
                        { headers },
                    );
                    if (!res.ok()) return `http-${res.status()}`;
                    const rows = (await res.json()) as WorkspaceCheckpointView[];
                    view = rows.find((row) => row.sourceRunId === runId) ?? null;
                    return view ? view.state : "missing";
                },
                { timeout: timeoutMs, intervals: [1000, 2000] },
            )
            .not.toBe("missing");
    } catch {
        return null;
    }
    return view;
}

async function previewRevert(
    request: APIRequestContext,
    headers: Record<string, string>,
    workspaceId: string,
    sliceRef: string,
): Promise<{ status: number; body: PreviewBody & ProblemBody }> {
    const res = await request.post(
        `${CP_URL}/api/v1/workspaces/${workspaceId}/checkpoints/revert/preview`,
        { headers, data: { sliceRef } },
    );
    return { status: res.status(), body: (await res.json()) as PreviewBody & ProblemBody };
}

async function executeRevert(
    request: APIRequestContext,
    headers: Record<string, string>,
    workspaceId: string,
    sliceRef: string,
    acknowledgeTypeChanges: string[] = [],
): Promise<{ status: number; body: RevertBody & ProblemBody }> {
    const res = await request.post(
        `${CP_URL}/api/v1/workspaces/${workspaceId}/checkpoints/revert`,
        {
            headers,
            data: { sliceRef, acknowledgeTypeChanges },
        },
    );
    return { status: res.status(), body: (await res.json()) as RevertBody & ProblemBody };
}

async function checkpointFile(
    request: APIRequestContext,
    headers: Record<string, string>,
    workspaceId: string,
    sliceRef: string,
    filePath: string,
): Promise<string> {
    const res = await request.get(`${CP_URL}/api/v1/workspaces/${workspaceId}/checkpoints/blob`, {
        headers,
        params: { sliceRef, path: filePath },
    });
    expect(res.ok(), `checkpoint file ${res.status()} ${await res.text()}`).toBeTruthy();
    return res.text();
}

// ── Browser helpers (no fixed sleeps) ───────────────────────────────────────

async function openWorkspace(page: Page, ctx: JourneyContext): Promise<void> {
    seedPage(page, ctx);
    await page.goto(`/workspace/${ctx.workspaceId}`, { waitUntil: "load" });
    await expect(page.locator('[data-testid="chat-input"]'), "workspace chat input").toBeVisible({
        timeout: 30000,
    });
}

/**
 * Send a chat message and return the Run id from the `POST /api/v1/chat`
 * response. Retries cover the two known hazards without sleeps: a session
 * switch clearing the input asynchronously, and a click before the SSE
 * component hydrates that never POSTs (PLAN-294 M1).
 */
async function startRun(page: Page, text: string): Promise<string> {
    const input = page.locator('[data-testid="chat-input"]');
    const send = page.locator('[data-testid="chat-send-button"]');
    await expect(input).toBeVisible({ timeout: 30000 });
    for (let attempt = 0; attempt < 4; attempt += 1) {
        await input.click().catch(() => {});
        await input.fill(text).catch(() => {});
        try {
            await expect(send).toBeEnabled({ timeout: 8000 });
        } catch {
            continue;
        }
        const posted = page
            .waitForResponse(
                (response) =>
                    response.url().endsWith("/api/v1/chat") &&
                    response.request().method() === "POST",
                { timeout: 20000 },
            )
            .catch(() => null);
        await send.click().catch(() => {});
        const response = await posted;
        if (!response) continue;
        const body = (await response.json().catch(() => ({}))) as { runId?: string };
        if (body.runId) return body.runId;
    }
    throw new Error("chat send never returned a runId (POST /api/v1/chat)");
}

/** Approve the pending approval card (approval-specific testids only). */
async function approveCard(page: Page): Promise<void> {
    const card = page
        .locator('[data-testid="approval-approve"], [data-testid="approval-allow-session"]')
        .first();
    await expect(card, "approval card").toBeVisible({ timeout: 180000 });
    await card.click();
    await expect(card).toBeHidden({ timeout: 60000 });
}

/** Poll the host file until the approved tool write lands (or time out). */
async function awaitHostFile(filePath: string, expected: string, timeoutMs = 60000): Promise<void> {
    await expect
        .poll(
            () => {
                try {
                    return readFileSync(filePath, "utf8");
                } catch {
                    return "";
                }
            },
            {
                message: `expected ${filePath} to contain the tool-written content`,
                timeout: timeoutMs,
                intervals: [500, 1000, 2000],
            },
        )
        .toContain(expected);
}

// ── Spec ────────────────────────────────────────────────────────────────────

test.describe("@host PLAN-0338 checkpoint slice model (real Runtime + CP)", () => {
    test.describe.configure({ mode: "serial", retries: 0 });
    test.setTimeout(300000);

    let ctx: JourneyContext;
    let hostDir: string;

    test.beforeAll(async ({ request }) => {
        test.skip(
            !RUN_ID,
            "requires the isolated host stack (XIHE_E2E_RUN_ID); never runs against a dev stack",
        );
        ctx = await registerJourneyUser(request, "checkpoint-slices");
        hostDir = path.join(HOST_ROOT, ctx.workspaceId);
    });

    // Warm-up ─ deterministic C0 baseline ──────────────────────────────────────
    test("W: materialize the workspace and observe the C0 slice baseline", async ({ request }) => {
        // The seed file must exist BEFORE the C0 capture: the read-only scenario
        // later proves "no tree change ⇒ no slice", which only holds when the seed
        // is already part of the baseline.
        mkdirSync(hostDir, { recursive: true });
        writeFileSync(path.join(hostDir, SEED_FILE), SEED_CONTENT);

        const res = await request.post(
            `${CP_URL}/api/v1/workspaces/${ctx.workspaceId}/materialize`,
            { headers: ctx.headers },
        );
        expect([200, 202], `materialize failed: ${res.status()} ${await res.text()}`).toContain(
            res.status(),
        );

        // C0 is captured best-effort inside the materialize task — poll the shadow
        // repo until the baseline ref exists (explicit timeout, no sleeps).
        await expect
            .poll(() => listSliceRefs(ctx.workspaceId).length, {
                message: "C0 baseline slice ref must appear after materialize",
                timeout: 180000,
                intervals: [1000, 2000, 3000],
            })
            .toBeGreaterThan(0);
        const refs = listSliceRefs(ctx.workspaceId);
        expect(refs.length, "C0 is the only slice before any Run").toBe(1);
        expect(refs[0]).toMatch(SLICE_REF_PATTERN);
        expect(existsSync(path.join(hostDir, SEED_FILE))).toBe(true);
        record("warmup-c0", { workspaceId: ctx.workspaceId, refs, seedFile: SEED_FILE });
    });

    // S1 ─ L1 native tool: write_file Run → exactly one new slice ───────────────
    test("S1: write_file capture records one new slice holding the written path", async ({
        page,
        request,
    }) => {
        test.skip(
            LLM_MODE !== "write_file",
            `requires XIHE_E2E_LLM_MODE=write_file (current: ${LLM_MODE})`,
        );
        await openWorkspace(page, ctx);
        await awaitPreviousRunSettled(request, ctx.headers);
        const before = listSliceRefs(ctx.workspaceId);

        const fileName = `s1-write-${NONCE}.md`;
        const content = `S1-SLICE-${NONCE}-written-by-l1`;
        const runId = await startRun(page, `XIHE-E2E-WRITE ${fileName} ${content}`);
        await approveCard(page);
        await awaitHostFile(path.join(hostDir, fileName), content);
        expect(await awaitRunTerminal(request, ctx.headers, runId)).toBe("succeeded");

        const view = await awaitCheckpointCaptured(
            request,
            ctx.headers,
            ctx.workspaceId,
            runId,
            30000,
        );
        expect(
            view.changedCount,
            "the written file is part of the capture change set",
        ).toBeGreaterThanOrEqual(1);
        expect(view.changedFiles.map((file) => file.path)).toContain(fileName);

        expect(view.sliceRef).toBeTruthy();
        const preview = await previewRevert(request, ctx.headers, ctx.workspaceId, view.sliceRef!);
        expect(preview.status, `preview ${preview.status} ${JSON.stringify(preview.body)}`).toBe(
            200,
        );
        expect(preview.body.sliceRef).toMatch(SLICE_REF_PATTERN);

        const after = listSliceRefs(ctx.workspaceId);
        expect(
            after.length,
            `slice refs grew by exactly 1 (${before.length} → ${after.length})`,
        ).toBe(before.length + 1);
        if (before.length === 0)
            expect(after.length, "first capture writes exactly one slice").toBe(1);
        expect(after, "the new ref is the Run slice").toContain(preview.body.sliceRef);

        const hostFile = path.join(hostDir, fileName);
        expect(existsSync(hostFile), "approved write_file lands on the host").toBe(true);
        expect(readFileSync(hostFile, "utf8")).toContain(content);
        record("s1-write-file", {
            runId,
            before,
            after,
            state: view.state,
            changedCount: view.changedCount,
            changedFiles: view.changedFiles,
            sliceRef: preview.body.sliceRef,
        });
    });

    // S2 ─ excluded paths zero-touch + preview/restore convergence ─────────────
    test("S2: excluded paths are never planned; preview/restore cover M/A/D and converge", async ({
        page,
        request,
    }) => {
        test.skip(
            LLM_MODE !== "write_file",
            `requires XIHE_E2E_LLM_MODE=write_file (current: ${LLM_MODE})`,
        );
        await openWorkspace(page, ctx);
        await awaitPreviousRunSettled(request, ctx.headers);

        const envRel = ".env";
        const envContent = `S2-ENV-SECRET-${NONCE}\n`;
        const keepRel = `s2-keep-${NONCE}.txt`;
        const delRel = `s2-del-${NONCE}.txt`;
        const addRel = `s2-add-${NONCE}.txt`;
        const runRel = `s2-run-${NONCE}.txt`;
        const nodeRel = `node_modules/s2-pkg-${NONCE}/data.txt`;
        const keepOriginal = `S2-KEEP-ORIGINAL-${NONCE}\n`;
        const delOriginal = `S2-DEL-ORIGINAL-${NONCE}\n`;
        const nodeOriginal = `S2-NODE-ORIGINAL-${NONCE}\n`;
        const nodeMutated = `S2-NODE-MUTATED-${NONCE}\n`;
        const keepMutated = `S2-KEEP-MUTATED-${NONCE}\n`;

        // Seeds must exist before the capture; `.env` + node_modules/ are excluded.
        mkdirSync(path.join(hostDir, path.dirname(nodeRel)), { recursive: true });
        writeFileSync(path.join(hostDir, envRel), envContent);
        writeFileSync(path.join(hostDir, keepRel), keepOriginal);
        writeFileSync(path.join(hostDir, delRel), delOriginal);
        writeFileSync(path.join(hostDir, nodeRel), nodeOriginal);

        const content = `S2-RUN-${NONCE}`;
        const runId = await startRun(page, `XIHE-E2E-WRITE ${runRel} ${content}`);
        await approveCard(page);
        await awaitHostFile(path.join(hostDir, runRel), content);
        expect(await awaitRunTerminal(request, ctx.headers, runId)).toBe("succeeded");
        const view = await awaitCheckpointCaptured(
            request,
            ctx.headers,
            ctx.workspaceId,
            runId,
            60000,
        );

        // Direct workspace mutations after the capture: M + A + D plus one excluded
        // path the restore must never touch.
        writeFileSync(path.join(hostDir, keepRel), keepMutated);
        writeFileSync(path.join(hostDir, addRel), `S2-ADD-AFTER-${NONCE}\n`);
        unlinkSync(path.join(hostDir, delRel));
        writeFileSync(path.join(hostDir, nodeRel), nodeMutated);

        const envHashBefore = sha256(readFileSync(path.join(hostDir, envRel)));

        expect(view.sliceRef).toBeTruthy();
        const preview = await previewRevert(request, ctx.headers, ctx.workspaceId, view.sliceRef!);
        expect(preview.status, `preview ${preview.status} ${JSON.stringify(preview.body)}`).toBe(
            200,
        );
        const paths = preview.body.entries.map((entry) => entry.path);
        expect(preview.body.counts, "M/A/D plan counts (restore=M+D, delete=A)").toEqual({
            restore: 2,
            delete: 1,
            typeConflict: 0,
        });
        expect(preview.body.entries.length).toBe(3);
        expect(preview.body.truncated).toBe(false);
        const entryByPath = new Map(preview.body.entries.map((entry) => [entry.path, entry]));
        expect(entryByPath.get(keepRel), "modified file is restored").toMatchObject({
            action: "restore",
            state: "execute",
        });
        expect(entryByPath.get(delRel), "deleted file is restored").toMatchObject({
            action: "restore",
            state: "execute",
        });
        expect(entryByPath.get(addRel), "post-capture file is deleted").toMatchObject({
            action: "delete",
            state: "execute",
        });
        expect(paths, "excluded .env is never planned").not.toContain(envRel);
        expect(
            paths.some((entry) => entry.startsWith("node_modules/")),
            "excluded node_modules/ is never planned",
        ).toBe(false);

        // The slice itself carries the original contents (read-only blob check).
        expect(
            await checkpointFile(
                request,
                ctx.headers,
                ctx.workspaceId,
                preview.body.sliceRef,
                keepRel,
            ),
        ).toBe(keepOriginal);
        expect(
            await checkpointFile(
                request,
                ctx.headers,
                ctx.workspaceId,
                preview.body.sliceRef,
                delRel,
            ),
        ).toBe(delOriginal);

        const revert = await executeRevert(
            request,
            ctx.headers,
            ctx.workspaceId,
            preview.body.sliceRef,
            [],
        );
        expect(revert.status, `revert ${revert.status} ${JSON.stringify(revert.body)}`).toBe(200);
        expect(revert.body.counts, "restore outcome counts").toEqual({
            restored: 2,
            deleted: 1,
            failed: 0,
        });
        expect(revert.body.suspects, "no concurrent write during the restore").toEqual([]);
        const outcomeByPath = new Map(
            revert.body.entries.map((entry) => [entry.path, entry.outcome]),
        );
        expect(outcomeByPath.get(keepRel)).toBe("restored");
        expect(outcomeByPath.get(delRel)).toBe("restored");
        expect(outcomeByPath.get(addRel)).toBe("deleted");

        // Disk: the slice content is back, the post-capture file is gone, excluded
        // paths were not touched (hash + content stable for `.env`).
        expect(readFileSync(path.join(hostDir, keepRel), "utf8")).toBe(keepOriginal);
        expect(readFileSync(path.join(hostDir, delRel), "utf8")).toBe(delOriginal);
        expect(
            existsSync(path.join(hostDir, addRel)),
            "post-capture file removed by the restore",
        ).toBe(false);
        expect(
            readFileSync(path.join(hostDir, nodeRel), "utf8"),
            "excluded node_modules/ untouched",
        ).toBe(nodeMutated);
        expect(readFileSync(path.join(hostDir, envRel), "utf8"), "excluded .env untouched").toBe(
            envContent,
        );
        const envHashAfter = sha256(readFileSync(path.join(hostDir, envRel)));
        expect(envHashAfter, ".env sha256 unchanged across the restore").toBe(envHashBefore);

        // Converged state: the re-preview is empty and the second execute is a no-op.
        const converged = await previewRevert(
            request,
            ctx.headers,
            ctx.workspaceId,
            preview.body.sliceRef,
        );
        expect(converged.status).toBe(200);
        expect(converged.body.counts).toEqual({ restore: 0, delete: 0, typeConflict: 0 });
        expect(converged.body.entries).toEqual([]);
        const idempotent = await executeRevert(
            request,
            ctx.headers,
            ctx.workspaceId,
            preview.body.sliceRef,
            [],
        );
        expect(idempotent.status).toBe(200);
        expect(idempotent.body.counts, "second restore is idempotent").toEqual({
            restored: 0,
            deleted: 0,
            failed: 0,
        });
        expect(idempotent.body.suspects).toEqual([]);

        record("s2-excluded-and-restore", {
            runId,
            sliceRef: preview.body.sliceRef,
            previewCounts: preview.body.counts,
            previewEntries: preview.body.entries,
            revertCounts: revert.body.counts,
            revertEntries: revert.body.entries,
            suspects: revert.body.suspects,
            convergedCounts: converged.body.counts,
            idempotentCounts: idempotent.body.counts,
            envHashBefore,
            envHashAfter,
        });
    });

    // S3 ─ nested repository is an opaque gitlink ──────────────────────────────
    test("S3: nested repository is captured as an opaque gitlink (mode 160000)", async ({
        page,
        request,
    }) => {
        test.skip(
            LLM_MODE !== "write_file",
            `requires XIHE_E2E_LLM_MODE=write_file (current: ${LLM_MODE})`,
        );
        await openWorkspace(page, ctx);
        await awaitPreviousRunSettled(request, ctx.headers);

        const subRepo = path.join(hostDir, "sub-repo");
        mkdirSync(subRepo, { recursive: true });
        gitIn(subRepo, ["init"]);
        writeFileSync(path.join(subRepo, "tracked.txt"), `S3-NESTED-${NONCE}\n`);
        gitIn(subRepo, ["add", "--", "tracked.txt"]);
        gitIn(subRepo, [
            "-c",
            "user.name=checkpoint-e2e",
            "-c",
            "user.email=checkpoint-e2e@test.local",
            "commit",
            "--no-gpg-sign",
            "-m",
            "nested baseline",
        ]);

        const fileName = `s3-run-${NONCE}.txt`;
        const content = `S3-RUN-${NONCE}`;
        const runId = await startRun(page, `XIHE-E2E-WRITE ${fileName} ${content}`);
        await approveCard(page);
        await awaitHostFile(path.join(hostDir, fileName), content);
        expect(await awaitRunTerminal(request, ctx.headers, runId)).toBe("succeeded");
        const view = await awaitCheckpointCaptured(
            request,
            ctx.headers,
            ctx.workspaceId,
            runId,
            60000,
        );

        expect(view.sliceRef).toBeTruthy();
        const preview = await previewRevert(request, ctx.headers, ctx.workspaceId, view.sliceRef!);
        expect(preview.status, `preview ${preview.status} ${JSON.stringify(preview.body)}`).toBe(
            200,
        );
        const sliceRef = preview.body.sliceRef;
        expect(sliceRef).toMatch(SLICE_REF_PATTERN);

        const treeLines = gitShadow(ctx.workspaceId, ["ls-tree", "-r", sliceRef])
            .split(/\r?\n/)
            .filter(Boolean);
        const gitlink = treeLines.filter((line) => line.endsWith("\tsub-repo"));
        expect(gitlink.length, "sub-repo is one tree entry").toBe(1);
        expect(
            gitlink[0].startsWith("160000 commit "),
            `gitlink mode 160000 (got: ${gitlink[0]})`,
        ).toBe(true);
        expect(
            treeLines.some((line) => line.includes("sub-repo/")),
            "nested contents are not part of the slice",
        ).toBe(false);
        expect(
            treeLines.some((line) => line.endsWith(`\t${fileName}`)),
            "the Run file is in the slice",
        ).toBe(true);

        // The projection reports the gitlink path as part of this Run's change set.
        const changedPaths = view.changedFiles.map((file) => file.path);
        expect(changedPaths).toContain(fileName);
        expect(changedPaths, "gitlink path is in the capture change set").toContain("sub-repo");
        expect(
            view.opaqueNestedRepos,
            "opaque nested repos are exposed by the projection",
        ).toContain("sub-repo");
        expect(preview.body.opaqueNestedRepos).toContain("sub-repo");

        record("s3-nested-repo", {
            runId,
            sliceRef,
            gitlink: gitlink[0],
            treeEntries: treeLines.length,
            changedFiles: view.changedFiles,
        });
    });

    // S4 ─ L2 exec/shell write is captured ─────────────────────────────────────
    test("S4: exec_command shell write lands in the next slice", async ({ page, request }) => {
        test.skip(
            LLM_MODE !== "exec_command",
            `requires XIHE_E2E_LLM_MODE=exec_command (current: ${LLM_MODE})`,
        );
        await openWorkspace(page, ctx);
        await awaitPreviousRunSettled(request, ctx.headers);
        const before = listSliceRefs(ctx.workspaceId);

        const fileName = `s4-shell-${NONCE}.txt`;
        const content = `S4-SHELL-${NONCE}`;
        const runId = await startRun(page, `XIHE-E2E-EXEC echo ${content} > ${fileName}`);
        await approveCard(page);
        await awaitHostFile(path.join(hostDir, fileName), content);
        expect(await awaitRunTerminal(request, ctx.headers, runId)).toBe("succeeded");

        const view = await awaitCheckpointCaptured(
            request,
            ctx.headers,
            ctx.workspaceId,
            runId,
            60000,
        );
        expect(
            view.changedFiles.map((file) => file.path),
            "shell-written file is in the capture change set",
        ).toContain(fileName);

        expect(view.sliceRef).toBeTruthy();
        const preview = await previewRevert(request, ctx.headers, ctx.workspaceId, view.sliceRef!);
        expect(preview.status, `preview ${preview.status} ${JSON.stringify(preview.body)}`).toBe(
            200,
        );
        expect(preview.body.sliceRef).toMatch(SLICE_REF_PATTERN);

        const after = listSliceRefs(ctx.workspaceId);
        expect(
            after.length,
            `slice refs grew by exactly 1 (${before.length} → ${after.length})`,
        ).toBe(before.length + 1);
        expect(after).toContain(preview.body.sliceRef);

        record("s4-exec-command", {
            runId,
            before,
            after,
            state: view.state,
            changedCount: view.changedCount,
            changedFiles: view.changedFiles,
            sliceRef: preview.body.sliceRef,
        });
    });

    // S5 ─ read-only Run: no tree change ⇒ no slice ref ────────────────────────
    test("S5: read-only Run writes no slice and keeps the projection at changedCount 0", async ({
        page,
        request,
    }) => {
        test.skip(
            LLM_MODE !== "read_file",
            `requires XIHE_E2E_LLM_MODE=read_file (current: ${LLM_MODE})`,
        );
        await openWorkspace(page, ctx);
        await awaitPreviousRunSettled(request, ctx.headers);
        const before = listSliceRefs(ctx.workspaceId);

        const runId = await startRun(page, `XIHE-E2E-READ ${SEED_FILE}`);
        // read_file is auto-allowed: no approval card may gate the Run.
        expect(await awaitRunTerminal(request, ctx.headers, runId)).toBe("succeeded");

        // The no-change capture is asynchronous; bounded settle then host proof.
        const view = await awaitCheckpointSettledOrNone(
            request,
            ctx.headers,
            ctx.workspaceId,
            runId,
            60000,
        );
        if (view === null) {
            console.warn(
                `[checkpoint-slices] no projection row for read-only run ${runId} (no-new-row variant)`,
            );
        } else {
            expect("captured", `read-only capture state (got ${view.state})`).toBe(view.state);
            expect(view.changedCount, "no-change capture has an empty change set").toBe(0);
        }

        const after = listSliceRefs(ctx.workspaceId);
        expect(after, "no-change Run writes no slice ref").toEqual(before);

        record("s5-read-only-no-change", {
            runId,
            before,
            after,
            state: view?.state ?? "missing",
            changedCount: view?.changedCount ?? 0,
            changedFiles: view?.changedFiles ?? [],
        });
    });

    // Ref namespace ─ only workspace slice refs are exposed ────────────────────
    test("S6: the shadow ref namespace exposes slice refs only", async () => {
        const refs = listAllRefs(ctx.workspaceId);
        expect(refs.length, "C0 baseline guarantees at least one slice ref").toBeGreaterThan(0);
        for (const ref of refs) {
            expect(ref, `unexpected/legacy ref shape: ${ref}`).toMatch(SLICE_REF_PATTERN);
        }
        record("s6-ref-namespace", { refs });
    });

    // S8 ─ explicit cleanup removes refs and allows a fresh C0 bootstrap ────────
    test("S8: cleanup physically clears refs and the next materialize bootstraps again", async ({
        request,
    }) => {
        const before = listSliceRefs(ctx.workspaceId);
        expect(before.length, "cleanup requires an existing slice ref").toBeGreaterThan(0);

        const cleanup = await request.post(
            `${CP_URL}/api/v1/workspaces/${ctx.workspaceId}/checkpoints/cleanup`,
            { headers: ctx.headers, data: { acknowledge: true } },
        );
        const cleanupBody = await cleanup.json();
        expect(cleanup.status(), JSON.stringify(cleanupBody)).toBe(200);
        expect(cleanupBody.removed).toBe(true);
        await expect
            .poll(() => listSliceRefs(ctx.workspaceId).length, {
                message: "cleanup must remove all shadow slice refs",
                timeout: 60000,
                intervals: [1000, 2000, 3000],
            })
            .toBe(0);

        const rematerialize = await request.post(
            `${CP_URL}/api/v1/workspaces/${ctx.workspaceId}/materialize`,
            { headers: ctx.headers },
        );
        expect([200, 202]).toContain(rematerialize.status());
        await expect
            .poll(() => listSliceRefs(ctx.workspaceId).length, {
                message: "materialize must bootstrap a fresh C0 slice after cleanup",
                timeout: 180000,
                intervals: [1000, 2000, 3000],
            })
            .toBeGreaterThan(0);
        record("s8-cleanup-bootstrap", {
            before,
            afterCleanup: listSliceRefs(ctx.workspaceId),
        });
    });
});
