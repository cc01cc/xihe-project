import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import { useSessionStore } from "../../../stores/session";
import { useAuthStore } from "../../../stores/auth";
import { api, apiPost, ApiError } from "../../../composables/api";
import type { ApiWorkspaceRoot } from "../../../composables/api";
import { readFilePreview } from "../composables/fileService";
import { humanizeErrorCode } from "../../../lib/errorMessages";
import { logger } from "../../../lib/logger";
import type { FileNode, OpenFile, UploadItem, WorkspaceEvent } from "../../../types";

function detectLanguage(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase() || "";
    const map: Record<string, string> = {
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        py: "python",
        rs: "rust",
        java: "java",
        go: "go",
        vue: "vue",
        svelte: "svelte",
        html: "html",
        css: "css",
        json: "json",
        yaml: "yaml",
        yml: "yaml",
        md: "markdown",
        sql: "sql",
        xml: "xml",
        sh: "shell",
        bash: "shell",
        toml: "toml",
        c: "c",
        cpp: "cpp",
        h: "c",
    };
    return map[ext] || "plaintext";
}

/**
 * 运行产物【文件】：不进树（.xihe-* 运行时状态、容器运行时日志）。
 * task-484：语义未变，只是从私有提升为导出 —— 原先 stores/workspace.ts 与 FileTree.vue
 * 各写一份同样的正则，改一处会漂。
 */
export function isRuntimeArtifact(name: string): boolean {
    return name.startsWith(".xihe-") || /^container-runtime\.log(?:\..*)?$/.test(name);
}

/**
 * 运行产物【目录】：不进树。
 * Lead 2026-11-14 裁定（task-484 / D-1393）：空 `logs` 目录维持隐藏是**合法例外**，
 * 不算 D-1234「空目录都显示」的缺口 —— 它与 .xihe-* 同属运行产物目录。
 * 单立常量的理由：原实现把 `name === "logs"` 直接写在两处（store 与 FileTree），
 * 而「空则隐、非空则显」这种半条规则散落两处必然不自洽；此处收成一处判据。
 * 【不要】把这里扩成「隐藏所有 logs」—— 那会改变用户可见面，属另一个决策。
 */
export const RUNTIME_ARTIFACT_DIRS: readonly string[] = ["logs"];

export function isRuntimeArtifactDir(name: string): boolean {
    return RUNTIME_ARTIFACT_DIRS.includes(name);
}

/**
 * VCS 内部目录：不进树（**.git 目录**）。
 * D-1234 边界（台账 lead-decisions-ledger.md:9451-9452）：显示 dotfile ≠ 显示 .git ——
 * 「不暴露版本库内部」与「不隐藏所有 dotfile」独立成立。
 * 【关键区分】只有**目录**形态的 .git 被排除：worktree 子仓的 .git 是**文件**（gitdir 指针），
 * 它必须保留可见可读（task-378 T3：\`.git\` 以文件呈现可读 gitdir，当目录展开/报错才红）。
 */
export const VCS_INTERNAL_DIRS: readonly string[] = [".git"];

export function isVcsInternalDir(name: string, isDir: boolean): boolean {
    return isDir && VCS_INTERNAL_DIRS.includes(name);
}

/** dotfile（以 `.` 开头的条目）。D-1234：可见、排普通条目之后、置灰。 */
export function isDotfileName(name: string): boolean {
    return name.startsWith(".");
}

/**
 * 空目录判据（D-1234「空目录淡样式」的唯一来源）。
 * 卡面明确要求「在 store 层露出判据，不许在模板里靠猜」⇒ 模板只消费这个函数。
 */
export function isEmptyDirectoryNode(node: Pick<FileNode, "type" | "children">): boolean {
    return node.type === "directory" && (node.children?.length ?? 0) === 0;
}

/** 树里是否隐藏该条目（唯一判据；store 构建与 FileTree 渲染共用）。 */
export function isHiddenTreeEntry(entry: { name: string; type: "file" | "directory" }): boolean {
    return (
        isRuntimeArtifact(entry.name) || isVcsInternalDir(entry.name, entry.type === "directory")
    );
}

/**
 * 同层排序（D-1234）：普通条目在前、dotfile 在后，各组内按名称升序。
 * 目录组与文件组各自排序、目录组整体在前 —— 这部分沿用既有行为，未改。
 */
export function compareTreeEntries(left: { name: string }, right: { name: string }): number {
    const leftDotfile = isDotfileName(left.name),
        rightDotfile = isDotfileName(right.name);
    if (leftDotfile !== rightDotfile) return leftDotfile ? 1 : -1;
    return left.name.localeCompare(right.name);
}

/**
 * PLAN-0557/BL-109: the file panel must name the cause in *visible* copy, not only
 * in a tooltip. Failures are bucketed into the three causes the contract
 * distinguishes; anything unmapped keeps the generic copy plus the raw detail.
 */
export type TreeErrorKind = "runtime" | "tool" | "other";

export function classifyTreeErrorCode(code: string | undefined | null): TreeErrorKind {
    switch ((code ?? "").trim()) {
        case "RUNTIME_ERROR":
        case "RUNTIME_UNAVAILABLE":
        case "MCP_STREAM_UNAVAILABLE":
        case "MCP_DISCONNECT_UNAVAILABLE":
        case "CAPABILITY_UNAVAILABLE":
            return "runtime";
        case "UNKNOWN_TOOL":
            return "tool";
        default:
            return "other";
    }
}

/**
 * PLAN-0639 M2 (design §5 candidate ①): per-root lazy tree state for secondary roots
 * of a multi-root workspace. The primary root keeps living in `fileTree` with the
 * pre-M2 load/refresh machinery; secondary roots are loaded on selection only.
 */
export interface RootTreeState {
    nodes: FileNode[];
    loaded: boolean;
    loading: boolean;
    error: string | null;
}

function emptyRootTreeState(): RootTreeState {
    return { nodes: [], loaded: false, loading: false, error: null };
}

export const useWorkspaceStore = defineStore("workspace", () => {
    const sessionStore = useSessionStore(),
        authStore = useAuthStore();

    const sessionId = computed<string | null>(() => sessionStore.currentSessionId),
        sessionAttachments = computed(() => sessionStore.currentSessionAttachments),
        sessionFileContext = computed(() => sessionStore.currentSessionFileContext),
        sessionAgents = computed(() => sessionStore.currentAgentIds),
        workspaceId = computed(() => authStore.currentWorkspaceId);

    function requireWorkspaceId(): string {
        if (!workspaceId.value) {
            throw new ApiError({
                status: 400,
                code: "WORKSPACE_CONTEXT_REQUIRED",
                detail: "Workspace context is required",
                requestId: "client",
            });
        }
        return workspaceId.value;
    }

    /** PLAN-0559: VIEWER is read-only; CP remains authoritative. */
    function ensureWritable(): boolean {
        if (authStore.canWriteWorkspace) return true;
        setTreeError("当前工作区为只读（VIEWER），无法修改内容");
        return false;
    }

    const fileTree = ref<FileNode[]>([]),
        expandedPaths = ref<Set<string>>(new Set()),
        loading = ref(false),
        treeError = ref<string | null>(null),
        treeErrorKind = ref<TreeErrorKind>("other"),
        loadedWorkspaceId = ref<string | null>(null);

    /**
     * task-498：身份代次与「被挡代次」。
     *
     * `workspaceId` 每变化一次算一代（null→id、A→B 都算）；`resumeGen` 记录 `loadTree`
     * 因身份缺失被挡住时所在的代次。重入只在「被挡的那一代正是上一代」时发生，于是：
     * ① 迟到的旧代次登记不会被用来替一个无关的新身份发请求；
     * ② 同一 tick 内连跳多次身份时 Vue 会把 watcher 合并到当代，只会发一次请求。
     * 这里刻意不用共享布尔 —— 布尔只能表达「有人被挡过」，无法表达「是谁的那一代」，
     * 也无法在旧代次作废时自我失效（同族教训见 task-497 的 timer 句柄串台）。
     */
    let identityGen = 0,
        resumeGen: number | null = null;

    /**
     * PLAN-0639 M2: multi-root grouping state. `expandedRootIds` holds root groups the
     * user selected (selection gates expansion — design §5 候选①); `collapsedRootIds`
     * records an explicit collapse of the auto-expanded primary group. `rootTrees`
     * carries the lazily loaded secondary root trees keyed by rootId.
     */
    const expandedRootIds = ref<Set<string>>(new Set()),
        collapsedRootIds = ref<Set<string>>(new Set()),
        rootTrees = ref<Map<string, RootTreeState>>(new Map());

    /**
     * Ordered root projection of the current workspace (wire contract PLAN-0639 M1:
     * [{id, alias, position}], Root[0].id == workspace.id). Empty for legacy
     * single-root workspaces that predate the projection — those render exactly as
     * before (no grouping).
     */
    const workspaceRoots = computed<ApiWorkspaceRoot[]>(() => {
        const roots = authStore.workspace?.roots;
        if (!roots || roots.length === 0) return [];
        return [...roots].sort((a, b) => a.position - b.position);
    });

    const isMultiRoot = computed(() => workspaceRoots.value.length > 1),
        primaryRootId = computed(() => workspaceRoots.value[0]?.id ?? null),
        /** Owner-only disclosed host path of the primary root (group header fallback). */
        primaryRootPath = computed(() => authStore.workspace?.hostPath ?? null);

    /**
     * Single writer for `treeError` so the visible category can never drift from the
     * message (PLAN-0557/BL-109). Defaults to `other`, which renders the generic copy
     * plus the detail line; load failures pass the classified kind.
     */
    function setTreeError(message: string | null, kind: TreeErrorKind = "other") {
        treeError.value = message;
        treeErrorKind.value = message ? kind : "other";
    }
    // PLAN-0365 (root cause C): bumped by refresh requests that arrive while a
    // load is in flight; the in-flight load re-runs itself instead of the
    // refresh being swallowed by the `loading` early-return.
    let loadTreePending = 0;

    const openFiles = ref<Map<string, OpenFile>>(new Map()),
        activeFilePath = ref<string | null>(null);

    const showImportDialog = ref(false),
        uploadQueue = ref<UploadItem[]>([]);

    const activeFile = computed(() => {
        if (!activeFilePath.value) return null;
        return openFiles.value.get(activeFilePath.value) ?? null;
    });

    const openFileList = computed(() => {
        return Array.from(openFiles.value.values());
    });

    /**
     * PLAN-0639 M2: `rootId` scopes the recursive listing to one declared root of a
     * multi-root workspace (omitted = primary root, the pre-M2 behavior). Paths stay
     * root-relative in both cases — the Runtime resolves the root, never the UI.
     */
    async function fetchDirectoryTree(dirPath: string, rootId?: string): Promise<FileNode[]> {
        const nodes: FileNode[] = [];
        const res = await api.listDirectory(dirPath, requireWorkspaceId(), rootId);
        // task-484：过滤与排序都走上面导出的统一判据（此前过滤只挡运行产物文件、
        // .git 目录会一路进树；排序用纯 localeCompare 让 dotfile 排到最前，与 D-1234 相反）。
        const entries = (res?.entries ?? []).filter((entry: any) => !isHiddenTreeEntry(entry));
        const dirs = entries.filter((e: any) => e.type === "directory").sort(compareTreeEntries),
            files = entries.filter((e: any) => e.type === "file").sort(compareTreeEntries);
        for (const dir of dirs) {
            const childPath = dirPath ? `${dirPath}/${dir.name}` : dir.name,
                children = await fetchDirectoryTree(childPath, rootId);
            // 运行产物目录：空则隐（Lead 2026-11-14 裁定的合法例外），非空则显。
            if (isRuntimeArtifactDir(dir.name) && children.length === 0) continue;
            nodes.push({
                name: dir.name,
                path: childPath,
                type: "directory",
                children,
            });
        }
        for (const file of files) {
            const filePath = dirPath ? `${dirPath}/${file.name}` : file.name;
            nodes.push({
                name: file.name,
                path: filePath,
                type: "file",
                size: file.size,
                modified: file.modified,
                mimeType: detectMimeType(file.name),
            });
        }
        return nodes;
    }

    // PLAN-292 T6: raster-image extensions routed to the binary-safe
    // read_file_range path (aligned with FileEditor's isImage list);
    // svg is text and takes the utf8 data-URL branch below.
    const IMAGE_PREVIEW_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

    function detectMimeType(name: string): string {
        const ext = name.split(".").pop()?.toLowerCase() || "";
        const map: Record<string, string> = {
            md: "text/markdown",
            pdf: "application/pdf",
            ts: "text/typescript",
            tsx: "text/typescript",
            js: "text/javascript",
            py: "text/x-python",
            rs: "text/x-rust",
            vue: "text/html",
            json: "application/json",
            yaml: "text/yaml",
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            gif: "image/gif",
            svg: "image/svg+xml",
            webp: "image/webp",
            txt: "text/plain",
            csv: "text/csv",
            log: "text/plain",
        };
        return map[ext] || "application/octet-stream";
    }

    async function loadTree() {
        const currentWorkspaceId = workspaceId.value;
        if (!currentWorkspaceId) {
            // task-498：深链/刷新时组件先挂载、auth.workspace 尚未 hydrate ⇒ 这一次必然被挡。
            // 记下被挡的代次，等身份到位（见下方 watch）再重入，否则树会永久为空
            // （实测：修前 0 次 list_directory，见 task-498 证据包）。
            resumeGen = identityGen;
            return;
        }
        // S3a audit P1-2: a workspace switch can arrive while the previous load is in
        // flight. Queue it instead of dropping it, otherwise the new workspace keeps
        // an empty tree and nothing retries it.
        if (loading.value) {
            if (loadedWorkspaceId.value !== currentWorkspaceId) loadTreePending += 1;
            return;
        }
        if (loadedWorkspaceId.value === currentWorkspaceId) return;

        loading.value = true;
        setTreeError(null);
        try {
            // E2E seeding hook (mock profile only): lets Playwright inject a tree
            // without a live CP+MCP chain. Never set by production code.
            if (typeof localStorage !== "undefined") {
                try {
                    const seed = localStorage.getItem("xihe-mock-filetree");
                    if (seed) {
                        fileTree.value = JSON.parse(seed) as FileNode[];
                        loadedWorkspaceId.value = currentWorkspaceId;
                        return;
                    }
                } catch {
                    // fall through to the real chain
                }
            }
            const nodes = await fetchDirectoryTree("");
            // S3a audit P1-2: the workspace may have changed while awaiting; a stale
            // result must be dropped instead of painting workspace A's tree under B.
            if (workspaceId.value !== currentWorkspaceId) return;
            fileTree.value = nodes;
            loadedWorkspaceId.value = currentWorkspaceId;
        } catch (e) {
            // PLAN-0557/BL-109: route load failures through the stable-code mapping so a
            // dependency outage is not rendered as the raw upstream detail, and keep the
            // category so the panel can show cause-specific visible copy.
            setTreeError(
                humanizeFileError(e, "加载文件树失败"),
                classifyTreeErrorCode(e instanceof ApiError ? e.problem.code : null),
            );
        } finally {
            // PLAN-0365 (root cause C): refresh requests that arrive while a load is
            // in flight are counted by refreshAfterMutation; drain them here instead
            // of letting the `loading` early-return swallow the refresh permanently.
            loading.value = false;
            while (loadTreePending > 0) {
                loadTreePending -= 1;
                const targetId: string = workspaceId.value;
                if (!targetId) break;
                loading.value = true;
                try {
                    const nodes = await fetchDirectoryTree("");
                    if (workspaceId.value !== targetId) continue;
                    fileTree.value = nodes;
                    loadedWorkspaceId.value = targetId;
                } catch (e) {
                    setTreeError(
                        humanizeFileError(e, "加载文件树失败"),
                        classifyTreeErrorCode(e instanceof ApiError ? e.problem.code : null),
                    );
                } finally {
                    loading.value = false;
                }
            }
        }
    }

    /**
     * task-498：身份到位后自我重入一次加载。
     *
     * `workspaceId` 派生自 `authStore.currentWorkspaceId`，而 `auth.workspace` 要等
     * `GET /workspaces/{id}` 回来才有值。深链/刷新进工作区时**组件先挂载**：`FileTreePanel`
     * 的 onMounted 立刻调 loadTree，此刻 workspaceId 仍是 null ⇒ 命中上面的
     * `if (!currentWorkspaceId) return;`；而 `WorkspaceWorkbench` 的 watch 只盯路由派生的
     * `props.workspaceId`（深链首帧即为路由值，不随 hydrate 变化）⇒ 身份到位后没有任何
     * 重入点，树永久为空、0 次 `list_directory`（实测见 task-498 证据包）。
     *
     * 这里放**唯一**一处「身份跃迁 ⇒ 加载」监听，同时覆盖 null→id（深链/刷新）与
     * A→B（切工作区，reset 在 Workbench 侧先跑）两种跃迁。重复调用不会多发请求：
     * loadTree 的 `loading` 排队与 `loadedWorkspaceId === currentWorkspaceId` 守卫在上方。
     */
    watch(workspaceId, (id) => {
        const previousGen = identityGen;
        identityGen += 1;
        if (!id) return;
        const resumeForThisIdentity = resumeGen === previousGen;
        resumeGen = null;
        if (resumeForThisIdentity) void loadTree();
    });

    async function refreshTree() {
        expandedPaths.value = new Set();
        loadedWorkspaceId.value = null;
        await loadTree();
        // PLAN-0639 M2: the panel-head refresh covers every loaded root group, not
        // just the primary one (unloaded secondary groups stay lazy).
        for (const rootId of Array.from(rootTrees.value.keys())) await refreshRootTree(rootId);
    }

    function toggleExpand(path: string) {
        const next = new Set(expandedPaths.value);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        expandedPaths.value = next;
    }

    // ------------------------------------------------------------------
    // PLAN-0639 M2: per-root grouping (design §5 candidate ①)
    // ------------------------------------------------------------------

    /**
     * The primary root group auto-expands in multi-root mode (its tree already loads
     * with the panel head refresh semantics); any explicit user collapse wins.
     */
    function isRootExpanded(rootId: string): boolean {
        if (collapsedRootIds.value.has(rootId)) return false;
        if (expandedRootIds.value.has(rootId)) return true;
        return isMultiRoot.value && rootId === primaryRootId.value;
    }

    /** Selection gates expansion: selecting a root group loads its tree on first use. */
    function toggleRoot(rootId: string) {
        const expanded = isRootExpanded(rootId);
        const nextExpanded = new Set(expandedRootIds.value),
            nextCollapsed = new Set(collapsedRootIds.value);
        if (expanded) {
            nextExpanded.delete(rootId);
            nextCollapsed.add(rootId);
        } else {
            nextExpanded.add(rootId);
            nextCollapsed.delete(rootId);
        }
        expandedRootIds.value = nextExpanded;
        collapsedRootIds.value = nextCollapsed;
        if (!expanded) {
            if (rootId === primaryRootId.value) {
                if (loadedWorkspaceId.value !== workspaceId.value) void loadTree();
            } else {
                const state = rootTrees.value.get(rootId);
                if (!state || (!state.loaded && !state.loading)) void loadRootTree(rootId);
            }
        }
    }

    /**
     * Load (or reload) one root group's tree. The primary root reuses the pre-M2
     * `loadTree`; secondary roots are listed root-scoped and cached in `rootTrees`.
     * Depends on the Runtime honoring `rootId` on `list_directory` (design §5
     * runtime fs row) — until that lands, real-chain secondary listings fall back
     * to the primary root.
     */
    async function loadRootTree(rootId: string) {
        if (rootId === primaryRootId.value) {
            await loadTree();
            return;
        }
        const current = rootTrees.value.get(rootId) ?? emptyRootTreeState();
        if (current.loading) return;
        const pending: RootTreeState = { ...current, loading: true, error: null };
        rootTrees.value = new Map(rootTrees.value).set(rootId, pending);
        try {
            // E2E seeding hook (mock profile only): per-root trees without a live
            // CP+MCP chain. Never set by production code.
            if (typeof localStorage !== "undefined") {
                try {
                    const seed = localStorage.getItem("xihe-mock-filetree-roots");
                    if (seed) {
                        const parsed = JSON.parse(seed) as Record<string, FileNode[]>;
                        if (Array.isArray(parsed?.[rootId])) {
                            rootTrees.value = new Map(rootTrees.value).set(rootId, {
                                nodes: parsed[rootId],
                                loaded: true,
                                loading: false,
                                error: null,
                            });
                            return;
                        }
                    }
                } catch {
                    // fall through to the real chain
                }
            }
            const currentWorkspaceId = workspaceId.value;
            const nodes = await fetchDirectoryTree("", rootId);
            // Same stale-workspace rule as loadTree: a result fetched for workspace A
            // must never paint under workspace B's root groups.
            if (workspaceId.value !== currentWorkspaceId) return;
            rootTrees.value = new Map(rootTrees.value).set(rootId, {
                nodes,
                loaded: true,
                loading: false,
                error: null,
            });
        } catch (e) {
            rootTrees.value = new Map(rootTrees.value).set(rootId, {
                ...pending,
                loading: false,
                error: humanizeFileError(e, "加载根文件列表失败"),
            });
        }
    }

    /** Re-list a secondary root in place (event refresh keeps group expansion). */
    async function refreshRootTree(rootId: string) {
        const current = rootTrees.value.get(rootId);
        if (!current || !current.loaded) return;
        await loadRootTree(rootId);
    }

    function rootTreeState(rootId: string): RootTreeState {
        return rootTrees.value.get(rootId) ?? emptyRootTreeState();
    }

    /**
     * Resolve the owning root for a tree path: primary-root paths return undefined
     * (legacy call shape), secondary-root paths return their rootId. Walks loaded
     * trees only — unloaded groups have no clickable nodes by construction.
     */
    function rootIdOf(path: string): string | undefined {
        if (!path) return undefined;
        const walk = (nodes: FileNode[]): boolean => {
            for (const n of nodes) {
                if (n.path === path) return true;
                if (n.children && walk(n.children)) return true;
            }
            return false;
        };
        if (walk(fileTree.value)) return undefined;
        for (const [rootId, state] of rootTrees.value.entries()) {
            if (state.loaded && walk(state.nodes)) return rootId;
        }
        return undefined;
    }

    function findFileSize(path: string): number | undefined {
        function walk(nodes: FileNode[]): number | undefined {
            for (const n of nodes) {
                if (n.path === path) return n.size;
                if (n.children) {
                    const found = walk(n.children);
                    if (found !== undefined) return found;
                }
            }
            return undefined;
        }
        return walk(fileTree.value);
    }

    /**
     * PLAN-0639 M2: `rootId` scopes the read to the owning declared root of a
     * multi-root workspace; omitted resolves via the loaded trees. Primary-root
     * paths keep the legacy unscoped call shape — the argument is left off, not
     * passed as undefined, so single-root traffic is byte-identical to pre-M2.
     */
    async function openFile(path: string, rootId?: string) {
        if (openFiles.value.has(path)) {
            activeFilePath.value = path;
            return;
        }
        const owningRootId = rootId ?? rootIdOf(path),
            preview = (size: number | undefined) =>
                owningRootId
                    ? readFilePreview(path, size, requireWorkspaceId(), owningRootId)
                    : readFilePreview(path, size, requireWorkspaceId());
        try {
            const size = findFileSize(path),
                name = path.split("/").pop() || path,
                ext = name.split(".").pop()?.toLowerCase() || "";
            // PLAN-292 T6: images land as data URLs so FileEditor's ImagePreview
            // branch is reachable. svg is text — read via the guarded text path and
            // wrap as a utf8 data URL; raster images use the binary-safe tool.
            if (ext === "svg") {
                const res = await preview(size),
                    svg: OpenFile = {
                        path,
                        name,
                        content: `data:image/svg+xml;utf8,${encodeURIComponent(res.content)}`,
                        originalContent: res.content,
                        language: detectLanguage(path),
                        modified: false,
                        loading: false,
                        truncated: res.truncated,
                    };
                openFiles.value.set(path, svg);
                activeFilePath.value = path;
                return;
            }
            if (IMAGE_PREVIEW_EXTENSIONS.has(ext)) {
                const binary = owningRootId
                    ? await api.readFileRange(
                          path,
                          requireWorkspaceId(),
                          undefined,
                          undefined,
                          owningRootId,
                      )
                    : await api.readFileRange(path, requireWorkspaceId());
                if (!binary.is_binary) {
                    throw new Error("not a binary file");
                }
                const image: OpenFile = {
                    path,
                    name,
                    content: `data:${detectMimeType(name)};base64,${binary.content}`,
                    originalContent: "",
                    language: detectLanguage(path),
                    modified: false,
                    loading: false,
                    truncated: false,
                };
                openFiles.value.set(path, image);
                activeFilePath.value = path;
                return;
            }
            const res = await preview(size),
                file: OpenFile = {
                    path,
                    name,
                    content: res.content,
                    originalContent: res.content,
                    language: detectLanguage(path),
                    modified: false,
                    loading: false,
                    truncated: res.truncated,
                };
            openFiles.value.set(path, file);
            activeFilePath.value = path;
        } catch (e) {
            setTreeError(`Failed to open ${path}: ${(e as Error).message}`);
        }
    }

    function closeFile(path: string) {
        openFiles.value.delete(path);
        if (activeFilePath.value === path) {
            const remaining = openFileList.value;
            activeFilePath.value =
                remaining.length > 0 ? remaining[remaining.length - 1].path : null;
        }
    }

    function updateFileContent(path: string, content: string) {
        const file = openFiles.value.get(path);
        if (file) {
            openFiles.value.set(path, {
                ...file,
                content,
                modified: content !== file.originalContent,
            });
        }
    }

    async function saveFile(path: string) {
        if (!ensureWritable()) return;
        const file = openFiles.value.get(path);
        if (!file || !file.modified) return;
        const owningRootId = rootIdOf(path);
        try {
            await (owningRootId
                ? api.writeFile(path, file.content, requireWorkspaceId(), owningRootId)
                : api.writeFile(path, file.content, requireWorkspaceId()));
            openFiles.value.set(path, {
                ...file,
                originalContent: file.content,
                modified: false,
                externalChange: undefined,
            });
        } catch (e) {
            setTreeError(humanizeFileError(e, `保存 ${path} 失败`));
        }
    }

    async function reloadOpenFile(path: string) {
        if (!openFiles.value.has(path)) return;
        const previousActivePath = activeFilePath.value;
        closeFile(path);
        await openFile(path);
        if (
            previousActivePath &&
            previousActivePath !== path &&
            openFiles.value.has(previousActivePath)
        ) {
            activeFilePath.value = previousActivePath;
        }
    }

    async function reloadUnmodifiedOpenFiles() {
        for (const [path, file] of Array.from(openFiles.value.entries())) {
            if (!file.modified) await reloadOpenFile(path);
        }
    }

    /** Apply a Workspace SSE hint without treating the event stream as file data. */
    async function applyWorkspaceEvent(event: WorkspaceEvent) {
        if (event.kind === "snapshot_required") {
            await refreshAfterMutation();
            await reloadUnmodifiedOpenFiles();
            // PLAN-0639 M2: a snapshot covers every declared root — refresh the loaded
            // secondary root groups too (unloaded groups stay lazy).
            for (const rootId of Array.from(rootTrees.value.keys())) await refreshRootTree(rootId);
            return;
        }
        if (event.kind !== "file_changed" || !event.path) return;

        const file = openFiles.value.get(event.path);
        if (file?.modified) {
            openFiles.value.set(event.path, {
                ...file,
                externalChange: {
                    sequence: event.sequence,
                    changeType: event.changeType ?? "modified",
                },
            });
        } else if (file) {
            await reloadOpenFile(event.path);
        }
        const slash = event.path.lastIndexOf("/"),
            parentDir = slash >= 0 ? event.path.substring(0, slash) : "";
        // PLAN-0639 M2: route the refresh to the owning root group (design §5 — 事件按
        // rootId 路由到对应分组刷新). Events without rootId (legacy single-root chain)
        // keep the pre-M2 primary-root refresh.
        if (
            event.rootId &&
            event.rootId !== primaryRootId.value &&
            rootTrees.value.has(event.rootId)
        ) {
            expandPathDirs(parentDir);
            await refreshRootTree(event.rootId);
            return;
        }
        await refreshAfterMutation(parentDir);
    }

    async function deleteNode(path: string): Promise<boolean> {
        if (!ensureWritable()) return false;
        const owningRootId = rootIdOf(path);
        try {
            await (owningRootId
                ? api.deleteFile(path, requireWorkspaceId(), owningRootId)
                : api.deleteFile(path, requireWorkspaceId()));
            closeFile(path);
            const slash = path.lastIndexOf("/");
            await refreshAfterMutation(slash >= 0 ? path.substring(0, slash) : "");
            return true;
        } catch (e) {
            const message = humanizeFileError(e, "删除失败");
            setTreeError(message);
            logger.warn("Delete failed: " + message);
            return false;
        }
    }

    async function createFile(parentDir: string, name: string): Promise<boolean> {
        if (!ensureWritable()) return false;
        const fullPath = parentDir ? `${parentDir}/${name}` : name,
            owningRootId = rootIdOf(parentDir);
        try {
            await (owningRootId
                ? api.writeFile(fullPath, "", requireWorkspaceId(), owningRootId)
                : api.writeFile(fullPath, "", requireWorkspaceId()));
            await refreshAfterMutation(parentDir);
            return true;
        } catch (e) {
            const message = humanizeFileError(e, "创建文件失败");
            setTreeError(message);
            logger.warn("Create file failed: " + message);
            return false;
        }
    }

    function humanizeFileError(e: unknown, fallback: string): string {
        if (e instanceof ApiError) {
            const code = e.problem.code,
                mapped = humanizeErrorCode(code, e.problem.detail);
            if (mapped && mapped !== `${code}: ${e.problem.detail}`) return mapped;
            if (e.problem.detail) return `${fallback}: ${e.problem.detail}`;
        }
        return `${fallback}: ${e instanceof Error ? e.message : String(e)}`;
    }

    /** Expand every ancestor directory of `dir` so a fresh/changed file is visible. */
    function expandPathDirs(dir: string) {
        if (!dir) return;
        const next = new Set(expandedPaths.value),
            parts = dir.split("/");
        let current = "";
        for (const part of parts) {
            if (!part) continue;
            current = current ? `${current}/${part}` : part;
            next.add(current);
        }
        expandedPaths.value = next;
    }

    /** Reload the tree while keeping the current expansion state (M3 task 3.4). */
    async function refreshAfterMutation(keepExpandedDir?: string) {
        expandPathDirs(keepExpandedDir ?? "");
        // PLAN-0365 (root cause C): if a load is already running, its result is
        // stale by definition (the mutation just landed). Register a pending
        // reload so the in-flight loadTree re-runs instead of the refresh being
        // swallowed by the `loading` early-return.
        if (loading.value) {
            loadTreePending += 1;
            loadedWorkspaceId.value = null;
            return;
        }
        loadedWorkspaceId.value = null;
        await loadTree();
    }

    async function renameNode(oldPath: string, newName: string): Promise<boolean> {
        const trimmed = newName.trim();
        if (!trimmed || trimmed.includes("/")) {
            setTreeError("Invalid name: must be non-empty and contain no path separators");
            return false;
        }
        const slash = oldPath.lastIndexOf("/"),
            newPath = slash >= 0 ? `${oldPath.substring(0, slash + 1)}${trimmed}` : trimmed;
        if (newPath === oldPath) return true;
        const owningRootId = rootIdOf(oldPath);
        try {
            await (owningRootId
                ? api.moveFile(oldPath, newPath, requireWorkspaceId(), owningRootId)
                : api.moveFile(oldPath, newPath, requireWorkspaceId()));
            if (activeFilePath.value === oldPath) {
                const file = openFiles.value.get(oldPath);
                openFiles.value.delete(oldPath);
                if (file) {
                    file.path = newPath;
                    file.name = trimmed;
                    openFiles.value.set(newPath, file);
                }
                activeFilePath.value = newPath;
            }
            await refreshAfterMutation(slash >= 0 ? oldPath.substring(0, slash) : "");
            return true;
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            setTreeError(`Failed to rename: ${message}`);
            logger.warn("Rename failed: " + message);
            return false;
        }
    }

    async function moveNode(from: string, toDir: string): Promise<boolean> {
        const name = from.split("/").pop() || from,
            to = toDir ? `${toDir}/${name}` : name;
        if (to === from) return true;
        const owningRootId = rootIdOf(from);
        try {
            await (owningRootId
                ? api.moveFile(from, to, requireWorkspaceId(), owningRootId)
                : api.moveFile(from, to, requireWorkspaceId()));
            closeFile(from);
            await refreshAfterMutation(toDir);
            return true;
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            setTreeError(`Failed to move: ${message}`);
            logger.warn("Move failed: " + message);
            return false;
        }
    }

    async function duplicateNode(path: string): Promise<boolean> {
        const slash = path.lastIndexOf("/"),
            dir = slash >= 0 ? path.substring(0, slash) : "",
            base = slash >= 0 ? path.substring(slash + 1) : path,
            dot = base.lastIndexOf("."),
            copyName =
                dot > 0 ? `${base.substring(0, dot)}-copy${base.substring(dot)}` : `${base}-copy`,
            to = dir ? `${dir}/${copyName}` : copyName;
        const owningRootId = rootIdOf(path);
        try {
            await (owningRootId
                ? api.copyFile(path, to, requireWorkspaceId(), owningRootId)
                : api.copyFile(path, to, requireWorkspaceId()));
            await refreshAfterMutation(dir);
            return true;
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            setTreeError(`Failed to duplicate: ${message}`);
            logger.warn("Duplicate failed: " + message);
            return false;
        }
    }

    async function createDirectory(parentDir: string, name: string): Promise<boolean> {
        const trimmed = name.trim();
        if (!trimmed || trimmed.includes("/")) {
            setTreeError(
                "Invalid directory name: must be non-empty and contain no path separators",
            );
            return false;
        }
        const fullPath = parentDir ? `${parentDir}/${trimmed}` : trimmed,
            owningRootId = rootIdOf(parentDir);
        try {
            await (owningRootId
                ? api.createDirectory(fullPath, requireWorkspaceId(), owningRootId)
                : api.createDirectory(fullPath, requireWorkspaceId()));
            await refreshAfterMutation(parentDir);
            return true;
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            setTreeError(`Failed to create directory: ${message}`);
            logger.warn("Create directory failed: " + message);
            return false;
        }
    }

    function highlightFile(path: string) {
        const parts = path.split("/");
        let current = "";
        for (const part of parts) {
            if (current) current += "/";
            current += part;
            const next = new Set(expandedPaths.value);
            next.add(current);
            expandedPaths.value = next;
        }
        if (openFiles.value.has(path)) {
            activeFilePath.value = path;
        }
    }

    function syncActiveFileToSession() {
        if (!sessionId.value || !activeFilePath.value) return;
        sessionStore.setFileContext(sessionId.value, {
            activeFilePath: activeFilePath.value,
            workspaceFiles: Array.from(openFiles.value.keys()),
        });
    }

    function openImportDialog() {
        if (!ensureWritable()) return;
        showImportDialog.value = true;
    }
    function closeImportDialog() {
        showImportDialog.value = false;
        uploadQueue.value = [];
    }

    function addToUploadQueue(files: File[]) {
        if (!ensureWritable()) return;
        for (const file of files) {
            uploadQueue.value.push({
                file,
                name: file.name,
                size: file.size,
                status: "pending",
                targetPath: file.name,
            });
        }
    }

    function removeFromUploadQueue(index: number) {
        uploadQueue.value.splice(index, 1);
    }

    const TEXT_EXTENSIONS = new Set([
        "md",
        "txt",
        "csv",
        "json",
        "yaml",
        "yml",
        "toml",
        "xml",
        "svg",
        "ts",
        "tsx",
        "js",
        "jsx",
        "mjs",
        "cjs",
        "py",
        "rs",
        "java",
        "go",
        "vue",
        "svelte",
        "css",
        "scss",
        "html",
        "sh",
        "bash",
        "sql",
        "log",
        "gitignore",
    ]);
    const MAX_WORKSPACE_FILE_BYTES = 64 * 1024 * 1024;

    function isTextualFile(file: File): boolean {
        if (file.type.startsWith("text/")) return true;
        if (
            file.type === "application/json" ||
            file.type === "application/xml" ||
            file.type === "application/yaml" ||
            file.type === "application/javascript" ||
            file.type === "application/x-yaml"
        )
            return true;
        const ext = file.name.split(".").pop()?.toLowerCase() || "";
        return TEXT_EXTENSIONS.has(ext);
    }

    async function executeUpload(targetDir: string, splitPreference?: boolean) {
        if (!ensureWritable()) return;
        const owningRootId = rootIdOf(targetDir);
        for (const item of uploadQueue.value) {
            if (item.status === "cancelled") continue;
            if (item.size > MAX_WORKSPACE_FILE_BYTES) {
                item.status = "error";
                item.error = "PAYLOAD_TOO_LARGE: Workspace file exceeds the 64 MiB file-tool limit";
                continue;
            }
            item.status = "uploading";
            try {
                const isLargePdf =
                    item.name.toLowerCase().endsWith(".pdf") && item.size > 10 * 1024 * 1024;
                if (isLargePdf && splitPreference) {
                    const formData = new FormData();
                    formData.append("file", item.file);
                    formData.append("splitPreference", "true");
                    await apiPost("/api/v1/files/upload", formData);
                } else if (isTextualFile(item.file)) {
                    const text = await item.file.text(),
                        fullPath = targetDir ? `${targetDir}/${item.name}` : item.name;
                    await (owningRootId
                        ? api.writeFile(fullPath, text, requireWorkspaceId(), owningRootId)
                        : api.writeFile(fullPath, text, requireWorkspaceId()));
                } else {
                    // Binary files must preserve raw bytes: route through the CP upload
                    // proxy (POST /api/v1/files/upload), which forwards the body to the
                    // Runtime binary write endpoint. UTF-8 text() decode would corrupt them.
                    const formData = new FormData();
                    formData.append("file", item.file);
                    await apiPost("/api/v1/files/upload", formData);
                }
                item.status = "done";
            } catch (e) {
                item.status = "error";
                item.error = (e as Error).message;
            }
        }
        await refreshAfterMutation();
    }

    async function splitPdf(path: string) {
        // B-4 (PLAN-262 decision 17): the CP /api/v1/files/split-pdf route does not
        // exist (openapi drift). Fail closed instead of letting the request 404.
        setTreeError(
            "PDF splitting is temporarily unavailable: the backend endpoint is not deployed.",
        );
        logger.warn(
            "splitPdf requested but /api/v1/files/split-pdf has no CP implementation: " + path,
        );
    }

    async function loadFullContent(path: string) {
        const owningRootId = rootIdOf(path);
        try {
            const res = owningRootId
                    ? await api.readFile(path, requireWorkspaceId(), owningRootId)
                    : await api.readFile(path, requireWorkspaceId()),
                file = openFiles.value.get(path);
            if (file) {
                file.content = res.content;
                file.originalContent = res.content;
                file.truncated = false;
            }
        } catch (e) {
            setTreeError(`Failed to load full content: ${(e as Error).message}`);
        }
    }

    /**
     * PLAN-0582 S3a (S2 audit P0-1): `openFiles` / `activeFilePath` are global
     * singletons. Without this reset, switching to workspace B keeps workspace
     * A's editor buffer and active path reachable, and `saveFile` would then
     * write A's content to B's same-named file. Called on every workspace change.
     */
    function resetWorkspaceScoped() {
        openFiles.value = new Map();
        activeFilePath.value = null;
        expandedPaths.value = new Set();
        setTreeError(null);
        loadedWorkspaceId.value = null;
        // PLAN-0639 M2: root grouping is workspace-scoped too — a stale secondary root
        // tree must not leak into the next workspace's groups.
        expandedRootIds.value = new Set();
        collapsedRootIds.value = new Set();
        rootTrees.value = new Map();
        // `loadTreePending` is intentionally kept: a request queued while the previous
        // workspace was loading is drained for whatever workspace is current then.
    }

    return {
        sessionId,
        sessionAttachments,
        sessionFileContext,
        sessionAgents,
        fileTree,
        expandedPaths,
        loading,
        treeError,
        treeErrorKind,
        workspaceRoots,
        isMultiRoot,
        primaryRootId,
        primaryRootPath,
        expandedRootIds,
        collapsedRootIds,
        rootTrees,
        isRootExpanded,
        toggleRoot,
        loadRootTree,
        refreshRootTree,
        rootTreeState,
        openFiles,
        activeFilePath,
        activeFile,
        openFileList,
        showImportDialog,
        uploadQueue,
        loadTree,
        refreshTree,
        toggleExpand,
        highlightFile,
        openFile,
        closeFile,
        updateFileContent,
        saveFile,
        reloadOpenFile,
        applyWorkspaceEvent,
        deleteNode,
        createFile,
        renameNode,
        moveNode,
        duplicateNode,
        createDirectory,
        refreshAfterMutation,
        splitPdf,
        loadFullContent,
        openImportDialog,
        closeImportDialog,
        addToUploadQueue,
        removeFromUploadQueue,
        executeUpload,
        syncActiveFileToSession,
        resetWorkspaceScoped,
    };
});
