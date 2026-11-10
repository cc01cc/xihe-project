/**
 * PLAN-0753 M1 (F10, task-167 matrix): the single `escapeHtml`. CodeBlockToken and CodeBlock
 * used to carry byte-identical copies; they converge here. Escape order matters: `&` first so
 * the other four replacements are not double-escaped.
 */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
