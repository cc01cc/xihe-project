/**
 * 专用面板域数据入口（ui-2 负责的三个域）。
 *
 * 消费方：
 * - `screens/S1SettingsAfter.vue` —— 把 `DEDICATED_DOMAINS` 并进域查找表（否则 `?domain=` 落回 CORE_DOMAINS[0]）；
 * - `data.ts` 的 `badgeOf()` —— 面板域徽标走 `panelBadgeOf()`，单位是资源数（个连接 / 个模板），
 *   不是「N 项配置」（[裁定 2026-11-11]）。
 *
 * 详细出处与取舍见 `domains-dedicated.ts` 的文件头注释。
 */
export { DEDICATED_DOMAINS, panelBadgeOf, default } from "./domains-dedicated";
