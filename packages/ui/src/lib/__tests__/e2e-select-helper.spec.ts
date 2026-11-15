import { describe, expect, it } from "vitest";
import type { Page } from "@playwright/test";
import {
    copyForKey,
    SELECT_LABEL_KEYS,
    selectLabelFor,
    triggerLabel,
} from "../../../e2e/helpers/select";
import { i18n } from "../../i18n";

// PLAN-0707/0709/0713 共用的 e2e Select 适配层：映射与文案读取是纯函数，锁住行为，
// 避免后续迁移时把 value→label 映射改乱或把空 trigger 伪造出占位。
//
// task-210（Lead 裁定 A，2026-11-15）：适配层的表已从「wire 值 → 硬编码文案」改成「wire 值 → i18n 键」，
// 真源唯一在 `e2e/helpers/select.ts`，文案运行时从语言包取 ⇒ **本 spec 不再抄第三份表**，只验两件事：
// 键能解析（①）、取到的就是它（① 同源）。原「② 全覆盖（两张表对账）」随双表合并**失去对象**，已删除 ——
// 单表之后「漏登记」不会静默：未登记 ⇒ 回退**原值** ⇒ `expectTriggerLabel(page, id, value)` 会拿 wire 值
// 去比产品显示的人话文案 ⇒ **真实断言直接红**，不需要一条专门的对账单测。

function fakePage(text: string): Page {
    return {
        getByTestId: () => ({ innerText: async () => text }),
    } as unknown as Page;
}

/** 取某 locale 某个键的文案（走 messages 树，不依赖 locale 状态）。 */
function copyOf(locale: string, path: string): string {
    let node: unknown = i18n.global.getLocaleMessage(locale);
    for (const segment of path.split(".")) {
        node = (node as Record<string, unknown> | undefined)?.[segment];
    }
    return typeof node === "string" ? node : "<missing:" + path + ">";
}

const zhCopy = (path: string): string => copyOf("zh-CN", path);

describe("e2e select helper", () => {
    it("① 每个登记键在语言包可解析，且 selectLabelFor 与语言包同源", () => {
        for (const [testId, entries] of Object.entries(SELECT_LABEL_KEYS)) {
            for (const [value, key] of Object.entries(entries)) {
                const copy = zhCopy(key);
                expect(copy, `${testId}/${value} 的 i18n 键 ${key} 必须存在`).not.toMatch(
                    /^<missing:/,
                );
                expect(selectLabelFor(testId, value), `${testId}/${value} ⇒ ${key}`).toBe(copy);
            }
        }
    });

    it("② 键表 zh/en 双侧对齐（新增映射必须两侧都给键，防单边漂移）", () => {
        const drift: string[] = [];
        for (const [testId, entries] of Object.entries(SELECT_LABEL_KEYS)) {
            for (const [value, key] of Object.entries(entries)) {
                if (copyOf("en-US", key).startsWith("<missing:"))
                    drift.push(`${testId}/${value} ⇒ ${key}`);
            }
        }
        expect(drift, "en-US 侧缺键：" + drift.join(", ")).toEqual([]);
    });

    it("③ 未登记的 (testid, value) 回退原值（不静默改写；Playwright 报错会带该文案便于定位）", () => {
        expect(selectLabelFor("approval-rule-layer", "bogus")).toBe("bogus");
        expect(selectLabelFor("no-such-testid", "x")).toBe("x");
        expect(SELECT_LABEL_KEYS["approval-rule-layer"]).not.toHaveProperty("bogus");
    });

    it("④ 已登记但语言包里没有这个键 ⇒ 也回退原值（不静默换成别的文案）", () => {
        // 直接打 copyForKey 的「键缺失」分支：这条判据若只靠「编个不存在的 testid」是测不到的，
        // 那种写法永远绿（D-1281）—— 这也是 copyForKey 作为 test-only export 的唯一理由。
        expect(copyForKey("chat.__no_such_key__")).toBeNull();
        expect(copyForKey("chat.approvalLayerUser")).toBe(zhCopy("chat.approvalLayerUser"));
    });

    it("⑤ triggerLabel 去空白；无文案时返回空串（不伪造占位）", async () => {
        // 当前层名文案（个人层）只在这里当「任意有文案的 trigger」用，不锁 i18n 值。
        const someCopy = zhCopy("chat.approvalLayerUser");
        await expect(
            triggerLabel(fakePage(`  ${someCopy} \n`), "approval-rule-layer"),
        ).resolves.toBe(someCopy);
        await expect(triggerLabel(fakePage("   "), "approval-rule-layer")).resolves.toBe("");
    });
});
