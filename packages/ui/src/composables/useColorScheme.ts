import { readonly, ref, type Ref } from "vue";
import {
    COLOR_SCHEME_ATTRIBUTE,
    DEFAULT_COLOR_SCHEME,
    getStoredColorScheme,
    isColorScheme,
    setStoredColorScheme,
    type ColorScheme,
} from "../lib/colorScheme";

/**
 * 5 个 base color 方案的响应式视图（task-48 M2）。
 *
 * 单一数据源仍是 `lib/colorScheme.ts`（持久化键 `xihe-color-scheme` + `<html data-xh-color>`）；
 * 这里只是让组件能读当前值、改值时同时落库 + 改属性。用**模块级单例**而不是每个组件各自读
 * localStorage：设置页的选项与任何后续读取点必须同步（同一个 ref）。
 *
 * 与 `useTheme`（明暗）互不读写：两者是正交轴。
 */
const current: Ref<ColorScheme> = ref(DEFAULT_COLOR_SCHEME);
let initialized = false;

function readApplied(): ColorScheme {
    if (typeof document === "undefined") return DEFAULT_COLOR_SCHEME;
    const applied = document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE);
    if (isColorScheme(applied)) return applied;
    // 属性还没设置（`initColorScheme()` 之前就被读）：以持久化值为准。
    return getStoredColorScheme();
}

function ensureInitialized(): void {
    if (initialized) return;
    current.value = readApplied();
    initialized = true;
}

export function useColorScheme() {
    ensureInitialized();

    function setColorScheme(scheme: ColorScheme): void {
        current.value = setStoredColorScheme(scheme);
    }

    return {
        colorScheme: readonly(current) as Readonly<Ref<ColorScheme>>,
        setColorScheme,
    };
}

/** 仅供测试：重置单例，让下一次 `useColorScheme()` 重新读环境。 */
export function __resetColorSchemeSingletonForTests(): void {
    current.value = DEFAULT_COLOR_SCHEME;
    initialized = false;
}
