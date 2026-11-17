/**
 * task-72 的机器判据：**mock 车道真的有自动化任务与仓库状态两条读面**，且形状/判定照契约。
 *
 * <p>为什么要钉死这些：根因是「端点根本不存在」（`grep 'scheduled-tasks' src/preview/` = 0 命中），
 * 页面在 mock 车道上整页红条「请求失败」+ 错误码 `MOCK_ENDPOINT_MISSING`。如果测试只断言
 * 「不再是 404」，下一次有人把 404 通配成 200 也能过 —— 所以这里同时钉住五类反例：
 * ① 未知 workspace 仍 404 `WORKSPACE_NOT_FOUND`（不是把所有 404 都改成 200）；
 * ② `/scheduled-tasks/{id}` 子路由仍 404（列表路由不得吞掉详情/处置面 —— 那四条本卡故意不实现）；
 * ③ 外壳逐字段等值于 e2e 桩（`e2e/mock/helpers/auth.ts:1448-1462` 的 task-174 桩形状）；
 * ④ 四颗计数 chip 与夹具一致（`all/active/pending/done` 的集合划分能对上，不允许「计数与可见项矛盾」）；
 * ⑤ git-status 的每条 entry 路径在虚拟文件系统里**真实存在**（不是编一个树里没有的文件）。
 */
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockApiPlugin } from "../api-server";
import {
    MOCK_SCHEDULED_TASKS_WORKSPACE_ID,
    isScheduledTasksEmptyPreview,
    mockScheduledTaskListPage,
    mockScheduledTasks,
    mockWorkspaceGitStatus,
} from "../data/scheduledTasks";
import { listDirectory } from "../data/workspaceTree";

interface Captured {
    status: number;
    body: unknown;
}

type ApiHandler = (req: unknown, res: unknown) => void;

/** 与 workspaceMembers.coverage.spec.ts 同口径：直接拿 vite 插件注册的中间件，用假 req/res 打真实 HTTP 面。 */
function mountApiHandler(): ApiHandler {
    let handler: ApiHandler | null = null;
    const plugin = mockApiPlugin();
    const server = {
        middlewares: {
            use: (first: unknown, second?: unknown) => {
                if (first === "/api/v1" && typeof second === "function") {
                    handler = second as ApiHandler;
                }
            },
        },
    };
    (plugin as unknown as { configureServer: (s: unknown) => void }).configureServer(server);
    if (!handler) throw new Error("mock api middleware 未注册");
    return handler;
}

/** `referer` 可选：`?empty=1` 空态开关是从 Referer 的查询串读回来的（与 `?denied=1` 同形）。 */
function call(handler: ApiHandler, url: string, referer?: string): Promise<Captured> {
    return new Promise((resolve, reject) => {
        const req = Readable.from([]);
        const reqAny = req as unknown as Record<string, unknown>;
        reqAny.method = "GET";
        reqAny.url = url;
        reqAny.headers = referer ? { referer } : {};
        const res = {
            statusCode: 200,
            headers: {} as Record<string, string>,
            setHeader(key: string, value: string) {
                this.headers[key] = value;
            },
            end(text?: string) {
                try {
                    resolve({
                        status: (this as unknown as { statusCode: number }).statusCode,
                        body: text ? JSON.parse(text) : null,
                    });
                } catch (cause) {
                    reject(cause);
                }
            },
        };
        handler(req, res);
    });
}

const handler = mountApiHandler();
const WS = MOCK_SCHEDULED_TASKS_WORKSPACE_ID;
const listUrl = "/workspaces/" + WS + "/scheduled-tasks?size=200";
const gitUrl = "/workspaces/" + WS + "/git-status";

interface ScheduledTaskShape {
    id: string;
    triggerKind: string;
    status: string;
    targetKind: string;
    timezone: string;
    missedCount: number;
    createdBy: { name: string | null; type: string };
    createdAt: string;
    updatedAt: string;
    cronExpr: string | null;
    targetSessionId: string | null;
    prompt: string | null;
    nextFireAt: string | null;
    expiresAt: string | null;
    lastMissedAt: string | null;
    missedReason: string | null;
    lastRunId: string | null;
}

interface ScheduledTaskPage {
    workspaceId: string;
    page: number;
    size: number;
    tasks: ScheduledTaskShape[];
}

const asPage = (body: unknown) => body as ScheduledTaskPage;

afterEach(() => {
    vi.unstubAllEnvs();
});
describe("mock 自动化任务读面：形状照契约（task-72）", () => {
    it("GET /workspaces/{id}/scheduled-tasks 回 ScheduledTaskListPage，外壳与 e2e 桩等值", async () => {
        const answer = await call(handler, listUrl);
        expect(answer.status).toBe(200);
        const body = asPage(answer.body);
        // 外壳四个字段逐条钉住（`e2e/mock/helpers/auth.ts:1453-1462` 的 task-174 桩就是这一份）。
        expect(body.workspaceId).toBe(WS);
        expect(body.page).toBe(0);
        // 页面发的是 `?size=200`（`stores/scheduledTasks.ts` 的 `listScheduledTasks(ws, { size: 200 })`）。
        expect(body.size).toBe(200);
        expect(Array.isArray(body.tasks)).toBe(true);
        expect(body.tasks).toHaveLength(3);
    });

    it("每条任务 required 字段齐全，枚举值都在契约词表内", async () => {
        const body = asPage((await call(handler, listUrl)).body);
        for (const task of body.tasks) {
            for (const key of [
                "id",
                "triggerKind",
                "timezone",
                "targetKind",
                "status",
                "missedCount",
                "createdBy",
                "createdAt",
                "updatedAt",
                "cronExpr",
                "targetSessionId",
                "prompt",
                "nextFireAt",
                "expiresAt",
                "lastMissedAt",
                "missedReason",
                "lastRunId",
            ]) {
                expect(task, key).toHaveProperty(key);
            }
            // 枚举逐字取自 openapi `ScheduledTask`（`:9004-9015`）。
            expect(["delay_once", "cron", "interval"]).toContain(task.triggerKind);
            expect(["session_wakeup", "job_dispatch"]).toContain(task.targetKind);
            expect([
                "scheduled",
                "firing",
                "missed",
                "expired",
                "cancelled",
                "completed",
            ]).toContain(task.status);
            expect(["human", "agent"]).toContain(task.createdBy.type);
            if (task.missedReason !== null) {
                expect(["target_gone", "dispatch_failed", "overdue_grace"]).toContain(
                    task.missedReason,
                );
            }
            // 时间字段必须是可解析的 date-time（页面 `new Date(iso)` 与 `Intl.DateTimeFormat` 都吃它）。
            expect(Number.isNaN(Date.parse(task.createdAt))).toBe(false);
            expect(Number.isNaN(Date.parse(task.updatedAt))).toBe(false);
            // cron only 才有 cronExpr（另外两种 triggerKind 必须恒 null，这是契约的硬断言）。
            if (task.triggerKind !== "cron") expect(task.cronExpr).toBeNull();
        }
    });

    it("三种 triggerKind / 两种 targetKind / human+agent 都有取样对象（否则列表页有分支没有可看的东西）", async () => {
        const body = asPage((await call(handler, listUrl)).body);
        const kinds = new Set(body.tasks.map((task) => task.triggerKind));
        const targets = new Set(body.tasks.map((task) => task.targetKind));
        const creators = new Set(body.tasks.map((task) => task.createdBy.type));
        expect(kinds.size).toBe(3);
        expect(targets.size).toBe(2);
        expect(creators.has("human")).toBe(true);
        expect(creators.has("agent")).toBe(true);
    });

    it("四颗计数 chip 与夹具一致（active=scheduled|firing / pending=missed|expired / done=completed|cancelled）", async () => {
        const body = asPage((await call(handler, listUrl)).body);
        // 判据与产品页同一套集合（`ScheduledTasksView.vue:64-68`）：这里**照抄集合而不是抄数字**，
        // 否则夹具加一条就得同时改两处，而两处一漂就是「计数与可见项矛盾」。
        const ACTIVE = new Set(["scheduled", "firing"]),
            PENDING = new Set(["missed", "expired"]),
            DONE = new Set(["completed", "cancelled"]);
        const count = (set: Set<string>) =>
            body.tasks.filter((task) => set.has(task.status)).length;
        // 四个 tab 都必须有取样对象：任一为 0 就说明那一个 tab 在预览里没有可看的东西。
        expect(count(ACTIVE)).toBe(1);
        expect(count(PENDING)).toBe(1);
        expect(count(DONE)).toBe(1);
        // 三种集合必须覆盖全部（夹具里不允许出现落不进任一 tab 的状态）。
        expect(count(ACTIVE) + count(PENDING) + count(DONE)).toBe(body.tasks.length);
    });

    it("列表按 createdAt 倒序（openapi `:4802-4811` newest-created first）", async () => {
        const body = asPage((await call(handler, listUrl)).body);
        const stamps = body.tasks.map((task) => Date.parse(task.createdAt));
        for (let i = 1; i < stamps.length; i += 1) {
            expect(stamps[i - 1]).toBeGreaterThan(stamps[i]);
        }
    });
});
describe("反例：不许用通配 200 掩盖缺口（task-72）", () => {
    it("未知 workspace ⇒ 404 WORKSPACE_NOT_FOUND（与成员面同一口径）", async () => {
        const ghost = "00000000-0000-4000-8000-000000000000";
        const answer = await call(handler, "/workspaces/" + ghost + "/scheduled-tasks?size=200");
        expect(answer.status).toBe(404);
        expect((answer.body as { code: string }).code).toBe("WORKSPACE_NOT_FOUND");
    });

    it("`/scheduled-tasks/{id}` 子路由仍落兜底 404（列表路由不得吞掉详情/处置面）", async () => {
        const answer = await call(
            handler,
            "/workspaces/" + WS + "/scheduled-tasks/a7f3c1e2-8d40-4a55-9c31-2f6b8e001001",
        );
        expect(answer.status).toBe(404);
        expect((answer.body as { code: string }).code).toBe("MOCK_ENDPOINT_MISSING");
    });

    it("夹具的工作区与产品 GET /workspaces 返回的是同一个 id（不是第二套 id）", async () => {
        const answer = await call(handler, "/workspaces");
        expect(answer.status).toBe(200);
        const workspace = (answer.body as Array<{ id: string }>)[0];
        expect(workspace?.id).toBe(WS);
    });
});

describe("空态开关（?empty=1，与 ?denied=1 同形的 Referer 通道）", () => {
    it("默认（无 Referer 或无 empty）⇒ 3 条；?empty=1 ⇒ tasks 为空数组，其余外壳不变", async () => {
        const base = asPage((await call(handler, listUrl)).body);
        const empty = asPage(
            (
                await call(
                    handler,
                    listUrl,
                    "http://127.0.0.1:5199/workspace/" + WS + "/scheduled-tasks?empty=1",
                )
            ).body,
        );
        expect(empty.tasks).toEqual([]);
        // 「另一态」必须只差 tasks 一项，外壳不能跟着变（否则两组图的差异原因不可归因）。
        const { tasks: baseTasks, ...restBase } = base;
        const { tasks: emptyTasks, ...restEmpty } = empty;
        expect(baseTasks).toHaveLength(3);
        expect(emptyTasks).toHaveLength(0);
        expect(restEmpty).toEqual(restBase);
    });

    it("isScheduledTasksEmptyPreview：1 / true 开，其余（0 / yes / 空 / 无 Referer）一律关", () => {
        expect(isScheduledTasksEmptyPreview(undefined)).toBe(false);
        expect(isScheduledTasksEmptyPreview("not a url")).toBe(false);
        expect(isScheduledTasksEmptyPreview("http://x/workspace/ws/scheduled-tasks")).toBe(false);
        expect(isScheduledTasksEmptyPreview("http://x/scheduled-tasks?empty=0")).toBe(false);
        expect(isScheduledTasksEmptyPreview("http://x/scheduled-tasks?empty=yes")).toBe(false);
        expect(isScheduledTasksEmptyPreview("http://x/scheduled-tasks?empty=1")).toBe(true);
        expect(isScheduledTasksEmptyPreview("http://x/scheduled-tasks?empty=true")).toBe(true);
    });
});

describe("分页 clamp：与 CP 同口径（size 1-200、默认 100；page 非负、默认 0）", () => {
    it("非法参数回落缺省，不演 400（页面只发正整数，400 会把「参数拼错」演成「后端坏了」）", () => {
        const fallback = mockScheduledTaskListPage(WS, {});
        expect(fallback.page).toBe(0);
        expect(fallback.size).toBe(100);
        expect(fallback.tasks).toHaveLength(3);

        const clamped = mockScheduledTaskListPage(WS, { size: 999 });
        // 契约上限是 200（openapi `:4820`），夹具不得回一个超出契约的 size。
        expect(clamped.size).toBe(200);

        const negative = mockScheduledTaskListPage(WS, { page: -1 });
        expect(negative.page).toBe(0);
    });

    it("分页切片真的按 page×size 走（不是每次都回全量）", () => {
        const second = mockScheduledTaskListPage(WS, { page: 1, size: 2 });
        // 3 条 / size=2 ⇒ 第 2 页只剩 1 条。
        expect(second.tasks).toHaveLength(1);
        expect(second.tasks[0]?.id).toBe(mockScheduledTasks()[2]?.id);
    });

    it("夹具返回的是副本：调用方改不坏夹具本体", () => {
        const first = mockScheduledTasks();
        first[0]!.status = "cancelled";
        const second = mockScheduledTasks();
        expect(second[0]!.status).toBe("scheduled");
    });
});
describe("git 状态读面（task-72 同类缺口）", () => {
    it("GET /workspaces/{id}/git-status 回 {isRepository, entries}，entry 是 {status, path}", async () => {
        const answer = await call(handler, gitUrl);
        expect(answer.status).toBe(200);
        const body = answer.body as {
            isRepository: boolean;
            entries: { status: string; path: string }[];
        };
        // required 字段照 openapi（`required: [isRepository, entries]`）。
        expect(body).toHaveProperty("isRepository");
        expect(body).toHaveProperty("entries");
        expect(body.isRepository).toBe(true);
        expect(Array.isArray(body.entries)).toBe(true);
        expect(body.entries.length).toBeGreaterThan(0);
        for (const entry of body.entries) {
            // porcelain 前缀至少两列宽（` M` / `??`），且 path 非空。
            expect(typeof entry.status).toBe("string");
            expect(entry.status.trim().length).toBeGreaterThan(0);
            expect(typeof entry.path).toBe("string");
            expect(entry.path.length).toBeGreaterThan(0);
        }
    });

    it("未知 workspace ⇒ 404（同一条反例口径）", async () => {
        const ghost = "00000000-0000-4000-8000-000000000000";
        const answer = await call(handler, "/workspaces/" + ghost + "/git-status");
        expect(answer.status).toBe(404);
        expect((answer.body as { code: string }).code).toBe("WORKSPACE_NOT_FOUND");
    });

    it("每条 entry 路径在虚拟文件系统里真实存在（树里没有的东西不许列成「已修改」）", () => {
        const body = mockWorkspaceGitStatus();
        for (const entry of body.entries) {
            // 逐段拆：`src/main.ts` ⇒ 先 listDirectory("") 找 src，再 listDirectory("src") 找 main.ts。
            const segments = entry.path.split("/");
            let parent = "";
            for (const segment of segments) {
                const listing = listDirectory(undefined, parent);
                if ("code" in listing) throw new Error(parent + " 无法列举：" + listing.code);
                const found = listing.entries.find((item) => item.name === segment);
                expect(found, entry.path + " 的 " + segment + " 不存在").toBeDefined();
                parent = parent ? parent + "/" + segment : segment;
            }
        }
    });
});
