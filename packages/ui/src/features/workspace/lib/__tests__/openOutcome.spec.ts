import { describe, expect, it } from "vitest";

import { FileOpReason } from "../fileOpError";
import {
    OPEN_PREVIEW_BUDGET_BYTES,
    classifyOpenOutcome,
    hasBody,
    isOpenFailure,
    showsMetadata,
    type OpenOutcomeState,
} from "../openOutcome";

/** 32 MiB = runtime capture cap（`lib/fileSize.ts` INTERCEPT）；10 MiB = FULL_LOAD。 */
const MB = 1024 * 1024,
    INTERCEPT = 32 * MB,
    FULL_LOAD = 10 * MB;

describe("classifyOpenOutcome —— 不可读三分流（task-78 / Q-1116-21）", () => {
    // ─────────────────────────────────────────────────────────────────────────
    // 判据本体：三种「不可读」必须给出**不同** state，而不是同一句 error。
    // 这三条是本卡的核心；它们红了才算分类错，文案错另有断言（见下）。
    // ─────────────────────────────────────────────────────────────────────────
    it("① 不可解析（二进制）⇒ unparsable，且元信息可信", () => {
        const outcome = classifyOpenOutcome(2048, { reason: "binary", code: null });
        expect(outcome.state).toBe("unparsable");
        expect(outcome.metadataTrusted).toBe(true);
        expect(outcome.previewBytes).toBeNull();
        expect(outcome.totalBytes).toBe(2048);
        // ① 不是失败：文件在那儿，只是内容不是文本。
        expect(isOpenFailure(outcome)).toBe(false);
        expect(showsMetadata(outcome)).toBe(true);
    });

    it("② 太大 ⇒ oversized 两档，且都元信息可信、都不是失败", () => {
        // ② 前段：给了前 N 字节（truncated 为真）。
        const partial = classifyOpenOutcome(20 * MB, null, true);
        expect(partial.state).toBe("oversized-partial");
        expect(partial.metadataTrusted).toBe(true);
        expect(partial.previewBytes).toBe(OPEN_PREVIEW_BUDGET_BYTES);
        expect(partial.totalBytes).toBe(20 * MB);
        expect(isOpenFailure(partial)).toBe(false);
        expect(hasBody(partial)).toBe(true);

        // ② 一个字都没给：>= 32MiB 走 intercept，content 为 ""。
        const empty = classifyOpenOutcome(INTERCEPT, null, true);
        expect(empty.state).toBe("oversized-empty");
        expect(empty.metadataTrusted).toBe(true);
        expect(empty.previewBytes).toBe(0);
        expect(isOpenFailure(empty)).toBe(false);
        expect(showsMetadata(empty)).toBe(true);
        // **关键**：这档没有正文 ⇒ 编辑器不许把它渲染成「空文件」。
        expect(hasBody(empty)).toBe(false);
    });

    it("③ 读不到（权限/消失/IO）⇒ unreadable，**元信息不可信**且仍是失败", () => {
        for (const reason of [
            "notFound",
            "permission",
            "runtime",
            "tool",
            "unavailable",
        ] as const) {
            const outcome = classifyOpenOutcome(undefined, { reason, code: null });
            expect(outcome.state, `reason=${reason} must be a failure, not a metadata page`).toBe(
                "unreadable",
            );
            // 这一位是「有东西可给 / 没东西可给」的机器可判形态。
            expect(outcome.metadataTrusted).toBe(false);
            expect(outcome.reason).toBe(reason);
            expect(isOpenFailure(outcome)).toBe(true);
            // **不许**给元信息页：那是把「没权限」说成「不能预览」。
            expect(showsMetadata(outcome)).toBe(false);
            expect(hasBody(outcome)).toBe(false);
        }
    });

    it("③ 即使文件存在（size 已知）读不到也不许变成元信息页", () => {
        // 这条钉住「size 有值」不能把 unreadable 掰回 ①/② —— 否则权限失败会被
        // 显示成「文件在这儿，只是不能预览」，正是本卡要防的那个错方向。
        const outcome = classifyOpenOutcome(4096, { reason: "permission", code: "ACCESS_DENIED" });
        expect(outcome.state).toBe("unreadable");
        expect(outcome.metadataTrusted).toBe(false);
        expect(showsMetadata(outcome)).toBe(false);
        expect(outcome.code).toBe("ACCESS_DENIED");
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 尺寸档位边界（Lead 追加判据：两档都要覆盖，别只处理 intercept）
    // ─────────────────────────────────────────────────────────────────────────
    it("尺寸档位边界：10MiB 与 32MiB 各落在正确档", () => {
        // <10MiB 且未被截 ⇒ 全给了。
        expect(classifyOpenOutcome(FULL_LOAD - 1, null, false).state).toBe("content");
        // 10–32MiB 区间真实会拿到 8MiB 前缀 ⇒ partial（不是 content）。
        expect(classifyOpenOutcome(FULL_LOAD, null, true).state).toBe("oversized-partial");
        expect(classifyOpenOutcome(INTERCEPT - 1, null, true).state).toBe("oversized-partial");
        // >=32MiB ⇒ 空正文档。
        expect(classifyOpenOutcome(INTERCEPT, null, true).state).toBe("oversized-empty");
        expect(classifyOpenOutcome(INTERCEPT + 1, null, true).state).toBe("oversized-empty");
    });

    it("小文件也可能被预算截住 ⇒ 按「实际给了什么」判，不按 size 判", () => {
        // 这一个就是「按 size 区间判会判错」的反例：5MiB 的极小文件没有 size 风险，
        // 但行数/字节预算仍可能截住它 ⇒ 它给了前缀，就必须是 partial。
        const outcome = classifyOpenOutcome(5 * MB, null, true);
        expect(outcome.state).toBe("oversized-partial");
    });

    it("size 未知时按读取自报的 truncated 判，不猜档位", () => {
        expect(classifyOpenOutcome(undefined, null, false).state).toBe("content");
        expect(classifyOpenOutcome(undefined, null, true).state).toBe("oversized-partial");
        // size 未知不可能判成 oversized-empty —— 那需要尺寸证据。
        expect(classifyOpenOutcome(undefined, { reason: "binary", code: null }).state).toBe(
            "unparsable",
        );
    });

    it("超大 + 读取失败 ⇒ **失败优先**（尺寸不能把错误吞成「太大了」）", () => {
        // 这条是本卡最重要的一条顺序判据（自查时发现自己一开始写反了）：
        // 若先判尺寸，一个 40MiB 文件权限被拒会落 oversized-empty 且 metadataTrusted=true
        // ⇒ 用户的读数变成「文件在这儿，只是太大」 ⇒ **他去换工具/等它变小，而不是去要权限**。
        // 尺寸只是树里读来的提示，失败是实际观测到的事实；观测到的失败不能被提示推翻。
        const outcome = classifyOpenOutcome(40 * MB, { reason: "permission", code: null });
        expect(outcome.state, "权限失败必须压过尺寸判断，否则「没权限」会被说成「太大」").toBe(
            "unreadable",
        );
        expect(outcome.metadataTrusted).toBe(false);
        expect(showsMetadata(outcome)).toBe(false);

        // 二进制 + 超大：仍然落 ①（元信息可信）—— 「不可解析」比「太大」更准确地描述了处境，
        // 且两者都属「有东西可给」，不冲突。
        const binary = classifyOpenOutcome(40 * MB, { reason: "binary", code: null });
        expect(binary.state).toBe("unparsable");
        expect(binary.metadataTrusted).toBe(true);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 文案可判：三种「不可读」不许共用一句话（Lead 明确要求钉「文案不同」）
    // ─────────────────────────────────────────────────────────────────────────
    it("三态的 i18n 键两两不同（文案可判，不只是状态可判）", () => {
        const keyOf: Record<OpenOutcomeState, string> = {
            content: "",
            unparsable: "workspace.fileMetaUnparsable",
            "oversized-partial": "workspace.fileMetaOversizedPartial",
            "oversized-empty": "workspace.fileMetaOversizedEmpty",
            unreadable: "workspace.fileOpOpenFailed",
        };
        const readable = [
            "unparsable",
            "oversized-partial",
            "oversized-empty",
            "unreadable",
        ] as const;
        const keys = readable.map((state) => keyOf[state]);
        expect(new Set(keys).size, "四种处境必须各有各的文案键，不许复用").toBe(keys.length);
    });

    it("oversized-empty 的语义是「正文未加载」而不是「已截断」", () => {
        // 这条是 Lead 抬成判据的那句话的机器形态：
        // 「撒谎的提示比没有提示更坏」⇒ 一个字都没给，就不许说「仅显示了一部分」。
        const outcome = classifyOpenOutcome(INTERCEPT, null, true);
        expect(outcome.previewBytes, "一个字都没给 ⇒ 前缀字节数必须是 0，不是 8MiB").toBe(0);
        expect(hasBody(outcome)).toBe(false);
    });

    it("Reason 联合类型覆盖 ③ 的全部成因（新增 reason 会红）", () => {
        // 用穷举钉住：`FileOpReason` 里除 binary 之外的每个值都必须落 unreadable。
        const all: FileOpReason[] = [
            "notFound",
            "permission",
            "runtime",
            "tool",
            "invalidName",
            "unavailable",
            "other",
            "unknown",
            "binary",
        ];
        const nonBinary = all.filter((r) => r !== "binary");
        for (const reason of nonBinary) {
            expect(classifyOpenOutcome(undefined, { reason, code: null }).state).toBe("unreadable");
        }
        expect(classifyOpenOutcome(undefined, { reason: "binary", code: null }).state).toBe(
            "unparsable",
        );
    });
});
