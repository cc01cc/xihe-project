import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../composables/api", () => ({
    request: vi.fn<typeof import("../../composables/api").request>(),
}));

import { request } from "../../composables/api";
import type { EmbeddingProfileInput } from "../embeddingProfile";
import { saveEmbeddingProfile } from "../embeddingProfile";

/**
 * PLAN-0764 T1.5：实例层保存的 payload 形状必须 = CP 收的形状。
 * CP ConfigService.validateEmbeddingLayer 的判据：payload 恰有一个 `profile` 键，否则
 * 400 INVALID_REQUEST；值再按 embeddingProfiles.parseProfile 解析 providerId/connectionKey/model。
 * 旧 UI 在实例层发 model/dimensions 两键 ⇒ 与这条判据正面冲突。
 */
const mockedRequest = vi.mocked(request);

const profile: EmbeddingProfileInput = {
    providerId: "dashscope-qwen",
    connectionKey: "embedding",
    model: "tongyi-embedding-vision-flash-2026-03-06",
};

beforeEach(() => {
    vi.clearAllMocks();
});

describe("saveEmbeddingProfile payload（PLAN-0764 T1.5）", () => {
    it("instance：PUT /config/instance/embedding，外 {profile}、内三键", async () => {
        await saveEmbeddingProfile("instance", profile);
        expect(mockedRequest).toHaveBeenCalledTimes(1);
        const [path, options] = mockedRequest.mock.calls[0]!;
        expect(path).toBe("/config/instance/embedding");
        expect(options?.method).toBe("PUT");
        const body = JSON.parse(String(options?.body)) as Record<string, string>;
        expect(Object.keys(body)).toEqual(["profile"]);
        expect(body["profile"]).toBe(JSON.stringify(profile));
        const unit = JSON.parse(body["profile"] as string) as Record<string, unknown>;
        expect(Object.keys(unit).sort()).toEqual(["connectionKey", "model", "providerId"]);
    });

    it("user：同一 profile 单元只换层路径（/config/user/embedding）", async () => {
        await saveEmbeddingProfile("user", profile);
        const [path, options] = mockedRequest.mock.calls[0]!;
        expect(path).toBe("/config/user/embedding");
        expect(options?.body).toBe(JSON.stringify({ profile: JSON.stringify(profile) }));
    });

    it("instance clear：PUT 空对象 = 清默认、恢复继承（不把键钉成空串）", async () => {
        await saveEmbeddingProfile("instance", null);
        const [path, options] = mockedRequest.mock.calls[0]!;
        expect(path).toBe("/config/instance/embedding");
        expect(options?.body).toBe("{}");
        expect(String(options?.body)).not.toContain("profile");
    });
});
