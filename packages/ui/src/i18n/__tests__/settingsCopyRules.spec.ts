import { describe, expect, it } from "vitest";
import { i18n } from "../index";

/**
 * task-509（T-02 / T-07）：**用户可见文案不得出现内部编号与实现标识**。
 *
 * <p>起因（task-507 选题表第 1 条）：左栏缺口徽标直出「后端缺口 G4」，悬停提示出现
 * `mcp_remote_servers` / `workspace_id` 这类表名列名；用户读到的不是能力缺失，而是
 * 「数据库长什么样」—— 后果是**永久误解**系统模型，且不会因为后续修好样式被挽回。</p>
 *
 * <p>判据为什么写成数据驱动（扫 locale 树）而不是逐个渲染断言：文案在 6 个组件里出现，
 * 逐个挂载只会覆盖「我今天想到的那几处」；扫树是**全集**判据，新增文案自动纳入。
 * 代价是它测的是 locale 值而不是最终 DOM —— 因此组件侧另有两条渲染断言（徽标文本 +
 * 提示 title），两侧都在。</p>
 *
 * <p>规则（全部可证伪，不看「好读不好读」）：<br>
 * ① 不出现 `G1…G9` 这类缺口编号；<br>
 * ② 不出现 snake_case 标识符（表名/列名/枚举值，如 `mcp_remote_servers`、`owner_type`）；<br>
 * ③ 不出现 D-/PLAN-/BL- 编号（内部决策号不属于用户界面）；<br>
 * ④ 不出现「缺口」这个内部概念词（用户语言是「暂不可用 / 尚未提供」）；<br>
 * ⑤（task-18 / 源 task-6 C-2）不出现数据模型词「配置键 / config key」——用户读到的是"这页有多少项已设置"，
 *    不需要知道它数的是 config key；<br>
 * ⑥（task-18 / 源 task-6 C-4）不出现 `namespace:atom` 形态的**能力位/原子标识**（`cap:instance:admin`）。
 *    注意口径：**点名动作原子**（`MANAGE_WORKSPACE_AGENTS` 这类 UPPER_SNAKE）是 AGENTS.md 允许的
 *    产品写法，不在本规则内；本规则只禁"小写命名空间:冒号段"这种 wire 内部标识。</p>
 */
type Flat = Array<{ path: string; value: string }>;

function flatten(node: unknown, prefix = ""): Flat {
    if (typeof node === "string") return [{ path: prefix, value: node }];
    if (node && typeof node === "object") {
        return Object.entries(node as Record<string, unknown>).flatMap(([key, child]) =>
            flatten(child, prefix ? prefix + "." + key : key),
        );
    }
    return [];
}

const LOCALES = ["zh-CN", "en-US"] as const;

/**
 * 扫描面 = **唯一覆盖路径**。task-26（批 1）把 `resources` 纳入，并**同批删掉** task-22 的
 * `OUTSIDE_SETTINGS_KEYS` 精确名单（**2 条 → 0 条**，机制退役）：同一 key 不允许两套覆盖，
 * 第二份判据必然漂。后续批次（workspace / orgMembers）直接往这里加命名空间，不回名单。
 *
 * <p>Lead 硬要求（判据③）：名单删掉后把 `resources.reasonCapability` 改回旧文案，门**仍红**
 * ⇒ 守它的是扫描面而不是名单。变异实测见 `internal/A03-xihe/evidence/2026-11-15-226-next-batch-candidates/task-26-impl.md`。</p>
 */
// 扫描面全集（加命名空间请改这一行 + 在 README/证据里同步）：
// settings / resources / workspace / orgMembers —— 批 1 resources（task-26）、
// 批 2 workspace（task-36）、批 3 orgMembers（task-47）。
// 纪律：任何命名空间进来之前，必须先把它名下命中清到 0（批内全绿）；进来后不许再为同一 key 立精确名单。
const SCANNED_NAMESPACES = ["settings", "resources", "workspace", "orgMembers"] as const;

function scannedCopy(locale: (typeof LOCALES)[number]): Flat {
    const message = i18n.global.getLocaleMessage(locale) as Record<string, unknown>;
    return SCANNED_NAMESPACES.flatMap((ns) => flatten(message[ns], ns));
}

const RULES: Array<{ name: string; test: (value: string) => boolean; sample: string }> = [
    { name: "缺口编号 G1…G9", test: (v) => /\bG\d\b/.test(v), sample: "后端缺口 G4" },
    {
        name: "snake_case 标识符（表名/列名/枚举值）",
        test: (v) => /[a-z][a-z0-9]*_[a-z0-9_]+/.test(v),
        sample: "mcp_remote_servers 的 workspace_id",
    },
    {
        name: "内部编号 D-/PLAN-/BL-",
        test: (v) => /\b(D|PLAN|BL)-\d{2,5}\b/.test(v),
        sample: "D-951 排期",
    },
    {
        name: "内部概念词「缺口」",
        test: (v) => /缺口/.test(v) || /\bbackend gap\b/i.test(v),
        sample: "后端缺口",
    },
    // task-18（C-2）：数据模型词。负数保护：`config key` 允许出现在**代码注释**里（本文件不扫源码），
    // 只禁用户可见文案；`配置键` 三个字在设置文案树里一律算违规。
    {
        name: "数据模型词「配置键 / config key」",
        test: (v) => /配置键/.test(v) || /\bconfig keys?\b/i.test(v),
        sample: "本域 3 个配置键",
    },
    // task-18（C-4）：`namespace:atom` 形态的内部标识（`cap:instance:admin`）。
    // 刻意不匹配 URL 与时间：冒号后必须紧跟小写字母才起判，`https://…` 的冒号后是 `//` ⇒ 不命中；
    // `10:30` 的冒号前不是字母 ⇒ 不命中。UPPER_SNAKE 的动作原子（AGENTS.md 允许点名）也不命中。
    {
        name: "能力位/原子标识（namespace:atom）",
        test: (v) => /(?<![\w.:/-])[a-z][a-z0-9-]*(?::[a-z][a-z0-9_-]*)+(?![\w/])/.test(v),
        sample: "cap:instance:admin",
    },
    // task-26（批 1）：层名 SSOT = 「个人层 / Personal layer」（task-251 / D-1043）。
    // 「用户层 / user layer」是同一层的第三个名字 —— 同层两名会让用户以为是两层。
    // 与 terminology.spec 的分工：那边钉**正向等值**（那两个键必须等于「个人层」），
    // 本条是**全集负向**（扫描面内任何键都不许出现旧称）；两者方向相同，不是两套判据。
    {
        name: "层名旧称「用户层 / user layer」",
        test: (v) => /用户层/.test(v) || /\buser layers?\b/i.test(v),
        sample: "实例层与用户层都不提供",
    },
];

describe("设置区 + 资源区用户可见文案：不得出现内部编号与实现标识（task-509 / task-26）", () => {
    for (const locale of LOCALES) {
        describe(locale, () => {
            const copy = scannedCopy(locale);
            // 扫描面自身不许空转：命名空间被改名/删除时 flatten 会静默返回 []，
            // 门看起来全绿其实什么都没扫 —— 这条是「改名即红」在命名空间级的等价物。
            it("扫描面内每个命名空间都真的有文案（防静默空扫）", () => {
                const message = i18n.global.getLocaleMessage(locale) as Record<string, unknown>;
                for (const ns of SCANNED_NAMESPACES) {
                    expect(
                        flatten(message[ns], ns).length,
                        `命名空间 ${ns} 在 ${locale} 下为空：改名就要同步改 SCANNED_NAMESPACES`,
                    ).toBeGreaterThan(0);
                }
            });
            for (const rule of RULES) {
                it(`不含${rule.name}`, () => {
                    const offenders = copy
                        .filter((entry) => rule.test(entry.value))
                        .map((entry) => entry.path + " = " + JSON.stringify(entry.value));
                    // 失败信息给「键路径 + 原文」，不写"有违规" —— 否则还得自己 grep 一遍。
                    expect(offenders, `示例违规形态：${rule.sample}`).toEqual([]);
                });
            }
        });
    }
});

/**
 * 退役留痕（task-26 批 1 → task-36 批 2）：`OUTSIDE_SETTINGS_KEYS` 精确 key 名单**已整块删除**。
 *
 * <p>演进：task-22 有 2 条（`resources.reasonCapability` / `resources.reasonNoWorkspace`）
 * → 批 1 纳入 `resources` 命名空间后删到 1 条（只剩 `workspace.resourcesRefHint`，那是
 * **过渡项不是残留**：层名已改，但 workspace 还有 4 条存量，一次纳入会当场红）
 * → 批 2 纳入 `workspace` 并清掉那 4 条存量后，**这最后 1 条同批删掉**（1 → 0）。</p>
 *
 * <p>**为什么整块删而不是留着**：全集扫描严格强于精确名单（改名/新增键自动纳入），
 * 留着就是同一 key 两套覆盖 —— 而两套覆盖里更弱的那套会先说话。</p>
 *
 * <p>**「删了谁在守」由变异回答，不靠注释声明**（两批各证一次）：</p>
 * <ul>
 *   <li>批 1：名单已无 resources 项，把 `resources.reasonCapability` 改回带 `instance:admin`
 *       的旧文案 ⇒ 本文件**仍然红**（规则⑥）。</li>
 *   <li>批 2：名单**已完全清空**，把 `workspace.resourcesRefHint` 改回「用户层」⇒ 本文件
 *       **仍然红**（规则⑦）⇒ 它现在靠**扫描面**守，不是靠名单守。这条是批 2 的核心判据：
 *       否则「名单清空」可能只是把门从扫描面偷偷换回名单，门变弱而读数变好看。</li>
 * </ul>
 *
 * <p>纪律不变：任何命名空间进入 `SCANNED_NAMESPACES` 前，必须先把它名下命中清到 0（批内全绿）；
 * 进去后不许再为同一 key 另立精确名单。</p>
 */
