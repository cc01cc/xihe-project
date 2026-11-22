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
 *   pendingModelIntent=false（CP 日志的 first_run_content_seeded 行）；
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
        const pending = seedLog.value.lines[0]?.match(/pendingModelIntent=(true|false)/)?.[1] ?? "";
        record(
            "pendingModelIntent=false",
            "CP log first_run_content_seeded carries pendingModelIntent=false",
            `hits=${seedLog.value.hits} pending=${pending || "absent"} ${JSON.stringify(seedLog.value.lines).slice(0, 400)}`,
            seedLog.ok && pending === "false" ? "PASS" : "FAIL",
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
