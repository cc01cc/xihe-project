// Mock 车道的**唯一入口**（每条用例都会调 `setupMockAuth`）。两处顺序/口径陷阱先看这里：
//
// 1. **Playwright route 是 LIFO —— 后注册优先。** 所以本文件把兜底 `**/api/v1/**` 放在前部、
//    显式桩放在后面；spec 里自己 `page.route(...)` 的桩一定赢过 `setupMockAuth` 的桩。反过来写
//    （先显式、后兜底）会让兜底吞掉显式桩，症状是「我明明桩了却拿到兜底数据」。
// 2. **没桩不再等于 `200 {}`**（task-64）：兜底对未被认领的 `/api/v1/*` 回 `404` +
//    `application/problem+json { code: "NO_MOCK_FOR_ROUTE", method, path }`，并打一条带 spec 文件名的
//    `[mock-fixture]` warn。
// 3. **本夹具不提供「容忍未桩端点」的逃生阀**：`task-64` 曾设计过一个页面级 `permissive` 开关
//    （开了就退回 `200 {}`），落地时**否决**了 —— task-144 补完 24 个端点后它零消费者，
//    按「0 引用 = 不在链上」不引入；留着一个没人用的逃生阀，下一个人只会顺手打开它。
//    若将来某条 spec 确需容忍未桩端点，**必须同批给出一条使用它的用例**，否则不许加。
//
// 注：本注释**刻意用行注释**而不是块注释 —— `**/api/v1/**` 里的 `*` 紧跟 `/` 会提前闭合块注释
// （`lint:e2e` 的 block-comment 门就是查这类事故，task-66）。
import { test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
    participantRoster,
    stubSessionProjectionsForAllSessions,
    type SessionProjectionOptions,
} from "./session-projections";
import {
    installChatSessionEventStream,
    installWorkspaceEventStream,
    type WorkspaceStreamScenario,
} from "./context-events";
import { fulfillWorkspaceDetail } from "./workspace-fixture";
import { mockWorkspaceJobs } from "../../../src/preview/mock/data/workspaceEnvironment";
import {
    CHAT_RUN_NOT_FOUND,
    chatRunCancelProjection,
    chatRunProjection,
    installRunRegistryObservers,
    mockRunsFor,
    parseChatRunPath,
} from "./run-registry";
import { installApprovalRegistry, mockApprovalsFor } from "./approval-registry";
import {
    API_INPUT_TYPES_FIXTURE,
    CHECKPOINT_RETENTION_FIXTURE,
    ORG_UNIT_NODES_FIXTURE,
    PROVIDER_CATALOG_FIXTURE,
    ROLE_CATALOG_FIXTURE,
    agentTemplatesResponse,
    buildConfigMetaKeys,
    contextSourcesResponse,
    parseConfigMetaPath,
} from "./stub-families";

export interface MockSSEStream {
    tokens: string[];
    usage?: {
        inputTokens: number;
        outputTokens: number;
        cost?: number;
        source: string;
    };
    retryTokens?: string[];
    /**
     * PLAN-0659 T1.2：给本流的每个事件盖 `participantId`（多主体线程证据用）。wire 契约里
     * 每条事件都带产出主体（openapi.yaml 的 M1b-3）；夹具不盖这个字段时 UI **正确地**不渲染
     * 身份行 —— 所以「谁产出的」必须由夹具显式给，UI 不猜。
     */
    participantId?: string;
    /** PLAN-0659 T1.2：token 之后补一个 `tool_call`（过程行/工具卡的 actor 徽标证据）。 */
    toolCall?: { tool: string; toolCallId?: string; arguments?: unknown };
    errorAfterTokens?: {
        code: string;
        detail: string;
        retryable?: boolean;
        /** PLAN-0492: exhausted run-budget dimension relayed by the CP. */
        dimension?: "turns" | "elapsed" | "tokens";
        outcome?: string;
    };
    delayMs?: number;
    holdOpen?: boolean;
}

export interface MockAuthOptions {
    /**
     * 聊天流（`GET /api/v1/events?sessionId=…`）的桩形态（task-62）：
     * - **省略（默认）**：装**永不关闭**的空流（`installChatSessionEventStream`）。真实 CP 这条流
     *   就是长连接；旧默认是有限体 ⇒ 客户端 `isConnected` 恒 false ⇒ `SSEStream.handleSend`
     *   只 `console.warn` 就 return ⇒ **`POST /api/v1/chat` 一次都不发**，而"忘了传 sse"的
     *   发送用例会静默变成一个空测试（点发送、界面无反应、只要不断言 wire 就照样绿）。
     * - 对象：装可按 token/usage/error 驱动的轮次流（既有行为，一字未改）。
     * - `false`：**退回旧口径**（一次性 `retry: 5000` 有限体）。需要「连接不建立」或靠
     *   `page.on("request")` 观察这条 URL 的 spec 必须显式选它 —— in-page `fetch` 覆盖
     *   不会在网络上留下 request 事件。
     *
     * 全局对照测量也可用 `XH_FIXTURE_CHAT_EVENTS=finite`（形态照 `XH_FIXTURE_WORKSPACE_EVENTS`）。
     */
    sse?: MockSSEStream | false;
    /**
     * PLAN-0639 M2: extra workspace fields merged into both workspace seeds
     * (localStorage + sessionStorage), e.g. `roots` for the grouped file tree.
     * Fields the caller does not set keep the existing fixture values.
     */
    workspace?: Record<string, unknown>;
    /**
     * task-59：`true` ⇒ **seed 不再注入 `roots`**，工作区 roots 必须从 wire 来
     * （需要固定多根数据的 spec 自己 `page.route` 给 `GET /api/v1/workspaces/{id}`）。
     *
     * 默认 `false`，保留既有的「合并进两个 seed」语义（96 个 spec 不动）。
     * 这个开关存在的唯一理由：roots 从 seed 来的时候，`normalizeWorkspaceRoots` 那条映射
     * **根本没被走到** —— 把它整行注释掉，多根用例照样绿（判别力 = 0）。
     */
    rootsFromWire?: boolean;
    /**
     * task-140：`GET /api/v1/workspaces`（**列表**）的响应体，默认 = 与 seed 同源的单工作区。
     *
     * <p>为什么必须有它：左栏自 task-352 / D-1206 起按**工作区分组**，页面要的是列表；本夹具原先只桩了
     * 详情 `GET /api/v1/workspaces/{id}`（见上面 `rootsFromWire` 的注释），列表请求就落到通配
     * `/api/v1/**` 那条兜底 ⇒ 拿到 `200 {}` ⇒ 左栏渲染成「还没有工作区」⇒ 会话列与正文永不挂载。</p>
     *
     * <p><b>不要把它写成「修复了 N 条红」</b>：它与那批红的因果关系**尚未确认** —— `ui-1` 在含 `task-64`
     * 404 兜底的树上看到「无列表桩 ⇒ 11 条红」，`ui-2` 在撤掉 404 后测同一批 spec 为全绿，两读冲突。
     * 本夹具的证据只有一条：**列表端点此前没有桩**（`git grep` 可核）。因果裁定见后续 2×2 探针。</p>
     *
     * <p>多工作区用例传数组（条数 = 期望的分组数）；**不要**写成「数组或 `{items:[]}` 都收」的宽松桩 ——
     * 生产返回的就是裸数组（`ApiWorkspace[]`，`src/composables/api.ts` 的 `listWorkspaces()`）。</p>
     */
    workspaceList?: Array<Record<string, unknown>>;
    /**
     * BL-318：四类会话投影默认挂（形状照抄真实 CP 响应）。传 `false` 关掉，用于极少数要断言
     * "投影不可用"降级路径的用例；传对象可覆盖参与者花名册 / capabilities。
     */
    projections?: SessionProjectionOptions | false;
    /**
     * PLAN-0752 M4：`/settings/data`、凭据面板这类**有 atom** 的页现在按能力投影决定是否挂载主体
     * （`SettingsPermissionGate` 的 `atom-denied` 只留 403 卡片，不渲染控件）。夹具用户默认**零能力**，
     * 所以「导出/导入按钮在」「保留期清理控件在」这类用例必须显式授予能力，否则看到的是 403 视图
     * ——那是另一条用例（权限门）该断言的东西，不该让功能用例替它红。
     */
    capabilities?: Record<string, boolean>;
    /**
     * task-163：`GET /api/v1/me/permissions` 的**原子面覆盖**（默认 = 本文件的 `PERMISSION_ATOMS` 全量）。
     *
     * 不传 ⇒ 行为与改动前逐字节相同（既有 100+ spec 不受影响）。要验「缺某个原子 ⇒ 入口应隐藏/置灰」的
     * 用例必须显式传 `permissionAtomsWithout("MANAGE_ROLES")` 这样的清单，否则那句话在夹具层是假的。
     */
    permissionAtoms?: ReadonlyArray<{ actionClass: string; resource: string }>;
    /**
     * task-163：工作区角色与 `workspaceAdmin`（默认 `WS_OWNER` / `true`，即既有的所有权限主体）。
     * 角色名用 CP 的 canonical 值（`SystemAccessRoleCatalog.WS_OWNER|WS_EDITOR|WS_VIEWER`），不自造别名。
     */
    workspaceRole?: "WS_OWNER" | "WS_EDITOR" | "WS_VIEWER";
    /**
     * task-176：成组的能力/角色预设 —— 让「缺能力」用例有一个自洽的起点（见 `CAPABILITY_PRESETS`）。
     * 传了它之后，显式的 `capabilities` / `permissionAtoms` / `workspaceRole` / `workspaceAdmin`
     * 仍按字段覆盖预设值；不传则一切照旧。
     */
    capabilitiesPreset?: "instanceAdmin" | "owner" | "editor" | "viewer" | "none";
    workspaceAdmin?: boolean;
    /**
     * task-100：工作区事件流（`GET /api/v1/workspaces/{id}/events`）的桩形态。
     * - `"stream"`（默认）：in-page `window.fetch` 覆盖返回**永不关闭**的流
     *   （`installWorkspaceEventStream`）。真实 CP 就是长连接，有限体会让客户端恒速重连
     *   —— task-98 实测 101 次 / 30 s。
     * - `"off"`：不装 in-page 桩，请求照旧走 `page.route`（网络层）。**只有两类 spec 需要**：
     *   ① 自己用 `page.route` 给这条 URL 回非 200（如 429 上限提示）—— in-page 桩会抢在前面把
     *   它盖掉；② 靠 `page.on("request")` 观察这条 URL 是否被请求。这类 spec 里会保留旧口径的
     *   有限体（含它的重连 churn），属**已知代价**，不是回退。
     */
    workspaceEvents?: "stream" | "off";
    /**
     * task-101：显式指定工作区事件流的**关流场景**（见 `WorkspaceStreamScenario`）。
     *
     * 为什么要能显式传：环境变量 `XH_FIXTURE_SSE_SCENARIO` 只在测量时设，忘了设的用例会
     * 悄悄跑在 `hold`（永不关流）上 —— 那种绿不携带信息。重连退避用例必须把场景**写进代码**。
     */
    workspaceEventsScenario?: WorkspaceStreamScenario;
}

export interface MockSessionRecord {
    id: string;
    title: string;
    agentPrincipalId?: string | null;
    /**
     * task-590：会话投影里的 provider 绑定。**发送路径的前提** ——
     * `ChatPanel.guardProviderBinding` 先看会话行的 `providerConnectionId`（BL-270），
     * 没有就回落 `POST /sessions/{id}/bind-defaults`，而 mock 车道**不会重放**被拦下的消息
     * （实测：只有 toast，没有 `POST /chat`、没有气泡）。
     * ⇒ 夹具要让"能发送"这件事**不需要时序**：直接让投影自带绑定，而不是桩 bind-defaults 再等重放。
     */
    providerConnectionId?: string | null;
    createdAt?: string;
    updatedAt?: string;
    workspaceId?: string;
}

export interface MockSessionOptions {
    sessions?: MockSessionRecord[];
    /**
     * task-373 / `D-1228`：独立会话（`workspace_id IS NULL`）。它们走
     * `GET /sessions?scope=workspaceless`，与 `sessions`（工作区作用域）是**两份**数据，
     * 不是一份里挑 null —— 后者会让「不带 scope 逐字节不变」这条契约在夹具里就破掉。
     */
    workspacelessSessions?: MockSessionRecord[];
    workspaceId?: string;
    messages?: Record<string, Array<Record<string, unknown>>>;
    createSession?: boolean;
    /**
     * BL-318：四类会话投影（derived-state / follow-ups / commands / participants）**默认挂**，
     * 因为它们不桩就是真 404 + console error（夹具缺口，会让 "0 console error" 门禁假红）。
     * - 传对象 = 覆盖参与者花名册 / capabilities；
     * - 传 `false` = 不挂（极少数要断言"投影不可用"降级路径的用例）；
     * - 想只覆盖其中一条：在本函数**之后**再 `page.route`（后注册优先）或 `route.fallback()`。
     */
    projections?: SessionProjectionOptions | false;
}

/** task-100：`XH_FIXTURE_WORKSPACE_EVENTS=off` 只在首次生效时喊一次，避免刷屏。 */
let warnedLegacyWorkspaceEvents = false;
/** task-100：`XH_FIXTURE_MONITOR=sse` 同样只喊一次。 */
let warnedLegacyMonitor = false;

/**
 * task-590：构造一条**能走完发送路径**的会话记录（投影自带 provider 绑定）。
 *
 * <p>用法：`setupMockSessions(page, { sessions: [sendableSession({ id, title })] })` ——
 * 之后按 Enter 就会真发 `POST /api/v1/chat`、乐观气泡上屏、输入框被清空；**不需要**
 * `bind-defaults` 桩，也不依赖「被拦下的消息会被重放」这个产品内部时机（mock 车道没有）。</p>
 *
 * <p>反向控制：同一条会话去掉 `providerConnectionId`（默认值就是 null）⇒ 发送被
 * `guardProviderBinding` 拦下，不会出现 `POST /chat`。判据见
 * `e2e/mock/task590-sendable-fixture.spec.ts`。</p>
 */
export function sendableSession(session: MockSessionRecord): MockSessionRecord {
    return { providerConnectionId: MOCK_PROVIDER_CONNECTION_ID, ...session };
}

const MOCK_ROOT_BRANCH_ID = "00000000-0000-4000-8000-000000000001";
/** task-590：夹具默认 provider 连接 id（只用于"看起来已绑定"的投影，不对应真实连接）。 */
const MOCK_PROVIDER_CONNECTION_ID = "conn-mock-sendable";
/** Default bound Agent principal for fixture Sessions (see `setupMockSessions`). */
const MOCK_BOUND_PRINCIPAL_ID = "00000000-0000-4000-8000-0000000000a1";
type MockBranch = {
    branchId: string;
    parentBranchId: string | null;
    forkPointMessageId: string | null;
    forkPointRunId: string | null;
    createdAt: string;
};

/**
 * `SessionMonitorResponse` 的最小合法体（形状照抄 `screenshots.spec.ts` 的同一桩）。
 * `history` / `readiness` 是产品渲染的必需投影（`SessionMonitorPanel` 读 `data.history.recent`），
 * 给 `{}` 会在面板里抛 "reading 'recent'"。
 */
function sessionMonitorResponse(): Record<string, unknown> {
    const now = new Date().toISOString();
    return {
        generatedAt: now,
        session: {
            id: "test-session",
            title: "Mock Session",
            agentPrincipalId: null,
            modelProvider: null,
            modelName: null,
            providerConnectionId: null,
            connectionRevision: null,
            createdAt: now,
            updatedAt: now,
        },
        activity: [],
        history: { windowSize: 20, counts: {}, recent: [] },
        readiness: {
            connection: null,
            agent: {
                status: "unknown",
                llmReady: "unknown",
                verifiedAt: null,
                configRevision: "0",
            },
            lastObservedRun: null,
        },
        transport: { attemptCount: 0, failedCount: 0, partialCount: 0 },
    };
}

/** task-546：mock 工作区的固定 id（形状合法 UUID，不是随机值）。 */
export const MOCK_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

/**
 * task-144：实例配置域夹具（`GET /api/v1/config/{domain}` 的 string map）。
 *
 * <p>**为什么需要**：这 10 个域在 mock 车道此前一个都没有 ⇒ 页面壳一挂载就吃 404 ⇒ 整条用例红在
 * `mock-test.ts:70` 的「无意外浏览器侧失败」上（实测 22 条新红里 21 条的**正文断言全过**）。</p>
 *
 * <p>**形状来源**：键规则照 `src/preview/mock/api-server.ts` 的 `entriesFor()`（非字符串值序列化成
 * JSON 字符串）；值取自 `src/preview/mock/data/mockValues.ts` 的同名域（该表对过真实 CP）。
 * 这里只搬**面板首屏会读**的键，未搬的键语义等价于「该键未配置」。</p>
 *
 * <p>`api-request-templates` 特别说明：真实响应里 `templates` 是 **JSON 字符串**
 * （`src/preview/mock/data/apiRequestTemplates.ts` 的 `apiRequestTemplateEntries()`）；
 * 这里给 `"[]"` = 未发布任何模板（合法空集），**不虚构模板对象**。</p>
 */
export const INSTANCE_CONFIG_FIXTURES: Record<string, Record<string, unknown>> = {
    "agent-profile": { userName: "xihe-operator" },
    "agent-runtime": {
        useRegistry: "true",
        useSupervisor: "true",
        workersDir: ".xihe/workers",
        runMaxTurns: 40,
        runMaxElapsedSeconds: 900,
        runMaxTokens: 200000,
        maxConcurrentRunsPerSession: 2,
    },
    "approval-policy": {
        mode: "manual",
        askActionClasses: ["file.write", "shell.exec", "network.egress"],
    },
    "context-policy": {
        defaults: {
            fingerprintEnabled: true,
            softThresholdPct: 0.72,
            hardThresholdPct: 0.9,
            keepRecentMessages: 6,
            maxInputTokens: 128000,
            summaryProvider: "llm",
            summaryModel: "gpt-4o-mini",
        },
    },
    embedding: {
        model: "text-embedding-3-small",
        dimensions: 768,
        "profile.providerId": "openai",
        "profile.connectionKey": "conn-embed-primary",
        "profile.model": "text-embedding-3-small",
    },
    "job-policy": { defaultTimeoutSecs: 3600, maxTimeoutSecs: 86400 },
    "llm-provider": {
        "profile.providerId": "anthropic",
        "profile.connectionKey": "conn-claude-primary",
        "profile.model": "claude-sonnet-4-5",
        imageProvider: "openai",
    },
    rag: { chunkSize: 512, chunkOverlap: 64, topK: 6, minScore: 0.35 },
    "user-preference": { theme: "dark", language: "zh-CN" },
    "api-request-templates": { templates: "[]" },
    // task-149 A：INSTANCE_DOMAINS 的 12 域里原本缺这两个 ⇒ `/config/{domain}` 与 `/config/{domain}/meta`
    // 两条路都在它们身上 404。值取自 `src/preview/mock/data/mockValues.ts:61-70`（agent-templates 的
    // roles/templates）与 `data/domains-b.ts` 的 logging 键清单；logging 值用 CP `logging.json` 的默认
    // 等级 INFO（`data/domains-b.ts:29-33` 列出每个键的源码出处）。
    logging: {
        logLevel: "INFO",
        levelCp: "INFO",
        levelAgent: "INFO",
        levelRuntime: "INFO",
        levelUi: "INFO",
    },
    "agent-templates": {
        roles: [
            { id: "coder", name: "编码助手", instructions: "先读后写，改动最小化。" },
            { id: "reviewer", name: "评审员", instructions: "只指出问题，不改代码。" },
        ],
        templates: [
            { id: "tpl-default", roleId: "coder", content: "默认任务模板（PLAN-0414）。" },
            { id: "tpl-review", roleId: "reviewer", content: "变更评审模板。" },
        ],
    },
};

/**
 * task-144：`GET /api/v1/me/permissions` 的权限原子投影。
 *
 * <p>形状照 `src/preview/mock/data/previewPermissions.ts` 的 `mockPermissionProjection()`：
 * `userId` / `instanceCapabilities` / `instancePermissions` / `workspaces` 四字段。原子取
 * `PREVIEW_PERMISSION_ATOMS` 里**产品真的会判**的那几条；角色名用 CP 的 canonical `WS_OWNER`
 * （`SystemAccessRoleCatalog.WS_OWNER`），不自造别名。</p>
 */
export const PERMISSION_ATOMS = [
    { actionClass: "MANAGE_ROLES", resource: "*" },
    { actionClass: "MANAGE_AGENT_PRINCIPALS", resource: "*" },
    { actionClass: "MANAGE_INSTANCE_CONFIG", resource: "*" },
    { actionClass: "MANAGE_WORKSPACE_DEFAULT_CONFIG", resource: "*" },
    { actionClass: "VIEW_INSTANCE_AUDIT", resource: "*" },
    { actionClass: "MANAGE_SKILL_LIBRARY", resource: "*" },
] as const;

/**
 * task-163：按用例裁剪原子面。默认（不调用它）保持 PERMISSION_ATOMS 全量 ⇒ 既有 spec 行为不变。
 *
 * 为什么要有：PERMISSION_ATOMS 是常量，/me/permissions 此前无条件整份塞进 instancePermissions ——
 * 于是「只给 isInstanceAdmin 能力位、不给 MANAGE_ROLES」这种用例在夹具层根本不成立：页面照样拿到
 * MANAGE_ROLES ⇒「缺能力应置灰/应隐藏」永远测不到（实测 resources-ia.spec.ts:36 计数 14 vs 期望 13、
 * policy-management.spec.ts:357 组数 2 vs 1）。
 *
 * 用法是显式点名**缺哪个原子**，而不是另给一份全量清单 —— 夹具里仍然只有一份原子词表（D-1485）。
 */
export function permissionAtomsWithout(
    ...deny: ReadonlyArray<string>
): Array<{ actionClass: string; resource: string }> {
    return PERMISSION_ATOMS.filter((atom) => !deny.includes(atom.actionClass));
}

/**
 * task-176：**能力预设**（viewer / editor / owner）—— 让「缺能力」能被真实表达。
 *
 * 为什么需要：夹具默认 `isInstanceAdmin: true` + 原子全量 ⇒ 「无权限」类用例一直在测管理员
 * （同族第 2 例，D-1536）。单点覆盖（`permissionAtoms` / `workspaceRole` / `workspaceAdmin`）能改一项，
 * 但门的判据是**组合**：`canManageWorkspace = isAdmin || projection.workspaceAdmin`、
 * `canViewMembers = canWrite(原子) || canManage`（`src/stores/auth.ts:234-295`）⇒ 必须成组自洽。
 *
 * 角色名用 CP canonical 值（`WS_OWNER|WS_EDITOR|WS_VIEWER`）；能力位照 `CapabilitiesView`
 * （`isInstanceAdmin` / `isInstanceSuper` / `canCreateWorkspace` / `workspaceAdminOf`）。
 * 未指定的项**回落既有默认**（`DEFAULT_CAPABILITIES` / 全量原子 / `WS_OWNER` / `true`）⇒ 不传 preset 行为逐字节不变。
 */
export const CAPABILITY_PRESETS = {
    /** 默认语义（= 今天不传任何选项时的夹具）：实例管理员。 */
    instanceAdmin: {
        capabilities: { isInstanceAdmin: true, isInstanceSuper: true, canCreateWorkspace: true },
        workspaceRole: "WS_OWNER" as const,
        workspaceAdmin: true,
        permissionAtoms: PERMISSION_ATOMS,
    },
    /** 工作区属主：非实例管理员，但本工作区 `workspace:admin`（`workspaceAdminOf` 只含本区）。 */
    owner: {
        capabilities: { isInstanceAdmin: false, isInstanceSuper: false, canCreateWorkspace: true },
        workspaceRole: "WS_OWNER" as const,
        workspaceAdmin: true,
        permissionAtoms: PERMISSION_ATOMS.filter((atom) => atom.actionClass !== "MANAGE_ROLES"),
    },
    /** 编辑者：可写（原子 `WRITE_WORKSPACE_CONTENT`），不能管理成员。 */
    editor: {
        capabilities: { isInstanceAdmin: false, isInstanceSuper: false, canCreateWorkspace: true },
        workspaceRole: "WS_EDITOR" as const,
        workspaceAdmin: false,
        permissionAtoms: [{ actionClass: "WRITE_WORKSPACE_CONTENT", resource: "*" }],
    },
    /** 只读者：无写、无管理；`canViewMembers` / 管理区都应不成立。 */
    viewer: {
        capabilities: { isInstanceAdmin: false, isInstanceSuper: false, canCreateWorkspace: false },
        workspaceRole: "WS_VIEWER" as const,
        workspaceAdmin: false,
        permissionAtoms: [] as Array<{ actionClass: string; resource: string }>,
    },
    /** 全空：连工作区只读都没有（用来测「什么都没给」的降级路径）。 */
    none: {
        capabilities: { isInstanceAdmin: false, isInstanceSuper: false, canCreateWorkspace: false },
        workspaceRole: "WS_VIEWER" as const,
        workspaceAdmin: false,
        permissionAtoms: [] as Array<{ actionClass: string; resource: string }>,
    },
} as const;

/** task-144：与 preview mock 的 CAPABILITIES 同值（isInstanceAdmin 等三位）。 */
const DEFAULT_CAPABILITIES = {
    isInstanceAdmin: true,
    isInstanceSuper: true,
    canCreateWorkspace: true,
};

export async function setupMockAuth(page: Page, options: MockAuthOptions = {}) {
    // task-163/176：能力与角色面按用例覆盖，`capabilitiesPreset` 是**成组**的起点。
    // 优先级：显式字段 > 预设 > 既有默认（⇒ 不传 preset 时与 task-144 逐字节相同）。
    const preset = options.capabilitiesPreset
        ? CAPABILITY_PRESETS[options.capabilitiesPreset]
        : undefined;
    const permissionAtoms = options.permissionAtoms ?? preset?.permissionAtoms ?? PERMISSION_ATOMS;
    const workspaceRole = options.workspaceRole ?? preset?.workspaceRole ?? "WS_OWNER";
    const workspaceAdmin = options.workspaceAdmin ?? preset?.workspaceAdmin ?? true;
    // 能力位**必须成套**给：`workspaceAdminOf` 缺失会让 `src/stores/auth.ts:237` 抛
    // `Cannot read properties of undefined (reading 'includes')`（产品对投影缺字段不健壮，`D-1536` 缺陷候选）。
    // **替换语义，不是合并**：`options.capabilities` 显式给出时**整份替换**默认三件套
    // （task-144 以来的既有语义 —— `{ capabilities: {} }` 就是「什么能力都没有」）。
    // 早期写成 `{...defaults, ...options.capabilities}` 合并，`{}` 就无法清空 `isInstanceAdmin`，
    // 实测让 `policy-management:363`（「无管理员能力」用例）从绿回落成红。
    const resolvedCapabilities = {
        workspaceAdminOf: workspaceAdmin ? [MOCK_WORKSPACE_ID] : [],
        ...(options.capabilities ?? preset?.capabilities ?? DEFAULT_CAPABILITIES),
    };
    // task-100：工作区事件流必须是**长连接**。旧桩用 `route.fulfill` 给有限体，响应立刻结束 ⇒
    // 客户端 clean_close + 恒速重连（task-98 实测 101 次 / 30 s）。Playwright 没有流式 fulfill，
    // 所以这条流由 in-page `window.fetch` 覆盖提供（见 `installWorkspaceEventStream`）。
    if (process.env.XH_FIXTURE_WORKSPACE_EVENTS === "off" && !warnedLegacyWorkspaceEvents) {
        // 显式喊一声：不喊的话，shell 里残留的这个变量会让整批 spec 悄悄跑在**旧夹具**上，
        // 而报告里看不出任何区别 —— 那就是另一种假绿。
        warnedLegacyWorkspaceEvents = true;
        console.warn(
            "[fixture] XH_FIXTURE_WORKSPACE_EVENTS=off ⇒ 工作区事件流退回 task-100 之前的有限体桩" +
                "（仅 before/after 对照测量用；产品行为不变）",
        );
    }
    // `XH_FIXTURE_WORKSPACE_EVENTS=off` 是**测量用的对照开关**（task-100）：它把这条流退回
    // task-100 之前的有限体口径，从而可以在**同一次窗口、同一条命令、同一棵树**上跑出 before
    // 读数。没有它，before 只能用另一棵树/另一把尺量，前后不可比。产品代码不读这个变量。
    const workspaceEvents =
        options.workspaceEvents ??
        (process.env.XH_FIXTURE_WORKSPACE_EVENTS === "off" ? "off" : "stream");
    if (workspaceEvents === "stream") {
        await installWorkspaceEventStream(page, options.workspaceEventsScenario);
    }
    const branchesBySession = new Map<string, MockBranch[]>();
    const branchResponses = new Map<
        string,
        {
            requestHash: string;
            response: { branchId: string; parentBranchId: string; forkPointMessageId: string };
        }
    >();
    // task-59：`rootsFromWire` 还必须**让 store 真的去取**。`selectWorkspace`（stores/auth.ts:504）
    // 的短路条件是「id 命中 且已有 name 或 workspaceRole」—— seed 一旦带 name，它就直接返回内存里的
    // 对象，`GET /workspaces/{id}` 连发都不发。那时无论 wire 返回什么，多根都到不了 UI。
    // 所以这个开关同时把 seed 收窄成「只知道 id」，逼出那次请求。
    // task-546：mock 工作区 id 必须是**形状合法的 UUID**（固定值，不随机）。
    //
    // 生产侧 CP 强制 `X-Workspace-Id` 是 UUID，而 mock 一直用 `workspace-1` 这种假 id ——
    // 它自己看不出问题，直到 task-537 的守卫（router/index.ts 的 `isUuid`）按生产形态先验形状：
    // 非 UUID 的深链一律回落到工作区列表（整条 mock 车道 `6 failed`）。
    // 改夹具而不是松守卫：假 id 才是保真度缺陷，把守卫改松等于让产品迁就夹具。
    // 固定值而非随机：spec 里的 URL / route 匹配 / 断言都直接写这个常量，随机值会让它们不可复算。
    const workspaceOverrides = options.rootsFromWire ? {} : (options.workspace ?? {});
    const seedWorkspace = options.rootsFromWire
        ? { id: "11111111-1111-4111-8111-111111111111" }
        : {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Mock Workspace",
              ownerId: "user-1",
              ...workspaceOverrides,
          };
    const seedTabWorkspace = options.rootsFromWire
        ? { id: "11111111-1111-4111-8111-111111111111" }
        : {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Mock Workspace",
              workspaceRole: "OWNER",
              ownerId: "user-1",
              ...workspaceOverrides,
          };
    await page.addInitScript(
        ({ seededWorkspace, seededTabWorkspace, capabilities }) => {
            localStorage.setItem("xihe-token", "mock-token");
            localStorage.setItem(
                "xihe-user",
                JSON.stringify({
                    id: "user-1",
                    email: "test@xihe.local",
                    name: "Test User",
                    ...(capabilities ? { capabilities } : {}),
                }),
            );
            localStorage.setItem("xihe-workspace", JSON.stringify(seededWorkspace));
            // PLAN-0559 per-tab context is authoritative; migrateLegacyWorkspace drops
            // role fields, so seed sessionStorage directly with the post-login shape
            // (PLAN-0560 workspace settings rely on workspaceRole).
            sessionStorage.setItem("xihe-workspace", JSON.stringify(seededTabWorkspace));
        },
        {
            seededWorkspace: seedWorkspace,
            seededTabWorkspace: seedTabWorkspace,
            capabilities:
                options.capabilities ??
                (options.capabilitiesPreset ? resolvedCapabilities : undefined),
        },
    );

    if (options.sse) {
        await page.addInitScript(
            ({
                tokens,
                retryTokens,
                errorAfterTokens,
                delayMs,
                optionsUsage,
                holdOpen,
                participantId,
                toolCall,
            }) => {
                const originalFetch = window.fetch.bind(window);
                let streamController: ReadableStreamDefaultController<Uint8Array> | null = null,
                    streamClosed = false;
                let streamReady = false,
                    streamEmitted = false,
                    shouldFail = Boolean(errorAfterTokens);
                /** `runId` of the latest `202 ChatRunResponse`, used to correlate SSE events. */
                let currentRunId: string | undefined;

                const encode = (value: string) => new TextEncoder().encode(value);
                const event = (name: string, data: unknown) =>
                    `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
                /**
                 * PLAN-0659 T1.2：装配可选的事件信封字段 —— `runId`（CP 的每条事件都带，UI 用它
                 * 把 token 与 tool_call 归到同一个 run 的同一个气泡）与 `participantId`（产出主体，
                 * wire 契约 M1b-3）。夹具不带 `runId` 时 tool_call 会另起一个气泡（假失败）。
                 */
                const withParticipant = (data: Record<string, unknown>) => ({
                    ...(currentRunId ? { runId: currentRunId } : {}),
                    ...data,
                    ...(participantId ? { participantId } : {}),
                });

                const emit = async () => {
                    if (!streamController || streamClosed || streamEmitted) return;
                    streamEmitted = true;
                    try {
                        const responseTokens = shouldFail ? tokens : (retryTokens ?? tokens);
                        for (const token of responseTokens) {
                            if (delayMs > 0)
                                await new Promise((resolve) => setTimeout(resolve, delayMs));
                            if (!streamController || streamClosed) return;
                            streamController.enqueue(
                                encode(event("token", withParticipant({ content: token }))),
                            );
                        }
                        if (!streamClosed && toolCall) {
                            streamController.enqueue(
                                encode(
                                    event(
                                        "tool_call",
                                        withParticipant({
                                            tool: toolCall.tool,
                                            ...(toolCall.toolCallId
                                                ? { toolCallId: toolCall.toolCallId }
                                                : {}),
                                            arguments: toolCall.arguments ?? {},
                                            ...(currentRunId ? { run_id: currentRunId } : {}),
                                        }),
                                    ),
                                ),
                            );
                        }
                        if (shouldFail && errorAfterTokens) {
                            // The stream is correlated by `runId` (the one the `202` ChatRunResponse
                            // handed back). An `error` event without it cannot be attached to the
                            // assistant message, so no `message-error` banner is rendered.
                            streamController.enqueue(
                                encode(
                                    event("error", {
                                        ...errorAfterTokens,
                                        ...(currentRunId ? { runId: currentRunId } : {}),
                                    }),
                                ),
                            );
                            shouldFail = false;
                            streamEmitted = false;
                            return;
                        }
                        if (!streamClosed && optionsUsage) {
                            streamController.enqueue(encode(event("usage", optionsUsage)));
                        }
                        if (holdOpen) return;
                        if (!streamClosed) {
                            streamController.enqueue(encode(event("done", {})));
                            streamController.close();
                            streamClosed = true;
                        }
                    } catch {
                        streamClosed = true;
                    }
                };

                window.fetch = async (input, init) => {
                    const requestUrl =
                        typeof input === "string"
                            ? input
                            : input instanceof Request
                              ? input.url
                              : input.url;
                    if (requestUrl.includes("/api/v1/events")) {
                        streamClosed = false;
                        streamReady = false;
                        streamEmitted = false;
                        const body = new ReadableStream<Uint8Array>({
                            start(controller) {
                                streamController = controller;
                                controller.enqueue(encode("retry: 1000\n\n"));
                                if (streamReady) void emit();
                            },
                            cancel() {
                                streamClosed = true;
                                streamController = null;
                            },
                        });
                        return new Response(body, {
                            status: 200,
                            headers: { "Content-Type": "text/event-stream" },
                        });
                    }

                    if (
                        requestUrl.includes("/api/v1/chat") &&
                        (init?.method ?? (input instanceof Request ? input.method : "GET")) ===
                            "POST"
                    ) {
                        const response = await originalFetch(input, init);
                        currentRunId = await response
                            .clone()
                            .json()
                            .then((payload: { runId?: string }) => payload?.runId)
                            .catch(() => undefined);
                        streamReady = true;
                        void emit();
                        return response;
                    }

                    return originalFetch(input, init);
                };
            },
            {
                tokens: options.sse.tokens,
                optionsUsage: options.sse.usage,
                retryTokens: options.sse.retryTokens,
                errorAfterTokens: options.sse.errorAfterTokens,
                delayMs: options.sse.delayMs ?? 0,
                holdOpen: options.sse.holdOpen ?? false,
                participantId: options.sse.participantId,
                toolCall: options.sse.toolCall,
            },
        );
    }

    if (options.sse === false || process.env.XH_FIXTURE_CHAT_EVENTS === "finite") {
        // 显式选择的旧口径：一次性 `route.fulfill`（有限体）。Playwright 没有流式 fulfill，
        // 所以这条桩必定结束响应体 ⇒ 客户端 clean_close ⇒ isConnected 恒 false。
        await page.route("**/api/v1/events**", async (route) => {
            await route.fulfill({
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
                body: "retry: 5000\n\n",
            });
        });
    } else if (!options.sse) {
        // task-62 默认：聊天流长连接（真实 CP 的形态）。忘了传 sse 不再是「静默发不出去」。
        await installChatSessionEventStream(page);
    }

    // task-149 B：run 登记表 —— 唯一生产者就是下面这条 `POST /api/v1/chat`（产品真实拿到 runId 的
    // 那一条路径），所以登记表**不是第二份清单**，它记的 sessionId 就是本次请求体里的那个。
    // 未登记的 runId 一律 404（真实 CP 对未知 run 的行为），不做「任何 id 都回同一个 run」的兜底。
    const runs = mockRunsFor(page);
    // task-162：登记表的第二个生产者 —— 观察**任何** `POST /api/v1/chat` 的 202（含 spec 自建的
    // 202 桩，如 `follow-up-queue.spec`），否则那些 runId 在 `GET /chat/runs/{id}` 上会 404。
    installRunRegistryObservers(page, runs);
    // task-161：审批待决摘要的派生表（每页一张；决定成功后才从摘要里消失）。
    const approvals = mockApprovalsFor(page);
    await installApprovalRegistry(page);
    await page.route("**/api/v1/chat", async (route) => {
        const body = route.request().postDataJSON() as {
            branchId?: string;
            sessionId?: string;
        } | null;
        if (!body?.branchId) {
            await route.fulfill({
                status: 400,
                contentType: "application/problem+json",
                body: JSON.stringify({ code: "INVALID_REQUEST", detail: "branchId is required" }),
            });
            return;
        }
        // `POST /api/v1/chat` answers `202` with the full `ChatRunResponse`
        // (`origin`/`status`/`sessionId`/`runId` are required by the OpenAPI schema). The old
        // `{status:"accepted"}` body carried no `runId`, so the composer never recorded the run:
        // the assistant bubble could not be correlated with the SSE stream, and an `error` event
        // had nothing to attach to — the `message-error` banner never appeared.
        const runId = randomUUID();
        const sessionId = body.sessionId ?? "mock-session";
        runs.record({ runId, sessionId });
        await route.fulfill({
            status: 202,
            contentType: "application/json",
            body: JSON.stringify({
                origin: "user_submission",
                status: "accepted",
                sessionId,
                runId,
                messageId: randomUUID(),
            }),
        });
    });

    await page.route("**/api/v1/models", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ models: {} }),
        });
    });

    // task-64：未桩端点的 warn **按 (method, path) 去重** —— 同一端点会被轮询几百次，
    // 逐次打会把真正的红点淹掉；但「哪个 spec 发起」必须每处都点名（见下面 warn 里的 spec 字段）。
    const warnedUnstubbed = new Set<string>();
    await page.route("**/api/v1/**", async (route) => {
        const url = route.request().url();
        if (url.includes("/api/v1/workspaces/") && url.includes("/events")) {
            if (workspaceEvents === "off") {
                // 该 spec 明确要自己在网络层处理这条 URL（自有 429 桩 / 观察 request 事件）。
                // 保留 task-100 之前的有限体口径 —— 代价是这个 spec 内仍有重连 churn。
                await route.fulfill({
                    status: 200,
                    headers: { "Content-Type": "text/event-stream" },
                    body: "retry: 1000\n\n",
                });
                return;
            }
            // 正常情况下**到不了这里** —— `installWorkspaceEventStream`（setupMockAuth 开头挂的
            // in-page fetch 覆盖）已经把这条 URL 截住并返回永不关闭的流。
            // 这里刻意返回 501 而不是任何有限体：finite body 会立刻结束响应，把 task-98 的
            // 101 次/30 s 重连风暴原样复活；而**静默**返回一个"看起来能用"的东西，会让
            // 又一次夹具回归无人发现。狼狈一点，可查一点。
            await route.fulfill({
                status: 501,
                contentType: "application/problem+json",
                body: JSON.stringify({
                    code: "FIXTURE_UNREACHABLE",
                    detail: "workspace event stream must be served by installWorkspaceEventStream (in-page fetch)",
                }),
            });
            return;
        }
        // `GET /chat/sessions/{id}/monitor` 是 **JSON** 聚合读（`openapi.yaml:2152-2156`，
        // `SessionMonitorResponse`），不是 SSE。旧桩按 `text/event-stream` 服务它，产品的
        // `api.getSessionMonitor` 按 JSON 读 ⇒ `session monitor fetch failed: Unexpected token
        // 'r', "retry: 1000 "`（task-98/§12）。契约站产品这边，所以修的是桩。
        // 保留 stub 的理由照旧（PLAN-0577）：不桩就逃到 dev proxy，真 CP 回 401，产品会把
        // mock 会话登出。
        if (url.includes("/api/v1/chat/sessions/") && url.includes("/monitor")) {
            if (process.env.XH_FIXTURE_MONITOR === "sse") {
                // 测量用对照（task-100）：把 monitor 退回 task-100 之前的 `text/event-stream` 口径，
                // 用来量 `session monitor fetch failed` 的 before 值。产品代码不读这个变量。
                if (!warnedLegacyMonitor) {
                    warnedLegacyMonitor = true;
                    console.warn(
                        "[fixture] XH_FIXTURE_MONITOR=sse ⇒ monitor 端点退回 SSE 桩（仅 before/after 对照测量用）",
                    );
                }
                await route.fulfill({
                    status: 200,
                    headers: { "Content-Type": "text/event-stream" },
                    body: "retry: 1000\n\n",
                });
                return;
            }
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(sessionMonitorResponse()),
            });
            return;
        }
        // Only the endpoints that have their own route above may fall through; matching on
        // "contains /chat" also swallowed every `/api/v1/chat/runs/{id}/…` sub-resource
        // (guidance, recovery, cancel) and let it escape to the dev proxy, which answers
        // ECONNREFUSED — the run then looked broken for reasons that had nothing to do with
        // the code under test.
        const pathname = new URL(url).pathname;
        if (
            pathname === "/api/v1/events" ||
            pathname === "/api/v1/chat" ||
            pathname === "/api/v1/models"
        ) {
            return route.fallback();
        }
        const branchRoute = url.match(/\/api\/v1\/sessions\/([^/?]+)\/branches(?:\?|$)/);
        if (branchRoute) {
            const sessionId = branchRoute[1],
                method = route.request().method();
            if (method === "GET") {
                const items = branchesBySession.get(sessionId) ?? [
                    {
                        branchId: MOCK_ROOT_BRANCH_ID,
                        parentBranchId: null,
                        forkPointMessageId: null,
                        forkPointRunId: null,
                        createdAt: "2026-09-29T00:00:00.000Z",
                    },
                ];
                branchesBySession.set(sessionId, items);
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ sessionId, items }),
                });
                return;
            }
            if (method === "POST") {
                const body = route.request().postDataJSON() as {
                    sourceBranchId?: string;
                    anchorMessageId?: string;
                };
                if (
                    !body.sourceBranchId ||
                    !body.anchorMessageId ||
                    !route.request().headers()["idempotency-key"]
                ) {
                    await route.fulfill({
                        status: 400,
                        contentType: "application/problem+json",
                        body: JSON.stringify({
                            code: "INVALID_REQUEST",
                            detail: "branch request is incomplete",
                        }),
                    });
                    return;
                }
                const key = `${sessionId}:${route.request().headers()["idempotency-key"]}`;
                const requestHash = `${body.sourceBranchId}:${body.anchorMessageId}`,
                    prior = branchResponses.get(key);
                if (prior && prior.requestHash !== requestHash) {
                    await route.fulfill({
                        status: 409,
                        contentType: "application/problem+json",
                        body: JSON.stringify({
                            code: "IDEMPOTENCY_KEY_CONFLICT",
                            detail: "branch key conflict",
                        }),
                    });
                    return;
                }
                const response = prior?.response ?? {
                    branchId: randomUUID(),
                    parentBranchId: body.sourceBranchId,
                    forkPointMessageId: body.anchorMessageId,
                };
                branchResponses.set(key, { requestHash, response });
                const items = branchesBySession.get(sessionId) ?? [
                    {
                        branchId: MOCK_ROOT_BRANCH_ID,
                        parentBranchId: null,
                        forkPointMessageId: null,
                        forkPointRunId: null,
                        createdAt: "2026-09-29T00:00:00.000Z",
                    },
                ];
                if (!items.some((item) => item.branchId === response.branchId)) {
                    items.push({
                        branchId: response.branchId,
                        parentBranchId: response.parentBranchId,
                        forkPointMessageId: response.forkPointMessageId,
                        forkPointRunId: null,
                        createdAt: new Date().toISOString(),
                    });
                }
                branchesBySession.set(sessionId, items);
                await route.fulfill({
                    status: 201,
                    contentType: "application/json",
                    body: JSON.stringify(response),
                });
                return;
            }
        }
        const workspaceMatch = url.match(/\/api\/v1\/workspaces\/([^/?]+)$/);
        if (workspaceMatch?.[1] === "current" && route.request().method() === "GET") {
            await route.fulfill({
                status: 404,
                contentType: "application/problem+json",
                body: JSON.stringify({
                    code: "WORKSPACE_NOT_FOUND",
                    detail: "No active workspace",
                }),
            });
            return;
        }
        if (
            workspaceMatch &&
            workspaceMatch[1] !== "current" &&
            route.request().method() === "GET"
        ) {
            // task-59（B 案）：工作区详情改由**单一来源** `helpers/workspace-fixture.ts` 供给，
            // 不再在本文件里自编 `{ id, name, status }`。该响应带 14 个 wire 字段 + roots 投影，
            // 所以 `normalizeWorkspaceRoots` 这条映射**第一次真正被执行到**（此前恒 undefined）。
            // 不用 `route.fallback()`：mock 车道 `XIHE_UI_MOCK_API=0`，插件中间件没挂，
            // 放行只会掉到真 CP（实测 401）。要改这条 lane 的数据面是 task-339 的事。
            await fulfillWorkspaceDetail(route, workspaceMatch[1], {
                workspace: options.workspace ?? {},
            });
            return;
        }
        const sessionMatch = url.match(/\/api\/v1\/sessions\/([^/?]+)/);
        if (sessionMatch && route.request().method() === "GET") {
            if (url.includes("/messages")) {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify([]),
                });
                return;
            }
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    id: sessionMatch[1],
                    title: "Mock Session",
                    workspaceId: "11111111-1111-4111-8111-111111111111",
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    archived: false,
                    // Same reason as `setupMockSessions`: a real Session is created bound to an
                    // Agent principal, and a null one routes the composer into the binding
                    // dialog instead of sending.
                    agentPrincipalId: MOCK_BOUND_PRINCIPAL_ID,
                }),
            });
            return;
        }
        // task-475（Lead 裁 C，2026-11-14）：**只给这两种形态，不补 `/workspaces/{id}/sessions`**。
        // 依据是实测而不是偏好 —— 12 条 mock 录制 trace 聚合（r17 + workspace-members，12 passed /
        // 0 failed / flaky 0）：`GET /api/v1/sessions` 18 次（带 `X-Workspace-Id` 选工作区，
        // `composables/api.ts:3254-3261`）、`GET /api/v1/sessions?scope=workspaceless` 6 次
        // （`:3270-3276`）、`GET /api/v1/workspaces/{id}/sessions` **0 次**。该路径在 CP 只有 POST
        // （`docs/api/openapi.yaml:1194-1195`；`api.ts:3248-3250` 原文即「只有 POST」）⇒ 卡面
        // 「兜底缺工作区形态」的前提在产品上不成立，补它是空转防御（膨胀门：被否决的更简方案 = 这段注释）。
        // 顺带记住为什么本地桩看起来"是必需的"：本 handler 之后的 `**/api/v1/**` blanket 桩（LIFO
        // 后注册者胜）会盖掉这里，所以 spec 里那 13 处两形态桩是对 POST 路径形态的防御性外推（真受害面
        // 5 处），不是缺口的证据；要退役它们只能**主动删除**，不能靠"这里已经有了"。
        if (url.match(/\/api\/v1\/sessions(?:\?.*)?$/) && route.request().method() === "GET") {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ sessions: [] }),
            });
            return;
        }
        if (url.includes("/api/v1/policy/mode") && route.request().method() === "GET") {
            const sessionId = new URL(url).searchParams.get("sessionId") ?? "mock-session";
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ sessionId, mode: "manual", sessionRules: 0 }),
            });
            return;
        }
        // task-64：**没桩 = 一次显式失败**（不再 `200 {}`）。
        //
        // 旧行为：凡未被上面任何分支认领的 `/api/v1/*`（**任意 method**，含 POST/PUT/DELETE）
        // 都得到 `200 + {}`。它把「没有夹具」伪装成「数据恰好为空」，而「空」在列表页里是
        // **合法状态** ⇒ 红点落在离根因很远的 DOM 断言上（task-33 实测：`GET /api/v1/org-units`
        // 拿到 `{}` ⇒ 组织树空 ⇒ `waitForSelector` 等 30 s 超时），把人引去改产品代码。
        // 本文件里已有三处「为它打补丁」的既成证据（`workspaces/*/agents`、`/version`、run 列表
        // 与委派预算投影的默认桩）—— 一个逼人反复写补丁桩的兜底，本身就说明它选错了失败层。
        //
        const path_ = new URL(url).pathname;
        const method_ = route.request().method();
        const unstubbedKey = `${method_} ${path_}`;
        if (!warnedUnstubbed.has(unstubbedKey)) {
            warnedUnstubbed.add(unstubbedKey);
            // spec 文件名：39 条红的时候必须能直接指到「哪条用例发起的这条请求」，
            // 否则这条 warn 只是又一条噪声（Lead 2026-11-15 口径）。`test.info()` 在用例上下文
            // 内可用，在 worker 级钩子里会抛 ⇒ 兜住。
            let specFile = "<unknown-spec>";
            try {
                specFile = test.info().file.replace(/\\/g, "/");
            } catch {
                // 非用例上下文（page 级夹具）：保留占位，不吞掉这条 warn。
            }
            console.warn(
                `[mock-fixture] 未桩端点（不是"空数据"，是**没有夹具**）：${unstubbedKey} · spec=${specFile} · ` +
                    "补显式桩（page.route 后注册优先；壳的固定请求见 task-144 那一批）—— 本夹具没有逃生阀（task-144）",
            );
        }
        await route.fulfill({
            status: 404,
            contentType: "application/problem+json",
            body: JSON.stringify({
                code: "NO_MOCK_FOR_ROUTE",
                method: method_,
                path: path_,
                detail:
                    "no mock route claimed this /api/v1 URL (task-64). Add an explicit page.route stub " +
                    "(page-level stubs registered after setupMockAuth win by LIFO). There is no permissive escape hatch (task-144).",
            }),
        });
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // task-144：页面壳一挂载就会发起、此前**完全没有夹具**的 23 个 (method, path)。
    //
    // 它们是**固定开销**不是被测行为（身份投影 / 配置域 / 后台流 / 工作区面板 / MCP 工具网关）。
    // 缺它们的症状在 task-64（兜底改 404）之后是「整条用例红在 mock-test.ts:70 的『无意外浏览器侧
    // 失败』上」—— 实测 22 条新红里 21 条的**正文断言全过**：红来自严格门，不是产品故障。
    //
    // 纪律：只处理对应 method（其余 route.fallback()）；每族写形状来源；**禁止 `{}`**、
    // 禁止「数组或包装对象都收」。注册位置在兜底之后 ⇒ LIFO 优先。
    // ─────────────────────────────────────────────────────────────────────────────

    // ① 身份与权限投影。来源：preview mock 的 `/auth/me`（api-server.ts:314）与
    //    `/me/permissions`（:352）；id/name/email 与本文件 localStorage 种子一致。
    await page.route("**/api/v1/auth/me", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                id: "user-1",
                name: "Test User",
                email: "test@xihe.local",
                // task-163：**`workspaceAdminOf` 必须存在**。真实 CP 的 `CapabilitiesView` 恒带这一位
                // （工件佐证：`src/views/settings/__tests__/ToolFacesView.spec.ts:92-94` 记着「旧夹具只写
                // `ownerId`、`workspaceAdminOf: []`，那是现实中不存在的属主」）。缺了它，`auth.ts:237`
                // 的 `capabilities.value.workspaceAdminOf.includes(id)` 会在**非实例管理员**路径上抛
                // `Cannot read properties of undefined (reading 'includes')` —— 实测于本轮覆盖口首版。
                capabilities: resolvedCapabilities,
            }),
        });
    });

    await page.route("**/api/v1/me/permissions", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                userId: "user-1",
                instanceCapabilities: Object.entries(resolvedCapabilities)
                    .filter(([, granted]) => granted === true)
                    .map(([name]) => name),
                instancePermissions: permissionAtoms,
                workspaces: [
                    {
                        workspaceId: MOCK_WORKSPACE_ID,
                        workspaceRole,
                        workspaceAdmin,
                        permissions: permissionAtoms,
                    },
                ],
            }),
        });
    });

    // ② 配置域：`GET /api/v1/config/{domain}` → CP 的 config string map。
    //    带 `?layer=` 时 CP 回 `{ domain, layer, entries, envOverridden }`，不带则**直接回 map**
    //    （preview api-server.ts 的两个分支）。未知域不接 —— 继续走兜底 404 保持「没桩」可见。
    await page.route("**/api/v1/config/*", async (route) => {
        const request = route.request();
        if (request.method() !== "GET") return route.fallback();
        const url = new URL(request.url());
        const domain = url.pathname.split("/").pop() ?? "";
        const fixture = INSTANCE_CONFIG_FIXTURES[domain];
        if (!fixture) return route.fallback();
        // wire 是 string map：非字符串值序列化成 JSON 字符串（同 preview entriesFor）。
        const entries: Record<string, string> = {};
        for (const [key, value] of Object.entries(fixture)) {
            entries[key] = typeof value === "string" ? value : JSON.stringify(value);
        }
        const layer = url.searchParams.get("layer");
        const body = layer
            ? {
                  domain,
                  layer,
                  entries,
                  envOverridden: {},
                  ...(url.searchParams.get("includeMeta") === "true" ? { keys: [] } : {}),
              }
            : entries;
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(body),
        });
    });

    // ②b 配置域 provenance：`GET /api/v1/config/{domain}/meta?layer=` → `{ keys: ConfigKeyMeta[] }`。
    //     这条**必须单独注册**：上面那条 `**/api/v1/config/*` 的 `*` 不跨 `/` ⇒ 只匹配
    //     `config/{domain}`，带 `/meta` 的请求此前一律 404（实测 12 域 × 13 次 warn，最高频族）。
    //     域 → 键集合来自同一份实例夹具，**不另起一份清单**（两份清单必然漂移）。
    //     形状与 preview api-server.ts:1484-1539 一致；生成逻辑见 helpers/stub-families.ts。
    await page.route("**/api/v1/config/*/meta*", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const url = new URL(route.request().url());
        const domain = parseConfigMetaPath(url.pathname);
        if (!domain) return route.fallback();
        const fixture = INSTANCE_CONFIG_FIXTURES[domain];
        if (!fixture) return route.fallback();
        const entries: Record<string, string> = {};
        for (const [key, value] of Object.entries(fixture)) {
            entries[key] = typeof value === "string" ? value : JSON.stringify(value);
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ keys: buildConfigMetaKeys(entries) }),
        });
    });

    // ②c 其余读面族（task-149 B）：形状全部照产品侧消费点/预览 mock 的真实实现，
    //     不是「最小桩」—— 每个端点的语义约束写在 helpers/stub-families.ts 的夹具注释里。
    await page.route("**/api/v1/provider-catalog", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(PROVIDER_CATALOG_FIXTURE),
        });
    });

    await page.route("**/api/v1/api-input-types", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(API_INPUT_TYPES_FIXTURE),
        });
    });

    // 组织单元树：信封 `{ nodes }`（裸数组会被 api.ts 的信封校验抛）。
    // `q` 名字搜、`parentId` 懒加载子级 —— 两者都按夹具过滤，不忽略参数
    // （忽略 `parentId` 会让展开任意节点都返回根节点，树看起来「有内容」但是错的）。
    await page.route("**/api/v1/org-units", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const url = new URL(route.request().url());
        const parentId = url.searchParams.get("parentId");
        const q = url.searchParams.get("q");
        const nodes = q
            ? ORG_UNIT_NODES_FIXTURE.filter((node) => node.name.includes(q))
            : parentId
              ? ORG_UNIT_NODES_FIXTURE.filter((node) => node.parentId === parentId)
              : ORG_UNIT_NODES_FIXTURE.filter((node) => node.parentId === null);
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ nodes }),
        });
    });

    await page.route("**/api/v1/agent-templates*", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const url = new URL(route.request().url());
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(
                agentTemplatesResponse(
                    url.searchParams.get("layer"),
                    url.searchParams.get("workspaceId"),
                ),
            ),
        });
    });

    // task-163：`GET /api/v1/roles/catalog?locale=` **补桩**（Lead 2026-11-15 裁定翻转 task-149 的「刻意不桩」）。
    // 依据：该路由真实存在（`docs/api/openapi.yaml:5438-5454`，operationId `getRoleCatalog`），页面请求它是对的，
    // 之前的 404 是**夹具缺桩**；把 404 放进 spec 的 `mockAllow` 等于把错误行为固化成契约。
    // 词表「不私抄」的原判据仍然成立 ⇒ 夹具只列本 helper 身份投影里真的会判的原子（子集不是全集），
    // 来源与边界写在 `helpers/stub-families.ts` 的 `ROLE_CATALOG_FIXTURE` 头注释里。
    await page.route("**/api/v1/roles/catalog*", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(ROLE_CATALOG_FIXTURE),
        });
    });
    // 个人主体 / 实例主体：都是 `{ principals: [] }`（同 preview api-server.ts:800-803）。
    // 空集是真实的「mock 车道没有主体行」，不是不知道；写面不在本夹具范围内 ⇒ 非 GET 走 fallback。
    for (const principalsPath of ["agent-principals", "instance/agent-principals"]) {
        await page.route(`**/api/v1/${principalsPath}`, async (route) => {
            if (route.request().method() !== "GET") return route.fallback();
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ principals: [] }),
            });
        });
    }

    // 上下文来源：单对象、只元数据（api.ts:3391-3399）。11 个不同 sessionId 共用这一条。
    await page.route("**/api/v1/context/*/sources", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const url = new URL(route.request().url());
        const sessionId = url.pathname.split("/")[4] ?? "";
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(contextSourcesResponse(sessionId)),
        });
    });

    await page.route("**/api/v1/workspaces/*/checkpoints/retention", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(CHECKPOINT_RETENTION_FIXTURE),
        });
    });

    // 技能定义列表：`{ items: [] }`（api.ts:3991 读 `items`）。实例层「没有技能定义」是合法空集。
    await page.route("**/api/v1/skills", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ items: [] }),
        });
    });

    // ②d 工作区读面（task-149 B）：`/jobs` 直接复用预览夹具的**纯工厂**
    //     （`src/preview/mock/data/workspaceEnvironment.ts:88` `mockWorkspaceJobs`，每次调用造新对象 ⇒
    //     没有跨用例的可变状态）。为什么不手抄一份：那份夹具覆盖「状态矩阵 + 7 个取消原因 + 清理进度」
    //     三列，手抄必然漂移，而环境页的三列断言正是按它写的。
    await page.route("**/api/v1/workspaces/*/jobs", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const url = new URL(route.request().url());
        const workspaceId = url.pathname.split("/")[4] ?? MOCK_WORKSPACE_ID;
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(mockWorkspaceJobs(workspaceId)),
        });
    });

    // `GET /workspaces/{id}/members` 是**裸数组**（`api.ts:5040-5046`：非数组按空集处理）。
    // 行只给与登录身份自洽的那一条（OWNER = `user-1`，与 `me/permissions` 的 WS_OWNER 同源），
    // 不虚构别的成员 —— 成员页的「改角色/移除」断言要用自己的夹具（spec 内 page.route 后注册优先）。
    await page.route("**/api/v1/workspaces/*/members", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([
                {
                    userId: "user-1",
                    username: "xihe-operator",
                    email: "operator@xihe.local",
                    name: "操作员",
                    role: "OWNER",
                    createdAt: "2026-01-01T00:00:00Z",
                },
            ]),
        });
    });

    // `GET /instance/credentials` → `{ credentials, count }`（`data/instanceResources.ts:198-200`）。
    // 行形状照 `MockInstanceCredential`（同文件 :21-27 + :206-215 的创建路径）：**永不含明文/suffix**，
    // 只有 `fingerprint`。空集会让实例资源页显示「暂无」；这里给一条 active，页面才有「有数据」形态。
    await page.route("**/api/v1/instance/credentials", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const credentials = [
            {
                id: "cred-mock-1",
                label: "部署令牌",
                kind: "token",
                deliveryTier: "lease",
                status: "active",
                fingerprint: "sha256:0f0f0f0f…mock",
                revision: 1,
                createdAt: "2026-01-01T00:00:00Z",
                replacedAt: null,
            },
        ];
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ credentials, count: credentials.length }),
        });
    });

    // task-149 B（C 复跑修正）：run 读面**必须注册在兜底 `**/api/v1/**` 之后**。
    // 原来写在上方 chat 202 桩的旁边（兜底之前）⇒ LIFO 下被兜底盖住，run 表在真跑里一次都没生效
    // （实测：C 全量 6× `GET /chat/runs/{id}` + 1× `POST …/cancel` 全部落到「未桩端点」warn）。
    // run 读面（task-149 B）：只服务**登记过**的 run。
    await page.route("**/api/v1/chat/runs/*", async (route) => {
        const request = route.request();
        if (request.method() !== "GET") return route.fallback();
        const parsed = parseChatRunPath(new URL(request.url()).pathname);
        if (!parsed || parsed.action !== "get") return route.fallback();
        const record = runs.get(parsed.runId);
        if (!record) {
            await route.fulfill({
                status: 404,
                contentType: "application/problem+json",
                body: JSON.stringify(CHAT_RUN_NOT_FOUND),
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(chatRunProjection(record)),
        });
    });

    // 取消：未登记 ⇒ 404；已登记 ⇒ 状态推到 cancelled（响应 `{status, runId}`）。
    await page.route("**/api/v1/chat/runs/*/cancel", async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        const parsed = parseChatRunPath(new URL(route.request().url()).pathname);
        if (!parsed || parsed.action !== "cancel") return route.fallback();
        const record = runs.cancel(parsed.runId);
        if (!record) {
            await route.fulfill({
                status: 404,
                contentType: "application/problem+json",
                body: JSON.stringify(CHAT_RUN_NOT_FOUND),
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(chatRunCancelProjection(record)),
        });
    });

    // ③ 后台流与小面：
    //    - `user-events` 是 **SSE**（`src/features/workspace/chat/useUserChannelSSE.ts` 订阅它），
    //      不能回 JSON：镜像 preview api-server.ts:1085 的最小流（首帧 `connected` + `retry`，
    //      否则客户端会立刻重连、把日志刷满）。
    //    - `telemetry/logs` 是 POST（api-server.ts:1109 回 `{status:"ok"}`；产品不读返回）。
    //    - `approvals/pending` 是**裸数组**（api-server.ts:523），**内容不能恒空** ——
    //      task-161：它由 helpers/approval-registry.ts 的派生表给出（见下方 handler 注释）。
    //    - `provider-connections` 是 `{ connections: [] }`（既有 spec 同形：provider-protocol-groups）。
    await page.route("**/api/v1/user-events", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
            status: 200,
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
            body: "retry: 5000\n\nevent: connected\ndata: {}\n\n",
        });
    });

    await page.route("**/api/v1/telemetry/logs", async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ status: "ok" }),
        });
    });

    // task-161：approvals/pending **不得恒空**。裸 `[]` 不是"空数据"，是一句断言：
    // "CP 认为没有任何待决审批"。客户端拿它对账（src/stores/agent.ts:306-323
    // reconcilePendingApprovals）⇒ SSE 刚推进来的卡会被撤掉，后续点击撞
    // `element is not detached from the DOM`（task-151 的 trace 证据）。
    // 派生表在 helpers/approval-registry.ts：生产者在 pushMockApproval()（推 SSE 的那一刻登记），
    // 消费者就是这条 handler —— 不另起第二份清单。
    await page.route("**/api/v1/approvals/pending", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(approvals.summaries()),
        });
    });

    // ⑥ `user-questions`：待处理提问的轮询面（`?state=pending`）。
    //    URL 带 `?state=pending` ⇒ glob **必须带尾部 `*`**（Playwright 的 `*` 不吃 `/`，但吃 query）。
    //    形状来自 preview api-server.ts:527：`{ items: [], pendingCount: 0 }`（**包装对象**，不是裸数组）。
    //    这条是补完 ②③ 之后才浮出来的（配置域一有值，页面壳才会启动这个轮询）—— 记在 task-144 卡面。
    await page.route("**/api/v1/user-questions*", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ items: [], pendingCount: 0 }),
        });
    });
    await page.route("**/api/v1/provider-connections", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ connections: [] }),
        });
    });

    // ④ 按 run / 按工作区读面：
    //    - `chat/runs/{id}/guidance` → `{ items, latestSequence }`（api.ts normalizeGuidanceSnapshot）。
    //    - `workspaces/{id}/checkpoints` → **裸数组**（preview api-server.ts:768 注释：api 要求裸数组）。
    //    - `workspaces/{id}/imports` → **裸数组**（api.ts listWorkspaceImports 只认数组）。
    //    - `workspaces/{id}/nested-repos` → `{ items }`（api.ts listWorkspaceNestedRepos 读 view.items）。
    await page.route("**/api/v1/chat/runs/*/guidance", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ items: [], latestSequence: 0 }),
        });
    });

    await page.route("**/api/v1/workspaces/*/checkpoints", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([]),
        });
    });

    await page.route("**/api/v1/workspaces/*/imports", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([]),
        });
    });

    await page.route("**/api/v1/workspaces/*/nested-repos", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ items: [] }),
        });
    });

    // ⑤ MCP 工具网关 `POST /api/v1/mcp`（JSON-RPC，api.ts callRuntimeTool）。外壳照 preview
    //    api-server.ts:542：非 2.0/非 tools-call 回 JSON-RPC error，tools/call 回 `result.isError`
    //    （= preview 的 UNKNOWN_TOOL 语义）。**不假装工具可用**：静默成功会让「工具其实没实现」
    //    在 UI 上表现成一切正常。
    await page.route("**/api/v1/mcp", async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        let envelope: { id?: unknown; jsonrpc?: unknown; method?: unknown } = {};
        try {
            envelope = JSON.parse(route.request().postData() ?? "{}") as typeof envelope;
        } catch {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: null,
                    error: { code: -32700, message: "Parse error" },
                }),
            });
            return;
        }
        const id = envelope.id ?? null;
        if (envelope.jsonrpc !== "2.0" || typeof envelope.method !== "string") {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id,
                    error: { code: -32600, message: "Invalid Request" },
                }),
            });
            return;
        }
        if (envelope.method !== "tools/call") {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id,
                    error: {
                        code: -32601,
                        message: "Method not supported by mock: " + envelope.method,
                    },
                }),
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: "mock 车道没有 MCP 工具夹具（task-144）：不要把它当契约证据",
                        },
                    ],
                },
            }),
        });
    });
    // BL-318：`setupMockAuth` 是**每条 mock 用例都会调**的入口，所以会话侧投影与工作区智能体清单
    // 必须在这里也有默认值 —— 只在 `setupMockSessions` 挂的话，只调 `setupMockAuth` 的 spec
    // （如 `chat.spec.ts` 的 beforeeach）仍会拿到兜底的 `200 {}`，UI 解析 `activeChildren.map` /
    // `agents.map` 直接 TypeError，被判成"夹具噪声红"。
    //
    // 形状来源同 `session-projections.ts` 头注释（2026-11-05 对 stack-1 真实 CP 记录）：
    //   GET /api/v1/workspaces/{id}/agents → { agents: [{ principalId, name, templateId,
    //        templateName, createdAt, permissionsSnapshot[], bound, hooks, contextPolicy, disabled }] }
    // task-140：`GET /api/v1/workspaces`（列表）。注册位置在兜底 `**/api/v1/**` **之后** ——
    // Playwright route 是 LIFO，后注册优先（本文件头注释第 1 条），所以这条赢兜底。
    // 默认体与 seed 同源（同一 id/name/角色），保证「列表里点进工作区」与「tab 上下文」是同一个工作区；
    // 多工作区由 `options.workspaceList` 覆盖。
    const workspaceListFixture = options.workspaceList ?? [
        {
            id: MOCK_WORKSPACE_ID,
            name: "Mock Workspace",
            ownerId: "user-1",
            workspaceRole: "OWNER",
            canWrite: true,
            createdAt: "2026-11-05T00:00:00.000Z",
            updatedAt: "2026-11-05T00:00:00.000Z",
        },
    ];
    await page.route("**/api/v1/workspaces", async (route) => {
        if (route.request().method() !== "GET") {
            // 非 GET（如 `POST /api/v1/workspaces` 新建工作区）保持既有行为：交回后面的处理器/兜底。
            await route.fallback();
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(workspaceListFixture),
        });
    });

    await page.route("**/api/v1/workspaces/*/agents", async (route) => {
        if (route.request().method() !== "GET") {
            await route.fallback();
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ agents: [] }),
        });
    });

    // BL-318：`/settings/monitoring` 读 `versionInfo.modules.cp.version`，不桩就是 `200 {}` ⇒
    // `Cannot read properties of undefined (reading 'cp')` 未捕获 pageerror（`full-ui-acceptance`
    // 的保护路由矩阵实测）。形状照抄真实 CP（2026-11-05 stack-1 `GET /api/v1/version`）。
    await page.route("**/api/v1/version", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                stackId: "stack-1",
                releaseChannel: "dev",
                startedAt: "2026-11-05T00:00:00.000Z",
                commit: null,
                modules: {
                    cp: { version: "0.1.0", commit: null },
                    agent: { version: "0.1.0", commit: null, framework: "langgraph" },
                    runtime: { version: "0.1.0", commit: null },
                },
            }),
        });
    });

    if (options.projections !== false) {
        await stubSessionProjectionsForAllSessions(page, {
            participants: participantRoster({ agentPrincipalId: MOCK_BOUND_PRINCIPAL_ID }),
            ...(options.projections ?? {}),
        });
    }

    // BL-318：会话 run 列表与委派预算投影的默认桩（不桩就是 `**/api/v1/**` 的 `200 {}`，
    // UI 侧 `runs.runs` 不是可迭代对象直接 TypeError：`plan0659-delegation-dag` 实测
    // `Failed to load durable child wait links {runs.runs is not iterable}`）。
    // 形状照抄真实 CP（2026-11-05 stack-1）：
    //   GET /api/v1/chat/sessions/{id}/runs → { sessionId, page, size, runs[] }
    //   GET /api/v1/sessions/{id}/delegation-usage → { rootSessionId, usedSessions, maxCount,
    //        currentDepth, maxDepth, principalId, principalName, policySource, disabled }
    // 注意用 **regex** 而不是 glob：glob 要匹配整个 URL，带 `?page=0&size=100` 的请求用
    // `…/runs` 结尾的 glob 是匹配不上的（实测 `runs.runs is not iterable` 依旧出现）。
    await page.route(/\/api\/v1\/chat\/sessions\/[^/]+\/runs(?:\?.*)?$/, async (route) => {
        const url = new URL(route.request().url());
        const sessionId = url.pathname.split("/").filter(Boolean).slice(-2, -1)[0] ?? "";
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                sessionId,
                page: Number(url.searchParams.get("page") ?? 0),
                size: Number(url.searchParams.get("size") ?? 20),
                runs: [],
            }),
        });
    });
    await page.route(/\/api\/v1\/sessions\/[^/]+\/delegation-usage(?:\?.*)?$/, async (route) => {
        const rootSessionId =
            new URL(route.request().url()).pathname.split("/").filter(Boolean).slice(-2, -1)[0] ??
            "";
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                rootSessionId,
                usedSessions: 0,
                maxCount: 8,
                currentDepth: 0,
                maxDepth: 3,
                principalId: MOCK_BOUND_PRINCIPAL_ID,
                principalName: "Mock Agent",
                policySource: "code-defaults",
                disabled: false,
            }),
        });
    });
}

export async function setupMockSessions(page: Page, options: MockSessionOptions = {}) {
    const now = new Date().toISOString();
    const mapSession = (session: MockSessionRecord, workspaceId: string | null) => ({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt ?? now,
        updatedAt: session.updatedAt ?? session.createdAt ?? now,
        workspaceId,
        modelProvider: null,
        modelName: null,
        // task-590：投影自带 provider 绑定 ⇒ guard 不拦、不需要 bind-defaults 重放。
        providerConnectionId:
            "providerConnectionId" in session ? (session.providerConnectionId ?? null) : null,
        archived: false,
        // `MockSessionRecord.agentPrincipalId` used to be dropped here, so a fixture could
        // not model a Session that already has a bound Agent — the UI then detoured every
        // send into the principal-binding dialog (removed by PLAN-0689 B3) and no `/chat`
        // POST was ever made (2026-11-03 mock-lane: approval `switching away…` could never
        // see the stop button). A bound principal is the normal state: `POST /sessions`
        // requires it.
        //
        // Default (not just pass-through): a Session that already has a bound Agent is the
        // *normal* server state — `POST /sessions` rejects a principal-null Session. The old
        // pre-first-send placeholder that opened the binding dialog (ChatPanel.handleSend →
        // `workspace-agent-principal-select`) was removed by PLAN-0689 B3; the field is still
        // carried by the current session view. A fixture that omitted it therefore never
        // reached the send path it was testing: no `/chat` POST, no user bubble, no stop
        // button. Callers that wanted the old placeholder (binding-dialog flows) passed
        // `agentPrincipalId: null` explicitly.
        agentPrincipalId:
            "agentPrincipalId" in session
                ? (session.agentPrincipalId ?? null)
                : MOCK_BOUND_PRINCIPAL_ID,
    });
    // task-373：两种作用域共用同一条映射（含 agentPrincipalId 的默认值口径），差别只有
    // workspaceId —— 独立会话是显式 null，不是缺字段。
    const sessions = (options.sessions ?? []).map((session) =>
        mapSession(
            session,
            session.workspaceId ?? options.workspaceId ?? "11111111-1111-4111-8111-111111111111",
        ),
    );
    const workspaceless = (options.workspacelessSessions ?? []).map((session) =>
        mapSession(session, null),
    );
    const createRootBranch = (createdAt: string): MockBranch[] => [
        {
            branchId: MOCK_ROOT_BRANCH_ID,
            parentBranchId: null,
            forkPointMessageId: null,
            forkPointRunId: null,
            createdAt,
        },
    ];
    const messages = options.messages ?? {};
    const branches = new Map<string, MockBranch[]>(
        [...sessions, ...workspaceless].map((session) => [session.id, createRootBranch(now)]),
    );

    // PLAN-0608 C′: the UI now creates sessions on the workspace-addressed path
    // (`POST /api/v1/workspaces/{workspaceId}/sessions`). Registering only the
    // legacy glob made every `createSession: true` stub silently fall through to
    // the `**/api/v1/**` catch-all, which answers `200 {}` — a *silent* failure
    // that reads as success to the spec. Match both surfaces by regex instead.
    const matchesSessionCreate = (url: string) =>
        /\/(?:api\/v1\/sessions|api\/v1\/workspaces\/[^/]+\/sessions)$/.test(new URL(url).pathname);

    await page.route(matchesSessionCreate, async (route) => {
        if (route.request().method() === "GET") {
            // task-373 / `D-1236` 甲案：不带 scope 逐字节不变；带 workspaceless 回独立会话；
            // 未知值 fail-closed 400（与 CP 同口径，夹具不替契约放宽）。
            const scope = new URL(route.request().url()).searchParams.get("scope");
            if (scope !== null && scope !== "workspaceless") {
                await route.fulfill({
                    status: 400,
                    contentType: "application/problem+json",
                    body: JSON.stringify({ code: "INVALID_REQUEST", detail: "unknown scope" }),
                });
                return;
            }
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    sessions: scope === "workspaceless" ? workspaceless : sessions,
                }),
            });
            return;
        }
        if (route.request().method() === "POST" && options.createSession) {
            const body = route.request().postDataJSON() as {
                title?: string;
                agentPrincipalId?: string;
            } | null;
            // task-373：`POST /sessions`（无工作区段）= 独立会话；工作区路径仍落工作区。
            const isWorkspaceless = new URL(route.request().url()).pathname === "/api/v1/sessions";
            const created = {
                id: `mock-session-${Date.now()}`,
                title: body?.title ?? "New Chat",
                agentPrincipalId: body?.agentPrincipalId ?? null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                workspaceId: isWorkspaceless ? null : "11111111-1111-4111-8111-111111111111",
                modelProvider: null,
                modelName: null,
                // task-590：新建设会话与既有会话同形（投影字段集必须一致，否则 typecheck:e2e 记账）。
                providerConnectionId: null,
                archived: false,
            };
            if (isWorkspaceless) workspaceless.unshift(created);
            else sessions.unshift(created);
            branches.set(created.id, createRootBranch(created.createdAt));
            await route.fulfill({
                status: 201,
                contentType: "application/json",
                body: JSON.stringify(created),
            });
            return;
        }
        await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({ code: "SESSION_CREATION_DISABLED" }),
        });
    });

    // C1（2026-11-04 合入）：composer 发送前会先 `POST /sessions/{id}/bind-defaults`，
    // 只有端点回带 `providerConnectionId` 才会真正发送；否则弹「绑定引导」并把消息挂起
    // （ChatPanel.handleSend → guardProviderBinding）。统一在此补齐夹具，否则所有
    // 「发送后断言」的 mock 用例都会在发送前被拦下（mock lane 基线红）。
    await page.route("**/api/v1/sessions/*/bind-defaults", async (route) => {
        const sessionId =
            new URL(route.request().url()).pathname.split("/").filter(Boolean).at(-2) ??
            sessions[0]?.id ??
            "mock-session";
        const base = sessions.find((item) => item.id === sessionId) ?? sessions[0];
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                id: base?.id ?? sessionId,
                title: base?.title ?? "Mock Session",
                workspaceId: base?.workspaceId ?? "11111111-1111-4111-8111-111111111111",
                agentPrincipalId: base?.agentPrincipalId ?? MOCK_BOUND_PRINCIPAL_ID,
                createdAt: base?.createdAt ?? now,
                updatedAt: base?.updatedAt ?? now,
                archived: false,
                providerConnectionId: "conn-mock-default",
                connectionRevision: 1,
                modelProvider: "openai",
                modelName: "fake-openai",
            }),
        });
    });

    await page.route("**/api/v1/sessions/**", async (route) => {
        const url = new URL(route.request().url()),
            parts = url.pathname.split("/").filter(Boolean);
        // bind-defaults 有专用桩（注册在本路由之前）：fallback 交给它，避免被这里的
        // 通用分支吃掉（Playwright 后注册优先，fallback 会回退到更早的 handler）。
        if (parts.at(-1) === "bind-defaults") {
            await route.fallback();
            return;
        }
        const sessionId = parts.at(-1) === "messages" ? parts.at(-2) : parts.at(-1);
        if (!sessionId) {
            await route.fulfill({
                status: 404,
                contentType: "application/json",
                body: JSON.stringify({}),
            });
            return;
        }
        if (parts.at(-1) === "branches") {
            if (route.request().method() === "GET") {
                // Sessions addressed directly by URL are not always declared in
                // `options.sessions`; mirror the auth-level fallback so branch
                // selection and sends do not dead-end on an empty list.
                const items = branches.get(sessionId) ?? createRootBranch(now);
                branches.set(sessionId, items);
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ sessionId, items }),
                });
                return;
            }
            if (route.request().method() === "POST") {
                const body = route.request().postDataJSON() as {
                    sourceBranchId?: string;
                    anchorMessageId?: string;
                } | null;
                const key = route.request().headers()["idempotency-key"];
                if (!body?.sourceBranchId || !body.anchorMessageId || !key) {
                    await route.fulfill({
                        status: 400,
                        contentType: "application/problem+json",
                        body: JSON.stringify({
                            code: "INVALID_REQUEST",
                            detail: "branch request is incomplete",
                        }),
                    });
                    return;
                }
                const branchId = randomUUID();
                const response = {
                    branchId,
                    parentBranchId: body.sourceBranchId,
                    forkPointMessageId: body.anchorMessageId,
                };
                const items = branches.get(sessionId) ?? createRootBranch(now);
                items.push({
                    branchId,
                    parentBranchId: body.sourceBranchId,
                    forkPointMessageId: body.anchorMessageId,
                    forkPointRunId: null,
                    createdAt: new Date().toISOString(),
                });
                branches.set(sessionId, items);
                await route.fulfill({
                    status: 201,
                    contentType: "application/json",
                    body: JSON.stringify(response),
                });
                return;
            }
        }
        if (parts.at(-1) === "messages" && route.request().method() === "GET") {
            // 分页请求（`?before=`）必须交给调用方注册的窄路由 —— 否则通配兜底会把
            // 「加载更早」的响应替换成首屏数据，prepend 结果被覆盖（实测 scrollHeight
            // 从 88530 崩回 698 重载）。通配只应答**首屏**（无 before）。
            if (!new URL(route.request().url()).searchParams.has("before")) {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify(messages[sessionId] ?? []),
                });
                return;
            }
        }
        const session =
            sessions.find((item) => item.id === sessionId) ??
            workspaceless.find((item) => item.id === sessionId);
        if (route.request().method() === "GET" && session) {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(session),
            });
            return;
        }
        await route.fulfill({
            status: session ? 200 : 404,
            contentType: "application/json",
            body: JSON.stringify(session ?? {}),
        });
    });

    // BL-318：四类会话投影默认桩。注册在本函数**最后**——Playwright 后注册者优先，所以它们会
    // 盖过上面的 `**/api/v1/sessions/**` 兜底；未知后缀仍按上面的规则落 404（本段只匹配这四条
    // 固定后缀，不做通配 200）。
    // BL-318 取证用临时开关：默认 true。跑"先红"对照时置 false（关掉公共投影桩，露出真 404 噪声）。
    if (options.projections !== false && process.env.XIHE_MOCK_PROJECTIONS !== "0") {
        await stubSessionProjectionsForAllSessions(page, {
            participants: participantRoster({ agentPrincipalId: MOCK_BOUND_PRINCIPAL_ID }),
            ...(options.projections ?? {}),
        });
    }
}
