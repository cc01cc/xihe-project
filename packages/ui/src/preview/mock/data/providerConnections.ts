import type { ProviderConnection } from "../../../types/providerConnection";

/**
 * task-454 / D-1301（task-284 判据②a 的前置）：实例层 provider 连接夹具 + **真写面**。
 *
 * <p>修两个实测缺陷（探针读数见卡面）：⑴ 三行 `scope` 是小写 `"instance"`，而 CP 枚举与
 * `ProviderScope` 都是大写 ⇒ `ProviderHub.scopeLabel` 三态穷举后落 else，三行全被渲染成「User」，
 * 实例层看不到任何 INSTANCE 行；⑵ `api-server.ts` 的 `if (path === "/provider-connections")`
 * **没有方法守卫** ⇒ POST 落进同一分支回 200 + 原样静态列表：UI 弹「已保存」而列表不变，
 * 谁拿它验「能建连接」都会**假绿**（D-1281 同族新子类：不是空集藏缺口，是假成功藏缺口）。</p>
 *
 * <p>形状照消费侧契约，不发明字段：行 = `ProviderConnection`（`types/providerConnection.ts:87-119`）；
 * 写面回**裸连接对象**（`providerConnectionService.ts:77-94`），verify 回 `{connection, models}`
 * （`:45-48/:96-103`，UI 建/改后立刻调它并读 `verification.connection.status`），DELETE 回 **204**
 * （CP `ProviderConnectionController:179` `noContent()`），未知名 404 用 CP 原码
 * `PROVIDER_CONNECTION_NOT_FOUND`（`ApiRequestTemplateService:275`）。`/models` 的目录按
 * **connectionId** 聚合且带 `connectionId` 字段 —— `ProviderHub:312-313` 按 `connection.id` 取并校验
 * `catalog.connectionId === connection.id`，再按 `capabilities.chat` 过滤。</p>
 *
 * <p><b>诚实边界（mock 不复刻的 CP 行为，写在这里免得被当已验）</b>：① 不校验 `connectionKey` 唯一性、
 * 不做 revision CAS（CP 有，mock 只递增 revision）；② `operation` 不由 API Type 注册表推导
 * （CP 由类型推导，mock 取请求体给的值否则 `chat`）；③ verify 只看 `hasKey`：有 key ⇒ READY，
 * 无 key ⇒ UNVERIFIED，不真打上游；④ delete-impact 的引用计数恒 0（mock 不建模会话/模板/profile 引用），
 * 所以「无引用」是 mock 的局限不是事实；⑤ 不实现 `api-type-change-impact`（未知 suffix ⇒ 上层 404
 * `MOCK_ENDPOINT_MISSING`，**不做通配 200**）。</p>
 *
 * <p><b>⑤ 的后果链不是「少一个端点」，别当无影响</b>（runtime-1 复核指出，我核了源码）：
 * `ProviderHub.vue:729-756` 的 `previewTypeChange()` 在**编辑连接时切换 apiType** 触发，`:740`
 * 在 try 内调 `getConnectionTypeImpact` ⇒ mock 404 抛错 ⇒ ①`catch` 里 `:753 toast.error(...)`
 * **弹错误提示**；② try 在抛出点中断 ⇒ `:748 listVisibleTemplates()` **不执行** ⇒ `templateOptions`
 * 永不加载（模板选项空）。这是**存量缺口**（本卡之前整个 `/{id}/*` 后缀空间都是 404），不是本卡引入；
 * 本卡修了 verify（缺它创建流整条断），这条留待另卡（已报 Lead）。写在这里免得后来者以为
 * 「不实现＝无影响」。</p>
 */
/**
 * 夹具行类型：**正常行仍绑产品类型** `ProviderConnection`（15 字段 + `operation` 枚举都受类型门管）。
 *
 * <p>只有 `conn-image-primary` 那一行例外：它的现值是 `"image"`，而契约
 * `openapi.yaml:8054/8153/8239/8304/8452` 的 enum 只有 `[chat, embedding]`（UI `ApiTypeOperation` 同）
 * ⇒ **第三处夹具漂移**（与 scope 小写同族）。本卡**不改那行一个字节**：runtime-1 的 08:40 判定集
 * 依赖它逐字未动，改值属另一张卡的裁定（已报 Lead 与 runtime-1，他建议另开卡）。</p>
 *
 * <p><b>放宽的作用域也是判据的一部分</b>（runtime-1 复核意见）：先前写成
 * `Omit<…,"operation"> & { operation: string }` 会让**每一行**都失去枚举校验（将来任何一行拼错
 * operation 都不被类型门抓到）。现在收窄成**联合**：漂移行只允许字面量 `"image"`，其余行必须是
 * 合法 `ProviderConnection` ⇒ 拼错值两个分支都不匹配，类型门照样红。裁定改 `chat` 后应删掉
 * `DriftedImageRow` 整个分支，收回单一产品类型。</p>
 */
type DriftedImageRow = Omit<ProviderConnection, "operation"> & { operation: "image" };
type MockConnectionRow = ProviderConnection | DriftedImageRow;

export interface MockResourceResult {
    status: number;
    body: unknown;
}

type ReadJsonBody = () => Promise<Record<string, unknown>>;

/** 种子四行：三条原有（只把 scope 改大写，其余逐字未动）+ 一条新增 INSTANCE chat 连接。 */
const SEED: readonly MockConnectionRow[] = [
    {
        id: "conn-claude-primary",
        providerId: "anthropic",
        connectionKey: "conn-claude-primary",
        apiTypeId: "anthropic-messages",
        apiTypeVersion: 1,
        operation: "chat",
        label: "Claude 主连接",
        scope: "INSTANCE",
        baseUrl: null,
        modelDiscovery: "curated",
        manualModels: [],
        hasKey: true,
        enabled: true,
        status: "READY",
        revision: 1,
    },
    {
        id: "conn-embed-primary",
        providerId: "openai",
        connectionKey: "conn-embed-primary",
        apiTypeId: "openai-embeddings",
        apiTypeVersion: 1,
        operation: "embedding",
        label: "嵌入模型主连接",
        scope: "INSTANCE",
        baseUrl: null,
        modelDiscovery: "curated",
        manualModels: [],
        hasKey: true,
        enabled: true,
        status: "READY",
        revision: 1,
    },
    {
        id: "conn-image-primary",
        providerId: "openai",
        connectionKey: "conn-image-primary",
        apiTypeId: "openai-chat",
        apiTypeVersion: 1,
        operation: "image",
        label: "图像生成连接",
        scope: "INSTANCE",
        baseUrl: null,
        modelDiscovery: "curated",
        manualModels: [],
        hasKey: true,
        enabled: true,
        status: "READY",
        revision: 1,
    },
    {
        // task-454 新增：判据②a 要「≥2 个 INSTANCE 连接且各带 ≥2 个模型」。原有只有主连接是 chat，
        // 另两条是 embedding / image ⇒ 加一条 chat，**不改现有行**（别的 spec 依赖它们）。
        id: "conn-claude-secondary",
        providerId: "anthropic",
        connectionKey: "conn-claude-secondary",
        apiTypeId: "anthropic-messages",
        apiTypeVersion: 1,
        operation: "chat",
        label: "Claude 备用连接",
        scope: "INSTANCE",
        baseUrl: null,
        modelDiscovery: "curated",
        manualModels: [],
        hasKey: true,
        enabled: true,
        status: "READY",
        revision: 1,
    },
];

/** 模型目录：`/models` 与 verify 共用这一份，避免两处名字漂移。 */
const MODEL_CATALOG: Readonly<
    Record<string, ReadonlyArray<{ name: string; capabilities: Record<string, boolean> }>>
> = {
    "conn-claude-primary": [
        { name: "claude-sonnet-4-5", capabilities: { chat: true } },
        { name: "claude-haiku-4-5", capabilities: { chat: true } },
    ],
    "conn-image-primary": [{ name: "gpt-image-1", capabilities: { image: true } }],
    "conn-claude-secondary": [
        { name: "claude-opus-4-1", capabilities: { chat: true } },
        { name: "claude-sonnet-4-5", capabilities: { chat: true } },
    ],
};

let rows: MockConnectionRow[] = SEED.map((row) => ({
    ...row,
    manualModels: [...row.manualModels],
}));
let created = 0;

/** 单测与 e2e 之间复位（dev server 进程活着期间写面落内存，重启回种子）。 */
export function resetProviderConnectionFixture(): void {
    rows = SEED.map((row) => ({ ...row, manualModels: [...row.manualModels] }));
    created = 0;
}

export function providerConnectionRows(): readonly MockConnectionRow[] {
    return rows;
}

/** `GET /models` 的响应体：providers 的 key 必须是 connectionId，且条目带 connectionId。 */
export function mockModelCatalogResponse(): {
    providers: Record<
        string,
        {
            providerId: string;
            connectionId: string;
            status: string;
            models: Array<{ name: string; capabilities: Record<string, boolean> }>;
        }
    >;
} {
    const providers: Record<
        string,
        {
            providerId: string;
            connectionId: string;
            status: string;
            models: Array<{ name: string; capabilities: Record<string, boolean> }>;
        }
    > = {};
    for (const row of rows) {
        const models = MODEL_CATALOG[row.id];
        if (!models) continue;
        providers[row.id] = {
            providerId: row.providerId,
            connectionId: row.id,
            status: "ready",
            models: models.map((model) => ({ ...model, capabilities: { ...model.capabilities } })),
        };
    }
    return { providers };
}

function problem(status: number, code: string, detail: string): MockResourceResult {
    return {
        status,
        body: { type: "about:blank", title: code, status, code, detail, requestId: "mock-request" },
    };
}

function modelNamesOf(row: MockConnectionRow): string[] {
    const catalog = MODEL_CATALOG[row.id];
    if (catalog) return catalog.map((model) => model.name);
    return row.operation === "chat" && row.modelDiscovery === "manual" ? [...row.manualModels] : [];
}

function asString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * dispatch：`/provider-connections` 与 `/provider-connections/{id}[/verify|/delete-impact]`。
 * 未知 suffix 回 `null` ⇒ 上层 404 `MOCK_ENDPOINT_MISSING`（不通配 200）。
 */
export async function handleProviderConnectionResource(
    method: string,
    path: string,
    _url: URL,
    readJsonBody: ReadJsonBody,
): Promise<MockResourceResult | null> {
    if (path === "/provider-connections") {
        if (method === "GET") return { status: 200, body: { connections: rows } };
        if (method !== "POST") return null;
        const body = await readJsonBody();
        const providerId = asString(body.providerId);
        const connectionKey = asString(body.connectionKey);
        const apiTypeId = asString(body.apiTypeId);
        const label = asString(body.label);
        const scope = asString(body.scope);
        if (!providerId || !connectionKey || !apiTypeId || !label || !scope) {
            return problem(
                400,
                "INVALID_REQUEST",
                "providerId/connectionKey/apiTypeId/label/scope are required",
            );
        }
        if (scope !== "USER" && scope !== "WORKSPACE" && scope !== "INSTANCE") {
            return problem(400, "INVALID_REQUEST", "scope must be USER, WORKSPACE or INSTANCE");
        }
        created += 1;
        const manualModels = Array.isArray(body.manualModels)
            ? body.manualModels.filter((item): item is string => typeof item === "string")
            : [];
        const row: MockConnectionRow = {
            id: `conn-mock-created-${created}`,
            providerId,
            connectionKey,
            apiTypeId,
            apiTypeVersion: typeof body.apiTypeVersion === "number" ? body.apiTypeVersion : 1,
            // mock 不查 API Type 注册表（CP 由类型推导 operation）：取请求体给的值，否则 chat。
            operation: body.operation === "embedding" ? "embedding" : "chat",
            label,
            scope,
            baseUrl: typeof body.baseUrl === "string" && body.baseUrl ? body.baseUrl : null,
            modelDiscovery:
                body.modelDiscovery === "manual" ||
                body.modelDiscovery === "curated" ||
                body.modelDiscovery === "remote-models" ||
                body.modelDiscovery === "litellm-catalog"
                    ? body.modelDiscovery
                    : "manual",
            manualModels,
            hasKey: Boolean(asString(body.apiKey) || asString(body.credentialId)),
            credentialId: asString(body.credentialId),
            enabled: body.enabled === undefined ? true : body.enabled === true,
            status: "UNVERIFIED",
            revision: 1,
        };
        rows.push(row);
        return { status: 201, body: row };
    }

    const item = path.match(/^\/provider-connections\/([^/]+)(\/.*)?$/);
    if (!item) return null;
    const id = decodeURIComponent(item[1] ?? "");
    const suffix = item[2] ?? "";
    const row = rows.find((candidate) => candidate.id === id);
    if (suffix === "/verify") {
        if (method !== "POST") return null;
        if (!row) {
            return problem(404, "PROVIDER_CONNECTION_NOT_FOUND", "Connection not found");
        }
        row.status = row.hasKey ? "READY" : "UNVERIFIED";
        row.lastVerifiedAt = row.hasKey ? new Date().toISOString() : null;
        return {
            status: 200,
            body: { connection: row, models: modelNamesOf(row).map((name) => ({ name })) },
        };
    }
    if (suffix === "/delete-impact") {
        if (method !== "GET") return null;
        if (!row) {
            return problem(404, "PROVIDER_CONNECTION_NOT_FOUND", "Connection not found");
        }
        // mock 不建模引用（会话/模板/profile）⇒ 计数恒 0，这是局限不是事实。
        return {
            status: 200,
            body: {
                connectionId: row.id,
                providerId: row.providerId,
                connectionKey: row.connectionKey,
                bindingCount: 0,
                bindingUserScopes: 0,
                defaultTemplateRef: false,
                profileCount: 0,
                profileScopes: [],
                sessionCount: 0,
                blocked: false,
            },
        };
    }
    if (suffix !== "") return null;
    if (method === "PATCH") {
        if (!row) {
            return problem(404, "PROVIDER_CONNECTION_NOT_FOUND", "Connection not found");
        }
        const body = await readJsonBody();
        const label = asString(body.label);
        if (label) row.label = label;
        if (typeof body.baseUrl === "string") row.baseUrl = body.baseUrl || null;
        if (typeof body.enabled === "boolean") row.enabled = body.enabled;
        if (Array.isArray(body.manualModels)) {
            row.manualModels = body.manualModels.filter(
                (item): item is string => typeof item === "string",
            );
        }
        const discovery = body.modelDiscovery;
        if (
            discovery === "manual" ||
            discovery === "curated" ||
            discovery === "remote-models" ||
            discovery === "litellm-catalog"
        ) {
            row.modelDiscovery = discovery;
        }
        const credentialId = asString(body.credentialId);
        if (credentialId) {
            row.credentialId = credentialId;
            row.hasKey = true;
        }
        if (asString(body.apiKey)) row.hasKey = true;
        // mock 不做 revision CAS（CP 有）：只递增，让 UI 的乐观锁字段有值可回传。
        row.revision += 1;
        return { status: 200, body: row };
    }
    if (method === "DELETE") {
        if (!row) {
            return problem(404, "PROVIDER_CONNECTION_NOT_FOUND", "Connection not found");
        }
        rows = rows.filter((candidate) => candidate.id !== id);
        return { status: 204, body: null };
    }
    return null;
}
