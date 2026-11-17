import { describe, expect, it } from "vitest";
import { i18n } from "../index";

/**
 * task-52 / batch-02（P1-2，`D-1703`）：**用量行的三段文案不得是内部标记**。
 *
 * <p>现象（截图 `.tmp/xh/b02-10-chat-full.png`）：中文界面底部读出 `in 3591 · out 8 未映射 real`。
 * 用户看到的 `未映射` 是 CP `UsageCostMapper` 的内部标记（`costSource="unmapped"`），
 * `real` 是 `source` 的 wire 枚举值 —— 两个都是**我们的实现词汇**，不是他的话。</p>
 *
 * <p><b>为什么扫 locale 树而不是逐个渲染断言</b>（同 `terminology.spec.ts` / `settingsCopyRules.spec.ts`
 * 的既有口径）：同一批文案会被多处消费（会话页读出、`title` 悬停说明、未来的移动端），
 * 逐个挂载只覆盖「今天想到的那几处」；扫树是**全集**判据，新增键自动纳入。
 * 扫描面**按命名空间前缀精确圈定**（`workspace.usage*` / `workspace.sessionDefaultTitle`），
 * 不做全树禁词 —— 全树扫会把 `fallback` 这类**命名空间名**（有子键、不是叶子值）一起误报。</p>
 *
 * <p><b>承重点（变异已实测）</b>：把 `workspace.usageCostUnmapped` 改回 `未映射` ⇒ 本文件第 1 条红；
 * 把 `usageSourceReal` 改回 `real` ⇒ 第 2 条红；把 `sessionDefaultTitle` 改回 `New Chat` ⇒ 第 3 条红。
 * 三条都点名了具体键，失败消息直接给出键路径。</p>
 *
 * <p>**刻意不钉的**：不校验译文措辞好不好（那是评审判断），只校验「不出现 wire 标记」这个
 * 可证伪的事实。译成「未定价」还是「暂无价格」都通过 —— 判据不该替设计定稿。</p>
 */
type Leaf = { path: string; value: string };

function leaves(node: unknown, path = ""): Leaf[] {
    if (typeof node === "string") return [{ path, value: node }];
    if (Array.isArray(node)) return node.flatMap((v, i) => leaves(v, `${path}[${i}]`));
    if (node && typeof node === "object") {
        return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
            leaves(v, path ? `${path}.${k}` : k),
        );
    }
    return [];
}

/**
 * 路径前缀匹配 = **键名前缀**，不是命名空间段。
 *
 * <p>踩过的坑（本 spec 第一版实证）：写成 `path === prefix || path.startsWith(prefix + ".")`
 * 时，`"workspace.usage"` **匹配不到** `"workspace.usageCostUnmapped"`，因为后者在 `usage`
 * 后面不是点 —— 结果是「用量键一个都没被扫」，断言空集合永远绿。**变异跑一次就露馅**：
 * 把 `usageCostUnmapped` 改回 `未映射`，旧写法仍然 5 passed。</p>
 */
function under(locale: "zh-CN" | "en-US", prefix: string): Leaf[] {
    return leaves(i18n.global.getLocaleMessage(locale)).filter((leaf) =>
        leaf.path.startsWith(prefix),
    );
}

const USAGE_PREFIX = "workspace.usage";

describe("task-52 ①：用量行文案不出现 wire 内部标记", () => {
    it("zh：用量行文案不含裸 未映射 / unmapped", () => {
        const offenders = under("zh-CN", USAGE_PREFIX)
            .filter((leaf) => /未映射|unmapped/i.test(leaf.value))
            .map((leaf) => `${leaf.path}: ${leaf.value}`);
        expect(offenders).toEqual([]);
    });

    it("zh：来源徽标不含裸 real / estimated / fallback 枚举值", () => {
        // 只查**来源徽标那三个键**：`usageSourceFallback` 的译文里允许出现「兜底」等中文，
        // 但不允许把 wire 值原样当文案（`real` 是 4 个字符的枚举，读者不知道它是什么）。
        const sourceKeys = new Set([
            "workspace.usageSourceReal",
            "workspace.usageSourceEstimated",
            "workspace.usageSourceFallback",
        ]);
        const offenders = leaves(i18n.global.getLocaleMessage("zh-CN"))
            .filter((leaf) => sourceKeys.has(leaf.path))
            .filter((leaf) => /^(real|estimated|fallback)$/i.test(leaf.value.trim()))
            .map((leaf) => `${leaf.path}: ${leaf.value}`);
        expect(offenders).toEqual([]);
    });

    it("en：用量行文案不含 unmapped 这个内部标记", () => {
        // **只查 `unmapped`**：`real / estimated / fallback` 在英文里本来就是正常单词
        // （"Estimated"、"Usage fallback" 读者看得懂），中文侧才是「英文枚举混进中文界面」。
        // 判据按语言分开写，不为了少写一行把英文也误伤 —— 那会逼译文改成别扭说法。
        const offenders = under("en-US", USAGE_PREFIX)
            .filter((leaf) => /unmapped/i.test(leaf.value))
            .map((leaf) => `${leaf.path}: ${leaf.value}`);
        expect(offenders).toEqual([]);
    });
});

describe("task-52 ②：新建会话的默认标题已本地化", () => {
    it("zh 默认标题不是英文占位（New Chat / Untitled）", () => {
        const leaf = under("zh-CN", "workspace.sessionDefaultTitle");
        expect(leaf, "workspace.sessionDefaultTitle 必须存在于 zh 树").toHaveLength(1);
        expect(/New Chat|Untitled/i.test(leaf[0].value)).toBe(false);
        // 也不能为空：空标题会让侧栏渲染出一行没有名字的会话项。
        expect(leaf[0].value.trim().length).toBeGreaterThan(0);
    });

    it("默认标题与页签回落文案是两个键（同名不同物的根因就在这里）", () => {
        // `tabChatFallback` = 页签占位「对话」，`sessionDefaultTitle` = 会话名。
        // 两者若被合并成一个键，侧栏会话项与页签又会同字 —— 本卡要修的正是这件事。
        expect(under("zh-CN", "workspace.sessionDefaultTitle")).toHaveLength(1);
        expect(under("zh-CN", "workspace.tabChatFallback")).toHaveLength(1);
        const [title] = under("zh-CN", "workspace.sessionDefaultTitle");
        const [fallback] = under("zh-CN", "workspace.tabChatFallback");
        expect(title.path).not.toBe(fallback.path);
        expect(title.value).not.toBe(fallback.value);
    });
});
