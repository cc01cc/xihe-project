import { describe, expect, it } from "vitest";

import {
    DENIED_PERMISSION_ATOMS,
    isDeniedPreviewMode,
    mockPermissionProjection,
    PREVIEW_PERMISSION_ATOMS,
} from "../mock/data/previewPermissions";

/**
 * task-249：preview 权限投影夹具（`/me/permissions`）的**名字与切换**守卫。
 *
 * <p>为什么值得单测：权限投影是"页面能不能用"的总闸，错一个原子名会让预览里整页变 403 或整页变
 * 可写，而 preview 车道**没有 e2e/组件测试覆盖**。这里钉三件事：①原子名照 CP 真实目录（尤其
 * `credential_manage` 不许写错大小写/别造名字）；②受限模式**只**扣一个原子、其余照给（否则
 * "403 形态"会变成"整个账号没权限"的假形态）；③`?denied=1` 的判定规则（`Referer` 解析）。</p>
 */
describe("preview 权限投影（task-249）", () => {
    it("默认投影含 credential_manage（与 ToolFaceRegistry.ACTION_CREDENTIAL_MANAGE 逐字相同）", () => {
        const atoms = PREVIEW_PERMISSION_ATOMS.map((atom) => atom.actionClass);
        expect(atoms).toContain("credential_manage");
        // 该页 403 文案点名的是同一个串（`CredentialAdminService` 的守卫原文）。
        expect(atoms).not.toContain("credential_manage@credential:*");
    });

    it("原子清单无重复（重复项在 CP 侧是两条授权，夹具里就是把自己骗了）", () => {
        const atoms = PREVIEW_PERMISSION_ATOMS.map((atom) => atom.actionClass);
        expect(new Set(atoms).size).toBe(atoms.length);
        for (const atom of PREVIEW_PERMISSION_ATOMS) expect(atom.resource).toBe("*");
    });

    it("授权模式：原样给齐全集，capabilities 由调用方透传", () => {
        const body = mockPermissionProjection({ capabilities: ["isInstanceAdmin"], denied: false });
        expect(body.instanceCapabilities).toEqual(["isInstanceAdmin"]);
        expect(body.instancePermissions).toHaveLength(PREVIEW_PERMISSION_ATOMS.length);
        expect(body.instancePermissions.map((atom) => atom.actionClass)).toContain(
            "credential_manage",
        );
    });

    it("受限模式：只扣 credential_manage，其余原子照给（保留真实 403 形态，不变成空权限账号）", () => {
        const body = mockPermissionProjection({ capabilities: ["isInstanceAdmin"], denied: true });
        const atoms = body.instancePermissions.map((atom) => atom.actionClass);
        expect(atoms).not.toContain("credential_manage");
        for (const denied of DENIED_PERMISSION_ATOMS) expect(atoms).not.toContain(denied);
        const expected = PREVIEW_PERMISSION_ATOMS.length - DENIED_PERMISSION_ATOMS.length;
        expect(body.instancePermissions).toHaveLength(expected);
        // 例如 MANAGE_SKILL_LIBRARY 这类别的页要用到的原子必须还在。
        expect(atoms).toContain("MANAGE_SKILL_LIBRARY");
    });

    it("?denied=1 判定：从 Referer 的页面 URL 读，支持 1/true，其余一律授权模式", () => {
        expect(
            isDeniedPreviewMode("http://127.0.0.1:5199/resources/credentials?layer=USER&denied=1"),
        ).toBe(true);
        expect(isDeniedPreviewMode("http://127.0.0.1:5199/resources/credentials?denied=true")).toBe(
            true,
        );
        expect(isDeniedPreviewMode("http://127.0.0.1:5199/resources/credentials?denied=0")).toBe(
            false,
        );
        expect(isDeniedPreviewMode("http://127.0.0.1:5199/resources/credentials?layer=USER")).toBe(
            false,
        );
        expect(isDeniedPreviewMode(undefined)).toBe(false);
        expect(isDeniedPreviewMode("")).toBe(false);
        expect(isDeniedPreviewMode("not-a-url")).toBe(false);
    });
});
