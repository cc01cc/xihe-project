import { describe, it, expect } from "vitest";
import { BUILTIN_PROVIDERS, isBuiltinProvider, getProviderInfo } from "../provider";

describe("BUILTIN_PROVIDERS", () => {
    it("defines exactly 4 providers", () => {
        expect(BUILTIN_PROVIDERS.length).toBe(4);
    });

    it("includes openai", () => {
        const p = BUILTIN_PROVIDERS.find((provider) => provider.id === "openai");
        expect(p).toBeDefined();
        expect(p!.name).toBe("OpenAI");
        expect(p!.defaultBaseUrl).toBe("https://api.openai.com/v1");
    });

    it("includes deepseek", () => {
        const p = BUILTIN_PROVIDERS.find((provider) => provider.id === "deepseek");
        expect(p).toBeDefined();
        expect(p!.name).toBe("DeepSeek");
        expect(p!.defaultBaseUrl).toBe("https://api.deepseek.com/v1");
    });

    it("includes xiaomi", () => {
        const p = BUILTIN_PROVIDERS.find((provider) => provider.id === "xiaomi");
        expect(p).toBeDefined();
        expect(p!.name).toBe("小米 MiMo");
        expect(p!.defaultBaseUrl).toBe("https://api.xiaomimimo.com/v1");
    });

    it("includes anthropic", () => {
        const p = BUILTIN_PROVIDERS.find((provider) => provider.id === "anthropic");
        expect(p).toBeDefined();
        expect(p!.name).toBe("Anthropic");
        expect(p!.defaultBaseUrl).toBe("https://api.anthropic.com/v1");
    });

    it("every provider has required fields", () => {
        for (const p of BUILTIN_PROVIDERS) {
            expect(p.id).toBeTruthy();
            expect(p.name).toBeTruthy();
            expect(p.defaultBaseUrl).toBeTruthy();
        }
    });

    // PLAN-0531 decision #3: `defaultModel` was removed from ProviderInfo.
    // The only product-default definition is the Agent's PROVIDER_DEFAULTS;
    // per Round-2/B-12 no negative "field is absent" test is added here.
    it("no duplicate ids", () => {
        const ids = BUILTIN_PROVIDERS.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("every defaultBaseUrl is a valid URL", () => {
        for (const p of BUILTIN_PROVIDERS) {
            expect(() => new URL(p.defaultBaseUrl)).not.toThrow();
        }
    });

    it("is readonly (frozen)", () => {
        expect(Object.isFrozen(BUILTIN_PROVIDERS)).toBe(true);
    });

    it("every defaultBaseUrl ends with /v1", () => {
        for (const p of BUILTIN_PROVIDERS) {
            expect(p.defaultBaseUrl).toMatch(/\/v1$/);
        }
    });
});

describe("isBuiltinProvider", () => {
    it("returns true for built-in providers", () => {
        expect(isBuiltinProvider("openai")).toBe(true);
        expect(isBuiltinProvider("deepseek")).toBe(true);
        expect(isBuiltinProvider("xiaomi")).toBe(true);
        expect(isBuiltinProvider("anthropic")).toBe(true);
    });

    it("returns false for unknown providers", () => {
        expect(isBuiltinProvider("custom")).toBe(false);
        expect(isBuiltinProvider("")).toBe(false);
    });
});

describe("getProviderInfo", () => {
    it("returns provider info for built-in ids", () => {
        const info = getProviderInfo("deepseek");
        expect(info).toBeDefined();
        expect(info!.id).toBe("deepseek");
        expect(info!.defaultBaseUrl).toBe("https://api.deepseek.com/v1");
    });

    it("returns undefined for unknown ids", () => {
        expect(getProviderInfo("nonexistent")).toBeUndefined();
    });
});
