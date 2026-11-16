import { ApiError } from "../../../composables/api";

/**
 * 树级故障的三类主因（PLAN-0557/BL-109）—— 面板据此挑专属可见文案，
 * 不再只把原始 detail 塞进 tooltip。task-59 起它与文件级判据同住本模块：
 * 两者互为镜像（同一批码，一个判「整棵树」一个判「某个文件」），放一起才看得见这件事。
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
 * task-59（D-1708 缺陷 B）：**文件级**故障与**树级**故障曾经共用一个显示位。
 *
 * <p>症状：`openFile()` 打开单个文件失败也调 `setTreeError()`，而面板唯一的那条横幅默认文案是
 * 「文件树加载失败，可重试或先继续使用聊天」⇒ 用户看到的是「整棵树没了」，于是去点「重试」，
 * 而树其实好好的（截图 `.tmp/xh/b02-24-approval-test.png` 左红框）。</p>
 *
 * <p>拆法（判据是**影响面**而不是措辞）：树级故障 = 整棵树拉不起来（用户一个文件都看不到）；
 * 文件级故障 = 某一个文件/目录的动作失败（树仍是可用的）。两类各占一个显示位。</p>
 *
 * <p>结构与文案分离：这里只产出 `kind`/`reason`/`code`/`path` 这些**机器可判的枚举**与 i18n
 * 键名，`t()` 一律由组件层调用 —— 与既有 `treeErrorKind` + headline 同一形态（store 不引 i18n）。
 *
 * <h3>取舍：拆显示位（本方案）vs 一个位按 kind 分支文案</h3>
 * <ul>
 *   <li><b>A（本方案）：拆成两个显示位。</b>退出成本 = 低。判据集中在 `visibleErrorSlot` 一个纯函数，
 *       新增一类故障只需要加一个 `FileOpKind` + 一个 i18n 键；要退回旧行为，把 `setFileOpError`
 *       改回 `setTreeError(msg)` 一处即可（这就是本卡的变异腿，实测 8 条用例转红），组件与 i18n 都不用动。</li>
 *   <li><b>B：保留一个位，按 `kind` 分支文案。</b>退出成本 = 中高。`treeError` 已经是「最后一次失败的
 *       可读消息」通道，`FileNodeMenu` 六处与 `WorkspaceContainerTabs` 等消费方都直接读它；把文案分支塞进
 *       同一个位意味着「横幅的严重度」也要跟着分支走 —— 文件级故障要么仍显示成整棵树不可用（本卡要修的
 *       正是这个），要么横幅自己降级成 toast，那时「树级故障」的 `role="alert"` 与重试出口就得另找位置，
 *       等于把 A 的工作换个顺序做，还多背一个「一条横幅同时表达两种严重度」的歧义。</li>
 * </ul>
 * <p>选 A 的关键判据：两类故障的**影响面不同**（整棵树 vs 一个文件），影响面不同就该占不同的位；
 * 文案分支只能改措辞，改不了「用户能不能继续用」。判据 ①-2 也靠 A 才守得住：横幅继续只表示树级故障，
 * 所以「树真的拉不起来」那条文案不会被文件级故障抢走。</p>
 *
 * <p>**为什么单开一个模块而不是留在 store 里**：`FileTreePanel` 的若干单测（如
 * `nestedRepos.spec.ts`）用 `vi.mock("../stores/workspace")` 整块替身 store，只提供渲染需要的字段；
 * 组件若从 store 里导入新符号就会在那些用例里拿到 `undefined`。判据与文案映射属于**纯函数**，
 * 放 lib 就能被组件直接使用、也能被单测直接表测，不依赖 store 是否被替身。</p>
 */
export type ErrorScope = "tree" | "file";

export type FileOpKind =
    | "open"
    | "save"
    | "delete"
    | "create"
    | "rename"
    | "move"
    | "duplicate"
    | "mkdir"
    | "read"
    | "splitPdf"
    | "readonly";

export type FileOpReason =
    | "notFound"
    | "permission"
    | "runtime"
    | "tool"
    | "invalidName"
    | "unavailable"
    | "binary"
    | "other"
    | "unknown";

export interface FileOpError {
    kind: FileOpKind;
    /** 工作区相对路径；只读拒绝这类「没有对象」的故障为 null。 */
    path: string | null;
    reason: FileOpReason;
    /** 稳定错误码（没有则为 null），供文案里的「（码）」兜底显示。 */
    code: string | null;
}

const FILE_OP_TITLE_KEYS: Record<FileOpKind, string> = {
    open: "workspace.fileOpOpenFailed",
    save: "workspace.fileOpSaveFailed",
    delete: "workspace.fileOpDeleteFailed",
    create: "workspace.fileOpCreateFailed",
    rename: "workspace.fileOpRenameFailed",
    move: "workspace.fileOpMoveFailed",
    duplicate: "workspace.fileOpDuplicateFailed",
    mkdir: "workspace.fileOpMkdirFailed",
    read: "workspace.fileOpReadFailed",
    splitPdf: "workspace.fileOpSplitPdfFailed",
    // 只读拒绝是「这个工作区不能改」，复用既有 VIEWER 文案，不新增同义句。
    readonly: "workspace.viewerReadOnly",
};

const FILE_OP_REASON_KEYS: Record<FileOpReason, string> = {
    notFound: "workspace.fileOpReasonNotFound",
    permission: "workspace.fileOpReasonPermission",
    runtime: "workspace.fileOpReasonRuntime",
    tool: "workspace.fileOpReasonTool",
    invalidName: "workspace.fileOpReasonInvalidName",
    unavailable: "workspace.fileOpReasonUnavailable",
    binary: "workspace.fileOpReasonBinary",
    other: "workspace.fileOpReasonOther",
    unknown: "workspace.fileOpReasonUnknown",
};

/** 标题键：组件层 `t(key, { name })` —— 点名是**哪个**对象失败了。 */
export function fileOpTitleKey(kind: FileOpKind): string {
    return FILE_OP_TITLE_KEYS[kind] ?? FILE_OP_REASON_KEYS.unknown;
}

/** 原因键：组件层 `t(key)` —— 说明**为什么**失败。 */
export function fileOpReasonKey(reason: FileOpReason): string {
    return FILE_OP_REASON_KEYS[reason] ?? FILE_OP_REASON_KEYS.unknown;
}

/** 只有这两类原因才把原始消息当详情行显示（其余原因是已本地化的判定）。 */
export function fileOpShowsRawDetail(reason: FileOpReason): boolean {
    return reason === "other" || reason === "unknown";
}

/**
 * 显示位的**唯一**判定（task-59）。纯函数 ⇒ 可表测：把分类改回「全部落 tree」时它必须变红。
 * - `tree`：真·树故障，用 FileTreePanel 的横幅（文案 = 文件树加载失败那组）；
 * - `file`：某个文件/目录的动作失败，用行内提示（文案点名文件 + 原因），树仍可用；
 * - `none`：没有故障。
 *
 * `scope` 为 null（旧写入方/旧夹具没这个字段）时按 `tree` 渲染 —— 与修前逐字节一致。
 */
export type ErrorDisplaySlot = "tree" | "file" | "none";

export function visibleErrorSlot(
    scope: ErrorScope | null | undefined,
    treeError: string | null,
    fileOpError: FileOpError | null,
): ErrorDisplaySlot {
    if (scope === "file") return fileOpError ? "file" : "none";
    return treeError ? "tree" : "none";
}

const NOT_FOUND_DETAIL = /not\s*found|no such file|enoent|does not exist/i;
const PERMISSION_DETAIL = /permission denied|access denied/i;
const PERMISSION_CODE = /(^|_)ACCESS_DENIED$|^FORBIDDEN$|^UNAUTHORIZED$|PERMISSION|READ_?ONLY/;
const BINARY_MESSAGE = /binary|not a binary file|无法作为文本/i;

/**
 * 把异常折成「用户能懂的原因」+ 支撑码。**原始 detail 只用于分类**，不直接当文案
 * （PLAN-0706/BL-152：后端 detail 可能是英文，页面不展示原文）。
 */
export function classifyFileOpReason(e: unknown): { reason: FileOpReason; code: string | null } {
    if (!(e instanceof ApiError)) {
        // 非 ApiError 也尽量说清原因：`fileService` 拒绝二进制预览时抛的就是裸 Error。
        const raw = e instanceof Error ? e.message : String(e ?? "");
        if (BINARY_MESSAGE.test(raw)) return { reason: "binary", code: null };
        if (NOT_FOUND_DETAIL.test(raw)) return { reason: "notFound", code: null };
        if (PERMISSION_DETAIL.test(raw)) return { reason: "permission", code: null };
        return { reason: "unknown", code: null };
    }
    const code = (e.problem.code ?? "").trim(),
        detail = e.problem.detail ?? "";
    // 「文件不在了」是打开失败最常见、也最该直说的原因（截图里的 demo-approval.txt 就是它）：
    // CP 的 MCP 工具错误把它包成 MCP_TOOL_ERROR，信号落在 detail 里。
    if (code === "FILE_NOT_FOUND" || NOT_FOUND_DETAIL.test(detail)) {
        return { reason: "notFound", code: code || null };
    }
    if (PERMISSION_CODE.test(code) || PERMISSION_DETAIL.test(detail)) {
        return { reason: "permission", code: code || null };
    }
    const treeKind: TreeErrorKind = classifyTreeErrorCode(code);
    if (treeKind === "runtime") return { reason: "runtime", code: code || null };
    if (treeKind === "tool") return { reason: "tool", code: code || null };
    return { reason: "other", code: code || null };
}
