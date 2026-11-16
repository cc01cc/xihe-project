import { FILE_SIZE_THRESHOLDS, MB } from "../../../lib/fileSize";
import type { FileOpReason } from "./fileOpError";

/**
 * task-78（Lead 裁定 Q-1116-21）：**不可读不是一件事，是三件**。
 *
 * <p>用户在「文件打开逻辑」提案里写的是「不可读（类型不支持）⇒ 显示元数据 + 提示不能解析」。
 * 但这把三种不同处境压成了一个 —— 与 D-1703 / D-1708 同族的坑：<b>同一个结论掩盖不同原因</b>，
 * 用户会照着错误的结论去查错方向（把「没权限」当成「格式不支持」，于是去找转换工具）。</p>
 *
 * <p>判别线<b>不是措辞</b>，而是<b>有没有东西可以给用户</b>，再细分「给了多少」：</p>
 * <ul>
 *   <li><b>unparsable</b>（内容不可解析：二进制/坏编码）—— <b>有</b>元信息，无正文。</li>
 *   <li><b>oversized</b>（超出读取上限）—— <b>有</b>元信息 + 前 N 字节。<b>从来不是失败</b>：
 *       内容是有的，只是没全给。</li>
 *   <li><b>unreadable</b>（权限/消失/IO）—— <b>没有</b>任何可给的东西，连元信息都不可信
 *       （`files/stat` 可能同样被拒，或它给出的是快照而非此刻的真相）⇒ 必须停在错误态。</li>
 * </ul>
 *
 * <h3>⚠ 路标：`TRUNCATE_BYTES` 是死参数（Lead 2026-11-16 要求留在这里，因为改它的人不在本卡）</h3>
 * <p><b>注意</b>：`lib/fileSize.ts` 的 `TRUNCATE_BYTES`（1 MiB）<b>目前无消费方</b>，实际预览上限是
 * `composables/fileService.ts` 的 `PREVIEW_BYTE_BUDGET`（8 MiB）。本分类器按<b>实际给了什么</b>判，
 * <b>不按 `decideReadMode` 的 `action` 判</b> —— 因为 action 与真实行为已脱节。</p>
 * <p><b>为什么这条注释在这里</b>：下一个人读 `decideReadMode` 会以为截断是 1 MiB（它甚至专门算了个
 * `maxBytes: 1MiB` 返回出来），而那个值一路没人用。修它要动 `fileService.ts`（本卡写面之外），
 * 所以本卡能做的极限就是<b>在旁边的文件里留一条能被 grep 到的路标</b>，让「声明当行为」这件事在
 * 下一个读者那里断掉。</p>
 *
 * <h3>`oversized` 为什么要再分两档（Lead 2026-11-16 追加判据）</h3>
 * <p>「有东西可给」本身还分三种：<b>全给了</b> / <b>给了前 N 字节</b> / <b>一个字都没给</b>。
 * 三种必须能在 UI 上看出来，否则又是「不同原因压成一种」在文件大小这条轴上的同构。</p>
 * <p><b>[实测] 2026-11-16 这条轴今天的行为（读源码，不是猜）：</b></p>
 * <ul>
 *   <li>`decideReadMode(size)`：`>=10MB` ⇒ `truncate`，`>=32MB` ⇒ `intercept`（`lib/fileSize.ts:28`）。</li>
 *   <li>`readFilePreview`（`composables/fileService.ts:84`）对 `truncate` 与 `full` 两支**逐字相同**，
 *       都调 `runtimeReadFilePreview(path, ws, rootId)`；`truncate` 算出的 `maxBytes`（1MB）**从未被消费**
 *       （`runtimeReadFilePreview` 不收该参数，`git grep maxBytes -- src` 零消费方）⇒ **`TRUNCATE_BYTES` 是死参数**。</li>
 *   <li>真正的上限是 `runtimeReadFilePreview` 自己的 `PREVIEW_BYTE_BUDGET = 8 MiB`。</li>
 *   <li>`intercept` 那一支 `return { content: "", truncated: true }` —— <b>空内容但不抛错</b>，
 *       于是 UI 拿到「空文件 + 已截断横幅」，而横幅那句「仅显示文件的一部分」暗示「有内容但截断了」，
 *       实际<b>一个字都没有</b> ⇒ <b>横幅在撒谎</b>。</li>
 * </ul>
 * <p>⇒ 所以本模块把「给了多少」分成 `partial` / `empty`：前者文案说「仅显示前 N 字节（共 M）」，
 * 后者必须换成「超出上限，正文未加载」——**同一句话不能同时描述「有前缀」和「什么都没有」**。</p>
 *
 * <p><b>为什么单开一个模块</b>：这是本卡第二个「唯一判据点」（第一个是 `fileOpError.visibleErrorSlot`）。
 * 纯函数 ⇒ 可表测、可变异证伪；组件/store 只消费结论，不各自复写 if 链（复写必然分叉）。</p>
 */
export type OpenOutcomeState =
    | "content"
    | "unparsable"
    | "oversized-partial"
    | "oversized-empty"
    | "unreadable";

export interface OpenOutcome {
    state: OpenOutcomeState;
    /** 仅 `unreadable` 有意义：为什么读不到。其余态为 null（不是失败）。 */
    reason: FileOpReason | null;
    code: string | null;
    /**
     * `files/stat` 的七字段此刻**能不能当真相显示**。
     * 前三态 true，`unreadable` false —— 这一位就是「有东西可给 / 没东西可给」的机器可判形态。
     */
    metadataTrusted: boolean;
    /** 只给了前多少字节（`oversized-partial`）；其余态 null。**算出来的，不是猜的**。 */
    previewBytes: number | null;
    /** 文件总大小（`files/stat` 或树里已知）；未知则 null。用于「共 M」与「截了多少」。 */
    totalBytes: number | null;
}

/** 预览的真实字节上限 = `fileService.PREVIEW_BYTE_BUDGET`（8 MiB）；这里只做一次导出以便表测对齐。 */
export const OPEN_PREVIEW_BUDGET_BYTES = 8 * MB;

/**
 * 打开一个文件后，用户到底拿到了什么。
 *
 * @param size 树里已知的文件大小（可能 undefined —— 懒加载子树或 stat 未回填）。
 * @param failure 读取抛出的原因分类；成功读取传 null。
 * @param actualTruncated 读取结果自报的 `truncated`（比用 size 猜更权威：小文件也可能被行数上限截断）。
 */
export function classifyOpenOutcome(
    size: number | undefined,
    failure: { reason: FileOpReason; code: string | null } | null,
    actualTruncated = false,
): OpenOutcome {
    const totalBytes = size ?? null;
    // ── 判据顺序：**失败优先于尺寸**（task-78 自查修正）───────────────────────────
    // 先判尺寸会出一个致命错：40MiB 的文件权限被拒 ⇒ 尺寸条件成立 ⇒ 落 `oversized-empty`
    // 且 `metadataTrusted = true` ⇒ **「没权限」被显示成「文件在这儿，只是太大」**。
    // 那正是本卡要防的错误方向（③ 必须保持错误态）。尺寸只是从树里读来的**提示**，
    // 失败是**实际观测到的事实**；观测到的失败不能被提示推翻。
    if (failure) {
        // ① 不可解析：文件在那儿，只是内容不是可读文本 ⇒ 元信息照给。
        if (failure.reason === "binary") {
            return {
                state: "unparsable",
                reason: null,
                code: failure.code,
                metadataTrusted: true,
                previewBytes: null,
                totalBytes,
            };
        }
        // ③ 读不到：**没有东西可给**。notFound / permission / runtime / tool / unavailable 全落这里 ——
        // 区分它们的措辞由 `fileOpReasonKey` 负责，但「有没有东西可给」这个结论只有一条。
        return {
            state: "unreadable",
            reason: failure.reason,
            code: failure.code,
            metadataTrusted: false,
            previewBytes: null,
            totalBytes,
        };
    }
    // ② 太大（且读取成功 ⇒ 内容确实拿到了）：`>= INTERCEPT` 时 `readFilePreview` 走 intercept
    // 支返回空内容，**一个字都没给** ⇒ 这档不是「截断」，是「正文未加载」。
    if (size !== undefined && size >= FILE_SIZE_THRESHOLDS.INTERCEPT) {
        return {
            state: "oversized-empty",
            reason: null,
            code: null,
            metadataTrusted: true,
            previewBytes: 0,
            totalBytes,
        };
    }
    // 10–32MiB 那一档，以及任何被行数/字节预算截住的文件：**给了前缀**。
    // 判据用「实际给了多少」（`actualTruncated`）而不是「size 落在哪个阈值区间」——
    // 后者会把「20MiB 只给 8MiB」与「20MiB 恰好全给」判成同一档。
    if (actualTruncated) {
        return {
            state: "oversized-partial",
            reason: null,
            code: null,
            metadataTrusted: true,
            previewBytes: OPEN_PREVIEW_BUDGET_BYTES,
            totalBytes,
        };
    }
    return {
        state: "content",
        reason: null,
        code: null,
        metadataTrusted: true,
        previewBytes: null,
        totalBytes,
    };
}

/** 这些态要显示元信息面板（① ② 两族）；`content` 不显示、`unreadable` 只在错误态里标不可信。 */
export function showsMetadata(outcome: OpenOutcome | null): boolean {
    return (
        outcome?.state === "unparsable" ||
        outcome?.state === "oversized-partial" ||
        outcome?.state === "oversized-empty"
    );
}

/** 只有 `unreadable` 走文件级错误条；其余四态都不是「打开失败」。 */
export function isOpenFailure(outcome: OpenOutcome | null): boolean {
    return outcome?.state === "unreadable";
}

/** 正文还能不能显示（`oversized-empty` 一个字都没有 ⇒ 编辑器要显示占位而不是空 buffer）。 */
export function hasBody(outcome: OpenOutcome | null): boolean {
    return outcome?.state === "content" || outcome?.state === "oversized-partial";
}
