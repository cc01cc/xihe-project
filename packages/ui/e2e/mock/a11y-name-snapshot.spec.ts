// timeout-exempt: 8 个核心面 × zh/en 两轮，逐元素取 ariaSnapshot（LONG_TIMEOUT_MS 25 s 预算）。
/**
 * task-762（W2 / P2-3）：可访问名称快照门。
 *
 * 只收「role + accessible name」这一层，不收像素/截图：
 *   - 枚举页面内可见的 `button` / `a` / `input` / `[role=combobox]`；
 *   - 用 Playwright 的 `locator.ariaSnapshot()`（浏览器原生 AX 计算）取首行的 role/name；
 *   - 对结果按 role、name 排序后落 JSON，zh-CN / en-US 各一份。
 *
 * 覆盖合同列出的 8 个核心面（与 task-753 同口径）：
 *   ① 会话列表 ② 聊天/composer ③ TO 指派 ④ 成员面板
 *   ⑤ 设置（Provider/模型） ⑥ 审批浮层 ⑦ 运行状态/错误态 ⑧ 首装/登录
 *
 * 快照落点（均在 task-762 写域内）：
 *   baseline: internal/A03-xihe/evidence/2026-11-22-w2-a11y-name-snapshot/baseline/
 *   current : A03-xihe/packages/ui/test-results/a11y-name-snapshot/（运行产物，不入库）
 *
 * 首轮基线：`XIHE_A11Y_SNAPSHOT_UPDATE=1` 跑本 spec。
 * 日常/CI：不设该变量 ⇒ 与基线比对，新增/删除/改名逐条失败。
 * 红线：空名与 en 轮次 CJK **永不因更新基线而变绿**（每次都单独断言）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { setupMockParticipants } from "./helpers/session-matrix";
import { installApprovalSSE } from "./helpers/approval-sse";
import { pushMockApproval } from "./helpers/approval-registry";
import { EXPECT_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "task762-session";
const AGENT_PRINCIPAL_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const RUN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

const LOCALES = ["zh-CN", "en-US"] as const;
type Locale = (typeof LOCALES)[number];

const UPDATE_BASELINE = process.env.XIHE_A11Y_SNAPSHOT_UPDATE === "1";
const MOCK_DIR = import.meta.dirname;
const BASELINE_DIR =
    process.env.XIHE_A11Y_SNAPSHOT_BASELINE ??
    path.resolve(
        MOCK_DIR,
        "../../../../../internal/A03-xihe/evidence/2026-11-22-w2-a11y-name-snapshot/baseline",
    );
const CURRENT_DIR =
    process.env.XIHE_A11Y_SNAPSHOT_CURRENT ??
    path.resolve(MOCK_DIR, "../../test-results/a11y-name-snapshot");

const CJK = /[\u4e00-\u9fff]/;
const CANDIDATE_SELECTOR = 'button, a, input, [role="combobox"]';

interface NameEntry {
    role: string;
    name: string;
}

interface CapturedEntry extends NameEntry {
    /** 仅失败信息用：空名元素的定位提示，不写入快照。 */
    detail?: string;
}

interface FaceSnapshot {
    task: "task-762";
    face: { id: string; label: string };
    locales: Record<Locale, NameEntry[]>;
}

interface Face {
    id: string;
    label: string;
    url: string;
    prepare?: (page: Page) => Promise<void>;
    ready: (page: Page) => Promise<void>;
    afterReady?: (page: Page) => Promise<void>;
}

const approvalEvent = {
    requestId: REQUEST_ID,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    tool: "request_approval",
    action: "delete file",
    details: "workspace/README.md",
    argumentsHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    state: "pending",
    replayed: false,
    policy: {
        effect: "ask",
        sourceLayer: "workspace",
        matchedRule: null,
        reason: "No matching allow rule",
        mode: "manual",
        actionClass: "delete",
        shape: "structured",
    },
};

async function bootWorkspaceShell(page: Page): Promise<void> {
    await setupMockAuth(page);
    await setupMockSessions(page, {
        sessions: [{ id: SESSION_ID, title: "a11y names", agentPrincipalId: AGENT_PRINCIPAL_ID }],
        workspaceId: WORKSPACE_ID,
    });
}

async function serveMembersProjection(page: Page): Promise<void> {
    await page.route("**/api/v1/me/permissions", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                userId: "user-1",
                instanceCapabilities: [],
                instancePermissions: [],
                workspaces: [
                    {
                        workspaceId: WORKSPACE_ID,
                        workspaceRole: "OWNER",
                        workspaceAdmin: true,
                        permissions: ["WRITE_WORKSPACE_CONTENT"],
                    },
                ],
            }),
        }),
    );
    await page.route(`**/api/v1/workspaces/${WORKSPACE_ID}/members**`, (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([]),
        }),
    );
}

async function serveWorkspaceEnvironment(page: Page): Promise<void> {
    await page.route("**/api/v1/workspaces/*/environment", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                workspaceId: WORKSPACE_ID,
                status: "ready",
                storageBackend: "host_directory",
                storageRef: WORKSPACE_ID,
                executionSpec: { status: "assigned", generation: 1, sandboxSpecHash: "task762" },
                runtime: { status: "ready", deviceId: "task762-device", lastHeartbeatAt: "now" },
            }),
        }),
    );
}

async function serveApprovalDeps(page: Page): Promise<void> {
    await page.route("**/api/v1/policy/mode*", (route) => {
        const url = new URL(route.request().url());
        const sessionId = url.searchParams.get("sessionId") ?? SESSION_ID;
        void route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessionId, mode: "manual", sessionRules: 0 }),
        });
    });
    await installApprovalSSE(page, { sessionId: SESSION_ID, runId: RUN_ID });
}

const FACES: Face[] = [
    {
        id: "01-session-list",
        label: "① 会话列表 / 工作区外壳",
        url: `/workspace/${WORKSPACE_ID}`,
        prepare: bootWorkspaceShell,
        ready: async (page) => {
            await expect(page.getByTestId("sidebar")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        },
    },
    {
        id: "02-chat-composer",
        label: "② 聊天 / composer",
        url: `/workspace/${WORKSPACE_ID}/session/${SESSION_ID}`,
        prepare: bootWorkspaceShell,
        ready: async (page) => {
            await expect(page.getByTestId("chat-input")).toBeVisible({
                timeout: LONG_TIMEOUT_MS,
            });
        },
    },
    {
        id: "03-to-assignment",
        label: "③ TO 指派（发送栏）",
        url: `/workspace/${WORKSPACE_ID}/session/${SESSION_ID}`,
        prepare: async (page) => {
            await bootWorkspaceShell(page);
            await setupMockParticipants(page, SESSION_ID);
        },
        ready: async (page) => {
            await expect(page.getByTestId("to-targets-bar")).toBeVisible({
                timeout: LONG_TIMEOUT_MS,
            });
        },
    },
    {
        id: "04-members",
        label: "④ 成员面板",
        url: `/workspace/${WORKSPACE_ID}/members`,
        prepare: async (page) => {
            await bootWorkspaceShell(page);
            await serveMembersProjection(page);
        },
        ready: async (page) => {
            await expect(page.getByTestId("workspace-members-page")).toBeVisible({
                timeout: LONG_TIMEOUT_MS,
            });
        },
    },
    {
        id: "05-settings-provider",
        label: "⑤ 设置（Provider/模型）",
        url: "/settings/user/llm-provider",
        prepare: bootWorkspaceShell,
        ready: async (page) => {
            await expect(page.getByTestId("provider-hub")).toBeVisible({
                timeout: LONG_TIMEOUT_MS,
            });
        },
    },
    {
        id: "06-approval",
        label: "⑥ 审批浮层",
        url: `/workspace/${WORKSPACE_ID}/session/${SESSION_ID}`,
        prepare: async (page) => {
            await bootWorkspaceShell(page);
            await serveApprovalDeps(page);
        },
        ready: async (page) => {
            await expect(page.getByTestId("chat-input")).toBeVisible({
                timeout: LONG_TIMEOUT_MS,
            });
        },
        afterReady: async (page) => {
            await pushMockApproval(page, approvalEvent);
            await expect(page.getByTestId("modal-content")).toBeVisible({
                timeout: EXPECT_TIMEOUT_MS,
            });
        },
    },
    {
        id: "07-runtime-environment",
        label: "⑦ 运行状态 / 环境",
        url: `/workspace/${WORKSPACE_ID}/environment`,
        prepare: async (page) => {
            await bootWorkspaceShell(page);
            await serveWorkspaceEnvironment(page);
        },
        ready: async (page) => {
            await expect(page.getByTestId("workspace-environment-heading")).toBeVisible({
                timeout: LONG_TIMEOUT_MS,
            });
        },
    },
    {
        id: "08-login",
        label: "⑧ 首装 / 登录",
        url: "/login",
        ready: async (page) => {
            await expect(page.locator("#identifier")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        },
    },
];

/** Playwright 的 ariaSnapshot 首行形如 `- button "Save"` / `- textbox "Name": value`。 */
function parseFirstAriaLine(snapshot: string): NameEntry | null {
    let first = snapshot.split("\n", 1)[0] ?? "";
    // 名称含冒号时 Playwright 把整行写成 YAML 引号标量：`- 'button "New tab: choose …"'`。
    // 用 RegExp 字符串而不是字面量：`check-e2e-block-comments` 的词法器不认 regex，
    // 正则里的引号会被当成字符串边界而误报 UNTERMINATED。
    const quoted = new RegExp("^- '(.*)'$").exec(first);
    if (quoted) {
        const inner = quoted[1].split('\\"').join('"').split("''").join("'");
        first = `- ${inner}`;
    }
    const match = new RegExp('^- ([a-z]+)(?: "((?:[^"\\\\]|\\\\.)*)")?').exec(first);
    if (!match) return null;
    const raw = match[2];
    let name = raw ?? "";
    if (raw !== undefined) {
        try {
            name = JSON.parse(`"${raw}"`) as string;
        } catch {
            name = raw;
        }
    }
    return { role: match[1], name: name.replace(/\s+/g, " ").trim() };
}

async function captureNames(page: Page): Promise<CapturedEntry[]> {
    const candidates = page.locator(CANDIDATE_SELECTOR);
    const total = await candidates.count();
    const entries: CapturedEntry[] = [];
    for (let index = 0; index < total; index += 1) {
        const element: Locator = candidates.nth(index);
        if (!(await element.isVisible())) continue;
        const snapshot = await element.ariaSnapshot();
        const parsed = parseFirstAriaLine(snapshot);
        const firstLine = JSON.stringify(snapshot.split("\n", 1)[0] ?? "");
        if (!parsed) {
            // ariaSnapshot 为空 = 元素不在 AX 树里（aria-hidden / 无 role）。用 DOM 标签兜底，
            // 让缺口在证据里可定位，而不是只剩一个 "unknown"。
            entries.push({
                role: await tagNameOf(element),
                name: "",
                detail: `${await describe(element)} :: snap=${firstLine}`,
            });
            continue;
        }
        entries.push(
            parsed.name
                ? parsed
                : { ...parsed, detail: `${await describe(element)} :: snap=${firstLine}` },
        );
    }
    return entries.sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
}

async function tagNameOf(element: Locator): Promise<string> {
    return element.evaluate((node) => node.tagName.toLowerCase());
}

async function describe(element: Locator): Promise<string> {
    return element.evaluate((node) => {
        const el = node as HTMLElement;
        const attrs = ["aria-label", "title", "placeholder"]
            .map((name) => `${name}=${JSON.stringify(el.getAttribute(name))}`)
            .join(" ");
        const html = el.outerHTML.replace(/\s+/g, " ").slice(0, 220);
        return `${el.tagName.toLowerCase()} ${attrs} :: ${html}`;
    });
}

/**
 * 等两次连续抓取完全一致再定稿：mock 面仍有异步投影（成员/环境/审批），
 * 固定 sleep 被规则禁止，用 expect.poll 做 readiness probe。
 */
async function captureStable(page: Page): Promise<CapturedEntry[]> {
    let previous = "";
    let stable: CapturedEntry[] = [];
    await expect
        .poll(
            async () => {
                const current = await captureNames(page);
                const serialized = JSON.stringify(current);
                if (serialized === previous) {
                    stable = current;
                    return true;
                }
                previous = serialized;
                return false;
            },
            { timeout: LONG_TIMEOUT_MS, intervals: [100, 150, 200, 250, 300] },
        )
        .toBe(true);
    return stable;
}

async function loadLocale(page: Page, face: Face, locale: Locale): Promise<CapturedEntry[]> {
    await page.evaluate((value) => localStorage.setItem("xihe-language", value), locale);
    await page.reload();
    await face.ready(page);
    if (face.afterReady) await face.afterReady(page);
    return captureStable(page);
}

function countByKey(entries: NameEntry[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const entry of entries) {
        const key = `${entry.role}\u0000${entry.name}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
}

interface Drift {
    added: NameEntry[];
    removed: NameEntry[];
    renamed: string[];
}

/** 新增/删除/改名：同名同 role 的多重集差分；剩余按 role 顺序配对视为改名。 */
function diffEntries(baseline: NameEntry[], current: NameEntry[]): Drift {
    const baseCounts = countByKey(baseline);
    const currentCounts = countByKey(current);
    const removed: NameEntry[] = [];
    const added: NameEntry[] = [];
    for (const [key, count] of baseCounts) {
        const [role, name] = key.split("\u0000");
        const delta = count - (currentCounts.get(key) ?? 0);
        for (let i = 0; i < delta; i += 1) removed.push({ role, name });
    }
    for (const [key, count] of currentCounts) {
        const [role, name] = key.split("\u0000");
        const delta = count - (baseCounts.get(key) ?? 0);
        for (let i = 0; i < delta; i += 1) added.push({ role, name });
    }
    removed.sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
    added.sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));

    const renamed: string[] = [];
    const removedByRole = new Map<string, NameEntry[]>();
    for (const entry of removed) {
        const bucket = removedByRole.get(entry.role) ?? [];
        bucket.push(entry);
        removedByRole.set(entry.role, bucket);
    }
    const addedByRole = new Map<string, NameEntry[]>();
    for (const entry of added) {
        const bucket = addedByRole.get(entry.role) ?? [];
        bucket.push(entry);
        addedByRole.set(entry.role, bucket);
    }
    for (const [role, olds] of removedByRole) {
        const news = addedByRole.get(role) ?? [];
        const pairs = Math.min(olds.length, news.length);
        for (let i = 0; i < pairs; i += 1) {
            renamed.push(`[${role}] "${olds[i].name}" -> "${news[i].name}"`);
        }
        if (pairs > 0) {
            removedByRole.set(role, olds.slice(pairs));
            addedByRole.set(role, news.slice(pairs));
        }
    }
    const remainingRemoved = [...removedByRole.values()].flat();
    const remainingAdded = [...addedByRole.values()].flat();
    return { added: remainingAdded, removed: remainingRemoved, renamed };
}

function formatDrift(drift: Drift): string {
    const lines: string[] = [];
    for (const item of drift.removed) lines.push(`- [${item.role}] "${item.name}"`);
    for (const item of drift.added) lines.push(`+ [${item.role}] "${item.name}"`);
    for (const item of drift.renamed) lines.push(`~ ${item}`);
    return lines.join("\n");
}

function snapshotPath(dir: string, face: Face): string {
    return path.join(dir, `a11y-names-${face.id}.json`);
}

function writeJson(file: string, value: unknown): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

for (const face of FACES) {
    test(`task-762 ${face.label} 可访问名称快照`, async ({ page }) => {
        if (face.prepare) await face.prepare(page);
        await page.goto(face.url);

        const captured = {} as Record<Locale, CapturedEntry[]>;
        for (const locale of LOCALES) {
            captured[locale] = await loadLocale(page, face, locale);
        }

        const snapshot: FaceSnapshot = {
            task: "task-762",
            face: { id: face.id, label: face.label },
            locales: {
                "zh-CN": captured["zh-CN"].map(({ role, name }) => ({ role, name })),
                "en-US": captured["en-US"].map(({ role, name }) => ({ role, name })),
            },
        };
        writeJson(snapshotPath(CURRENT_DIR, face), snapshot);
        if (UPDATE_BASELINE) writeJson(snapshotPath(BASELINE_DIR, face), snapshot);

        const emptyNames: string[] = [];
        for (const locale of LOCALES) {
            captured[locale].forEach((entry, index) => {
                if (!entry.name) {
                    emptyNames.push(
                        `${locale}[${index}] ${entry.role}${entry.detail ? ` :: ${entry.detail}` : ""}`,
                    );
                }
            });
        }
        const cjkNames = captured["en-US"]
            .filter((entry) => CJK.test(entry.name))
            .map((entry) => `[${entry.role}] "${entry.name}"`);
        // 两类缺口一次报全（先报空名会遮住 CJK，上一版实测把 23 条 CJK 藏掉了）。
        const gaps = [
            ...emptyNames.map((entry) => `empty-name ${entry}`),
            ...cjkNames.map((entry) => `en-US-cjk ${entry}`),
        ];
        expect(
            gaps,
            `${face.label}：可访问名称缺口（空名 / en-US CJK；红线，基线更新也不能掩盖）`,
        ).toEqual([]);

        const baselineFile = snapshotPath(BASELINE_DIR, face);
        if (UPDATE_BASELINE) return;
        expect(
            existsSync(baselineFile),
            `缺少基线 ${baselineFile}；先跑 XIHE_A11Y_SNAPSHOT_UPDATE=1 生成并提交`,
        ).toBeTruthy();

        const baseline = JSON.parse(readFileSync(baselineFile, "utf8")) as FaceSnapshot;
        const driftLines: string[] = [];
        for (const locale of LOCALES) {
            const drift = diffEntries(baseline.locales[locale] ?? [], captured[locale]);
            const text = formatDrift(drift);
            if (text) driftLines.push(`${locale}:\n${text}`);
        }
        expect(
            driftLines.join("\n\n"),
            `${face.label}：可访问名称快照漂移（- 删除 / + 新增 / ~ 改名）`,
        ).toBe("");
    });
}
