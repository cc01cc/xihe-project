// timeout-exempt: first-install L2 polls PostgreSQL after a real onboarding registration (budgets are env-driven).
/**
 * task-733 | task-725 L2：真实 PG 首装（`cp.bootstrap.seed-admin=false`）走
 * `POST /api/v1/auth/register` 建首账号，断言首装内容种子的完整读数。
 *
 * 车道（唯一合法形态）：
 *   XIHE_SEED_ADMIN=false XIHE_E2E_FIRST_INSTALL=1 \
 *     node scripts/e2e-host.mjs --jar-mode=use --llm-mode=mock --retries=0 \
 *       e2e/real/first-install-l2.spec.ts
 *
 * 为什么必须 `XIHE_SEED_ADMIN=false`：`application-e2e.properties` 的默认值是
 * `true`，那是 host 车道给其它 spec 的 seed-admin 账户；本卡要验证的正是
 * **产品默认首装路径**（不 seed，靠 /onboarding 首注册）。
 *
 * 判据（缺一不算）：
 *   users=1 / workspaces=1 / provider_connections=1 且 owner=instance_identity.instance_id；
 *   pendingModelIntent 按 D-1917 分两支，由 `GET /api/v1/provider-catalog` 里
 *   **seed provider 那一条 catalog 事实**分流（禁止写死其中一支）：
 *     A 支 catalog 声明了 model id ⇒ pendingModelIntent=false，且 intent 指向该 provider+model；
 *     B 支 catalog 未声明任何 model id（如 ollama `modelDiscovery=remote-models`）
 *       ⇒ pendingModelIntent=true 为正确行为，且必须同时抓到
 *         `first_run_content_seeded ... pendingModelIntent=true` 日志行，且 subject 全部保持未绑定；
 *   反例守卫：落入 subject 的 model id 必须是 catalog 声明过的 id，B 支必须保持未绑定（NULL）；
 *   为把 pending 变 false 而写占位/假 model id ⇒ 判红（D-1917）。
 *   审计行 instance_admin_bootstrapped 存在且指向首账号；
 *   第二账号无 cap:instance:admin，且 provider_connections 不新增。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type APIRequestContext } from "@playwright/test";

import { CP_URL } from "./helpers/journey";
import { generateE2EPassword } from "./helpers/password";
import { LONG_TIMEOUT_MS } from "../timeouts";

const ENABLED = process.env.XIHE_E2E_FIRST_INSTALL === "1";
const SEED_ADMIN = process.env.XIHE_SEED_ADMIN ?? "";
const PROFILE = process.env.XIHE_E2E_PROFILE ?? "all";
const RUN_ID = process.env.XIHE_E2E_RUN_ID ?? "";
const PG_CONTAINER = process.env.XIHE_E2E_PG_CONTAINER ?? "";
const PG_DATABASE = process.env.XIHE_E2E_PG_DATABASE ?? "";
const PG_USER = process.env.XIHE_E2E_PG_USER ?? "xihe";
const HOST_ROOT =
    process.env.XIHE_WORKSPACE_HOST_ROOT ??
    path.resolve(process.cwd(), "../../.tmp/e2e-host", RUN_ID || "unknown-run");
const EVIDENCE_DIR = process.env.XIHE_FIRST_INSTALL_EVIDENCE_DIR
    ? path.resolve(process.env.XIHE_FIRST_INSTALL_EVIDENCE_DIR)
    : path.resolve(process.cwd(), "../../.tmp/first-install-l2");

const BUDGET = {
    test: Number(process.env.XIHE_FIRST_INSTALL_TEST_MS ?? 240000),
    seed: Number(process.env.XIHE_FIRST_INSTALL_WAIT_MS ?? 60000),
    short: Number(process.env.XIHE_FIRST_INSTALL_SHORT_MS ?? 15000),
};

type Status = "PASS" | "FAIL" | "PRECONDITION_UNMET";

interface Check {
    check: string;
    expected: string;
    observed: string;
    status: Status;
    at: string;
}

function psql(sql: string): string[][] {
    const out = execFileSync(
        "docker",
        [
            "exec",
            PG_CONTAINER,
            "psql",
            "-U",
            PG_USER,
            "-d",
            PG_DATABASE,
            "-tA",
            "-F",
            "|~|",
            "-c",
            sql,
        ],
        { encoding: "utf8" },
    ).trim();
    if (!out) return [];
    return out
        .split(/\r?\n/)
        .map((line) => line.split("|~|"))
        .filter((row) => row.length > 1 || (row[0] ?? "") !== "");
}

function scalar(sql: string): string {
    return psql(sql)[0]?.[0] ?? "";
}

async function pollUntil<T>(
    probe: () => Promise<T> | T,
    predicate: (value: T) => boolean,
    timeoutMs: number,
    intervalMs = 1000,
): Promise<{ ok: boolean; value: T; waitedMs: number }> {
    const began = Date.now();
    let value = await probe();
    for (;;) {
        if (predicate(value)) return { ok: true, value, waitedMs: Date.now() - began };
        if (Date.now() - began > timeoutMs)
            return { ok: false, value, waitedMs: Date.now() - began };
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        value = await probe();
    }
}

function scanCpLogs(pattern: RegExp): { hits: number; lines: string[] } {
    const logsDir = path.join(HOST_ROOT, "logs");
    if (!existsSync(logsDir)) return { hits: 0, lines: [] };
    const lines: string[] = [];
    for (const entry of readdirSync(logsDir)) {
        if (!entry.endsWith(".log")) continue;
        for (const line of readFileSync(path.join(logsDir, entry), "utf8").split(/\r?\n/)) {
            if (pattern.test(line)) lines.push(`${entry}: ${line.slice(0, 500)}`);
        }
    }
    return { hits: lines.length, lines };
}

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject {
    [key: string]: JsonValue;
}

/** `typeof x === "object"` also matches arrays; JSON object indexing needs the array case gone. */
function isObjectRecord(value: JsonValue | undefined): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Mirror of `FirstRunSeedModelIntent.modelIds` (cp/config): a textual id, an array of ids/objects,
 * or one object carrying `id` / `model` / `name`. Every tolerated position is read and the result is
 * sorted, so the caller picks the same "first declared id" the seeder picks.
 */
function collectModelIds(node: JsonValue | undefined, ids: Set<string>): void {
    if (node === undefined || node === null) return;
    if (typeof node === "string") {
        const trimmed = node.trim();
        if (trimmed) ids.add(trimmed);
        return;
    }
    if (Array.isArray(node)) {
        for (const entry of node) collectModelIds(entry, ids);
        return;
    }
    if (isObjectRecord(node)) {
        for (const field of ["id", "model", "name"] as const) {
            const value = node[field];
            if (typeof value === "string" && value.trim()) {
                ids.add(value.trim());
                return;
            }
        }
    }
}

/** The model ids the catalog declares for one provider, sorted (empty = catalog declared nothing). */
function declaredModelIds(providers: JsonValue[], providerId: string): string[] {
    const entry = providers.find(
        (candidate): candidate is JsonObject =>
            isObjectRecord(candidate) && candidate.id === providerId,
    );
    if (!entry) return [];
    const ids = new Set<string>();
    collectModelIds(entry["models"], ids);
    collectModelIds(entry["defaultModel"], ids);
    const pairs = Array.isArray(entry["supportedApiTypes"]) ? entry["supportedApiTypes"] : [];
    for (const pair of pairs) {
        if (!isObjectRecord(pair)) continue;
        collectModelIds(pair["models"], ids);
        collectModelIds(pair["defaultModel"], ids);
    }
    return [...ids].sort();
}

interface BranchFacts {
    /** Provider id the seed wrote into `provider_connections`. */
    seedProviderId: string;
    /** Model ids the catalog declares for that provider (empty ⇒ catalog declared nothing). */
    catalogDeclared: string[];
    /** `pendingModelIntent` as read from the CP log line ("" when the flag is absent). */
    observedPending: string;
    /**
     * Rows of `first_run_content_seeded ... pendingModelIntent=<value>`, keyed by value. The verdict
     * reads only the entry for its own branch, so "the log line was caught with this branch's value"
     * stays a real observation instead of a bare line count.
     */
    pendingLogHitsByValue: Record<"true" | "false", number>;
    /** `[provider, model]` per seeded subject, coalesced to "" when the column is NULL. */
    subjectModels: string[][];
    /**
     * Whether the provider-catalog read actually produced a provider list. A failed HTTP read must
     * not degrade into "catalog declares nothing" (which would silently pick B 支), so it fails here.
     */
    catalogFactReadable: boolean;
    /** Whether the `event=first_run_content_seeded` line was observed at all. */
    seedLogSeen: boolean;
}

interface BranchVerdict {
    branch: "A" | "B";
    expectedPending: "false" | "true";
    ok: boolean;
    boundPairs: { provider: string; model: string }[];
    unboundCount: number;
    /** Model ids that reached a subject without being declared by the catalog (D-1917 反例). */
    invented: string[];
    failureReasons: string[];
}

/**
 * D-1917: the two branches are chosen by the catalog fact, never hard-coded. A 支 requires the
 * intent to point at the seeded provider plus a catalog-declared model; B 支 requires every subject
 * to stay unbound *and* the pending log line plus the 待绑定 warning to be present. A placeholder or
 * forged model id lands in `invented` and judges red.
 */
function evaluateModelIntentBranch(facts: BranchFacts): BranchVerdict {
    const branch = facts.catalogDeclared.length > 0 ? "A" : "B";
    const expectedPending = branch === "A" ? "false" : "true";
    const boundPairs = facts.subjectModels
        .map(([provider, model]) => ({ provider, model }))
        .filter((pair) => pair.provider !== "" && pair.model !== "");
    const unboundCount = facts.subjectModels.filter(
        ([provider, model]) => provider === "" && model === "",
    ).length;
    const invented = [...new Set(boundPairs.map((pair) => pair.model))].filter(
        (model) => facts.catalogDeclared.length === 0 || !facts.catalogDeclared.includes(model),
    );
    const failureReasons: string[] = [];
    if (!facts.seedLogSeen) failureReasons.push("seed-log-missing");
    // Fail-closed: an unreadable catalog means the branch itself is undetermined. Without this,
    // a 401/500 on `/api/v1/provider-catalog` looks exactly like "no model declared" ⇒ B 支.
    if (!facts.catalogFactReadable) failureReasons.push("catalog-fact-unreadable");
    if (facts.observedPending !== expectedPending) failureReasons.push("pending-mismatch");
    // Anti-vacuity: the seed always creates three subjects (Lead / WorkerA / WorkerB); an empty
    // table would make both branches trivially true.
    if (facts.subjectModels.length === 0) failureReasons.push("no-seeded-subjects");
    if (facts.pendingLogHitsByValue[expectedPending] <= 0)
        failureReasons.push("pending-log-line-missing");
    if (branch === "A") {
        if (!boundPairs.every((pair) => pair.provider === facts.seedProviderId)) {
            failureReasons.push("intent-provider-mismatch");
        }
        if (!boundPairs.every((pair) => facts.catalogDeclared.includes(pair.model))) {
            failureReasons.push("intent-model-not-declared");
        }
        if (boundPairs.length !== facts.subjectModels.length)
            failureReasons.push("intent-not-bound");
    } else {
        if (unboundCount !== facts.subjectModels.length)
            failureReasons.push("b-branch-subject-bound");
    }
    if (invented.length > 0) failureReasons.push("placeholder-model-id");
    return {
        branch,
        expectedPending,
        ok: failureReasons.length === 0,
        boundPairs,
        unboundCount,
        invented,
        failureReasons,
    };
}

interface RegisterBody {
    accessToken: string;
    user: {
        id: string;
        capabilities?: { isInstanceAdmin?: boolean; isInstanceSuper?: boolean };
    };
}

async function register(request: APIRequestContext, tag: string): Promise<RegisterBody> {
    const email = `${tag}-${Date.now()}@test.com`;
    const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: {
            email,
            password: generateE2EPassword(),
            name: tag,
            username: `${tag}${Date.now()}`.replace(/[^A-Za-z0-9]/g, "").slice(0, 24),
        },
        timeout: LONG_TIMEOUT_MS,
    });
    expect(
        [200, 201],
        `register(${tag}) failed: ${response.status()} ${await response.text()}`,
    ).toContain(response.status());
    return (await response.json()) as RegisterBody;
}

test.describe.configure({ mode: "serial", retries: 0, timeout: BUDGET.test });

test.describe("task-733 first-install L2 — real PG onboarding @host", () => {
    test.skip(!ENABLED, "set XIHE_E2E_FIRST_INSTALL=1");
    test.skip(SEED_ADMIN !== "false", "requires XIHE_SEED_ADMIN=false on the runner");
    test.skip(PROFILE !== "host", "first-install L2 is a @host lane");
    test.skip(!RUN_ID, "requires the isolated host stack (XIHE_E2E_RUN_ID)");
    test.skip(!PG_CONTAINER || !PG_DATABASE, "requires XIHE_E2E_PG_CONTAINER/DATABASE");

    test("first real registration seeds exactly one workspace + one instance provider connection", async ({
        request,
    }) => {
        const began = Date.now();
        const checks: Check[] = [];
        const record = (check: string, expected: string, observed: string, status: Status) =>
            checks.push({ check, expected, observed, status, at: new Date().toISOString() });

        const bootstrap = await request.get(`${CP_URL}/api/v1/auth/bootstrap-status`, {
            timeout: LONG_TIMEOUT_MS,
        });
        record(
            "fresh instance bootstrap-status",
            "HTTP 200 with initialized=false before the first registration",
            `HTTP ${bootstrap.status()} ${(await bootstrap.text()).slice(0, 200)}`,
            bootstrap.status() === 200 && (await bootstrap.json()).initialized === false
                ? "PASS"
                : "FAIL",
        );

        const first = await register(request, "firstadmin");
        const firstId = first.user.id;
        record(
            "first registration is instance administrator",
            "user.capabilities.isInstanceAdmin=true",
            JSON.stringify(first.user.capabilities),
            first.user.capabilities?.isInstanceAdmin === true ? "PASS" : "FAIL",
        );

        // The content seed runs after the registration commit (request filter); poll
        // until both the workspace and the instance connection have landed.
        const seeded = await pollUntil(
            () => {
                const users = Number(scalar("SELECT count(*) FROM users"));
                const workspaces = Number(
                    scalar("SELECT count(*) FROM workspaces WHERE deleted_at IS NULL"),
                );
                const connections = Number(scalar("SELECT count(*) FROM provider_connections"));
                return { users, workspaces, connections };
            },
            (value) => value.users === 1 && value.workspaces === 1 && value.connections === 1,
            BUDGET.seed,
        );
        record(
            "first-run row counts",
            "users=1 workspaces=1 provider_connections=1",
            JSON.stringify({ ...seeded.value, waitedMs: seeded.waitedMs }),
            seeded.ok ? "PASS" : "FAIL",
        );

        const identity = scalar("SELECT instance_id FROM instance_identity WHERE id = 1");
        const connection =
            psql(
                "SELECT owner_type, owner_id, provider_id, connection_key FROM provider_connections",
            )[0] ?? [];
        record(
            "instance provider connection owner",
            "provider_connections=1, owner_type=INSTANCE, owner_id=instance_identity.instance_id",
            `identity=${identity} row=${JSON.stringify(connection)}`,
            seeded.value.connections === 1 &&
                connection[0] === "INSTANCE" &&
                connection[1] === identity &&
                identity !== ""
                ? "PASS"
                : "FAIL",
        );

        const ownerPointer = scalar("SELECT owner_user_id FROM instance_owner WHERE id = 1");
        record(
            "instance_owner points at the first account",
            "owner_user_id = first user id",
            `owner=${ownerPointer} first=${firstId}`,
            ownerPointer === firstId ? "PASS" : "FAIL",
        );

        const audit = psql(
            `SELECT user_id, action, left(coalesce(details,''),200) FROM audit_logs ` +
                `WHERE action = 'instance_admin_bootstrapped' ORDER BY created_at`,
        );
        record(
            "instance_admin_bootstrapped audit row",
            ">=1 row with user_id = first account",
            JSON.stringify(audit),
            audit.length >= 1 && audit[0][0] === firstId ? "PASS" : "FAIL",
        );

        const seedLog = await pollUntil(
            () => scanCpLogs(/event=first_run_content_seeded/),
            (scan) => scan.hits > 0,
            BUDGET.short,
        );
        // ---- D-1917 · pendingModelIntent 分两支 -------------------------------------------
        // The branch is chosen by a catalog fact visible to this test, never hard-coded: the
        // provider-catalog entry for the provider this install seeded. Declared model ids ⇒ A 支
        // (false + intent points at provider+model); nothing declared ⇒ B 支 (true is correct and
        // must be backed by the log line). Flipping the expected value to `true` would hide an A 支
        // regression, so both branches carry their own observable evidence.
        const seedProviderId = connection[2] ?? "";
        const catalogResponse = await request.get(`${CP_URL}/api/v1/provider-catalog`, {
            headers: { Authorization: `Bearer ${first.accessToken}` },
            timeout: LONG_TIMEOUT_MS,
        });
        const catalogBody = (await catalogResponse.json().catch(() => null)) as {
            providers?: JsonValue[];
        } | null;
        const catalogProviders = Array.isArray(catalogBody?.providers)
            ? catalogBody!.providers!
            : [];
        // "Readable" = HTTP 200 with a non-empty provider list. A missing provider entry is *not* an
        // error (the seeder resolves an unknown id to `Intent.pending()` too), but the read itself
        // must have succeeded, otherwise the branch would be unknowable and must not default to B 支.
        const catalogFactReadable = catalogResponse.ok() && catalogProviders.length > 0;
        const catalogDeclared = declaredModelIds(catalogProviders, seedProviderId);
        const pending = seedLog.value.lines[0]?.match(/pendingModelIntent=(true|false)/)?.[1] ?? "";
        const subjectModels = psql(
            "SELECT coalesce(default_model_provider,''), coalesce(default_model_name,'') " +
                "FROM agent_principals WHERE created_by_user_id = " +
                `'${firstId}' ORDER BY name`,
        );
        const verdict = evaluateModelIntentBranch({
            seedProviderId,
            catalogDeclared,
            observedPending: pending,
            pendingLogHitsByValue: {
                true: scanCpLogs(/event=first_run_content_seeded.*pendingModelIntent=true/).hits,
                false: scanCpLogs(/event=first_run_content_seeded.*pendingModelIntent=false/).hits,
            },
            subjectModels,
            catalogFactReadable,
            seedLogSeen: seedLog.ok,
        });
        const warnHits = scanCpLogs(/model intent 待绑定/).hits;
        const { branch, expectedPending, invented, boundPairs, unboundCount } = verdict;
        record(
            `pendingModelIntent ${branch} 支（D-1917）`,
            branch === "A"
                ? `catalog declares [${catalogDeclared.join(", ")}] for provider=${seedProviderId} ⇒ pendingModelIntent=false 且 intent 指向 ${seedProviderId}+声明过的 model`
                : `catalog declares no model id for provider=${seedProviderId} ⇒ pendingModelIntent=true 为正确行为，并附 first_run_content_seeded 日志行与未绑定 subject`,
            `branch=${branch} catalog=${catalogResponse.status()} readable=${catalogFactReadable} hits=${seedLog.value.hits} pending=${pending || "absent"} expected=${expectedPending} declared=${JSON.stringify(catalogDeclared)} subjects=${JSON.stringify(subjectModels)} bound=${JSON.stringify(boundPairs)} unbound=${unboundCount} invented=${JSON.stringify(invented)} warnHits=${warnHits} failures=${JSON.stringify(verdict.failureReasons)} pendingLines=${JSON.stringify(seedLog.value.lines).slice(0, 400)}`,
            verdict.ok ? "PASS" : "FAIL",
        );

        const second = await register(request, "seconduser");
        record(
            "second registration stays USER",
            "user.capabilities.isInstanceAdmin=false",
            JSON.stringify(second.user.capabilities),
            second.user.capabilities?.isInstanceAdmin === false ? "PASS" : "FAIL",
        );
        const afterSecond = {
            users: Number(scalar("SELECT count(*) FROM users")),
            workspaces: Number(scalar("SELECT count(*) FROM workspaces WHERE deleted_at IS NULL")),
            connections: Number(scalar("SELECT count(*) FROM provider_connections")),
        };
        record(
            "second account adds no provider connection",
            "users=2, provider_connections still 1",
            JSON.stringify(afterSecond),
            afterSecond.users === 2 && afterSecond.connections === 1 ? "PASS" : "FAIL",
        );

        mkdirSync(EVIDENCE_DIR, { recursive: true });
        const evidenceFile = path.join(
            EVIDENCE_DIR,
            `run-${new Date().toISOString().replace(/[-:.TZ]/g, "")}.json`,
        );
        writeFileSync(
            evidenceFile,
            `${JSON.stringify(
                {
                    card: "task-733",
                    runId: RUN_ID,
                    stack: RUN_ID,
                    seedAdmin: SEED_ADMIN,
                    elapsedMs: Date.now() - began,
                    modelIntent: {
                        decision: "D-1917",
                        branch,
                        seedProviderId,
                        catalogStatus: catalogResponse.status(),
                        catalogFactReadable,
                        catalogDeclared,
                        expectedPending,
                        observedPending: pending,
                        subjectModels,
                        boundPairs,
                        unboundCount,
                        pendingWarnHits: warnHits,
                        invented,
                        failureReasons: verdict.failureReasons,
                    },
                    sql: {
                        counts: "SELECT count(*) FROM users / workspaces WHERE deleted_at IS NULL / provider_connections",
                        owner: "SELECT owner_type, owner_id, provider_id, connection_key FROM provider_connections",
                        identity: "SELECT instance_id FROM instance_identity WHERE id = 1",
                        ownerPointer: "SELECT owner_user_id FROM instance_owner WHERE id = 1",
                        audit: "SELECT user_id, action, details FROM audit_logs WHERE action='instance_admin_bootstrapped'",
                        pendingModelIntent:
                            "grep 'event=first_run_content_seeded' in HOST_ROOT/logs/*.log",
                    },
                    checks,
                },
                null,
                2,
            )}\n`,
            "utf8",
        );

        const failed = checks.filter((check) => check.status === "FAIL");
        expect(failed, JSON.stringify(checks, null, 2)).toHaveLength(0);
    });
});
