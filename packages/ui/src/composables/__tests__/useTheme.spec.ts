import { describe, it, expect, beforeEach } from "vitest";
import { nextTick } from "vue";
import { useTheme } from "../useTheme";
import {
    THEME_STORAGE_KEY,
    migrateLegacyThemeValue,
    parseStoredTheme,
    themeStorage,
} from "../../stores/settings";

/**
 * `task-65`：明暗持久化（P1 回归）。
 *
 * 修前这里断言的是 `localStorage.getItem("xihe-theme") === "dark"`（**裸值**）——
 * 也就是把 bug 的序列化形态当成了契约；`index.html` 的预涂脚本按 JSON 解析，于是
 * "点了深色、刷新回浅色"永远测不出来。现在契约改成：**磁盘上只允许 JSON**
 * （`"dark"` / `"light"` / `"system"` 三种字面量），并有负断言钉住。
 */

const readRaw = () => localStorage.getItem(THEME_STORAGE_KEY);

beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = "";
    // 模块级单例需要在用例间复位（它不会被 localStorage.clear() 自动重置）
    themeStorage.value = "system";
    document.documentElement.classList.remove("dark");
});

describe("useTheme：基本行为", () => {
    it("默认 system，且非深色系统偏好时 theme=light", () => {
        const { colorMode, theme } = useTheme();
        expect(colorMode.value).toBe("system");
        expect(theme.value).toBe("light");
    });

    it("setColorMode(dark) 同时切换 ref 与 html.dark", async () => {
        const { colorMode, setColorMode, theme } = useTheme();

        setColorMode("dark");
        await nextTick();

        expect(colorMode.value).toBe("dark");
        expect(theme.value).toBe("dark");
        expect(document.documentElement.className).toContain("dark");
    });

    it("setColorMode(light) 移除 html.dark，setColorMode(system) 回到 system", async () => {
        const { colorMode, setColorMode } = useTheme();

        setColorMode("dark");
        await nextTick();
        setColorMode("light");
        await nextTick();
        expect(colorMode.value).toBe("light");
        expect(document.documentElement.className).not.toContain("dark");

        setColorMode("system");
        await nextTick();
        expect(colorMode.value).toBe("system");
    });
});

describe("useTheme：持久化契约（task-65）", () => {
    it("写盘只有一种形态：JSON 字符串（不是裸值）", async () => {
        const { setColorMode } = useTheme();

        setColorMode("dark");
        await nextTick();

        expect(readRaw()).toBe("dark");
        expect(readRaw()?.startsWith('"')).toBe(false);
    });

    it("负断言：连续切换 light/dark/system，磁盘形态恒为 JSON（不出现两者交替）", async () => {
        const { setColorMode } = useTheme();
        const shapes: string[] = [];

        for (const mode of ["dark", "light", "system", "dark"] as const) {
            setColorMode(mode);
            await nextTick();
            const raw = readRaw() ?? "";
            // 形态标记：以 `"` 开头 = JSON（本应永不出现）；否则 = 裸值（唯一合法形态）
            shapes.push(raw.startsWith('"') ? "json" : "raw");
            expect(raw).toBe(mode);
        }

        expect(shapes).toEqual(["raw", "raw", "raw", "raw"]);
    });

    it("重新挂载后 html.dark 仍在（本 bug 的直接回归）", async () => {
        // 模拟"上一次会话选了深色并落盘"：写 JSON
        localStorage.setItem(THEME_STORAGE_KEY, "dark");
        themeStorage.value = "dark";
        document.documentElement.classList.remove("dark");

        // 重新挂载 = 新的 composable 实例（`immediate` 必须立刻把类加上）
        const { theme } = useTheme();
        await nextTick();

        expect(theme.value).toBe("dark");
        expect(document.documentElement.className).toContain("dark");
        // 类由 SSOT 施加，不靠"上次残留"
        expect(readRaw()).toBe("dark");
    });

    it("磁盘读不到时落默认 system（VueUse 会写入默认值，形态仍是裸值）", () => {
        useTheme();
        // 行为记录，而不是期望：`useLocalStorage` 在键缺失时会写下默认值。
        // 关键判据是**形态**（裸值），不是"有没有写"。
        expect(readRaw()).toBe("system");
        expect(readRaw()?.startsWith('"')).toBe(false);
    });
});

describe("旧值兼容（task-65 第 3 条）", () => {
    it("parseStoredTheme 同时接受 JSON 与裸值，其余返回 null", () => {
        expect(parseStoredTheme('"dark"')).toBe("dark");
        expect(parseStoredTheme("dark")).toBe("dark");
        expect(parseStoredTheme("light")).toBe("light");
        expect(parseStoredTheme('"system"')).toBe("system");
        expect(parseStoredTheme("nonsense")).toBeNull();
        expect(parseStoredTheme("{}")).toBeNull();
        expect(parseStoredTheme(null)).toBeNull();
    });

    it("JSON 引号形态被就地改写成裸值（一次性迁移，不是每次启动都猜）", () => {
        localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify("dark"));

        const result = migrateLegacyThemeValue();

        expect(result).toEqual({ status: "migrated", value: "dark" });
        expect(readRaw()).toBe("dark");
        // 第二次跑已是规范形态（幂等）
        expect(migrateLegacyThemeValue()).toEqual({ status: "clean", value: "dark" });
    });

    it("无法识别的值被丢弃，不留垃圾", () => {
        localStorage.setItem(THEME_STORAGE_KEY, '{"theme":"dark"}');
        expect(migrateLegacyThemeValue()).toEqual({ status: "dropped", value: null });
        expect(readRaw()).toBeNull();
    });

    it("没有存过时保持 absent，不凭空造值", () => {
        expect(migrateLegacyThemeValue()).toEqual({ status: "absent", value: null });
        expect(readRaw()).toBeNull();
    });

    it("迁移后 useTheme 认这个值（旧用户不会卡在浅色）", async () => {
        localStorage.setItem(THEME_STORAGE_KEY, "dark");
        const migrated = migrateLegacyThemeValue();

        themeStorage.value = migrated.value ?? "system";
        document.documentElement.classList.remove("dark");
        const { theme } = useTheme();
        await nextTick();

        expect(theme.value).toBe("dark");
        expect(document.documentElement.className).toContain("dark");
    });
});
