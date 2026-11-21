import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ScheduledTasksOverviewView from "../ScheduledTasksOverviewView.vue";

/**
 * task-11（DSD-1518 B）：自动化任务总览页的**缺口呈现判据**。
 *
 * <p>本页没有任何数据面，所以这里断的不是「列表长什么样」，而是三件事：</p>
 * <ol>
 *   <li><b>缺口在场的 testid 真的渲染出来了</b>（`scheduled-tasks-not-wired`）——没有它，
 *       页面就是一张空白列表，读者会以为「任务本来就是 0 条」。</li>
 *   <li><b>文案点名端点与来源卡号</b>：`GET /api/v1/scheduled-tasks` + `task-10`。
 *       这两串是**下游找实现的唯一线索**，改文案时把卡号删掉就等于把线索剪断。</li>
 *   <li><b>不许出现伪装成品的措辞</b>：`加载中` / `暂无数据` 一律禁 —— 缺口要显式呈现，
 *       不用加载态或空态冒充「已经查过，结果是空的」。</li>
 * </ol>
 *
 * <p>产物口径与 `check-copy-leak.mjs` 的「接口路径」形态有张力：那条门只扫**渲染文本的 main 轴**
 * 且要求 `/api/v1/` 不得出现在面向用户的文案里。本页是**实例级诊断面**，端点名是判据的一部分，
 * 不是泄露（本轮无栈，门在无实例时 SKIP，属已知盲区，已在证据里写明）。</p>
 */
describe("ScheduledTasksOverviewView（task-11：数据面缺口的显式呈现）", () => {
    const mountPage = () => mount(ScheduledTasksOverviewView, { attachTo: document.body });

    it("缺口条真的渲染出来了，不是空白页", () => {
        const wrapper = mountPage();
        const notice = wrapper.find('[data-testid="scheduled-tasks-not-wired"]');
        expect(notice.exists()).toBe(true);
        // 页根也在：顶层路由页必须有 main landmark 与自持滚动容器。
        expect(wrapper.find('[data-testid="scheduled-tasks-page"]').exists()).toBe(true);
        wrapper.unmount();
    });

    it("文案点名端点 GET /api/v1/scheduled-tasks 与来源卡号 task-10", () => {
        const wrapper = mountPage();
        const text = wrapper.get('[data-testid="scheduled-tasks-not-wired"]').text();
        expect(text).toContain("GET /api/v1/scheduled-tasks");
        expect(text).toContain("task-10");
        wrapper.unmount();
    });

    it("不许用「加载中」「暂无数据」冒充成品", () => {
        const wrapper = mountPage();
        const rootText = wrapper.text();
        expect(rootText).not.toContain("加载中");
        expect(rootText).not.toContain("暂无数据");
        wrapper.unmount();
    });
});
