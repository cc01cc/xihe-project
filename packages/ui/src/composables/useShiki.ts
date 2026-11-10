import { logger } from "@/lib/logger";

/**
 * PLAN-0753 M1 (F1/F2/F3, task-167 render matrix): one lazy shiki singleton for the whole app.
 *
 * - **F1**: `createHighlighter()` used to run per code block per content change, reloading 15
 *   grammars + 2 themes every time. The singleton loads once; every block reuses the instance.
 * - **F2**: both app themes are registered and every highlight carries BOTH palettes as CSS
 *   custom properties (`defaultColor: false`), so which palette paints follows the document
 *   scheme (Tailwind `dark` class on `<html>`; see `styles/main.css`) instead of a pinned
 *   theme name. The theme ids below are shiki grammar ids, not a second design language — the
 *   selection is CSS-driven and never hardcoded at the call site.
 * - **F3**: this composable is the single highlight path for streaming and final states alike;
 *   the per-token highlight.js branch is gone. highlight.js itself stays in package.json
 *   untouched (design #5: a later @git-diff-view adoption would reuse it as one copy).
 */
const PRELOADED_LANGS = [
    "typescript",
    "javascript",
    "python",
    "html",
    "css",
    "json",
    "yaml",
    "bash",
    "shell",
    "sql",
    "markdown",
    "xml",
    "vue",
    "jsx",
    "tsx",
] as const;

const LIGHT_THEME = "github-light";
const DARK_THEME = "github-dark";

type ShikiHighlighter = Awaited<ReturnType<(typeof import("shiki"))["createHighlighter"]>>;

let singleton: Promise<ShikiHighlighter> | null = null;
const loadedLangs = new Set<string>(PRELOADED_LANGS);

/** Map the loose language tags that reach the chat surface onto shiki grammar ids. */
function normalizeLang(raw: string): string {
    const lang = (raw ?? "").trim().toLowerCase();
    if (!lang || lang === "text" || lang === "plain" || lang === "plaintext") return "text";
    if (lang === "sh" || lang === "zsh" || lang === "shellscript") return "bash";
    if (lang === "yml") return "yaml";
    if (lang === "htm") return "html";
    return lang;
}

async function getHighlighter(): Promise<ShikiHighlighter> {
    // A failed creation resets the slot so a transient failure is retryable instead of
    // poisoning every later code block with a cached rejection.
    singleton ??= (async () => {
        const { createHighlighter } = await import("shiki");
        return createHighlighter({
            themes: [LIGHT_THEME, DARK_THEME],
            langs: [...PRELOADED_LANGS],
        });
    })().catch((error: unknown) => {
        singleton = null;
        throw error;
    });
    return singleton;
}

/**
 * Highlight one code block with the shared singleton.
 *
 * @returns shiki HTML with both theme palettes as CSS variables, or `null` when highlighting
 * failed (unknown grammar, shiki unavailable) — the caller falls back to escaped plain text.
 */
export async function highlightCodeBlock(code: string, langRaw: string): Promise<string | null> {
    try {
        const lang = normalizeLang(langRaw);
        const highlighter = await getHighlighter();
        // Grammars outside the preloaded set load on demand (single instance, cached for good),
        // so languages the old highlight.js auto-detect covered keep working under one engine.
        if (lang !== "text" && !loadedLangs.has(lang)) {
            await highlighter.loadLanguage(lang as Parameters<ShikiHighlighter["loadLanguage"]>[0]);
            loadedLangs.add(lang);
        }
        return highlighter.codeToHtml(code, {
            lang: lang as Parameters<ShikiHighlighter["codeToHtml"]>[1] extends never
                ? never
                : string,
            themes: { light: LIGHT_THEME, dark: DARK_THEME },
            defaultColor: false,
        });
    } catch (error) {
        logger.warn("shiki highlight failed; falling back to escaped plain text", error);
        return null;
    }
}
