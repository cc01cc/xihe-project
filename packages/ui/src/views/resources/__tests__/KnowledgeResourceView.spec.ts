import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import KnowledgeResourceView from "../KnowledgeResourceView.vue";
import { i18n } from "../../../i18n";

/**
 * task-42：知识库缺口页的**文案判据**（不是"渲染出来了"就算）。
 *
 * <p>本卡之前的正文是一段概括 + 一句「恢复要等 G3 落地后挂到本资源页」—— 那是**时间承诺**，
 * 而没有人能给出这个时间。所以这里的负断言比正断言更重要：**不许出现排期措辞**、
 * **不许出现通用兜底文案**（「加载失败，请重试」这类既没说明缺什么、也指错了方向）。</p>
 *
 * <p>正断言的要求来自 Lead 的两条口径：① 文案必须来自**实测的缺口原因**（每条缺口带自己的
 * 核法读面，每条回答"什么请求 / 什么返回 / 页面显示什么"）；② 必须**点名缺的是 CP 库实体**，
 * 不能只说"暂不可用"。</p>
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

describe("KnowledgeResourceView — 缺口文案", () => {
    it("四条缺口逐条渲染，每条都带自己的核法", () => {
        const wrapper = mountView();
        const ids = ["noLibrary", "noDocList", "partition", "noWriteEntry"];
        for (const id of ids) {
            const item = wrapper.get(`[data-testid="resources-knowledge-gap-${id}"]`);
            expect(item.text().length).toBeGreaterThan(20);
            expect(item.text()).toContain("怎么核");
        }
        // 阳性对照：四条之外不应多出条目（`<li>` 恰好 4 个），否则是模板漏了 v-for 边界
        expect(wrapper.findAll("li")).toHaveLength(4);
    });

    it("点名缺的是 CP 侧的库实体，而不是笼统的「暂不可用」", () => {
        const wrapper = mountView();
        const text = wrapper.text();
        expect(text).toContain("CP");
        expect(text).toContain("库");
        // 缺口的三种形态都要有名字：实体 / 文档列表 / 分区
        expect(text).toContain("实体");
        expect(text).toContain("文档列表");
        expect(text).toContain("分区");
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
