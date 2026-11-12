/**
 * 已删除的旧资源路径 —— **唯一单源**（`PLAN-0772` M2 / 决策 10，`task-315`）。
 *
 * <p><b>为什么有这份清单</b>：`297` 盘点发现「删过哪些旧路径」这个事实被**手抄了三份**——
 * `e2e/mock/resources-ia.spec.ts` 的 404 负断言循环、`src/router/__tests__/legacy-paths.spec.ts`
 * 的 unit 守卫、以及 `src/router/index.ts` 的注释。三份各写各的 ⇒ 下次再删一条路径，
 * 只能靠人记得回来把三处都加上；忘一处就会留下"看似守着、实则对新增路径是盲的"门。
 * 现在三处消费者全部引用这里的 `LEGACY_RESOURCE_PATHS`，**新增/删除必须同批改本文件**。</p>
 *
 * <p><b>这里只放路径字面量，不放断言逻辑</b>：两条车道各自的判据不同（unit 查路由表本体、
 * e2e 查真实渲染与 URL 不跳走），共享数据不等于共享判据；把它们合并成"共享断言"会让
 * 任何一处判据退化都同时污染另一车道。</p>
 *
 * <p><b>为什么放在 `src/lib` 而不是 `e2e/`</b>：`e2e → src/lib` 在本包里是**既有惯例**
 * 而非新发明的依赖方向 —— mock 车道早有 `e2e/mock/plan-0752-settings-ia.spec.ts` 引
 * `src/lib/settingsIaRequests`、`e2e/mock/bl576-workbench-panel-widths.spec.ts` 引
 * `src/composables/useWorkspaceLayout`，real 车道有十余处引 `src/lib/routes`。反过来把清单放
 * `e2e/` 再由 `src/router/__tests__/**` 反向引用，才会造出一个"产品源码依赖测试目录"的畸形边。
 * 放在 `src/lib` 还顺带让路由注释能直接指名它，不必写"请去看某个 spec"。</p>
 *
 * <p><b>清单的语义边界</b>：这些是**旧资源入口**（凭据/MCP/技能/智能体/知识库在设置区的那套路径），
 * 决策 10 是**一次性删除、不留 redirect**（用户 2026-11-12 裁定「不用考虑旧的兼容性，要改就全改」）。
 * 因此每条都必须落 `settings-not-found`，且路由表里不得有精确 `path` 记录 —— 判据消费者：
 * `src/router/__tests__/legacy-paths.spec.ts`（半秒级，查路由表本体）与
 * `e2e/mock/resources-ia.spec.ts` 的「旧资源路径直接删除（无 redirect）」用例（要起栈，查真实渲染）。</p>
 */
export const LEGACY_RESOURCE_PATHS = [
    "/settings/instance/credentials",
    "/settings/instance/agents",
    "/settings/instance/mcp",
    "/settings/skills",
    "/settings/credentials",
    "/settings/agent-principals",
    "/settings/knowledge",
] as const;
