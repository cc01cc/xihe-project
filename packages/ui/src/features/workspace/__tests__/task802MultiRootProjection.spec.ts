import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
    clearTabWorkspace,
    readTabWorkspaceId,
    writeTabWorkspace,
    writeTabWorkspaceId,
} from "../../../lib/workspaceContext";
import { useAuthStore } from "../../../stores/auth";
import { useWorkspaceStore } from "../stores/workspace";

/**
 * task-802：多根工作区 UI 只渲染单根 —— **投影新鲜度**链路用例。
 *
 * <p>run6/run7 host E2E 的 `plan0639-multi-root.spec.ts:279` 在第二组根头处超时；
 * 数据面 CP/Runtime 已是 `roots=2`。本文件把「UI 侧的 roots 是从哪来的」拆成两段可证伪读数：</p>
 *
 * <ol>
 *   <li><b>新鲜重读</b>：`hydrateWorkspace()` 真走 HTTP → `normalizeWorkspace` → store，
 *       这条链上 roots 应该是 2（若这里就是 1，断点在 wire 映射）；</li>
 *   <li><b>再次进入</b>：同一 workspace 在 add-root 之前已被加载过（投影 roots=1），
 *       add-root 之后 `selectWorkspace()` 必须以 CP 为准重读并让投影收敛到 2 —— 旧实现的
 *       「同 id + 有 name/role 即早返回」直接复用旧投影（0 次重读），这就是 UI 与
 *       CP/Runtime 分叉的直接机制（`auth.ts:631-637`）。</li>
 * </ol>
 *
 * <p>反假绿判据：把 `selectWorkspace` 的早返回改回「只返回、不重读」，第 2 条用例必红；
 * 把 `normalizeWorkspace` 的 `roots` 映射删掉，第 1 条必红。</p>
 */

const WORKSPACE_ID = "1a6cbc63-0000-4000-8000-000000000802";

function root(id: string, alias: string, position: number) {
    return { id, alias, position, path: `mock/${alias}` };
}

const SINGLE_ROOT = [root(WORKSPACE_ID, "alpha", 0)];
const TWO_ROOTS = [root(WORKSPACE_ID, "alpha", 0), root("root-beta-802", "beta", 1)];

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });
}

function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input.url;
}

let serverRoots: ReturnType<typeof root>[] = SINGLE_ROOT;
let workspaceReads = 0;

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    sessionStorage.clear();
    clearTabWorkspace();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem("xihe-token", "task-802-token");
    serverRoots = SINGLE_ROOT;
    workspaceReads = 0;
    fetchMock.mockImplementation(async (input) => {
        const url = requestUrl(input as RequestInfo | URL);
        if (url.includes(`/api/v1/workspaces/${WORKSPACE_ID}`)) {
            workspaceReads += 1;
            return jsonResponse({
                id: WORKSPACE_ID,
                name: "多根工作区",
                ownerId: "owner-802",
                storageMode: "direct_attach",
                workspaceRole: "OWNER",
                canWrite: true,
                roots: serverRoots,
            });
        }
        return new Response("{}", {
            status: 404,
            headers: { "Content-Type": "application/json" },
        });
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    clearTabWorkspace();
    sessionStorage.clear();
    localStorage.clear();
});

describe("task-802 多根投影：UI roots 必须与 CP 事实一致", () => {
    it("① 证伪读数：新鲜 hydrate 后 roots.length=2（wire 映射不是断点）", async () => {
        serverRoots = TWO_ROOTS;
        writeTabWorkspaceId(WORKSPACE_ID);
        expect(readTabWorkspaceId()).toBe(WORKSPACE_ID);

        await useAuthStore().hydrateWorkspace();

        const auth = useAuthStore(),
            ws = useWorkspaceStore();
        // 证伪输出（evidence README 抄录这一行）。
        console.log(
            `[task-802-probe] fresh hydrate roots.length=${auth.workspace?.roots?.length ?? "undefined"} isMultiRoot=${ws.isMultiRoot}`,
        );
        expect(auth.workspace?.roots).toHaveLength(2);
        expect(ws.isMultiRoot).toBe(true);
    });

    it("② add-root 之后再次进入：投影必须收敛到 2（不得停在旧的单根对象）", async () => {
        writeTabWorkspaceId(WORKSPACE_ID);
        const auth = useAuthStore();

        // 第一次进入（add-root 之前）：投影只有主根。
        await auth.hydrateWorkspace();
        expect(auth.workspace?.roots).toHaveLength(1);
        console.log(
            `[task-802-probe] before add-root roots.length=${auth.workspace?.roots?.length}`,
        );

        // CP/Runtime 侧 add-root 完成（run6 log :8360-8362 roots=2）。
        serverRoots = TWO_ROOTS;
        const readsBefore = workspaceReads;

        // WorkspaceView / WorkspaceSettingsView 的进入路径：selectWorkspace(同 id)。
        // 命中缓存时立即返回旧值（不阻塞首屏），随后后台重读并写回。
        await auth.selectWorkspace(WORKSPACE_ID);
        await vi.waitFor(() => expect(auth.workspace?.roots).toHaveLength(2));

        const ws = useWorkspaceStore();
        console.log(
            `[task-802-probe] after re-enter roots.length=${auth.workspace?.roots?.length ?? "undefined"} isMultiRoot=${ws.isMultiRoot} extraReads=${workspaceReads - readsBefore}`,
        );
        expect(auth.workspace?.roots).toHaveLength(2);
        expect(ws.isMultiRoot).toBe(true);
        // 复用同一 id 的缓存也不是「读旧值」的借口：必须真的重读过一次。
        expect(workspaceReads).toBeGreaterThan(readsBefore);
    });

    it("③ tab 上下文里只有 {id} 的旧缓存同样要被一次真实读取补齐投影", async () => {
        // 路由守卫只写 id（workspaceContext.writeTabWorkspaceId），name/role/roots 全缺。
        writeTabWorkspace({ id: WORKSPACE_ID });
        serverRoots = TWO_ROOTS;
        const auth = useAuthStore();

        await auth.selectWorkspace(WORKSPACE_ID);

        console.log(
            `[task-802-probe] minimal-cache select roots.length=${auth.workspace?.roots?.length ?? "undefined"}`,
        );
        expect(auth.workspace?.roots).toHaveLength(2);
        expect(useWorkspaceStore().isMultiRoot).toBe(true);
    });
});
