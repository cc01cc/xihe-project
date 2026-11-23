import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import FileTree from "../FileTree.vue";
import { i18n } from "../../../../i18n";
import { useWorkspaceStore } from "../../stores/workspace";
import type { FileNode } from "../../../../types";
import type { ApiNestedRepoItem } from "../../../../composables/api";

/**
 * task-939（R76，用户 2026-11-24 实拍批注）—— 文件树**行内**的两件事：
 *
 *   ① 展开控件：改前是 `▼`/`▶` 文本字符，于是 treeitem 的可访问名是「▶ repo-a」，
 *      屏幕阅读器念出一个三角形而不是「已折叠」。现在是 `@lucide/vue` 图标（`aria-hidden`）
 *      + 行按钮上的 `aria-expanded`。
 *   ② 未声明的嵌套 Git 仓库：改前是面板顶部两张全宽卡片；现在是**树内节点操作**
 *      （未声明节点带类型徽标 + 行内「纳入快照」两步确认），已声明的不再出现。
 *
 * 挂产品组件（`FileTree` = reka `Tree` + `TreeNodeList`），与
 * `__tests__/d1234TreeVisibility.spec.ts` 同一口径：挂死组件的判据证明不了页面。
 */

vi.mock("../../../../stores/auth", () => ({
    useAuthStore: () => ({
        workspace: { id: "ws-test", hostPath: "H:/mock/ws" },
        currentWorkspaceId: "ws-test",
        canWriteWorkspace: true,
    }),
}));

const dir = (name: string, children: FileNode[] = []): FileNode => ({
    name,
    path: name,
    type: "directory",
    children,
});

const TREE: FileNode[] = [
    dir("plain-dir", [dir("inner")]),
    dir("repo-a", [
        dir("src", [{ name: "a.ts", path: "repo-a/src/a.ts", type: "file" }]),
        { name: "readme.md", path: "repo-a/readme.md", type: "file" },
    ]),
    dir("repo-b"),
];

const REPOS: ApiNestedRepoItem[] = [
    { path: "repo-a", type: "nested", declared: false },
    { path: "repo-b", type: "gitdir", declared: false },
    { path: "plain-dir", type: "nested", declared: true },
];

function mountTree(
    options: {
        nestedRepos?: ApiNestedRepoItem[];
        canDeclare?: boolean;
        declaring?: boolean;
    } = {},
) {
    return mount(FileTree, {
        props: {
            nodes: TREE,
            nestedRepos: options.nestedRepos ?? [],
            nestedRepoCanDeclare: options.canDeclare ?? true,
            nestedRepoDeclaring: options.declaring ?? false,
        },
        global: { plugins: [i18n] },
    });
}

beforeEach(() => {
    setActivePinia(createPinia());
    useWorkspaceStore().expandedPaths = new Set<string>();
});

describe("task-939 ①：展开控件必须是 aria-expanded，不得把箭头念出来", () => {
    it("目录行带 aria-expanded，文件行不带（文件永远没有子项）", () => {
        const wrapper = mountTree();
        const buttons = wrapper.findAll("button");
        const dirButtons = buttons.filter((button) =>
            ["plain-dir", "repo-a", "repo-b"].includes(button.text().trim()),
        );
        // 三个顶层目录都必须在默认折叠下带 aria-expanded=false。
        expect(dirButtons).toHaveLength(3);
        for (const row of dirButtons) {
            expect(row.attributes("aria-expanded"), row.text()).toBe("false");
        }
    });

    it("展开后的子目录同样带 aria-expanded；文件行没有该属性", async () => {
        const wrapper = mountTree();
        const repoRow = wrapper
            .findAll("button")
            .find((button) => button.text().trim() === "repo-a");
        await repoRow!.trigger("click");

        // 文件行没有该属性（不是 false，否则读屏会说"可折叠的文件"）。
        const fileRow = wrapper
            .findAll("button")
            .find((button) => button.text().includes("readme.md"));
        expect(fileRow).toBeDefined();
        expect(fileRow!.attributes("aria-expanded")).toBeUndefined();
        // 同层的子目录必须有，且默认折叠。
        const innerDir = wrapper
            .findAll("button[aria-expanded]")
            .find((button) => button.text().trim() === "src");
        expect(innerDir).toBeDefined();
        expect(innerDir!.attributes("aria-expanded")).toBe("false");
    });

    it("可访问名里不再出现 ▼/▶ 字形", () => {
        const wrapper = mountTree();
        const names = wrapper.findAll("button").map((button) => button.text());
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) {
            expect(name).not.toContain("\u25bc");
            expect(name).not.toContain("\u25b6");
        }
    });

    it("展开后 aria-expanded 翻成 true，箭头是装饰（svg 带 aria-hidden）", async () => {
        const wrapper = mountTree();
        const row = wrapper.findAll("button").find((button) => button.text().trim() === "repo-a");
        expect(row).toBeDefined();
        await row!.trigger("click");

        const expanded = wrapper
            .findAll("button[aria-expanded]")
            .find((button) => button.text().includes("repo-a"));
        expect(expanded?.attributes("aria-expanded")).toBe("true");
        const chevron = row!.element.querySelector("svg");
        expect(chevron?.getAttribute("aria-hidden")).toBe("true");
    });
});

describe("task-939 ②：嵌套仓声明是树内节点操作，不是顶部卡片", () => {
    it("未声明节点带类型徽标 + 行内入口；已声明的不出现", () => {
        const wrapper = mountTree({ nestedRepos: REPOS });
        const badges = wrapper.findAll('[data-testid="nested-repo-type"]');
        expect(badges).toHaveLength(2);
        expect(badges.map((badge) => badge.text())).toEqual(["独立 Git 仓库", "关联工作副本"]);
        const entries = wrapper.findAll('[data-testid="nested-repo-declare"]');
        expect(entries).toHaveLength(2);
        expect(entries[0].text()).toBe("纳入快照");
        // 徽标/入口挂在**那一行**上：与行按钮同处一个行容器。
        const rowHost = entries[0].element.parentElement;
        expect(rowHost?.textContent).toContain("repo-a");
    });

    it("入口是两步确认：第一次点击只展开确认，不 POST 任何东西", async () => {
        const wrapper = mountTree({ nestedRepos: REPOS });
        const entry = wrapper.get('[data-testid="nested-repo-declare"]');
        await entry.trigger("click");

        expect(wrapper.find('[data-testid="nested-repo-confirm"]').exists()).toBe(true);
        expect(wrapper.emitted("declare-nested-repo")).toBeUndefined();

        await wrapper.get('[data-testid="nested-repo-declare-confirm"]').trigger("click");
        expect(wrapper.emitted("declare-nested-repo")).toEqual([["repo-a"]]);
        // 确认态**不收起**：失败要能原地重试；成功时该 repo 从发现列表消失 ⇒ 入口整块不渲染。
        expect(wrapper.find('[data-testid="nested-repo-confirm"]').exists()).toBe(true);
    });

    it("申报成功后（发现列表不再返回该 repo）整块入口消失", async () => {
        const wrapper = mountTree({ nestedRepos: REPOS });
        await wrapper.get('[data-testid="nested-repo-declare"]').trigger("click");
        await wrapper.get('[data-testid="nested-repo-declare-confirm"]').trigger("click");
        await wrapper.setProps({ nestedRepos: [{ ...REPOS[0], declared: true }] });
        expect(wrapper.find('[data-testid="nested-repo-confirm"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="nested-repo-declare"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="nested-repo-type"]').exists()).toBe(false);
    });

    it("取消不申报；写权限关闭时入口置灰但仍可见", async () => {
        const wrapper = mountTree({ nestedRepos: REPOS });
        await wrapper.get('[data-testid="nested-repo-declare"]').trigger("click");
        await wrapper.get('[data-testid="nested-repo-declare-cancel"]').trigger("click");
        expect(wrapper.emitted("declare-nested-repo")).toBeUndefined();
        expect(wrapper.find('[data-testid="nested-repo-confirm"]').exists()).toBe(false);

        const readOnly = mountTree({ nestedRepos: REPOS, canDeclare: false });
        const greyed = readOnly.get('[data-testid="nested-repo-declare"]');
        expect(greyed.attributes("disabled")).toBeDefined();
        await greyed.trigger("click");
        expect(readOnly.emitted("declare-nested-repo")).toBeUndefined();
    });

    it("在途申报时所有行内入口置灰（防重复 POST）", () => {
        const wrapper = mountTree({ nestedRepos: REPOS, declaring: true });
        for (const entry of wrapper.findAll('[data-testid="nested-repo-declare"]')) {
            expect(entry.attributes("disabled")).toBeDefined();
        }
    });

    it("不可申报的类型（子模块/符号链接/裸库）只留徽标，不给入口", () => {
        const wrapper = mountTree({
            nestedRepos: [
                { path: "plain-dir", type: "submodule", declared: false },
                { path: "repo-a", type: "symlink", declared: false },
                { path: "repo-b", type: "bare", declared: false },
            ],
        });
        expect(wrapper.findAll('[data-testid="nested-repo-type"]')).toHaveLength(3);
        expect(wrapper.findAll('[data-testid="nested-repo-declare"]')).toHaveLength(0);
    });

    it("没有发现项时树照常渲染，行内不出现任何声明控件（发现是咨询性的）", () => {
        const wrapper = mountTree();
        expect(wrapper.findAll('[role="treeitem"]').length).toBeGreaterThan(0);
        expect(wrapper.find('[data-testid="nested-repo-type"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="nested-repo-declare"]').exists()).toBe(false);
    });

    it("内部术语不出屏：行内文案不得写「声明为根 / 嵌套仓」", () => {
        const wrapper = mountTree({ nestedRepos: REPOS });
        const text = wrapper.text();
        expect(text).not.toContain("声明为根");
        expect(text).not.toContain("嵌套仓");
        expect(text).not.toContain("Declare as root");
    });
});
