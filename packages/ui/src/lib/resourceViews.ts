import type { Component } from "vue";
import type { ResourceId } from "./settingsIa";

/**
 * 资源 id → 页面宿主组件的**唯一**映射（PLAN-0773 M4-2 / task-210 从 `router/index.ts` 搬出）。
 *
 * <p>为什么搬家：工作区资源页（`/workspace/:id/resources`）要复用同一批视图组件，而
 * 「哪个 id 对应哪个组件」如果各写一份，新增资源时两处必然漂（一处漏了就是运行时 404 或
 * 空白页）。现在路由与工作区资源页**都从这里读**，映射只有一份。</p>
 *
 * <p>写成 `satisfies Record<ResourceId, ...>` 而不是 `Record<string, ...>`：漏一个资源
 * id 会在这里**类型报错**，而不是运行时才掉进 404 兜底。</p>
 *
 * <p>动态 `import()` 用显式表而不是拼路径：Vite 对变量形式的 `import()` 只有
 * 「前缀 + 后缀」的受限支持，拼错就是运行时 404；显式映射让 typecheck 能抓到漏项。</p>
 */
export type ResourceViewLoader = () => Promise<{ default: Component }>;

export const RESOURCE_VIEWS = {
    credentials: () => import("../views/resources/CredentialsResourceView.vue"),
    mcp: () => import("../views/resources/McpResourceView.vue"),
    skills: () => import("../views/resources/SkillsResourceView.vue"),
    agents: () => import("../views/resources/AgentsResourceView.vue"),
    knowledge: () => import("../views/resources/KnowledgeResourceView.vue"),
} satisfies Record<ResourceId, ResourceViewLoader>;
