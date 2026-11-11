import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    COLOR_SCHEMES,
    COLOR_SCHEME_ATTRIBUTE,
    COLOR_SCHEME_STORAGE_KEY,
    DEFAULT_COLOR_SCHEME,
    applyColorScheme,
    getStoredColorScheme,
    initColorScheme,
    isColorScheme,
    normalizeColorScheme,
    resolveColorScheme,
    setStoredColorScheme,
} from "../colorScheme";

/** `components.json` 的 baseColor 必须与默认方案同源，否则"默认"会有两个说法。 */
const componentsJson = JSON.parse(readFileSync(join(process.cwd(), "components.json"), "utf8")) as {
    tailwind?: { baseColor?: string };
};

function clearEnv(): void {
    localStorage.removeItem(COLOR_SCHEME_STORAGE_KEY);
    document.documentElement.removeAttribute(COLOR_SCHEME_ATTRIBUTE);
}

describe("常量与默认值", () => {
    it("方案集合 = shadcn-vue 官方 5 个 base color", () => {
        expect([...COLOR_SCHEMES]).toEqual(["neutral", "gray", "slate", "stone", "zinc"]);
    });

    it("默认方案是单一常量，且与 components.json 的 baseColor 一致", () => {
        expect(DEFAULT_COLOR_SCHEME).toBe("neutral");
        expect(componentsJson.tailwind?.baseColor).toBe(DEFAULT_COLOR_SCHEME);
    });

    it("isColorScheme 只认 5 值", () => {
        for (const scheme of COLOR_SCHEMES) expect(isColorScheme(scheme)).toBe(true);
        for (const bad of ["c1", "c3", "C2′", "", null, undefined, "nope"]) {
            expect(isColorScheme(bad as string)).toBe(false);
        }
    });
});

describe("normalizeColorScheme（旧键映射表）", () => {
    it("合法值原样返回且不标记迁移", () => {
        for (const scheme of COLOR_SCHEMES) {
            expect(normalizeColorScheme(scheme)).toEqual({ scheme, migratedFrom: null });
        }
    });

    it("旧候选值 c1/c2/c2′/c2p/c3 一律映射到默认方案（不是报错、不是原样保留）", () => {
        for (const legacy of ["c1", "c2", "c2′", "c2'", "c2p", "c3", "C1", " C3 "]) {
            const result = normalizeColorScheme(legacy);
            expect(result.scheme, `${legacy} 应落默认`).toBe(DEFAULT_COLOR_SCHEME);
            expect(result.migratedFrom, `${legacy} 应标记为已迁移`).toBe(legacy);
        }
    });

    it("历史清除值与未知串都落默认，不抛错", () => {
        for (const value of ["default", "off", "none", "whatever", "  "]) {
            const result = normalizeColorScheme(value);
            expect(result.scheme).toBe(DEFAULT_COLOR_SCHEME);
        }
        expect(normalizeColorScheme(null)).toEqual({
            scheme: DEFAULT_COLOR_SCHEME,
            migratedFrom: null,
        });
    });
});

describe("resolveColorScheme（URL 一次性覆盖）", () => {
    it("5 值可解析，大小写与空白不影响", () => {
        for (const scheme of COLOR_SCHEMES) {
            expect(resolveColorScheme(`?color=${scheme}`)).toBe(scheme);
        }
        expect(resolveColorScheme("?color=%20SLATE%20")).toBe("slate");
    });

    it("旧候选值与未知值一律返回 null（旧链接不把界面拉回已下线的调色板）", () => {
        for (const bad of ["c1", "c2", "c3", "default", "off", "none", "", "nope"]) {
            expect(resolveColorScheme(`?color=${bad}`), bad).toBeNull();
        }
        expect(resolveColorScheme("")).toBeNull();
    });
});

describe("applyColorScheme", () => {
    afterEach(clearEnv);

    it("设置与移除 <html data-xh-color>", () => {
        applyColorScheme("slate");
        expect(document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE)).toBe("slate");
        applyColorScheme(null);
        expect(document.documentElement.hasAttribute(COLOR_SCHEME_ATTRIBUTE)).toBe(false);
    });
});

describe("initColorScheme（持久化反转 + 旧键就地归一）", () => {
    afterEach(clearEnv);

    it("没存过 ⇒ 默认方案生效，且属性被显式设置（不再有「无属性=默认」的隐式态）", () => {
        expect(initColorScheme()).toBe(DEFAULT_COLOR_SCHEME);
        expect(document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE)).toBe(
            DEFAULT_COLOR_SCHEME,
        );
        // 没存过就不写键：避免首访即落库造成的"用户选择"假象
        expect(localStorage.getItem(COLOR_SCHEME_STORAGE_KEY)).toBeNull();
    });

    it("存了合法值 ⇒ 该值生效，键保持不变", () => {
        localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, "stone");
        expect(initColorScheme()).toBe("stone");
        expect(document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE)).toBe("stone");
        expect(localStorage.getItem(COLOR_SCHEME_STORAGE_KEY)).toBe("stone");
    });

    it("存了旧候选值 ⇒ 生效为默认，并把键就地改写成归一值（第二次启动不再走迁移分支）", () => {
        for (const legacy of ["c1", "c2", "c3"]) {
            localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, legacy);
            expect(initColorScheme(), `残留 ${legacy} 不得生效`).toBe(DEFAULT_COLOR_SCHEME);
            expect(document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE)).toBe(
                DEFAULT_COLOR_SCHEME,
            );
            expect(localStorage.getItem(COLOR_SCHEME_STORAGE_KEY)).toBe(DEFAULT_COLOR_SCHEME);
        }
    });

    it("URL ?color= 优先于持久化值，且不写库", () => {
        localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, "gray");
        window.history.replaceState({}, "", "/?color=zinc");
        try {
            expect(initColorScheme()).toBe("zinc");
            expect(document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE)).toBe("zinc");
            expect(localStorage.getItem(COLOR_SCHEME_STORAGE_KEY)).toBe("gray");
        } finally {
            window.history.replaceState({}, "", "/");
        }
    });
});

describe("setStoredColorScheme / getStoredColorScheme", () => {
    afterEach(clearEnv);

    it("选择后：写库 + 立即生效 + 返回值可用于回显", () => {
        expect(setStoredColorScheme("slate")).toBe("slate");
        expect(localStorage.getItem(COLOR_SCHEME_STORAGE_KEY)).toBe("slate");
        expect(document.documentElement.getAttribute(COLOR_SCHEME_ATTRIBUTE)).toBe("slate");
        expect(getStoredColorScheme()).toBe("slate");
    });

    it("传旧值/脏值不会炸：按映射表归一后落库", () => {
        expect(setStoredColorScheme("c3")).toBe(DEFAULT_COLOR_SCHEME);
        expect(localStorage.getItem(COLOR_SCHEME_STORAGE_KEY)).toBe(DEFAULT_COLOR_SCHEME);
        expect(getStoredColorScheme()).toBe(DEFAULT_COLOR_SCHEME);
    });
});
