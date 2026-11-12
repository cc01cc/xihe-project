import { describe, expect, it } from "vitest";
import type { Page } from "@playwright/test";
import { SELECT_LABELS, selectLabelFor, triggerLabel } from "../../../e2e/helpers/select";
import { i18n } from "../../i18n";

// PLAN-0707/0709/0713 共用的 e2e Select 适配层：映射与文案读取是纯函数，锁住行为，
// 避免后续迁移时把 value→label 映射改乱或把空 trigger 伪造出占位。
//
// task-270：本 spec 原先直接断言「用户层」字面量，i18n 改名（251 的同批：层名统一为「个人层」）后
// 单测连带红 —— 不是产品错，是"改了映射没改锁它的单测"。这里改为**断言映射与 i18n 同源**：
// helper 的 label 必须等于对应 i18n 键的 zh 文案；文案改名只改 i18n，单测不再需要跟着抄一份。
function fakePage(text: string): Page {
    return {
        getByTestId: () => ({ innerText: async () => text }),
    } as unknown as Page;
}

/** 取 zh-CN 某个 i18n 键的文案（走 messages 树，不依赖 locale 状态）。 */
function zhCopy(path: string): string {
    let node: unknown = i18n.global.getLocaleMessage("zh-CN");
    for (const segment of path.split(".")) {
        node = (node as Record<string, unknown> | undefined)?.[segment];
    }
    return typeof node === "string" ? node : `<missing:${path}>`;
}

/**
 * helper 映射 label 的 i18n 键（zh 侧，en 侧的语义由 i18n parity 保证）。
 * 判据：`selectLabelFor(testId, value)` 必须等于该键的当前文案 —— 文案 rename 只需改 i18n。
 */
const LABEL_KEYS: Record<string, Record<string, string>> = {
    "approval-rule-layer": {
        workspace: "chat.approvalLayerWorkspace",
        user: "chat.approvalLayerUser",
    },
    "approval-classify-shape": {
        structured: "chat.approvalShapeStructured",
        interpreter: "chat.approvalShapeInterpreter",
        opaque: "chat.approvalShapeOpaque",
    },
    "session-policy-mode": {
        manual: "chat.approvalModeManual",
        auto: "chat.approvalModeAuto",
    },
    "settings-audit-status": { failed: "settings.auditStatusLabels.failed" },
    "settings-audit-type": { chat_run: "settings.auditTypeChatRun" },
    "ws-members-add-role": {
        EDITOR: "workspace.membersRoleEditor",
        VIEWER: "workspace.membersRoleViewer",
    },
    "workspace-execution-mode": { "windows-host": "workspace.executionModeHost" },
    "config-select-approval-policy-mode": {
        manual: "chat.approvalModeManual",
        auto: "chat.approvalModeAuto",
    },
    "config-select-logging-levelCp": {
        TRACE: "settings.logLevelTrace",
        DEBUG: "settings.logLevelDebug",
        INFO: "settings.logLevelInfo",
        WARN: "settings.logLevelWarn",
        ERROR: "settings.logLevelError",
    },
};

/**
 * 已知偏差登记：**当前为空**（task-270 已把 `ws-members-add-role` EDITOR 的映射从「编辑」修正为
 * 「可编辑」并移入 LABEL_KEYS）。若再发现"映射抄错产品文案"，先登记在这里（锁"当前仍是旧值"），
 * 修好后移入 LABEL_KEYS 并删除登记 —— ④ 会在修好时变红，逼着清理这张表。
 */
const KNOWN_MAPPING_DRIFT: Record<string, Record<string, string>> = {};

/** 原样显示的技术标识（下拉里没有 i18n 文案）：label 必须 === value（大写技术 id 不能被人话化）。 */
const PASSTHROUGH_VALUES: Record<string, string[]> = {
    "workspace-execution-mode": ["windows-mxc"],
};

describe("e2e select helper", () => {
    it("① 映射与 i18n 文案同源（按 testid 分组）", () => {
        for (const [testId, entries] of Object.entries(LABEL_KEYS)) {
            for (const [value, key] of Object.entries(entries)) {
                const copy = zhCopy(key);
                expect(copy, `${testId}/${value} 的 i18n 键 ${key} 必须存在`).not.toMatch(
                    /^<missing:/,
                );
                expect(selectLabelFor(testId, value), `${testId}/${value} ⇒ ${key}`).toBe(copy);
            }
        }
    });

    it("② 映射表全覆盖：每个 (testid, value) 都已声明（新增映射必须登记）", () => {
        const declared = new Set<string>();
        for (const [testId, entries] of Object.entries(LABEL_KEYS)) {
            for (const value of Object.keys(entries)) declared.add(`${testId}/${value}`);
        }
        for (const [testId, values] of Object.entries(PASSTHROUGH_VALUES)) {
            for (const value of values) declared.add(`${testId}/${value}`);
        }
        for (const [testId, entries] of Object.entries(KNOWN_MAPPING_DRIFT)) {
            for (const value of Object.keys(entries)) declared.add(`${testId}/${value}`);
        }

        const actual: string[] = [];
        for (const [testId, entries] of Object.entries(SELECT_LABELS)) {
            for (const value of Object.keys(entries)) actual.push(`${testId}/${value}`);
        }
        expect([...actual].sort()).toEqual([...declared].sort());
    });

    it("③ 未知 value 回退原值（不静默改写；Playwright 报错会带该文案便于定位）", () => {
        expect(selectLabelFor("approval-rule-layer", "bogus")).toBe("bogus");
        expect(selectLabelFor("no-such-testid", "x")).toBe("x");
        expect(SELECT_LABELS["approval-rule-layer"]).not.toHaveProperty("bogus");
    });

    it("④ 已无已知偏差；passthrough 仍原样显示（修好偏差后本项红 ⇒ 清理登记）", () => {
        expect(Object.keys(KNOWN_MAPPING_DRIFT), "已知偏差表应为空").toEqual([]);
        for (const [testId, entries] of Object.entries(KNOWN_MAPPING_DRIFT)) {
            for (const [value, label] of Object.entries(entries)) {
                expect(
                    selectLabelFor(testId, value),
                    `${testId}/${value} 的已知偏差已修复？请移入 LABEL_KEYS 并删掉登记`,
                ).toBe(label);
            }
        }
        for (const [testId, values] of Object.entries(PASSTHROUGH_VALUES)) {
            for (const value of values) {
                expect(selectLabelFor(testId, value), `${testId}/${value} 必须原样显示`).toBe(
                    value,
                );
            }
        }
    });

    it("⑤ triggerLabel 去空白；无文案时返回空串（不伪造占位）", async () => {
        // 当前层名文案（个人层）只在这里当"任意有文案的 trigger"用，不锁 i18n 值。
        const someCopy = zhCopy("chat.approvalLayerUser");
        await expect(
            triggerLabel(fakePage(`  ${someCopy} \n`), "approval-rule-layer"),
        ).resolves.toBe(someCopy);
        await expect(triggerLabel(fakePage("   "), "approval-rule-layer")).resolves.toBe("");
    });
});
