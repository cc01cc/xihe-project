import { mount } from "@vue/test-utils";
import { computed, defineComponent, h, ref } from "vue";
import { provideSidebarContext } from "@/components/ui/sidebar/utils";

/**
 * task-509（T-02 / T-07）：缺口条目的**渲染结果**里不得出现内部编号与实现标识。
 *
 * <p>为什么不能只靠 locale 树断言（`src/i18n/__tests__/settingsCopyRules.spec.ts`）：
 * 「后端缺口 G4」里的 `G4` **不是 locale 里的字面量**，而是 `t("settings.ia.backendGapBadge",
 * { code })` 的插值产物 ⇒ 扫 locale 树永远扫不到它（第一版就是这样漏的，红是绿的）。
 * 这条用例钉的是**用户实际读到的字符串**：徽标文本 + `title` 提示。</p>
 *
 * <p>同时钉两件不许被顺手删掉的东西：`data-gap-codes` 仍保留（调试与 e2e 靠它判断"缺口是哪一类"），
 * 缺口项仍**留在列表里**（D7：留位不隐藏）。</p>
 */
/*
 * 用**生产 locale** 而不是局部夹具：本条用例判的正是真文案（夹具里写一份"干净文案"会让
 * 它永远绿）。附带好处：仓库的「渲染结果不许出现裸 i18n 键」兜底守卫（`test-utils/i18nKeys.ts`）
 * 在这里也顺带生效 —— 以前局部夹具缺键会被它判红，那种红指向夹具而不是产品。
 */
import { i18n } from "../../../i18n";
i18n.global.locale.value = "zh-CN";

import type { ResourceNavItem } from "../../../lib/settingsIa";
import SettingsResourceNav from "../SettingsResourceNav.vue";

const GAP_ITEM: ResourceNavItem = {
    id: "knowledge",
    labelKey: "settings.ia.resourceKnowledge",
    gaps: ["G3"],
    gapNoteKey: "settings.ia.gapNoteKnowledge",
};
const LINK_ITEM: ResourceNavItem = {
    id: "mcp",
    labelKey: "settings.ia.resourceMcp",
    path: "/resources/mcp",
};

function mountNav(items: ResourceNavItem[]) {
    const Host = defineComponent({
        setup() {
            const open = ref(true);
            provideSidebarContext({
                state: computed(() => (open.value ? "expanded" : "collapsed")),
                open,
                setOpen: (value: boolean) => {
                    open.value = value;
                },
                isMobile: ref(false),
                openMobile: ref(false),
                setOpenMobile: () => {},
                toggleSidebar: () => {
                    open.value = !open.value;
                },
            });
            return () =>
                h(SettingsResourceNav, {
                    groupLabelKey: "settings.ia.groupInstanceResources",
                    items,
                });
        },
    });
    return mount(Host, {
        global: {
            plugins: [i18n],
            stubs: { RouterLink: { template: "<a><slot /></a>" } },
        },
    });
}

/** 用户真正读到的字符集合：可见文本 + title（title 是悬停才出现，仍属"用户可见"）。 */
function visibleStrings(root: ReturnType<typeof mountNav>): string[] {
    const entry = root.find('[data-testid="settings-nav-resource-gap-knowledge"]');
    return [entry.text(), entry.attributes("title") ?? ""];
}

describe("SettingsResourceNav 缺口条目：用户可见文本不含内部编号/实现标识（task-509）", () => {
    it("缺口条目留在列表里且保留 data-gap-codes（D7 留位不隐藏）", () => {
        const wrapper = mountNav([GAP_ITEM, LINK_ITEM]);
        const entry = wrapper.find('[data-testid="settings-nav-resource-gap-knowledge"]');
        expect(entry.exists()).toBe(true);
        expect(entry.attributes("data-gap-codes")).toBe("G3");
    });

    it("徽标与 title 都不出现缺口编号 G3", () => {
        const wrapper = mountNav([GAP_ITEM, LINK_ITEM]);
        const offenders = visibleStrings(wrapper).filter((text) => /\bG\d\b/.test(text));
        expect(offenders).toEqual([]);
    });

    it("徽标与 title 都不出现表名/列名（snake_case）", () => {
        const wrapper = mountNav([GAP_ITEM, LINK_ITEM]);
        const offenders = visibleStrings(wrapper).filter((text) =>
            /[a-z][a-z0-9]*_[a-z0-9_]+/.test(text),
        );
        expect(offenders).toEqual([]);
    });

    it("徽标与 title 都不出现内部概念词「缺口」", () => {
        const wrapper = mountNav([GAP_ITEM, LINK_ITEM]);
        const offenders = visibleStrings(wrapper).filter((text) => /缺口/.test(text));
        expect(offenders).toEqual([]);
    });
});
