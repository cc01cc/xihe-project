import { describe, expect, it } from "vitest";
import { profileReadiness, usesOwnCredential } from "../llmProfileNotices";
import type { LlmProviderProfile } from "../../../services/llmProviderProfile";
import type { ProviderConnection } from "../../../types/providerConnection";

/**
 * task-385 / task-386（D-1233 / D-1232）：两条判据都是纯函数，正反两侧都钉。
 * 承重负例：① 消费侧漏掉 scope 过滤（WORKSPACE/INSTANCE 行会被误判成「你自己的凭据」）；
 * ② 漏掉 enabled/READY（UNVERIFIED 时运行时回落 INSTANCE，标注就是假的）；
 * ③ 只比 connectionKey 不比 providerId（CP 按四元组找）。去掉任一条这里必红。
 */
const profile: LlmProviderProfile = {
    providerId: "provider-a",
    connectionKey: "key-a",
    model: "model-a",
};

function connection(overrides: Partial<ProviderConnection> = {}): ProviderConnection {
    return {
        id: "conn-1",
        providerId: "provider-a",
        connectionKey: "key-a",
        apiTypeId: "openai",
        apiTypeVersion: 1,
        operation: "chat",
        label: "Connection",
        scope: "USER",
        modelDiscovery: "manual",
        manualModels: ["model-a"],
        hasKey: true,
        enabled: true,
        status: "READY",
        revision: 1,
        ...overrides,
    };
}

describe("profileReadiness（task-385 写入侧：保存后要不要警示）", () => {
    it("无 profile ⇒ null（不警示）", () => {
        expect(profileReadiness(null, [connection()])).toBeNull();
    });

    it("同 key 对且 enabled ∧ READY ⇒ ready（判据②：不警示）", () => {
        expect(profileReadiness(profile, [connection()])).toBe("ready");
    });

    it("UNVERIFIED ⇒ unverified（判据①：警示但保存已成功）", () => {
        expect(profileReadiness(profile, [connection({ status: "UNVERIFIED" })])).toBe(
            "unverified",
        );
    });

    it("READY 但 enabled=false ⇒ unverified（禁用同样解析不了）", () => {
        expect(profileReadiness(profile, [connection({ enabled: false })])).toBe("unverified");
    });

    it("列表里没有该连接 ⇒ ghost", () => {
        expect(profileReadiness(profile, [])).toBe("ghost");
    });

    it("connectionKey 相同但 providerId 不同 ⇒ ghost（匹配键是二元组，不是单 key）", () => {
        expect(profileReadiness(profile, [connection({ providerId: "provider-b" })])).toBe("ghost");
    });

    it("写入侧不过滤 scope：INSTANCE 连接 READY 也算 ready（实例层 profile 引用的就是它）", () => {
        expect(profileReadiness(profile, [connection({ scope: "INSTANCE" })])).toBe("ready");
    });
});

describe("usesOwnCredential（task-386 消费侧：该不该标注用自己的凭据）", () => {
    it("USER ∧ enabled ∧ READY ∧ 同 key 对 ⇒ true", () => {
        expect(usesOwnCredential(profile, [connection()])).toBe(true);
    });

    it("无 profile ⇒ false", () => {
        expect(usesOwnCredential(null, [connection()])).toBe(false);
    });

    it("WORKSPACE 行同 key ⇒ false（T1.5 只找 OWNER_USER，工作区连接不算「你自己的」）", () => {
        expect(usesOwnCredential(profile, [connection({ scope: "WORKSPACE" })])).toBe(false);
    });

    it("INSTANCE 行同 key ⇒ false（管理员视角会命中它，复用 defaultConnection 就会反向）", () => {
        expect(usesOwnCredential(profile, [connection({ scope: "INSTANCE" })])).toBe(false);
    });

    it("USER 但 UNVERIFIED ⇒ false（运行时回落 INSTANCE，标注会是假的）", () => {
        expect(usesOwnCredential(profile, [connection({ status: "UNVERIFIED" })])).toBe(false);
    });

    it("USER 但 disabled ⇒ false", () => {
        expect(usesOwnCredential(profile, [connection({ enabled: false })])).toBe(false);
    });

    it("connectionKey 不同 ⇒ false", () => {
        expect(usesOwnCredential(profile, [connection({ connectionKey: "key-b" })])).toBe(false);
    });

    it("providerId 不同 ⇒ false", () => {
        expect(usesOwnCredential(profile, [connection({ providerId: "provider-b" })])).toBe(false);
    });

    it("混合列表：WORKSPACE + INSTANCE 同 key 在前，USER READY 在后 ⇒ true（过滤不是取第一条）", () => {
        const list = [
            connection({ id: "ws", scope: "WORKSPACE" }),
            connection({ id: "inst", scope: "INSTANCE" }),
            connection({ id: "user", scope: "USER" }),
        ];
        expect(usesOwnCredential(profile, list)).toBe(true);
    });
});
