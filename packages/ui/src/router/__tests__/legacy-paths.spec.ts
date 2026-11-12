import { describe, expect, it } from "vitest";

import router from "../index";

/**
 * `task-301`（PLAN-0772 `T2.3` 遗留）：**七条已删除的旧资源路径不在路由表**（unit 车道守卫）。
 *
 * <p>为什么需要这条（`297` 盘点的结论）：e2e 侧已有 404 负断言
 * （`e2e/mock/resources-ia.spec.ts:384-401`，7/7 覆盖），但那是 **mock 车道、要起栈**；
 * unit 车道此前 **0 条**守着「旧路径没被加回路由表」—— 本文件补的就是这半秒级的绊线。</p>
 *
 * <p><b>为什么断言两件而不是一件</b>：只断言 `resolve(path).name === "settings-not-found"`
 * 会假绿 —— 若哪天有人把兜底路由改名成与真实路由同名（或反过来），name 判据可以同时成立而
 * 路由表里真的躺着一条旧路径。所以第二条直接查
 * `router.getRoutes()` 里**是否存在 `path` 精确等于该旧路径的记录**，那是"不在表里"的本体判据。</p>
 *
 * <p><b>单源提示（`297` 缺口 3：清单手写、无单源绑定）</b>：
 * 已删除资源路径清单的唯一凭据 = `src/router/index.ts:202-203` 的注释（决策 10：一次性删除、
 * 不留 redirect）+ 本文件 {@link GUARD}.legacy。**新增删除必须同批加进这个数组**，
 * 否则本门对未来新增的旧路径是盲的（它只能证明"列出来的这些"不在表里）。</p>
 *
 * <p><b>反向自检不是可选项</b>：{@link GUARD}.live 与 {@link GUARD}.surviving 两组断言证明
 * "这套写法能分辨存活/已删" —— 否则「七条都解析到 404」可能只是因为判据恒真
 * （例如路由表根本没装配、或 `resolve` 对任何路径都回兜底名）。</p>
 */
interface GuardFixture {
    /** 设置区兜底路由的 name（`router/index.ts` 的 `settings-not-found`）。 */
    readonly notFoundName: string;
    /** 已删除的七条旧资源路径（PLAN-0772 M2 / 决策 10）。**新增删除同批加进来。** */
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
    legacy: [
        "/settings/instance/credentials",
        "/settings/instance/agents",
        "/settings/instance/mcp",
        "/settings/skills",
        "/settings/credentials",
        "/settings/agent-principals",
        "/settings/knowledge",
    ],
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
