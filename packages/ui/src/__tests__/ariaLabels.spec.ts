import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { describe, expect, it } from "vitest";
import MessageSearch from "../features/workspace/chat/components/MessageSearch.vue";
import EditorTabBar from "../features/workspace/components/EditorTabBar.vue";

const SRC = resolve(process.cwd(), "src");
const i18n = createI18n({
    legacy: false,
    locale: "zh-CN",
    messages: {
        "zh-CN": {
            common: {
                closeSearch: "关闭搜索",
                closeTab: "关闭标签页",
            },
        },
    },
});

function vueFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === "node_modules" ? [] : vueFiles(full);
        return entry.name.endsWith(".vue") ? [full] : [];
    });
}

describe("hardcoded English aria-labels (PLAN-0725)", () => {
    it("has no literal English aria-label left in product .vue files", () => {
        const offenders: string[] = [];
        for (const file of vueFiles(SRC)) {
            const text = readFileSync(file, "utf8");
            const matches = text.match(/(?<!:)\baria-label="[A-Za-z][^"]*"/g) ?? [];
            for (const match of matches) {
                offenders.push(relative(SRC, file) + " -> " + match);
            }
        }
        expect(offenders).toEqual([]);
    });

    it("renders the localized close-search label under zh-CN", () => {
        const wrapper = mount(MessageSearch, {
            props: { modelValue: "" },
            global: { plugins: [i18n] },
        });
        expect(wrapper.find("button").attributes("aria-label")).toBe("关闭搜索");
    });

    it("renders the localized close-tab label under zh-CN", () => {
        const wrapper = mount(EditorTabBar, {
            props: {
                openFiles: [{ path: "a.ts", name: "a.ts" }],
                activePath: "a.ts",
            },
            global: { plugins: [i18n] },
        });
        expect(wrapper.find("button").attributes("aria-label")).toBe("关闭标签页");
    });
});
