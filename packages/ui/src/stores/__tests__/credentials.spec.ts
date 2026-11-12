import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useCredentialsStore } from "../credentials";
import { api } from "../../composables/api";
import type * as apiModule from "../../composables/api";
import type { CredentialSummary } from "../../types";

vi.mock("../../composables/api", () => ({
    api: {
        listCredentials: vi.fn<typeof apiModule.api.listCredentials>(),
        createCredential: vi.fn<typeof apiModule.api.createCredential>(),
        replaceCredential: vi.fn<typeof apiModule.api.replaceCredential>(),
        deleteCredential: vi.fn<typeof apiModule.api.deleteCredential>(),
    },
}));

const mockedApi = vi.mocked(api, true);

function credential(overrides: Partial<CredentialSummary> = {}): CredentialSummary {
    return {
        id: "11111111-2222-3333-4444-555555555555",
        label: "workspace key",
        kind: "token",
        deliveryTier: "lease",
        ownerType: "WORKSPACE",
        ownerId: "ws-1",
        status: "active",
        fingerprint: "abcdef0123456789abcdef0123456789",
        revision: 1,
        createdAt: "2026-11-12T00:00:00Z",
        replacedAt: null,
        referenceCount: 0,
        ...overrides,
    };
}

describe("credentials store (task-239)", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.clearAllMocks();
        mockedApi.listCredentials.mockResolvedValue({ credentials: [], count: 0 });
    });

    it("sends ownerType + ownerId for the workspace layer", async () => {
        mockedApi.listCredentials.mockResolvedValue({
            credentials: [credential()],
            count: 1,
        });
        const store = useCredentialsStore();

        await store.load("WORKSPACE", "ws-1");

        // task-239 的核心：WORKSPACE 层两参必须同时发出（缺 ownerId ⇒ CP 回落成调用者
        // user id ⇒ 403，task-237 真栈实测）。这条断言的对象就是**构造出的请求参数**，
        // 而 `api.ts:4939-4946` 是该 URL 的唯一构造点 ⇒ 断言入参 ≡ 断言 URL。
        expect(mockedApi.listCredentials).toHaveBeenCalledTimes(1);
        expect(mockedApi.listCredentials).toHaveBeenCalledWith({
            ownerType: "WORKSPACE",
            ownerId: "ws-1",
        });
        expect(store.credentials).toHaveLength(1);
        expect(store.scopeMissing).toBe(false);
    });

    it("does not send a request when the workspace layer has no ownerId", async () => {
        const store = useCredentialsStore();

        await store.load("WORKSPACE");

        // 卡里②的硬要求：无上下文 ⇒ **不发请求**（也不许静默退化成无参调用 ——
        // 无参拿到的是调用者自己的 USER 凭据，标成工作区凭据就是 P1 的反面坑）。
        expect(mockedApi.listCredentials).not.toHaveBeenCalled();
        expect(store.scopeMissing).toBe(true);
        expect(store.credentials).toEqual([]);
        expect(store.loading).toBe(false);
        expect(store.error).toBeNull();
    });

    it("clears scopeMissing again on the next resolvable load", async () => {
        const store = useCredentialsStore();

        await store.load("WORKSPACE");
        expect(store.scopeMissing).toBe(true);

        await store.load("WORKSPACE", "ws-1");
        expect(store.scopeMissing).toBe(false);
        expect(mockedApi.listCredentials).toHaveBeenCalledWith({
            ownerType: "WORKSPACE",
            ownerId: "ws-1",
        });
    });

    it("keeps the user layer unscoped (ownerType only, no ownerId)", async () => {
        const store = useCredentialsStore();

        await store.load("USER");

        expect(mockedApi.listCredentials).toHaveBeenCalledWith({ ownerType: "USER" });
        expect(store.scopeMissing).toBe(false);
    });

    it("keeps the default (unscoped) request unchanged", async () => {
        const store = useCredentialsStore();

        await store.load();

        // 向后兼容：无参仍是 `{}`（服务端按调用者 USER 层归一），面板"不限定层"的路径靠这条。
        expect(mockedApi.listCredentials).toHaveBeenCalledWith({});
    });

    it("leaves the INSTANCE layer untouched (ownerType only)", async () => {
        const store = useCredentialsStore();

        await store.load("INSTANCE");

        // INSTANCE 归 `instance:admin` 门控，且有 ownerId 反而 400 ⇒ 本卡不动这条路径。
        expect(mockedApi.listCredentials).toHaveBeenCalledWith({ ownerType: "INSTANCE" });
        expect(store.scopeMissing).toBe(false);
    });

    it("reloads the same layer after a mutation (既有隐性 bug：旧实现退回 USER 层)", async () => {
        mockedApi.createCredential.mockResolvedValue(credential() as never);
        mockedApi.listCredentials.mockResolvedValue({ credentials: [credential()], count: 1 });
        const store = useCredentialsStore();

        await store.load("WORKSPACE", "ws-1");
        await store.create({ ownerType: "WORKSPACE", ownerId: "ws-1", label: "ws key" } as never);

        // 旧实现 `create` 里是 `await load()`（无参）⇒ 建完工作区凭据后列表会翻回个人层。
        // 新实现按 lastScope 重载 ⇒ 两次请求都带同一个 ownerId，且第二次不是 `{}`。
        const calls = mockedApi.listCredentials.mock.calls;
        expect(calls).toHaveLength(2);
        expect(calls[0]?.[0]).toEqual({ ownerType: "WORKSPACE", ownerId: "ws-1" });
        expect(calls[1]?.[0]).toEqual({ ownerType: "WORKSPACE", ownerId: "ws-1" });
        expect(calls.some(([params]) => Object.keys(params ?? {}).length === 0)).toBe(false);
    });
});
