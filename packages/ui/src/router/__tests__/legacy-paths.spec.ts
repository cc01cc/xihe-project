import { describe, expect, it } from "vitest";

import { LEGACY_RESOURCE_PATHS } from "../../lib/legacyRoutes";
import router from "../index";

/**
 * `task-301`（PLAN-0772 `T2.3` 遗留）：**七条已删除的旧资源路径不在路由表**（unit 车道守卫）。
 *
 * <p>为什么需要这条（`297` 盘点的结论）：e2e 侧已有 404 负断言
 * （`e2e/mock/resources-ia.spec.ts:389-400`，7/7 覆盖），但那是 **mock 车道、要起栈**；
 * unit 车道此前 **0 条**守着「旧路径没被加回路由表」—— 本文件补的就是这半秒级的绊线。</p>
 *
 * <p><b>为什么断言两件而不是一件</b>：只断言 `resolve(path).name === "settings-not-found"`
 * 会假绿 —— 若哪天有人把兜底路由改名成与真实路由同名（或反过来），name 判据可以同时成立而
 * 路由表里真的躺着一条旧路径。所以第二条直接查
 * `router.getRoutes()` 里**是否存在 `path` 精确等于该旧路径的记录**，那是"不在表里"的本体判据。</p>
 *
 * <p><b>清单的单源（`task-315` 收口 `297` 缺口 3）</b>：
 * 已删除资源路径的**唯一**清单是 `src/lib/legacyRoutes.ts` 的 `LEGACY_RESOURCE_PATHS`
 * （{@link GUARD}.legacy 直接引用它，本文件不再手抄）。**新增删除必须同批改那个模块** ——
 * 否则本门以及对面的 e2e 404 负断言对新路径同时是盲的（它们只能证明"列出来的这些"不在表里）。
 * 单源之前的形态是三处手抄（本文件 + `e2e/mock/resources-ia.spec.ts` + `router/index.ts` 注释），
 * 任何一处漏改都会让另一处静默过期。</p>
 *
 * <p><b>反向自检不是可选项</b>：{@link GUARD}.live 与 {@link GUARD}.surviving 两组断言证明
 * "这套写法能分辨存活/已删" —— 否则「七条都解析到 404」可能只是因为判据恒真
 * （例如路由表根本没装配、或 `resolve` 对任何路径都回兜底名）。</p>
 */
interface GuardFixture {
    /** 设置区兜底路由的 name（`router/index.ts` 的 `settings-not-found`）。 */
    readonly notFoundName: string;
    /** 已删除的七条旧资源路径（PLAN-0772 M2 / 决策 10）。**数据来自单源，不在本文件手抄。** */
    readonly legacy: readonly string[];
    /** 反向自检：**活着**的新资源路径（名字来自 `router/index.ts` 的 `resources-<id>`）。 */
    readonly live: readonly (readonly [path: string, name: string])[];
    /**
     * 反向自检第二种：一条**仍存活**的 `/settings/instance/<域>` 路径。
     *
     * <p>它证明七条旧路径的 404 **不是**因为 `/settings` 子树整体消失（那样"表里没有该 path"
     * 会对任何路径恒真）；层进 URL 时代之后的配置域页必须一直在。</p>
     */
    readonly surviving: { readonly path: string; readonly name: string };
}

const GUARD: GuardFixture = {
    notFoundName: "settings-not-found",
    legacy: LEGACY_RESOURCE_PATHS,
    live: [
        ["/resources/credentials", "resources-credentials"],
        ["/resources/mcp", "resources-mcp"],
        ["/resources/skills", "resources-skills"],
        ["/resources/agents", "resources-agents"],
        ["/resources/knowledge", "resources-knowledge"],
    ],
    surviving: {
        path: "/settings/instance/llm-provider",
        name: "settings-instance-domain-llm-provider",
    },
};

function exactRoutePaths(): readonly string[] {
    return router.getRoutes().map((route) => route.path);
}

describe("旧资源路径不在路由表（task-301 / PLAN-0772 T2.3）", () => {
    /**
     * 判据一：七条旧路径全部落到设置区兜底路由。
     *
     * <p>一次性比较整张表（`toEqual` 对数组），失败时会打印**全部**七条的 path 与 name，
     * 不用为每一条单独跑一遍才知道哪条漏了。</p>
     */
    it("七条旧路径都解析到设置区 404 兜底（不是某个真实页）", () => {
        const resolved = GUARD.legacy.map((path) => ({
            path,
            name: router.resolve(path).name,
        }));

        expect(resolved).toEqual(GUARD.legacy.map((path) => ({ path, name: GUARD.notFoundName })));
    });

    /**
     * 判据二（本体）：路由表里没有 `path` 精确等于任何一条旧路径的记录。
     *
     * <p>这条同时兜住"兜底与真实路由同名"的假绿：即便 name 判据成立，只要表里有这条精确 path，
     * 这里就会红。`getRoutes()` 返回的是**扁平化后的完整 path**，所以嵌套子路由也会被覆盖。</p>
     */
    it("七条旧路径在路由表里没有精确 path 记录（防同名兜底假绿）", () => {
        const leaked = exactRoutePaths().filter((path) => GUARD.legacy.includes(path));

        expect(leaked).toEqual([]);
    });

    /**
     * 反向自检一：五条新资源路径**必须**能解析到真实 name，且表里有精确 path。
     *
     * <p>若判据一/二写错（例如 `resolve` 对所有路径都回兜底、或 `routes` 表没装配），
     * 本条立刻红 —— 它要求"存活"这一侧在**同一套判据**下得到相反结果。</p>
     */
    it("反向自检：五条新资源路径解析到真实 name 且表里有它们（判据有分辨力）", () => {
        for (const [path, name] of GUARD.live) {
            expect({ path, resolved: router.resolve(path).name }).toEqual({ path, resolved: name });
            expect({ path, inTable: exactRoutePaths().includes(path) }).toEqual({
                path,
                inTable: true,
            });
        }
    });

    /**
     * 反向自检二：`/settings/instance/llm-provider` 仍存活。
     *
     * <p>它堵住"`/settings` 整棵树都没了 ⇒ 旧路径当然不在表里"这种等价于恒真的解释；
     * 也顺手把"层进 URL 时代之后的配置域页没被误删"钉住。</p>
     */
    it("反向自检：仍存活的 /settings/instance/llm-provider 解析到真实 name（不是整棵树消失）", () => {
        expect(router.resolve(GUARD.surviving.path).name).toBe(GUARD.surviving.name);
        expect(exactRoutePaths()).toContain(GUARD.surviving.path);
    });
});

/**
 * task-485 / task-226 D4（用户 2026-11-14 ④）：`agent-profile` 撤出设置区 ⇒ 两条旧深层链接
 * **302 到成员管理**，不做 404。
 *
 * <p>为什么用 unit 也钉一遍（e2e 侧已钉终态 URL）：浏览器段要起栈、要等 Chrome 单窗
 * （task-378 占用中），而这半秒的判据能直接回答"重定向还在不在、落点还是不是成员页"。
 * 两侧都留着的理由同上面 task-301 那段：**e2e 断的是页面终态，unit 断的是路由表本身**。</p>
 *
 * <p>反向自检（不是可选项）：同一套 `resolve` 判据下，一条**仍存活**的设置页必须解析到真实 name，
 * 否则"解析到 org-members"可能只是因为路由表没装配（`resolve` 对任何路径都回某个兜底）。</p>
 */
describe("task-485：agent-profile 撤出设置区（302 → 成员管理）", () => {
    const RETIRED = ["/settings/instance/agent-profile", "/settings/user/agent-profile"] as const;

    /**
     * 判据：旧路径的记录**存在**且它的 redirect 指向 `org-members`，而 `org-members` 解析到 `/members`。
     *
     * <p><b>为什么不断言"resolve 之后就到 /members"</b>（第一版这么写，实测红）：vue-router 4 的
     * `router.resolve()` **不跟随 redirect** —— 跟随只发生在导航时（`pushWithRedirect`）。所以
     * resolve 一条 redirect 记录得到的是"匹配到该记录、name 为空、path 原样"（`[实测]` 2026-11-14）。
     * 真 302 终态由 e2e 钉（`config-settings.spec.ts` / `plan-0752-settings-ia.spec.ts` 的
     * `toHaveURL(/\/members$/)`）；unit 这一侧钉的是**路由表里这条记录还在、目标没串**。</p>
     */
    it("两条旧路径都有 redirect 记录且指向成员管理页", () => {
        for (const path of RETIRED) {
            const record = router.resolve(path).matched.at(-1);
            // 记录存在（否则 matched 为空 ⇒ record 为 undefined，下一条断言会以具体形态红）
            expect({ path, hasRecord: record !== undefined }).toEqual({ path, hasRecord: true });
            expect({ path, redirect: record?.redirect }).toEqual({
                path,
                redirect: { name: "org-members" },
            });
            // 目标路由本身可解析且落在 /members（防"重定向到一个已改名的 name"）。
            expect(router.resolve({ name: "org-members" }).path).toBe("/members");
        }
    });

    it("反向自检：仍存活的设置页解析到真实 name（判据有分辨力）", () => {
        const live = "/settings/user/agent-templates";
        expect(router.resolve(live).name).toBe("settings-user-domain-agent-templates");
        expect(exactRoutePaths()).toContain(live);
        // 且设置区没有留下 `agent-profile` 域名路由/组路由。
        const names = router.getRoutes().map((route) => String(route.name ?? ""));
        expect(names.filter((name) => name.includes("agent-profile"))).toEqual([]);
    });
});

/**
 * task-485 ①：`agent-templates` 撤出工作区层 ⇒ `/settings/workspace-default/agent-templates` 这条
 * 旧深层链接**302 到智能体配置组页（实例层）**，不是 404。
 *
 * <p>为什么单独一段：它和「智能体个人」是**两条不同的撤出面**（一个是域退出某层、一个是域退出设置区），
 * 判据落点也不同（前者去组页、后者去成员管理）。混在一条里会让"改错落点"看起来像绿。</p>
 */
describe("task-485：agent-templates 撤出工作区层（302 → 智能体配置组页）", () => {
    const RETIRED = "/settings/workspace-default/agent-templates";

    it("旧路径有 redirect 记录，且目标 = 实例层智能体配置组页", () => {
        const record = router.resolve(RETIRED).matched.at(-1);
        expect(record?.redirect).toEqual({ name: "settings-instance-agent-config" });
        // 目标自身可解析（防「重定向到一个被改名/被删掉的 name」）。
        expect(router.resolve({ name: "settings-instance-agent-config" }).path).toBe(
            "/settings/instance/agent-config",
        );
    });

    it("反向自检：工作区层的模板域页与组页都不在了（不是「还在但改了名」）", () => {
        expect(router.resolve("/settings/workspace-default/agent-templates").name).not.toBe(
            "settings-workspace-default-domain-agent-templates",
        );
        expect(router.resolve("/settings/workspace-default/agent-config").name).toBe(
            "settings-not-found",
        );
        // 但工作区层其余 3 域仍在（否则上面的「不在了」可能只是整层消失）。
        expect(router.resolve("/settings/workspace-default/agent-runtime").name).toBe(
            "settings-workspace-default-domain-agent-runtime",
        );
    });
});

/**
 * task-485 ③：「智能体配置」组页 = 注册表里的第二组。
 *
 * <p>判据三件：①instance/user 两层**都注册**了组路由；②工作区层**不注册**（撤掉 `agent-templates`
 * 后只剩 1 段 ⇒ 不成组，且组政策本就只开两层）；③组 id 不冒充域路由（否则 CP 会收到
 * `/config/agent-config/meta` 必 400 —— 同 task-227 的模型组边界）。</p>
 */
describe("task-485：智能体配置组页路由（两段一页，域不合并）", () => {
    it("instance / user 两层注册组路由，且路径与 name 同构", () => {
        for (const layer of ["instance", "user"] as const) {
            const path = `/settings/${layer}/agent-config`;
            expect({ path, name: router.resolve(path).name }).toEqual({
                path,
                name: `settings-${layer}-agent-config`,
            });
            expect(exactRoutePaths()).toContain(path);
        }
    });

    it("工作区层不注册该组路由（不成组 ⇒ 走 404 兜底，不是死链页面）", () => {
        const path = "/settings/workspace-default/agent-config";
        expect(router.resolve(path).name).toBe("settings-not-found");
        expect(exactRoutePaths()).not.toContain(path);
    });

    it("组 id 不是域 id：解析不出域路由（防 /config/agent-config/meta 打到 CP）", () => {
        expect(router.resolve("/settings/instance/agent-config").name).not.toBe(
            "settings-instance-domain-agent-config",
        );
        expect(router.resolve("/settings/instance/agent-config").meta.settingsGroup).toBe(
            "agent-config",
        );
        expect(
            router.resolve("/settings/instance/agent-config").meta.settingsDomain,
        ).toBeUndefined();
    });
});
