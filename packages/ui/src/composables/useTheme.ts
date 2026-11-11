import { watch, ref } from "vue";
import { useColorMode } from "@vueuse/core";
import { themeStorage, type ThemeMode } from "../stores/settings";

/**
 * 明暗（`light` / `dark` / `system`）—— `task-65` 修的就是这里。
 *
 * <p>**改前（有 bug）**：`useColorMode({ storageKey: "xihe-theme" })` 自己读写 localStorage，
 * 写的是**裸字符串** `dark`；同一个键还有 `useLocalStorage`（JSON，写 `"dark"`）与
 * `stores/settings.ts` 的第三个 `useLocalStorage`。三者两种序列化互相覆盖，刷新后
 * `index.html` 的预涂脚本 `JSON.parse("dark")` 抛错 ⇒ 不加 `dark` 类 ⇒ **点了深色、刷新回浅色**。</p>
 *
 * <p>**改后（单 writer）**：`stores/settings.ts` 的 `themeStorage` 是唯一持久化面（固定 JSON）；
 * `useColorMode` 只做**受控应用层**——给它一个内存 storage（永不落盘），把"该不该有 `dark` 类"
 * 完全交给 `watch(themeStorage)` 决定。`system` 仍由 `useColorMode` 的 `prefers-color-scheme`
 * 求值，行为不变。</p>
 *
 * <p>为什么保留 `useColorMode` 而不是自己 `classList.toggle`：`system` 模式要监听
 * `matchMedia('(prefers-color-scheme: dark)')` 的**实时变化**（用户在系统里切深浅要跟手），
 * 自己写就得再实现一遍媒体查询订阅与清理。这里保留它的应用层能力、只剥掉它的持久化。</p>
 */

/** 永不落盘的内存 storage：`useColorMode` 因此不再写 localStorage（序列化冲突的根因）。 */
const INERT_STORAGE = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
};

export function useTheme() {
    const colorMode = useColorMode({
        selector: "html",
        attribute: "class",
        initialValue: "system",
        storage: INERT_STORAGE,
    });

    const theme = ref<"light" | "dark">(colorMode.value === "dark" ? "dark" : "light");

    watch(colorMode, (value) => {
        theme.value = value === "dark" ? "dark" : "light";
    });

    // SSOT → 类名：`immediate` 保证**重新挂载**后 class 与磁盘一致（本 bug 的直接回归点）。
    watch(
        themeStorage,
        (mode) => {
            colorMode.value = mode;
        },
        { immediate: true },
    );

    /** 唯一写入口：只写 SSOT，类名由上面的 watch 施加。 */
    function setColorMode(mode: ThemeMode) {
        themeStorage.value = mode;
    }

    return {
        theme,
        colorMode: themeStorage,
        setColorMode,
    };
}
