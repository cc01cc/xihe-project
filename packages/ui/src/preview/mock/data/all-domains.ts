// 域全集 + 派生计数：**唯一来源**。
//
// WHY 单一模块（task-81）：此前「域全集」有两处各拼一份，必然漂 ——
//   ① `screens/S1SettingsAfter.vue` 用 DEDICATED + CORE + A/B 去重，给 `?domain=` 查详情；
//   ② `data.ts` 的 `badgeOf()` 只查 `domains-core.ts` 的 `CORE_DOMAINS`。
// 后果实测：A/B 组 5 个域 + agent-runtime 在左栏**有徽标位却永远渲染 `—`**（②查不到），
// 而 `?domain=agent-runtime` 在①里根本不存在 ⇒ 静默落回 rag（画错域的假绿）。
// 收敛后两处都从这里取，新增域只改这一个文件。
import { domains as GROUP_A_DOMAINS } from "./domains-a";
import { domains as GROUP_B_DOMAINS } from "./domains-b";
import { domains as AGENT_RUNTIME_DOMAINS } from "./domains-agent-runtime";
import { CORE_DOMAINS } from "./domains-core";
import { DEDICATED_DOMAINS } from "../panels/domains-dedicated";
import type { MockDomain } from "./types";

/** 面板域与核心域优先：同 id 时表单域让位（A/B 组里可能给出与面板域同名的表单版）。 */
const TAKEN_IDS = new Set([...DEDICATED_DOMAINS, ...CORE_DOMAINS].map((domain) => domain.id));

/** 表单域（画 Field 表）：核心 3 + A/B 5 + agent-runtime 1，去掉与面板域/核心域重名的。 */
export const FORM_DOMAINS: MockDomain[] = [
    ...CORE_DOMAINS,
    ...[...GROUP_A_DOMAINS, ...GROUP_B_DOMAINS, ...AGENT_RUNTIME_DOMAINS].filter(
        (domain) => !TAKEN_IDS.has(domain.id),
    ),
];

/** 12 个配置域的**唯一全集**：面板域在前（同 id 优先命中专用面板实现），其后表单域。 */
export const ALL_DOMAINS: MockDomain[] = [...DEDICATED_DOMAINS, ...FORM_DOMAINS];

/** 域 id → 字段条数（左栏 badge 的唯一来源）。未知域返回 0，由 `badgeOf()` 决定怎么显示。 */
export function fieldCountOf(domainId: string): number {
    const domain = ALL_DOMAINS.find((item) => item.id === domainId);
    if (!domain) return 0;
    return domain.groups.reduce((n, group) => n + group.fields.length, 0);
}

/**
 * 左栏徽标文本。
 *
 * 两种量纲不能混：面板域量**资源条数**（3 个连接 / 3 个模板），表单域量**配置项数**。
 * 数据还没落地时渲染 `—`，**不渲染 0** —— 0 会被读成「这个域没有配置项」，是另一种假信息。
 */
export function badgeOf(domainId: string): string {
    const domain = ALL_DOMAINS.find((item) => item.id === domainId);
    // 面板域量资源条数（3 个连接 / 3 个模板 / 3 个提供商），单位由数据给；缺省「条目」与标题行同口径
    if (domain?.panel) return domain.panel.rows.length + " " + (domain.panel.unit ?? "条目");
    const count = fieldCountOf(domainId);
    return count > 0 ? String(count) : "—";
}
