/**
 * task-846 机械门 —— 核心面的错误文案不得直出原始异常 / 硬编码英文。
 *
 * <p>判据（合同 §3）：错误必须「可读文案 + 错误码」，英文 `Problem.detail` 只作诊断字段；
 * UI 文案走 i18n。用户主文案的唯一入口是 `lib/errorMessages.ts#presentCauseError` /
 * `causeErrorToastText`。</p>
 *
 * <p><b>覆盖四面</b>（task-846 要求至少 chat / members / settings / auth）：
 * chat = `features/workspace/chat/**`；members = `WorkspaceMembersPanel.vue`；
 * settings = `ConfigLayerPanels.vue` + `ConfigSettings.vue`；auth = `stores/auth.ts` +
 * `views/auth/**`。</p>
 *
 * <p><b>为什么门文件放在 chat 目录</b>：task-846 的写域是
 * `packages/ui/src/features/workspace/chat`，扫描面不限于本目录（只读其他文件）。
 * 白名单每条必须带 `reason + owner + reviewDate`，只减不增。</p>
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");

/** 四个核心面；每项是相对 `src/` 的文件或目录。 */
const FACE_ROOTS: Record<string, string[]> = {
    chat: ["features/workspace/chat"],
    members: ["features/workspace/components/WorkspaceMembersPanel.vue"],
    settings: ["components/settings/ConfigLayerPanels.vue", "views/settings/ConfigSettings.vue"],
    auth: ["stores/auth.ts", "views/auth"],
};

const SKIP_DIRS = new Set(["node_modules", "__tests__", "__poc__", "preview"]);

interface Rule {
    id: string;
    re: RegExp;
    why: string;
}

const RULES: Rule[] = [
    {
        id: "toast-raw-message",
        re: /toast\.(?:error|warning)\([^)]*\.message\b/,
        why: "toast 不得直接接 Error.message（原始/英文），应走 causeErrorToastText",
    },
    {
        id: "copy-raw-message",
        re: /\w*(?:[Ee]rror|[Mm]sg|[Mm]essage)\.value\s*=\s*[^;]*\.message\b/,
        why: "用户错误态不得直出 Error.message，应本地化文案 + 错误码",
    },
    {
        id: "ternary-raw-message",
        re: /\?\s*[\w$.?[\]]+\.message\b/,
        why: "三元分支不得把原始异常文本当文案",
    },
    {
        id: "nullish-raw-message",
        re: /\?\?\s*[\w$.?[\]]+\.message\b/,
        why: "空值合并不得把原始异常文本当文案",
    },
    {
        id: "stringified-error",
        re: /=\s*String\((?:err|cause|error|e|failure)\)/,
        why: "String(err) 是原始异常串，不能当用户文案",
    },
    {
        id: "english-copy-literal",
        re: /=\s*"(?:Failed to|Unable to|Workspace context is required|SSE connection error)/,
        why: "UI 不写死英文文案，走 i18n",
    },
    {
        id: "english-toast-literal",
        re: /toast\.(?:error|warning)\("(?:Failed to|Unable to|Error)/,
        why: "toast 文案走 i18n，不写死英文",
    },
    {
        id: "problem-detail-as-copy",
        re: /problemDetailText\(/,
        why: "problemDetailText 只允许诊断字段（errorDetail/technicalDetail），不得当用户主文案",
    },
];

/** 允许原样保留的**诊断字段**用法（不是用户主文案）。 */
const DIAGNOSTIC_LINE =
    /logger\.|^\s*(?:error|detail|reason|technicalDetail|errorDetail)\s*:|errorDetail|technicalDetail|problem\.detail|\.title\s*=/;

/** 多行 logger 载荷：命中行前 3 行内出现 `logger.` 也视为诊断。 */
const LOGGER_LOOKBACK = 3;

interface AllowlistEntry {
    file: string;
    match: string;
    reason: string;
    owner: string;
    reviewDate: string;
}

/**
 * 只减不增。当前为空：四个面已全部改走本地化入口。
 * 若确需新增，必须写清「为什么不是用户文案」，并带 owner + reviewDate。
 */
const ALLOWLIST: AllowlistEntry[] = [
    {
        file: "stores/auth.ts",
        match: "problemDetailText",
        reason: "登录/首装面把原始 detail 放进可展开的 errorDetail 诊断区（主文案已是 authErrors.*）",
        owner: "w2-errors-1",
        reviewDate: "2026-12-22",
    },
];

function walk(abs: string, out: string[]): void {
    const stat = statSync(abs);
    if (stat.isDirectory()) {
        for (const entry of readdirSync(abs)) {
            if (SKIP_DIRS.has(entry)) continue;
            walk(join(abs, entry), out);
        }
        return;
    }
    if (/\.(?:ts|vue)$/.test(abs)) out.push(abs);
}

function faceFiles(): string[] {
    const files: string[] = [];
    for (const roots of Object.values(FACE_ROOTS)) {
        for (const root of roots) walk(join(SRC, root), files);
    }
    return [...new Set(files)].sort();
}

function isAllowed(file: string, line: string): boolean {
    return ALLOWLIST.some((entry) => entry.file === file && line.includes(entry.match));
}

describe("task-846 核心面错误文案机械门", () => {
    it("每条规则都能命中一个已知反例（防止规则静默失效）", () => {
        const samples: Record<string, string> = {
            "toast-raw-message": "toast.error(e.message);",
            "copy-raw-message": "loadError.value = cause.message;",
            "ternary-raw-message": "const m = ok ? cause.message : t('x');",
            "nullish-raw-message": "const m = t('x') ?? cause.message;",
            "stringified-error": "loadError.value = String(err);",
            "english-copy-literal": 'loadError.value = "Failed to load workspace";',
            "english-toast-literal": 'toast.error("Failed to save");',
            "problem-detail-as-copy": "loadError.value = problemDetailText(cause, t('x'));",
        };
        for (const rule of RULES) expect(rule.re.test(samples[rule.id] as string)).toBe(true);
    });

    it("chat / members / settings / auth 不直出原始异常或硬编码英文", () => {
        const offenders: string[] = [];
        for (const abs of faceFiles()) {
            const file = relative(SRC, abs).replace(/\\/g, "/");
            const lines = readFileSync(abs, "utf8").split(/\r?\n/);
            lines.forEach((line, index) => {
                const inLoggerBlock = lines
                    .slice(Math.max(0, index - LOGGER_LOOKBACK), index + 1)
                    .some((prev) => prev.includes("logger."));
                if (DIAGNOSTIC_LINE.test(line) || inLoggerBlock) return;
                if (isAllowed(file, line)) return;
                for (const rule of RULES) {
                    if (!rule.re.test(line)) continue;
                    offenders.push(
                        `${file}:${index + 1} [${rule.id}] ${rule.why}\n    ${line.trim()}`,
                    );
                    break;
                }
            });
        }
        expect(offenders).toEqual([]);
    });

    it("白名单条目必须带 reason + owner + reviewDate（防止无主放行）", () => {
        for (const entry of ALLOWLIST) {
            expect(entry.reason.trim().length).toBeGreaterThan(0);
            expect(entry.owner.trim().length).toBeGreaterThan(0);
            expect(entry.reviewDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
    });

    it("causeErrorToastText / presentCauseError 的兜底必须走 t()（不写死文案）", () => {
        const offenders: string[] = [];
        for (const abs of faceFiles()) {
            const file = relative(SRC, abs).replace(/\\/g, "/");
            readFileSync(abs, "utf8")
                .split(/\r?\n/)
                .forEach((line, index) => {
                    const call =
                        /(?:causeErrorToastText|presentCauseError)\(\s*t\s*,[^,]+,\s*(.+)$/.exec(
                            line,
                        );
                    if (!call) return;
                    const fallback = call[1].trim();
                    // `"..."` / `'...'` 一律算写死；反引号只有 `${` 之前出现字母才算（纯 t() 拼接放行）。
                    const literalQuote = /^["']/.test(fallback);
                    const literalBacktick =
                        fallback.startsWith("`") && /[A-Za-z]/.test(fallback.split("${")[0] ?? "");
                    if (literalQuote || literalBacktick)
                        offenders.push(`${file}:${index + 1} literal fallback: ${line.trim()}`);
                });
        }
        expect(offenders).toEqual([]);
    });
});
