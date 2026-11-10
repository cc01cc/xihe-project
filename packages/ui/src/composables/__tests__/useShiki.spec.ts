import { describe, it, expect, vi, beforeEach } from "vitest";

// PLAN-0753 M1 (F1/F2/F3): the singleton contract of the shared shiki composable.
interface FakeHighlighter {
    codeToHtml: (code: string, options?: Record<string, unknown>) => string;
    loadLanguage: (lang: string) => Promise<void>;
}
const codeToHtml = vi.fn<() => string>(
    () => '<pre class="shiki"><code><span>ok</span></code></pre>',
);
const loadLanguage = vi.fn<(lang: string) => Promise<void>>(async () => undefined);
const createHighlighter = vi.fn<() => Promise<FakeHighlighter>>(async () => ({
    codeToHtml,
    loadLanguage,
}));

vi.mock("shiki", () => ({
    createHighlighter: (...args: unknown[]) => createHighlighter(...(args as [])),
}));

describe("useShiki", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        loadLanguage.mockImplementation(async () => undefined);
        codeToHtml.mockImplementation(
            () => '<pre class="shiki"><code><span>ok</span></code></pre>',
        );
        createHighlighter.mockImplementation(async () => ({ codeToHtml, loadLanguage }));
    });

    async function fresh() {
        vi.resetModules();
        return await import("@/composables/useShiki");
    }

    it("F1: creates the highlighter once across consecutive calls (singleton)", async () => {
        const { highlightCodeBlock } = await fresh();
        await highlightCodeBlock("const a = 1", "typescript");
        await highlightCodeBlock("const b = 2", "typescript");
        await highlightCodeBlock("print(1)", "python");
        expect(createHighlighter).toHaveBeenCalledTimes(1);
    });

    it("F2: highlights with BOTH palettes and no pinned default color", async () => {
        const { highlightCodeBlock } = await fresh();
        await highlightCodeBlock("const a = 1", "typescript");
        expect(codeToHtml).toHaveBeenCalledWith(
            "const a = 1",
            expect.objectContaining({
                lang: "typescript",
                themes: { light: "github-light", dark: "github-dark" },
                defaultColor: false,
            }),
        );
    });

    it("F3: loose language tags normalize onto shiki grammars", async () => {
        const { highlightCodeBlock } = await fresh();
        await highlightCodeBlock("echo hi", "sh");
        expect(codeToHtml).toHaveBeenLastCalledWith(
            "echo hi",
            expect.objectContaining({ lang: "bash" }),
        );
        await highlightCodeBlock("key: value", "yml");
        expect(codeToHtml).toHaveBeenLastCalledWith(
            "key: value",
            expect.objectContaining({ lang: "yaml" }),
        );
    });

    it("returns null (escape fallback) when the grammar cannot load", async () => {
        const { highlightCodeBlock } = await fresh();
        loadLanguage.mockImplementation(async (lang: string) => {
            if (lang === "notalang") throw new Error("Unknown language: notalang");
        });
        await expect(highlightCodeBlock("x", "notalang")).resolves.toBeNull();
        await expect(highlightCodeBlock("x", "notalang")).resolves.toBeNull();
        // A grammar that does load must not be affected by the failure path.
        await expect(highlightCodeBlock("x", "typescript")).resolves.toContain("ok");
    });

    it("returns null and remains retryable when highlighter creation fails", async () => {
        const { highlightCodeBlock } = await fresh();
        createHighlighter.mockImplementationOnce(async () => {
            throw new Error("shiki unavailable");
        });
        await expect(highlightCodeBlock("x", "typescript")).resolves.toBeNull();
        // The failed creation must not poison the slot: the next call retries creation.
        await expect(highlightCodeBlock("x", "typescript")).resolves.toContain("ok");
        expect(createHighlighter).toHaveBeenCalledTimes(2);
    });
});
