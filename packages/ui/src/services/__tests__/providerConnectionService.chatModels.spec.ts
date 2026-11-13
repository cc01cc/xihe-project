import { describe, expect, it } from "vitest";
import { chatModelNamesOf } from "../providerConnectionService";
import type { ProviderCatalog } from "../../types/provider";
import type { ProviderConnection } from "../../types/providerConnection";

/**
 * task-401：`chatModelNamesOf` 是「一条连接下可用于对话的模型」的**唯一口径**
 * （与 `ProviderHub.vue#chatModelsOf` 同策略；该组件目前仍持本地副本，迁移是后续项）。
 *
 * <p>为什么值得单独钉：它决定创建智能体时模型下拉里有什么。三条容易写错的地方 ——
 * ①目录按 **connectionId** 聚合，键命中但 `connectionId` 不符时**不许借**；
 * ②非 chat 连接（embedding/image）不该拿到模型；③目录缺失时只有 **manual** 才回手填值，
 * curated/remote 一律空（不猜、不跨连接借）。这三条错了都会让用户选到一个发不出去的模型。</p>
 */
function connection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
    return {
        id: "conn-1",
        providerId: "anthropic",
        connectionKey: "conn-1",
        apiTypeId: "anthropic-messages",
        apiTypeVersion: 1,
        operation: "chat",
        label: "主连接",
        scope: "INSTANCE",
        modelDiscovery: "curated",
        manualModels: [],
        hasKey: true,
        enabled: true,
        status: "READY",
        revision: 1,
        ...overrides,
    } as ProviderConnection;
}

function catalog(models: ProviderCatalog["models"], connectionId = "conn-1"): ProviderCatalog {
    return { providerId: "anthropic", connectionId, status: "ready", models };
}

describe("chatModelNamesOf", () => {
    it("目录命中：只回 chat 模型，保持目录顺序", () => {
        const catalogs = {
            "conn-1": catalog([
                { name: "claude-sonnet-4-5", capabilities: { chat: true } },
                { name: "voyage-3", capabilities: { chat: false } },
                { name: "claude-haiku-4-5", capabilities: { chat: true } },
            ]),
        };
        expect(chatModelNamesOf(connection(), catalogs)).toEqual([
            "claude-sonnet-4-5",
            "claude-haiku-4-5",
        ]);
    });

    it("键命中但 connectionId 不符：不借别人的目录（回退按 discovery 判）", () => {
        const catalogs = {
            "conn-1": catalog(
                [{ name: "someone-elses-model", capabilities: { chat: true } }],
                "conn-2",
            ),
        };
        expect(chatModelNamesOf(connection(), catalogs)).toEqual([]);
        expect(
            chatModelNamesOf(
                connection({ modelDiscovery: "manual", manualModels: ["hand-written"] }),
                catalogs,
            ),
        ).toEqual(["hand-written"]);
    });

    it("目录缺失 + manual + chat：回手填模型", () => {
        expect(
            chatModelNamesOf(
                connection({ modelDiscovery: "manual", manualModels: ["hand-written"] }),
                {},
            ),
        ).toEqual(["hand-written"]);
    });

    it("目录缺失 + manual 但连接不是 chat：不回模型（embedding 连接不该出现在模型选择里）", () => {
        expect(
            chatModelNamesOf(
                connection({
                    operation: "embedding",
                    modelDiscovery: "manual",
                    manualModels: ["text-embedding-3-large"],
                }),
                {},
            ),
        ).toEqual([]);
    });

    it("目录缺失 + curated/remote：空（不猜模型名）", () => {
        expect(chatModelNamesOf(connection({ modelDiscovery: "curated" }), {})).toEqual([]);
        expect(
            chatModelNamesOf(connection({ modelDiscovery: "remote-models" }), undefined),
        ).toEqual([]);
    });

    it("目录命中但一个 chat 模型都没有：仍按 manual 回退（与 ProviderHub 同口径）", () => {
        const catalogs = {
            "conn-1": catalog([
                { name: "gpt-image-1", capabilities: { chat: false, image: true } },
            ]),
        };
        expect(
            chatModelNamesOf(
                connection({ modelDiscovery: "manual", manualModels: ["hand-written"] }),
                catalogs,
            ),
        ).toEqual(["hand-written"]);
        expect(chatModelNamesOf(connection(), catalogs)).toEqual([]);
    });
});
