import { describe, expect, it } from "vitest";
import { resolveModelDisplay } from "../modelDisplay";

/**
 * C1（2026-11-04 用户裁定）：`hasBinding` 只认会话行。
 *
 * 本地 binding 缓存与 llm-provider profile 是"发送时会用的兜底"，不是"已经绑上"——
 * 把它们算进 `hasBinding` 会让裸会话显示成已绑模型（用户一发言就 409
 * `PROVIDER_REQUIRED`，BL-204 B）。回归断言：兜底链仍解析 model/provider（发送要用），
 * 但 `hasBinding` 必须是 false，触发器因此退回占位文案。
 */
const BASE = {
    connections: [] as never[],
    connectionsLoaded: true,
};

describe("resolveModelDisplay — C1 binding truthfulness", () => {
    it("reports a bound session row as bound and shows its model", () => {
        const display = resolveModelDisplay({
            ...BASE,
            session: {
                modelProvider: "deepseek",
                modelName: "deepseek-flash",
                providerConnectionId: "conn-1",
            },
        });

        expect(display.hasBinding).toBe(true);
        expect(display.model).toBe("deepseek-flash");
        expect(display.providerId).toBe("deepseek");
        expect(display.connectionId).toBe("conn-1");
    });

    it("keeps resolving the fallback chain but never claims an unbound session is bound", () => {
        const display = resolveModelDisplay({
            ...BASE,
            // 裸会话：没有 providerConnectionId —— 正是 UI 新建会话的默认形态。
            session: { modelProvider: undefined, modelName: undefined },
            binding: { provider: "deepseek", model: "deepseek-flash", connectionId: "conn-1" },
        });

        // 发送侧仍会用这个兜底（getEffectiveModel 同源），但显示不得声称"已绑"。
        expect(display.model).toBe("deepseek-flash");
        expect(display.providerId).toBe("deepseek");
        expect(display.hasBinding).toBe(false);
    });

    it("does not claim a profile default is a session binding", () => {
        const display = resolveModelDisplay({
            ...BASE,
            profile: { providerId: "openai", connectionKey: "main", model: "gpt-5.1" } as never,
        });

        expect(display.model).toBe("gpt-5.1");
        expect(display.hasBinding).toBe(false);
    });

    it("stays empty when nothing resolves", () => {
        const display = resolveModelDisplay({ ...BASE });
        expect(display.hasBinding).toBe(false);
        expect(display.model).toBeNull();
        expect(display.state).toBe("not-recorded");
    });
});
