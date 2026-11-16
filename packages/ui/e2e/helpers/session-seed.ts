import type { Page } from "@playwright/test";

/**
 * 会话状态种子的**唯一实现**（task-95 ①）。
 *
 * <p>为什么要有这个文件：此前「让一个浏览器上下文处于『已登录 + 指定工作区』状态」这件事
 * 在 `packages/ui/e2e` 里有 **220 处写入点 / 85 个文件**（`token` 108 处、`user` 87 处、
 * `workspace` 95 处 —— 跨行稳健计数，2026-11-16 实测）。同一件事有多份实现，
 * 各自会漂，而**漂了不报错**：</p>
 *
 * <ul>
 *   <li>`mock/task83-ui-audit.spec.ts` 只种了主题键、**从不种登录态** ⇒ 整份 spec 被登录页
 *       拦走（ui-9 报的那条红）。</li>
 *   <li>12 个文件写 `xihe-token` 却从不写 `xihe-user` ⇒ 半个会话。按 task-224 档 3
 *       （`router/index.ts:604`）这种会话**应当停在 `/login`**，于是「想验已登录页面」
 *       的用例实际验的是「被拦在登录页」。`auth-flows.spec.ts:62` 就曾因此假红。</li>
 * </ul>
 *
 * <p>关键设计取舍（三条，都写在这里以免下次被「简化」掉）：</p>
 *
 * <ol>
 *   <li><b>`user` 可选，但省略必须是**显式**的</b>：半会话是**合法被测形态**
 *       （`auth-flows` 与 `plan0772-login-entry` 都在验它），所以不能做成必填；
 *       但默认值也**不能是「静默什么都不种」** —— 那正是今天这个坑。故用
 *       `halfSession: true` 判别式把「有意半会话」与「忘了种」区分开，编译期强制。</li>
 *   <li><b>主题键也收进来</b>：task83 那条红的真因就是「只种主题、没种登录态」。
 *       若种子只管 auth、不管 theme，下次就是「种了登录态、忘了主题」—— 同一个坑换个方向。
 *       判据是「让页面处于某个**已知 UI 状态**」这件事只有一处实现，主题属于它。</li>
 *   <li><b>与 CLI 不互相 import</b>：CLI 是 Node 侧（产出令牌、存文件），本模块是浏览器侧
 *       （把状态装进 localStorage/sessionStorage）。唯一来源落在**状态形状**上，
 *       而不是把 CLI 硬塞进 e2e 包 —— 两端各自演进，形状由这里单点定义。</li>
 * </ol>
 *
 * <p><b>编码形态是有坑的，别照抄直觉</b>（`src/stores/settings.ts:21-56` 为权威）：</p>
 *
 * <ul>
 *   <li>`xihe-theme` / `xihe-language`：**规范形态是裸值**（`dark` 而非 `"dark"`）。
 *       JSON 引号形态是历史兼容项（`parseStoredTheme` 能读，且 boot 时会被迁移回裸值）。
 *       本模块写**规范形态**；写旧形态不会立刻坏，但会让「同一件事两种形态」继续存在。</li>
 *   <li>`xihe-user` / `xihe-workspace`：**JSON**（对象序列化）。</li>
 *   <li>`xihe-workspace` 有**两个存储位置**：`sessionStorage` 是 PLAN-0559 之后的逐 tab
 *       权威值，`localStorage` 是迁移来源。只写 localStorage 时页面仍会走迁移/回退分支。</li>
 * </ul>
 */

/** 承载「已登录 + 指定工作区」的全部存储键。改这里 = 改全仓的种子形状。 */
export const SESSION_STORAGE_KEYS = {
    token: "xihe-token",
    user: "xihe-user",
    workspace: "xihe-workspace",
    theme: "xihe-theme",
    language: "xihe-language",
} as const;

export type SessionStorageKey = (typeof SESSION_STORAGE_KEYS)[keyof typeof SESSION_STORAGE_KEYS];

/** `[key, rawValue]` 对；`rawValue` 是**已经序列化好**的落盘字符串。 */
export type SeedEntry = [string, string];

/**
 * 种子的**纯数据**形态：把「浏览器里该有什么」表述成键值对，而不是一段 addInitScript 代码。
 *
 * <p>这样做的两个好处：① 可在 Node 侧断言（不需要浏览器就能验形状）；
 * ② 形状是数据 ⇒ 将来 CLI 或别的驱动面要复用同一份形状时，不必 import Playwright。</p>
 */
export interface SessionSeedPayload {
    localStorage: SeedEntry[];
    sessionStorage: SeedEntry[];
}

interface SessionSeedBase {
    /** 访问令牌（真栈由 CP 签发，mock 车道是假令牌）。 */
    token: string;
    /** 工作区对象：JSON 序列化后同时写入 localStorage 与 sessionStorage。 */
    workspace?: Record<string, unknown>;
    /** 只覆盖 sessionStorage 的逐 tab 权威值（PLAN-0559）；缺省则与 `workspace` 相同。 */
    tabWorkspace?: Record<string, unknown>;
    /** 主题；写**裸值**（规范形态）。 */
    theme?: "light" | "dark" | "system";
    /** 语言；写**裸值**。 */
    language?: string;
}

/**
 * 种子入参。
 *
 * <p>`user` 与 `halfSession` 是**互斥且必须二选一**的：要给完整会话就传 `user`；
 * 要**有意**造半个会话（只有 token）就写 `halfSession: true`。两个都不给是编译错误，
 * 运行时也会抛 —— 因为「忘了种 user」与「有意种半个会话」在行为上是两回事，必须可区分。</p>
 */
export type SessionSeed =
    | (SessionSeedBase & { user: Record<string, unknown> })
    | (SessionSeedBase & { user?: undefined; halfSession: true });

/**
 * 把种子规格编译成落盘键值对（纯函数，不碰浏览器）。
 *
 * @throws 当既没有 `user` 也没有 `halfSession: true` 时 —— 见 {@link SessionSeed}。
 */
export function buildSessionSeed(seed: SessionSeed): SessionSeedPayload {
    const payload: SessionSeedPayload = { localStorage: [], sessionStorage: [] };

    if (!seed.token) {
        throw new Error("seedSession: token 不能为空（空 token 等于没种登录态）");
    }
    payload.localStorage.push([SESSION_STORAGE_KEYS.token, seed.token]);

    if (seed.user === undefined) {
        if (seed.halfSession !== true) {
            throw new Error(
                "seedSession: 未给 user 时必须显式声明 halfSession: true —— " +
                    "「有意造半个会话」与「忘了种 user」必须可区分（task-224 档 3）",
            );
        }
    } else {
        payload.localStorage.push([SESSION_STORAGE_KEYS.user, JSON.stringify(seed.user)]);
    }

    const tabWorkspace = seed.tabWorkspace ?? seed.workspace;
    if (seed.workspace) {
        payload.localStorage.push([SESSION_STORAGE_KEYS.workspace, JSON.stringify(seed.workspace)]);
    }
    if (tabWorkspace) {
        // PLAN-0559：逐 tab 上下文是权威值；只写 localStorage 时页面会走迁移分支。
        payload.sessionStorage.push([SESSION_STORAGE_KEYS.workspace, JSON.stringify(tabWorkspace)]);
    }

    // 裸值（规范形态，见文件头）。JSON 引号形态只是历史兼容项，这里不生产它。
    if (seed.theme) payload.localStorage.push([SESSION_STORAGE_KEYS.theme, seed.theme]);
    if (seed.language) payload.localStorage.push([SESSION_STORAGE_KEYS.language, seed.language]);

    return payload;
}

/**
 * 把种子装进页面：在**每次导航前**（`addInitScript`）写入，故对 `goto`/`reload` 都生效。
 *
 * <p>用 `addInitScript` 而不是 `page.evaluate` 是必须的：后者要求页面已加载，而登录态
 * 必须在**首帧之前**就位，否则守卫读到「未登录」会先把人弹到 `/login`。</p>
 *
 * @returns 实际写入的键值对（供调用方/断言核对，避免「以为种了、其实没种」）。
 */
export async function seedSession(page: Page, seed: SessionSeed): Promise<SessionSeedPayload> {
    const payload = buildSessionSeed(seed);
    await page.addInitScript((entries) => {
        for (const [key, value] of entries.localStorage) localStorage.setItem(key, value);
        for (const [key, value] of entries.sessionStorage) sessionStorage.setItem(key, value);
    }, payload);
    return payload;
}

/**
 * 只种主题（不碰登录态），用于「验主题但不验登录」的既有 spec。
 *
 * <p>单独给出这个入口，是为了让 `task83-ui-audit` 那类「本来只想验视觉、顺手漏了登录态」
 * 的用例**不必**为了种主题而引入 auth 语义 —— 但同时也让「只种主题」变成一次**显式选择**，
 * 而不是像现在这样「悄悄少种了三个键」。</p>
 */
export async function seedTheme(
    page: Page,
    theme: "light" | "dark" | "system",
): Promise<SessionSeedPayload> {
    const payload: SessionSeedPayload = {
        localStorage: [[SESSION_STORAGE_KEYS.theme, theme]],
        sessionStorage: [],
    };
    await page.addInitScript((entries) => {
        for (const [key, value] of entries.localStorage) localStorage.setItem(key, value);
    }, payload);
    return payload;
}
