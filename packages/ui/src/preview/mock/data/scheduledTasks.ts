/**
 * 工作区**自动化任务**读面（`GET /api/v1/workspaces/{id}/scheduled-tasks`）夹具 + 工作区
 * **git 状态**读面（`GET /api/v1/workspaces/{id}/git-status`）夹具 —— task-72。
 *
 * ## 为什么有这个文件
 * Lead 实拍：`/workspace/<id>/scheduled-tasks` 整页红条「请求失败…」，网络实测唯一失败项是
 * `GET /api/v1/workspaces/<id>/scheduled-tasks?size=200 => 404`。`grep 'scheduled-tasks' src/preview/`
 * = 0 命中 ⇒ **mock 车道根本没有这条端点**（同类对照：credentials / workspaceMembers /
 * workspaceAgents / workspaceEnvironment / sessions / providerConnections / apiRequestTemplates /
 * orgUnits 都有 data 模块）。自动化任务是**当时唯一整页不可自审的工作区页**。
 * 同时 `/api/v1/git-status` 同类缺口：文件树面板的只读仓库状态（`FileTreePanel.vue:70` 经
 * `composables/useWorkspaceGitReadState.ts` 消费）一进工作区就打它，404 让该面板常驻「加载失败」。
 *
 * ## 形状照契约，不照页面（三个来源，逐条可回查）
 * ① **列表**：`docs/api/openapi.yaml:4802-4858` 的 `GET .../scheduled-tasks`（query `page` /
 *    `size`，其中 `size` minimum 1 / maximum 200 / default 100）→ `ScheduledTaskListPage`
 *    （`:9037-9042` required `workspaceId/page/size/tasks`）；明细 `ScheduledTask`
 *    （`:8992-9019`，**17 个字段**，required `id/triggerKind/timezone/targetKind/status/
 *    missedCount/createdBy/createdAt/updatedAt`，列表项 `prompt` 截断到 120 字符）。
 * ② **外壳**照 e2e 已落地的读数桩 `e2e/mock/helpers/auth.ts:1448-1462`（task-174 所加）：
 *    `200 { workspaceId, page: 0, size: 200, tasks: [...] }` —— 本模块只把 `tasks` 从空数组
 *    换成真夹具，**外壳逐字段不动**（那是 e2e 与预览共用的形状，另造一份必然漂）。
 * ③ **git-status**：`docs/api/openapi.yaml:3964-3985`（required `isRepository` / `entries`，
 *    entry = `{status, path}`；非 Git 工作区 `isRepository:false` + 空 entries）；
 *    UI 侧解析器 `composables/api.ts:1919-1932` 的 `normalizeWorkspaceGitStatus`；
 *    e2e 夹具形状 `e2e/mock/task36-readstate-fix.spec.ts:19-25`（` M` / `??` 两个 porcelain 前缀样本）。
 *
 * ## 比 e2e 桩「多一点」的三件事（卡面 ①②③）
 * ① **非空列表**：3 条夹具覆盖四种 tab —— `scheduled`（调度中 1）/ `missed`（待处理 1）/
 *    `completed`（已结束 1）⇒ 「全部 3 / 调度中 1 / 待处理 1 / 已结束 1」四颗计数 chip **能对上**；
 *    三种 `triggerKind`（cron / interval / delay_once）、两种 `targetKind`、human 与 agent 两种
 *    `createdBy` 各至少一条（否则列表页有一半分支在预览里没有取样对象）。
 * ② **保留空态**：`?empty=1`（页面 URL 查询串经 `Referer` 读回，与 `?denied=1` / `?nonadmin=1`
 *    同一形态，见 `data/previewPermissions.ts:123-153`）⇒ 返回 `tasks: []`，即「本工作区暂无自动化任务」。
 *    **不做 env 开关**：`XIHE_UI_MOCK_*` 参与截图 manifest 的环境快照（`scripts/ui-mock-shot.mjs`
 *    的 `MOCK_ENV_KEYS`），新增一个键要同批改脚本；本卡 write_scopes 只到 `src/preview/**`。
 * ③ **失败态不做**：不造 500 /「请求失败」夹具（卡面明确：失败态已由 task-67 在单测层覆盖）。
 *    唯一保留的 404 是**未知 workspace**（`WORKSPACE_NOT_FOUND`）——那是真实判定，不是演失败。
 *
 * ## 诚实边界（写面不复刻 —— 与 `data/providerConnections.ts` 同一口径）
 * 本模块只接**读面**：`POST /scheduled-tasks`（新建）、`DELETE|rerun|remove|postpone`（处置）
 * 全部**不实现**，仍按 mock 车道兜底回 `404 MOCK_ENDPOINT_MISSING`。原因两条：
 * ① CP 的写面带配额（每工作区 50 / 每主体 10）、`MANAGE_SCHEDULED_TASK` 授权、状态机 409
 *    （`SCHEDULED_TASK_STATE`）、重跑幂等键与审计落库（openapi `:4860-4990`）—— 只复刻一半会变成
 *    「在 mock 里能点通、真栈 409」的假通过；
 * ② 页面处置按钮的可用性由 `canManageScheduledTask`（`features/workspace/stores/scheduledTasks.ts:65-77`）
 *    fail-closed 判定：只认 **human 且 creator 名命中当前用户**。故三条夹具的 `createdBy` 故意都是
 *    **非当前预览用户**（阿岚 / 周野 / agent），按钮呈真实产品的「需要授权」禁用态 ——
 *    **不制造「看得到、点了 404」的死入口**（那正是本卡要消掉的那类假象）。
 */
import type { ScheduledTask, ScheduledTaskListPage } from "../../../types";

/** 与 `api-server.ts` 的 `MOCK_WORKSPACE.id` / `data/sessions.ts` 的 `MOCK_SESSION_WORKSPACE_ID`
 *  同一个工作区（同一性由 coverage 测用 `GET /workspaces` 反查钉住，不另造第三套 id）。 */
export const MOCK_SCHEDULED_TASKS_WORKSPACE_ID = "9f8e7d6c-5b4a-4321-8fed-cba987654321";

/** 目标会话取 `data/sessions.ts` 的 S1（`c1f0c4d2-…-000101`）—— 夹具之间互相指向同一个实体，
 *  不给 `targetSessionId` 编一个库里不存在的会话（那会让「目标是哪条会话」在预览里无法核对）。 */
const TARGET_SESSION_ID = "c1f0c4d2-7b3e-4c55-8f10-5d2c9b000101";

/** 契约上限（openapi `:4819-4820`：page minimum 0；size minimum 1 / maximum 200 / default 100）。 */
const MAX_PAGE_SIZE = 200;
/** 缺省 size（openapi `:4820` 的 `default: 100`）。 */
const DEFAULT_PAGE_SIZE = 100;

function task(
    fields: Partial<ScheduledTask> & Pick<ScheduledTask, "id" | "triggerKind" | "status">,
): ScheduledTask {
    return {
        cronExpr: null,
        timezone: "Asia/Shanghai",
        targetKind: "session_wakeup",
        targetSessionId: null,
        prompt: null,
        nextFireAt: null,
        expiresAt: null,
        missedCount: 0,
        lastMissedAt: null,
        missedReason: null,
        lastRunId: null,
        createdBy: { name: null, type: "human" },
        createdAt: "2026-11-14T02:00:00Z",
        updatedAt: "2026-11-14T02:00:00Z",
        ...fields,
    };
}

/**
 * 三条夹具，**按 createdAt 倒序**（openapi `:4802-4811`：newest-created first）。
 *
 * ## 时钟相关字段是**冻结快照**，不是「此刻」（已知限制，非缺陷）
 * `nextFireAt` / `lastMissedAt` / `expiresAt` 都是相对「某个瞬时」才有意义的投影字段。这里给的是
 * **静态字面量**，口径为「夹具快照瞬时 = `2026-11-17T04:00Z`（即 12:00 Asia/Shanghai）」——
 * 读图时把 `nextFireAt` 理解成「快照那一刻的下次触发」，**不是**「你看到这张图的此刻」。
 * 为什么不用 `Date.now()` 派生：截图执行器 `scripts/ui-mock-shot.mjs` 连拍两次比 sha，
 * 时间派生的值会让**每一轮像素都不同** ⇒ 抖动判据恒红、交付图不可复算。**确定性优先于「新鲜感」**，
 * 代价是这套夹具随快照瞬时远去而「看起来过期」（cron 那条的 nextFireAt 会落在过去）。
 * 要改口径，得先改截图执行器的判据（不在本卡 write_scopes 内）。
 *
 * 覆盖矩阵（列表页与四颗计数 chip 的取样对象，缺一条就有一支分支在预览里看不到）：
 *
 * | # | triggerKind | status    | tab 归属 | createdBy            | 二级信息 |
 * |---|-------------|-----------|----------|----------------------|----------|
 * | A | cron        | scheduled | 调度中   | human（阿岚）        | cronExpr + nextFireAt |
 * | B | interval    | missed    | 待处理   | human（周野）        | missedCount + missedReason |
 * | C | delay_once  | completed | 已结束   | agent（流水线巡检）  | expiresAt（7d TTL 用尽） |
 */
const MOCK_SCHEDULED_TASKS: ScheduledTask[] = [
    task({
        id: "a7f3c1e2-8d40-4a55-9c31-2f6b8e001001",
        triggerKind: "cron",
        status: "scheduled",
        cronExpr: "*/15 * * * *",
        targetKind: "session_wakeup",
        targetSessionId: TARGET_SESSION_ID,
        prompt: "每 15 分钟巡检一次流水线失败日志，把新增的失败摘要发回本会话。",
        nextFireAt: "2026-11-17T04:15:00Z",
        createdBy: { name: "阿岚", type: "human" },
        createdAt: "2026-11-16T08:30:00Z",
        updatedAt: "2026-11-17T03:15:00Z",
    }),
    task({
        id: "b8e4d2f3-9a51-4b66-ad42-3f7c9d002002",
        triggerKind: "interval",
        status: "missed",
        targetKind: "job_dispatch",
        targetSessionId: null,
        prompt: "每 10 分钟跑一次 typecheck，失败则落一条工作区任务记录。",
        nextFireAt: "2026-11-17T01:40:00Z",
        missedCount: 2,
        lastMissedAt: "2026-11-17T01:40:00Z",
        // 枚举逐字取自 openapi `:9015`（target_gone / dispatch_failed / overdue_grace）。
        missedReason: "dispatch_failed",
        createdBy: { name: "周野", type: "human" },
        createdAt: "2026-11-15T12:05:00Z",
        updatedAt: "2026-11-17T01:40:00Z",
    }),
    task({
        id: "c9f5e3a4-6b72-4c77-be53-4a8d0e003003",
        triggerKind: "delay_once",
        status: "completed",
        targetKind: "session_wakeup",
        targetSessionId: TARGET_SESSION_ID,
        prompt: "30 分钟后提醒本会话复核 task-72 的截图基线。",
        nextFireAt: null,
        expiresAt: "2026-11-16T03:00:00Z",
        createdBy: { name: "流水线巡检", type: "agent" },
        createdAt: "2026-11-15T08:00:00Z",
        updatedAt: "2026-11-15T09:00:00Z",
    }),
];

/**
 * `?empty=1` 判定：页面 URL 的查询串经 `Referer` 读回（产品代码不发这个参数，mock 层自己读）。
 * 与 `isDeniedPreviewMode` / `isNonAdminPreviewMode` 同形（`data/previewPermissions.ts:123-153`）：
 * 零产品改动、用户可手动切换、截图脚本只要能改 URL 就能取到空态。非 `1` / `true` 一律按默认非空。
 */
export function isScheduledTasksEmptyPreview(referer: string | undefined): boolean {
    if (!referer) return false;
    let page: URL;
    try {
        page = new URL(referer);
    } catch {
        return false;
    }
    const raw = page.searchParams.get("empty");
    return raw === "1" || raw === "true";
}

/** 夹具本体（只读视图：**不返回引用**，调用方改不动夹具本体）。 */
export function mockScheduledTasks(): ScheduledTask[] {
    // 逐条浅拷贝；`createdBy` 是嵌套对象，单独再拷一层（否则调用方改 name 会改到夹具本体）。
    // 用 for…of 而不是 map（`oxc/no-map-spread` 会把「在 map 里 spread 后改属性」判为低效写法）。
    const copies: ScheduledTask[] = [];
    for (const row of MOCK_SCHEDULED_TASKS) {
        const copy: ScheduledTask = { ...row };
        copy.createdBy = { name: row.createdBy.name, type: row.createdBy.type };
        copies.push(copy);
    }
    return copies;
}

/**
 * 列表读面：`{ workspaceId, page, size, tasks }`（openapi `:9037-9042` + e2e 桩外壳）。
 *
 * page/size 的 clamp 与 CP 同口径：`page` 非负整数（缺省 0），`size` 1–200（缺省 100）；
 * 非法值**回落缺省**而不是 400 —— 页面的 `listScheduledTasks` 只发正整数，这里回 400 只会
 * 把「参数拼错」演成「后端坏了」。空态开关见 `isScheduledTasksEmptyPreview`。
 */
export function mockScheduledTaskListPage(
    workspaceId: string,
    query: { page?: number; size?: number },
    options: { empty?: boolean } = {},
): ScheduledTaskListPage {
    const page =
        typeof query.page === "number" && Number.isInteger(query.page) && query.page >= 0
            ? query.page
            : 0;
    const size =
        typeof query.size === "number" && Number.isInteger(query.size) && query.size >= 1
            ? Math.min(query.size, MAX_PAGE_SIZE)
            : DEFAULT_PAGE_SIZE;
    const rows = options.empty ? [] : mockScheduledTasks();
    return {
        workspaceId,
        page,
        size,
        tasks: rows.slice(page * size, (page + 1) * size),
    };
}

/** porcelain 前缀 + 路径（`git status --porcelain` 前两列；只用真实会出现的前缀）。 */
export interface MockGitStatusEntry {
    status: string;
    path: string;
}

/**
 * 工作区 git 状态读面：`{ isRepository: true, entries }`（openapi `:3964-3985`）。
 *
 * 三条 entry 的路径**都真的存在于 mock 虚拟文件系统**（`data/workspaceTree.ts` 的 `MAIN_ROOT`：
 * `README.md` / `src/main.ts` / `docs/changelog.md`），coverage 测用 `listDirectory` 逐段反查钉住 ——
 * 否则「文件树里没有这个文件、仓库状态里却列着它」就是另一种假信息。
 */
export function mockWorkspaceGitStatus(): { isRepository: boolean; entries: MockGitStatusEntry[] } {
    return {
        isRepository: true,
        entries: [
            { status: " M", path: "README.md" },
            { status: " M", path: "src/main.ts" },
            { status: "??", path: "docs/changelog.md" },
        ],
    };
}
