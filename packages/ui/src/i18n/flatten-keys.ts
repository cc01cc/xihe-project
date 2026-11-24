import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * task-1027 · 从按域拆分的 locale 模块里抽出**扁平键清单**（虚拟模块 `virtual:xihe-i18n-keys`）。
 *
 * <p>拆分后 `index.ts` 只剩聚合（对象展开），源文件里不再有字面量文案，所以不能再像
 * task-105 那样用 `new Function` 求值整个 `index.ts`（`export` 能剥，但无法解析 import）。
 * 改为：按 `index.ts` 的 import 顺序读取 `messages/<域>.ts`，逐域求值并合并 —— 合并顺序与
 * 拆分前的 `messages` 对象一致，因此扁平键清单**逐字节不变**（task-1027 的断言口径）。</p>
 *
 * <p>为什么仍用 `new Function`：这些域文件是纯对象字面量（无 import / 无运行时依赖），
 * 求值比手写 parser 更可靠，也与拆分前的做法同源。</p>
 */
export function flattenI18nKeys(i18nDir: string): string[] {
    const indexPath = path.join(i18nDir, "index.ts");
    const indexSource = readFileSync(indexPath, "utf8");
    const order = [...indexSource.matchAll(/from\s+"\.\/messages\/([^"]+)"/g)].map(
        (match) => match[1],
    );
    if (order.length === 0) {
        throw new Error(`[i18n] 聚合入口没有域导入：${indexPath}`);
    }

    const merged: Record<string, Record<string, unknown>> = {};
    for (const domain of order) {
        const source = readFileSync(path.join(i18nDir, "messages", `${domain}.ts`), "utf8");
        const body = source.replace(/\bexport\s+(const|let|var|function|class)\b/g, "$1");
        const mod = new Function(`${body}\nreturn messages;`)() as Record<string, unknown>;
        for (const [locale, subtree] of Object.entries(mod)) {
            merged[locale] ??= {};
            Object.assign(merged[locale], subtree as Record<string, unknown>);
        }
    }

    const keys: string[] = [];
    const walk = (node: unknown, prefix: string): void => {
        if (typeof node === "string") {
            if (prefix) keys.push(prefix);
            return;
        }
        if (node && typeof node === "object") {
            for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
                walk(value, prefix ? `${prefix}.${key}` : key);
            }
        }
    };
    // 逐 locale 展开（不能从 messages 顶层展开，否则键会带 `zh-CN.` 前缀）
    for (const localeMessages of Object.values(merged)) walk(localeMessages, "");
    return keys;
}
