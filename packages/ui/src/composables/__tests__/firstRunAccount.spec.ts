import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";

afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
});

describe("first-run account API", () => {
    it("uses POST without retry for disclosure and sends only contract rewrite fields", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({}),
        } as Response);
        await api.discloseFirstRunAccount();
        await api.rewriteFirstRunAccount("example-password", "admin");
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(fetchSpy.mock.calls[0][0]).toBe("/api/v1/bootstrap/first-run-account");
        expect(fetchSpy.mock.calls[0][1]).toEqual(
            expect.objectContaining({ method: "POST", cache: "no-store" }),
        );
        expect(fetchSpy.mock.calls[1][0]).toBe("/api/v1/bootstrap/first-run-account/rewrite");
        expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body))).toEqual({
            password: "example-password",
            username: "admin",
        });
    });
});
