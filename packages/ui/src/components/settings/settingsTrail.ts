import { inject, onUnmounted, toValue, watchEffect } from "vue";
import type { InjectionKey, MaybeRefOrGetter } from "vue";

/**
 * task-153：设置区面包屑的「动态尾段」注入点。
 *
 * <p>为什么不是 route.meta：末段里含**运行时数据**（主体名 / 主体 id），元数据是静态表，
 * 塞进去就得让 router 依赖 api，且刷新/深链时会先渲染出错的段。所以由 SettingsLayout
 * provide 一个 setter，页面在 onMounted/加载后写入、**onUnmounted 清空**——不清空的话，
 * 从 A 主体跳到 B 主体或跳到别的设置页时，头里会残留上一个主体名（串页残留）。</p>
 *
 * <p>零变化契约：不调用 setter（或写成 null / 空数组）时，`SettingsLayerHeader` 走原来
 * 那条「根 → 层 →（可选）域」分支，DOM 与加这个能力之前逐字相同。</p>
 */
export interface SettingsTrailItem {
    /** 段文案（已是本地化后的字符串，不做键名解析）。 */
    label: string;
    /** 该段是否可点回上级；省略 = 只显示文字（末段永远不可点）。 */
    to?: string;
}

export type SettingsTrail = readonly SettingsTrailItem[];

/** setter：传 null 表示「本页没有尾段」（回到零变化分支）。 */
export type SettingsTrailSetter = (trail: SettingsTrail | null) => void;

export const SETTINGS_TRAIL_KEY: InjectionKey<SettingsTrailSetter> = Symbol("xihe-settings-trail");

/**
 * 页面侧使用方式（task-153）：把运行时段写进设置区面包屑，卸载时清空。
 *
 * <pre>
 * useSettingsTrail(() => [
 *     { label: t("agentBindings.crumbSubjects"), to: "/settings/instance/agent-principals" },
 *     { label: displayName.value },
 *     { label: t("agentBindings.crumbBindings") },
 * ]);
 * </pre>
 *
 * <p>不在 `SettingsLayout` 之下（或单测里裸挂本组件）时 inject 拿不到 setter —— 静默跳过，
 * 不抛错：面包屑是外框能力，页面不应因为它而挂不起来。</p>
 */
export function useSettingsTrail(items: MaybeRefOrGetter<SettingsTrail | null>): void {
    const setter = inject(SETTINGS_TRAIL_KEY, null);
    if (!setter) return;
    watchEffect(() => setter(toValue(items)));
    onUnmounted(() => setter(null));
}
