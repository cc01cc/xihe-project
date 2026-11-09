import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { shallowMount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia } from "pinia";
import { describe, expect, it, vi } from "vitest";
import WorkspaceToolbar from "../features/workspace/components/WorkspaceToolbar.vue";

vi.mock("vue-router", async (importOriginal) => ({
    ...(await importOriginal<typeof import("vue-router")>()),
    useRouter: () => ({ push: vi.fn<() => void>() }),
}));

const SRC = resolve(process.cwd(), "src");
const i18n = createI18n({
    legacy: false,
    locale: "zh-CN",
    messages: {
        "zh-CN": {
            common: { closeSearch: "关闭搜索", closeTab: "关闭标签页" },
            files: { titleFiles: "文件" },
            nav: { open: "打开导航" },
            chat: { titleChat: "对话" },
            settings: { providerHub: { defaultPlaceholder: "如：default" } },
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

function isPreview(rel: string): boolean {
    return (
        rel === "preview" ||
        rel.startsWith("preview/") ||
        rel.startsWith("preview" + String.fromCharCode(92))
    );
}

describe("product title/placeholder literals (PLAN-0726)", () => {
    it("has no literal English placeholder/title in product .vue files (preview excluded)", () => {
        const offenders: string[] = [];
        for (const file of vueFiles(SRC)) {
            const rel = relative(SRC, file);
            if (isPreview(rel)) continue;
            const lines = readFileSync(file, "utf8").split(/\r?\n/);
            lines.forEach((line, index) => {
                const matches =
                    line.match(/(?<![:@\w-])(placeholder|title)="[A-Za-z][^"]*"/g) ?? [];
                for (const match of matches)
                    offenders.push(rel + ":" + (index + 1) + " -> " + match);
            });
        }
        expect(offenders).toEqual([]);
    });

    it("renders the localized file-tree title under zh-CN", () => {
        const wrapper = shallowMount(WorkspaceToolbar, {
            props: { workspaceId: "workspace-1" },
            global: { plugins: [i18n, createPinia()], stubs: { RouterLink: true } },
        });
        const filesButton = wrapper.find('[data-testid="workspace-toolbar-files-mobile"]');
        expect(filesButton.exists()).toBe(true);
        expect(filesButton.attributes("title")).toBe("文件");
    });
});
