/**
 * 专用面板域数据入口（ui-2 负责的三个域）。
 *
 * 消费方：
 * - `screens/S1SettingsAfter.vue` —— 把 `DEDICATED_DOMAINS` 并进域查找表（否则 `?domain=` 落回 CORE_DOMAINS[0]）；
 * - 徽标：由 `data/all-domains.ts#badgeOf()` 统一派生（面板域量资源条数、单位取 `panel.unit`），
 *   本文件不再提供第二个派生实现（原 `panelBadgeOf()` 要求写死 unit，`llm-provider` 因此长期显示「—」）。
 *
 * 详细出处与取舍见 `domains-dedicated.ts` 的文件头注释。
 */
export { DEDICATED_DOMAINS, default } from "./domains-dedicated";
