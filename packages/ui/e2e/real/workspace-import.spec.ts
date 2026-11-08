// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { test, expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateE2EPassword } from "./helpers/password";
import { ensureWorkspace } from "./helpers/workspace";
import { dockerFrozenIncluded, dockerFrozenReason } from "./helpers/docker-frozen";
import { EXPECT_TIMEOUT_MS, LONG_TIMEOUT_MS, TEST_TIMEOUT_MS } from "../timeouts";

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;

interface ImportUser {
    token: string;
    wsId: string;
}

test.describe("@host Workspace import", () => {
    test.describe.configure({ mode: "serial" });

    let sourceDir = "",
        oversizedFile = "";
    const bulkDirs: string[] = [],
        users: ImportUser[] = [];

    function hostRoot(): string {
        if (process.env.XIHE_WORKSPACE_HOST_ROOT)
            return path.resolve(process.env.XIHE_WORKSPACE_HOST_ROOT);
        const runId = process.env.XIHE_E2E_RUN_ID;
        if (runId) return path.resolve(process.cwd(), "..", "..", ".tmp", "e2e-host", runId);
        return path.resolve("..", "..", ".xihe-workspaces");
    }

    /**
     * Managed import targets must be empty, so every import test registers its own user:
     * the auto-created default workspace is fresh, and the access token's workspace context
     * matches the page the import dialog is opened from.
     */
    async function registerUser(request: APIRequestContext, tag: string): Promise<ImportUser> {
        const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `workspace-import-${tag}-${Date.now()}@test.com`,
                password: SHARED_PASSWORD,
                name: `Import ${tag}`,
            },
        });
        expect(
            [200, 201],
            `register ${tag} failed: ${response.status()} ${await response.text()}`,
        ).toContain(response.status());
        const body = await response.json();
        // PLAN-0614: registration no longer creates a workspace — create one explicitly.
        const user = {
            token: body.accessToken as string,
            wsId: await ensureWorkspace(request, body.accessToken as string),
        };
        expect(user.wsId).toBeTruthy();
        users.push(user);
        return user;
    }

    function seedPage(page: Page, user: ImportUser) {
        page.addInitScript((token) => localStorage.setItem("xihe-token", token), user.token);
        page.addInitScript(
            (raw) => localStorage.setItem("xihe-user", raw),
            JSON.stringify({
                id: "e2e-import",
                email: "import@test.com",
                name: "Import UI",
                workspaceId: user.wsId,
            }),
        );
        page.addInitScript(
            (workspace) => localStorage.setItem("xihe-workspace", JSON.stringify(workspace)),
            {
                id: user.wsId,
                name: "Import Workspace",
            },
        );
        page.addInitScript((id) => localStorage.setItem("xihe-workspace-id", id), user.wsId);
    }

    async function startImportFrom(
        page: Page,
        user: ImportUser,
        source: string,
        options: { read?: boolean } = {},
    ) {
        await page.goto(`/workspace/${user.wsId}`, { waitUntil: "load" });
        await page.getByTestId("workspace-toolbar-import-source").click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await dialog.getByPlaceholder("Runtime 可访问的目录路径").fill(source);
        if (options.read !== false) await dialog.getByRole("button", { name: "读取" }).click();
        await dialog.getByRole("button", { name: "开始导入" }).click();
        return dialog;
    }

    test.beforeAll(async () => {
        sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "xihe-import-"));
        fs.mkdirSync(path.join(sourceDir, "src"));
        fs.writeFileSync(path.join(sourceDir, "src", "imported.md"), "# Imported\n");
        fs.mkdirSync(path.join(sourceDir, "node_modules"));
        fs.writeFileSync(path.join(sourceDir, "node_modules", "ignored.js"), "ignored\n");
        oversizedFile = path.join(sourceDir, "oversized.bin");
        fs.writeFileSync(oversizedFile, Buffer.alloc(64 * 1024 * 1024 + 1));
    });

    test.afterAll(async ({ request }) => {
        // Workspace files live under the isolated host root, which the runner recycles at
        // teardown; only the test-created temp source trees need explicit removal here.
        // PLAN-0586: 90 s budget (formerly 180 s) keeps ~3x headroom over the measured
        // ~31 s concurrent teardown while staying far below the old serial worst case.
        test.setTimeout(TEST_TIMEOUT_MS);
        if (sourceDir) fs.rmSync(sourceDir, { recursive: true, force: true });
        for (const dir of bulkDirs) fs.rmSync(dir, { recursive: true, force: true });
        // PLAN-0586: CP workspace DELETE takes ~11 s each here (active-job/cleanup gate),
        // so issue the independent deletes concurrently instead of serially. The runner's
        // teardown still performs the residual check on the isolated host root.
        const results = await Promise.all(
            users.map(async (user) => {
                try {
                    const response = await request.delete(
                        `${CP_URL}/api/v1/workspaces/${user.wsId}`,
                        { headers: { Authorization: `Bearer ${user.token}` } },
                    );
                    return { wsId: user.wsId, status: response.status() };
                } catch (error) {
                    // Keep the failure reason visible without leaking headers/tokens: the
                    // APIRequestContext error message carries the URL/method only.
                    const reason =
                        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
                    return { wsId: user.wsId, status: 0, reason: reason.slice(0, 300) };
                }
            }),
        );
        const unexpected = results.filter((row) => row.status !== 204 && row.status !== 404);
        if (unexpected.length > 0) {
            console.warn(`PLAN-0586 workspace teardown unexpected: ${JSON.stringify(unexpected)}`);
        }
    });
    test("imports a Runtime-visible source directory without creating a Session", async ({
        page,
        request,
    }) => {
        test.skip(
            !dockerFrozenIncluded,
            dockerFrozenReason(
                "the managed import pipeline imports a Runtime-visible source directory without creating a Session",
            ),
        );
        const user = await registerUser(request, "basic");
        seedPage(page, user);
        const dialog = await startImportFrom(page, user, sourceDir);
        await expect(dialog.getByRole("button", { name: /src/ })).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(dialog).toBeHidden({ timeout: LONG_TIMEOUT_MS });
    });

    test("copies the source tree into the managed workspace", async ({ page, request }) => {
        test.skip(
            !dockerFrozenIncluded,
            dockerFrozenReason(
                "the managed import pipeline copies the source tree into the managed workspace",
            ),
        );
        const user = await registerUser(request, "copy");
        seedPage(page, user);
        const dialog = await startImportFrom(page, user, sourceDir);
        await expect(dialog.getByRole("button", { name: /src/ })).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(dialog).toBeHidden({ timeout: LONG_TIMEOUT_MS });

        // PLAN-0384 V5: durable completion must correspond to real copied files.
        const copied = path.join(hostRoot(), user.wsId, "src", "imported.md");
        await expect.poll(() => fs.existsSync(copied), { timeout: LONG_TIMEOUT_MS }).toBe(true);
        expect(fs.readFileSync(copied, "utf8")).toContain("Imported");
        expect(fs.existsSync(path.join(hostRoot(), user.wsId, "node_modules"))).toBe(false);
    });

    test("recovers an in-flight import after a reload", async ({ page, request }) => {
        test.skip(
            !dockerFrozenIncluded,
            dockerFrozenReason("an in-flight managed import is recovered after a page reload"),
        );
        const user = await registerUser(request, "recover");
        seedPage(page, user);
        const bulkDir = fs.mkdtempSync(path.join(os.tmpdir(), "xihe-import-bulk-"));
        bulkDirs.push(bulkDir);
        for (let index = 0; index < 8000; index += 1) {
            fs.writeFileSync(path.join(bulkDir, `file-${index}.txt`), `payload ${index}\n`);
        }

        await startImportFrom(page, user, bulkDir);
        await expect(page.getByTestId("workspace-import-status")).toContainText("进行中", {
            timeout: LONG_TIMEOUT_MS,
        });

        // Disconnect (reload) mid-import; the durable record must restore the in-flight import.
        await page.reload({ waitUntil: "load" });
        await page.getByTestId("workspace-toolbar-import-source").click();
        await expect(page.getByTestId("workspace-import-recovered")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await expect(page.getByTestId("workspace-import-status")).toContainText("进行中");

        // The resumed import reaches durable completion (the dialog closes on completion).
        await expect(page.getByRole("dialog")).toBeHidden({ timeout: LONG_TIMEOUT_MS });
        await expect
            .poll(() => fs.existsSync(path.join(hostRoot(), user.wsId, "file-0.txt")), {
                timeout: LONG_TIMEOUT_MS,
            })
            .toBe(true);
    });

    test("cancels a running import from the dialog", async ({ page, request }) => {
        test.skip(
            !dockerFrozenIncluded,
            dockerFrozenReason(
                "a running managed import can be cancelled from the dialog and the workspace reaches the cancelled state",
            ),
        );
        const user = await registerUser(request, "cancel");
        seedPage(page, user);
        const bulkDir = fs.mkdtempSync(path.join(os.tmpdir(), "xihe-import-cancel-"));
        bulkDirs.push(bulkDir);
        for (let index = 0; index < 8000; index += 1) {
            fs.writeFileSync(path.join(bulkDir, `file-${index}.txt`), `payload ${index}\n`);
        }

        await startImportFrom(page, user, bulkDir);
        await expect(page.getByTestId("workspace-import-cancel")).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await page.getByTestId("workspace-import-cancel").click();

        // PLAN-0384 V5: cancellation is reflected in the dialog and the durable record.
        // 2026-10-29: on loaded full-matrix runs (mock-full + one isolated rerun)
        // the docker import job's cancel acknowledgement sometimes took >30 s and
        // the assertion flipped between 排队中/进行中; the same case passed in 9 s
        // on a clean rerun. Keep the assertion unchanged, only widen the headroom
        // so machine load does not turn it into a false red (no retry, no weaken).
        await expect(page.getByTestId("workspace-import-status")).toContainText("已取消", {
            timeout: LONG_TIMEOUT_MS,
        });
        await expect(page.getByTestId("workspace-import-cancel")).toBeHidden();
    });

    test("reports a failed import for a missing source directory", async ({ page, request }) => {
        const user = await registerUser(request, "missing");
        seedPage(page, user);
        // Skip the source listing: the point is the import start path failing visibly.
        await startImportFrom(page, user, path.join(os.tmpdir(), `xihe-missing-${Date.now()}`), {
            read: false,
        });

        // PLAN-0384 V5: the failure is visible in the UI (durable status carries the reason).
        await expect(page.getByTestId("workspace-import-status")).toContainText(/导入失败/, {
            timeout: LONG_TIMEOUT_MS,
        });
    });

    test("rejects Workspace file-tool payloads above 64 MiB before transport", async ({
        page,
        request,
    }) => {
        const user = await registerUser(request, "oversized");
        seedPage(page, user);
        await page.goto(`/workspace/${user.wsId}`, { waitUntil: "load" });
        await page.getByTitle("Upload files").click();
        const uploadInput = page.locator('input[type="file"]').last();
        await expect(uploadInput).toBeAttached();
        await uploadInput.setInputFiles(oversizedFile);
        await page.getByRole("button", { name: "导入" }).click();
        const bodyText = await page.locator("body").innerText();
        await expect(page.locator('[title*="PAYLOAD_TOO_LARGE"]'), bodyText).toBeVisible();
        await expect(page.getByText("oversized.bin")).toBeVisible();
    });
});
