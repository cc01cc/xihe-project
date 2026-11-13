/**
 * task-402 / `D-1243 G2` · mock lane 的 **agent 主体技能绑定**（`/api/v1/agent-principals/{id}/skills`）。
 *
 * <p>为什么单独一份：这是 v1 principal 级路径，不属于 `/instance/*` 三资源（那份在
 * `instanceResources.ts`），也不属于技能**定义**库（`skills.ts`）。绑定是「主体 × 定义 × scope」
 * 的第三张表，塞进任何一份都会把两件事的状态搅在一起。</p>
 *
 * <p>**scope 由请求派生，客户端不选**（CP `AgentPrincipalSkillBindingService#deriveScope:196`）：
 * 带 `workspaceId` ⇒ workspace 行；不带 ⇒ instance 行。真 HTTP 已在 stack-1 验过
 * （2026-11-14 02:35，`.tmp/xh/task-402/probe-report.json`：不带 workspaceId 的 POST ⇒ 201
 * `scopeType=instance`/`scopeId=null`，DELETE ⇒ 204，body 多带一键 ⇒ 400 INVALID_REQUEST）。
 * 这里照同一口径实现，**不是**「mock 想怎么回就怎么回」。</p>
 *
 * <p>照契约实现的判定：body 白名单只收 `skillId`；实例档只能绑实例库定义（工作区私有定义 ⇒ 404
 * `SKILL_NOT_FOUND`，不泄露存在性）；同 scope 重复绑 ⇒ 409 `SKILL_BINDING_EXISTS`；
 * 实例档可删**任意** scope 行，工作区档只能删本工作区行（`mayDeleteAtRowScope:180`）。</p>
 *
 * <p>**一处有意的分歧**：真 CP 要 `skillId` 是 UUID，而本 lane 的定义夹具用可读 id
 * （`skill-0001-instance-commit-msg`）。这里只校验非空字符串 —— 夹具的可读性优先，
 * UUID 形态由真 HTTP 探针覆盖，不在 mock 里假造一套 UUID 映射。</p>
 */
import { mockSkillDefinitions, mockWorkspaceSkillDefinitions, type MockSkillView } from "./skills";

export interface MockAgentSkillBinding {
    bindingId: string;
    principalId: string;
    skillId: string;
    name: string;
    description: string | null;
    sourceType: "instance" | "workspace";
    sourceName: string | null;
    scopeType: "instance" | "workspace";
    scopeId: string | null;
    scopeName: string | null;
    tokenEstimate: number | null;
    /** 契约 required（AgentPrincipalSkillBindingView）：夹具不许少给。 */
    createdAt: string;
}

const PRINCIPAL_A = "a1f0c4d2-7b3e-4c55-8f10-5d2c9b000001";
const WORKSPACE_ID = "workspace-1";

function seed(): MockAgentSkillBinding[] {
    return [
        {
            bindingId: "b1f0c4d2-7b3e-4c55-8f10-5d2c9b000101",
            principalId: PRINCIPAL_A,
            skillId: "skill-0001-instance-commit-msg",
            name: "commit-msg",
            description: "实例库定义，绑在实例档 ⇒ 对所有工作区生效。",
            sourceType: "instance",
            sourceName: "实例技能库",
            scopeType: "instance",
            scopeId: null,
            scopeName: null,
            tokenEstimate: 180,
            createdAt: "2026-11-13T09:00:00Z",
        },
        {
            // 同一个 principal 也可能有工作区档行：实例档列表照实显示两种 scope，
            // 且实例档可删任意 scope 行（藏起来会让人以为没绑）。
            bindingId: "b1f0c4d2-7b3e-4c55-8f10-5d2c9b000102",
            principalId: PRINCIPAL_A,
            skillId: "skill-ws01-repo-conventions",
            name: "repo-conventions",
            description: "工作区私有定义，绑在该工作区档。",
            sourceType: "workspace",
            sourceName: "Ws workspace-1",
            scopeType: "workspace",
            scopeId: WORKSPACE_ID,
            scopeName: "Ws workspace-1",
            tokenEstimate: 260,
            createdAt: "2026-11-13T09:05:00Z",
        },
    ];
}

let bindings: MockAgentSkillBinding[] = seed();
let counter = 0;

export function resetAgentSkillBindingFixtures(): void {
    bindings = seed();
    counter = 0;
}

function problem(status: number, code: string, detail?: string) {
    return {
        status,
        body: {
            type: "about:blank",
            title: code,
            status,
            code,
            detail: detail ?? code,
            requestId: "mock-request",
        },
    };
}

function viewOf(row: MockAgentSkillBinding) {
    return {
        bindingId: row.bindingId,
        principalId: row.principalId,
        skillId: row.skillId,
        name: row.name,
        description: row.description,
        sourceType: row.sourceType,
        sourceName: row.sourceName,
        scopeType: row.scopeType,
        scopeId: row.scopeId,
        scopeName: row.scopeName,
        tokenEstimate: row.tokenEstimate,
        createdAt: row.createdAt,
    };
}

function definitionOf(skillId: string, workspaceId: string | null): MockSkillView | null {
    const instance = mockSkillDefinitions().items.find((item) => item.skillId === skillId);
    if (instance) return instance;
    if (!workspaceId) return null;
    return (
        mockWorkspaceSkillDefinitions(workspaceId).items.find((item) => item.skillId === skillId) ??
        null
    );
}

/**
 * 一次 dispatch。`null` = 这条路径不归本模块（交回 api-server 的其余分支）。
 * `url` 用来读 `workspaceId`（有 ⇒ 工作区档，无 ⇒ 实例档）。
 */
export async function handleAgentSkillBinding(
    method: string,
    path: string,
    url: URL,
    readBody: () => Promise<Record<string, unknown>>,
): Promise<{ status: number; body: unknown } | null> {
    const collection = path.match(/^\/agent-principals\/([^/]+)\/skills$/);
    const item = path.match(/^\/agent-principals\/([^/]+)\/skills\/([^/]+)$/);
    if (!collection && !item) return null;

    const principalId = decodeURIComponent((collection ?? item)![1]!);
    const workspaceId = url.searchParams.get("workspaceId");
    const upper = method.toUpperCase();

    if (collection && upper === "GET") {
        // CP list 回该 principal 的**全部**行（两种 scope 都带），不按 workspaceId 过滤。
        const rows = bindings.filter((row) => row.principalId === principalId);
        return { status: 200, body: { items: rows.map(viewOf) } };
    }

    if (collection && upper === "POST") {
        const body = await readBody();
        const keys = Object.keys(body);
        if (keys.some((key) => key !== "skillId")) {
            return problem(400, "INVALID_REQUEST", "Body must contain only skillId");
        }
        const skillId = typeof body.skillId === "string" ? body.skillId.trim() : "";
        if (!skillId) return problem(400, "INVALID_REQUEST", "skillId is required");
        const definition = definitionOf(skillId, workspaceId);
        // 实例档绑不到工作区私有定义（固定顺序可见性 ⇒ 404，不泄露存在性）。
        if (!definition || (!workspaceId && definition.definitionScope.type !== "instance")) {
            return problem(404, "SKILL_NOT_FOUND", "Skill not found");
        }
        const scopeType = workspaceId ? "workspace" : "instance";
        const scopeId = workspaceId ?? null;
        if (
            bindings.some(
                (row) =>
                    row.principalId === principalId &&
                    row.skillId === skillId &&
                    row.scopeType === scopeType &&
                    row.scopeId === scopeId,
            )
        ) {
            return problem(409, "SKILL_BINDING_EXISTS", "already bound in that scope");
        }
        counter += 1;
        const row: MockAgentSkillBinding = {
            bindingId: `b1f0c4d2-7b3e-4c55-8f10-5d2c9b0002${String(counter).padStart(2, "0")}`,
            principalId,
            skillId,
            name: definition.name,
            description: definition.description,
            sourceType: definition.definitionScope.type === "workspace" ? "workspace" : "instance",
            sourceName:
                definition.definitionScope.type === "workspace"
                    ? "Ws " + workspaceId
                    : "实例技能库",
            scopeType,
            scopeId,
            scopeName: scopeType === "workspace" ? "Ws " + workspaceId : null,
            tokenEstimate: definition.bodyTokensEst,
            createdAt: "2026-11-14T00:00:00Z",
        };
        bindings.push(row);
        return { status: 201, body: viewOf(row) };
    }

    if (item && upper === "DELETE") {
        // item 正则的组 1 是 principalId、组 2 才是 bindingId（取错组会让每次 DELETE 都 404）。
        const bindingId = decodeURIComponent(item[2]!);
        const index = bindings.findIndex(
            (row) => row.bindingId === bindingId && row.principalId === principalId,
        );
        if (index < 0) return problem(404, "SKILL_BINDING_NOT_FOUND", "Skill binding not found");
        const row = bindings[index]!;
        // 实例档（无 workspaceId）可删任意 scope 行；工作区档只能删本工作区行。
        const mayDelete =
            !workspaceId || (row.scopeType === "workspace" && row.scopeId === workspaceId);
        if (!mayDelete) return problem(404, "SKILL_BINDING_NOT_FOUND", "Skill binding not found");
        bindings.splice(index, 1);
        return { status: 204, body: null };
    }

    return problem(405, "METHOD_NOT_ALLOWED", method);
}
