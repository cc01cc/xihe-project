import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import KnowledgeResourceView from "../KnowledgeResourceView.vue";
import { i18n } from "../../../i18n";
import { findLeaks, summarizeLeaks } from "../../../lib/copyLeakPatterns";

/**
 * 知识库缺口页的**文案判据**（不是"渲染出来了"就算）。
 *
 * <p><b>判据在 D-1879 裁定一改过一次方向，改这里之前先读那段。</b></p>
 *
 * <p>task-42 曾把两条口径写进本文件（原文「正断言的要求来自 Lead 的两条口径：① 每条缺口带自己的
 * 核法读面 ② 必须点名缺的是 CP 库实体」），并据此断言 `toContain("怎么核")` 与
 * `toContain("CP"/"实体"/"文档列表"/"分区")`。那两条**已废止**：可核验性属于测试面与证据面，
 * 不属于文案面；把审查者的验证义务写进用户正文，页面就必然长成工程工作日志 —— 而这两条断言会
 * **主动维持**那个畸形（改掉文案不改断言，下一个人会把文案改回来）。
 * 依据：`internal/A03-xihe/docs/lead-decisions-ledger.md` D-1879 裁定一。</p>
 *
 * <p>task-42 的另一半目的**保留**：干掉不可兑现的时间承诺。所以「不承诺时间」与「不用兜底文案」
 * 两条判据原样不动 —— 它们不产生泄露，且正是当初要解决的问题。</p>
 *
 * <p>新增的方向是**负向**的：面向用户的渲染文本里不得出现「审查者形态」的字符串（LEAK_PATTERNS）。
 * 判据从「要求带核法」翻成「要求不带核法」，畸形才不会被反向改回去。机器判据正文见 DEV-011 §14。</p>
 */
function mountView() {
    return mount(KnowledgeResourceView, { global: { plugins: [i18n] } });
}

/** 排期/时间承诺的黑名单（命中任一即判失败）。 */
const SCHEDULE_PATTERNS: [string, RegExp][] = [
    ["等…落地", /等[^。；]{0,12}落地/],
    ["恢复要等", /恢复要等/],
    ["即将/将要", /即将|将要|预计/],
    ["计划在", /计划在/],
    ["英文 scheduled", /scheduled for|we plan to/i],
    ["英文 once-lands", /once[^.。]{0,24}lands/i],
    ["英文 coming soon", /coming soon|in a future release/i],
];

/** 通用兜底文案的黑名单：它说明不了缺口，只会让人去点重试。 */
const FALLBACK_PATTERNS: [string, RegExp][] = [
    ["加载失败", /加载失败/],
    ["请重试", /请重试|重试/],
    ["出错了", /出错了|发生错误/],
    ["英文 generic", /something went wrong|please try again|failed to load/i],
];

/**
 * 9 形态判据**不在本文件维护**（task-57 收口）：唯一来源是 `src/lib/copyLeakPatterns.ts`，
 * 门脚本 `scripts/check-copy-leak.mjs` 那份由 `src/lib/__tests__/copyLeakPatterns.spec.ts` 逐条对齐。
 * 原先这里有一份字面量副本 —— 同一契约写两份会各自漂移，仓库里已为此留过话
 * （`e2e/mock/resource-detail.spec.ts` 末尾那条注释）。用形态而不是枚举具体词，
 * 因为枚举追不上新形态（task-39 主结论）；四条缺口的读数原文在
 * `internal/A03-xihe/evidence/2026-11-13-task-42-resource-detail/README.md`，不在页面复述。
 */

describe("KnowledgeResourceView — 缺口文案", () => {
    it("四条缺口逐条渲染，且都不带审查者形态的字符串（D-1879 裁定二）", () => {
        const wrapper = mountView();
        const ids = ["noLibrary", "noDocList", "partition", "noWriteEntry"];
        for (const id of ids) {
            const item = wrapper.get(`[data-testid="resources-knowledge-gap-${id}"]`);
            expect(item.text().length).toBeGreaterThan(20);
            const leaks = findLeaks(item.text());
            expect(leaks, `条目 ${id} 命中审查者形态：${summarizeLeaks(leaks)}`).toEqual([]);
        }
        // 阳性对照：四条之外不应多出条目（`<li>` 恰好 4 个），否则是模板漏了 v-for 边界
        expect(wrapper.findAll("li")).toHaveLength(4);
    });

    it("用用户语言点名缺的是哪四块，而不是笼统的「暂不可用」", () => {
        const wrapper = mountView();
        const text = wrapper.text();
        // 废止「点名 CP 库实体」之后，这条的正向对应物是：用户要能看出缺的是**哪四块**。
        // 断言锚在用户词上，不锚在实现词（实体 / 读面 / 端点 / CP）上。
        expect(text).toContain("库");
        expect(text).toContain("文档");
        expect(text).toContain("共享");
        expect(text).toContain("上传");
    });

    it("整页正文同样过 9 形态负断言（条目之外的标题与引言也不许泄露）", () => {
        const text = mountView().text();
        const leaks = findLeaks(text);
        expect(leaks, `整页命中审查者形态：${summarizeLeaks(leaks)}`).toEqual([]);
    });

    it("不承诺时间（逐条正则，命中即失败并点名）", () => {
        const text = mountView().text();
        for (const [name, pattern] of SCHEDULE_PATTERNS) {
            expect(pattern.test(text), `命中排期措辞：${name}`).toBe(false);
        }
    });

    it("提到「排期」时必须是否定句（不写排期 / 不是排期），不能是承诺", () => {
        const text = mountView().text();
        const mentions = text.match(/.{0,6}排期/g) ?? [];
        expect(mentions.length).toBeGreaterThan(0);
        for (const mention of mentions) {
            expect(/不写|不是|没有|无/.test(mention), `排期措辞未加否定：${mention}`).toBe(true);
        }
    });

    it("不用通用兜底文案（缺口页不是错误页）", () => {
        const text = mountView().text();
        for (const [name, pattern] of FALLBACK_PATTERNS) {
            expect(pattern.test(text), `命中兜底文案：${name}`).toBe(false);
        }
    });

    it("不出现裸 i18n 键（漏翻会让页面长出 resources.xxx）", () => {
        expect(mountView().text()).not.toContain("resources.");
    });

    it("保留 e2e 依赖的两个 testid（缺口容器 + 写入口已撤），避免文案重写打断既有用例", () => {
        const wrapper = mountView();
        expect(wrapper.find('[data-testid="resources-knowledge-gap"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="resources-knowledge-write-gone"]').exists()).toBe(true);
    });
});
