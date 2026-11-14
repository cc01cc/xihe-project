import { describe, expect, it } from "vitest";
import { isNonAdminPreviewMode, mockAuthCapabilities } from "../data/previewPermissions";

/**
 * task-227 ⑨ 类 H-11 的截图证据通道：`SettingsForbiddenView` 只在 `capabilities.isInstanceAdmin === false`
 * 时渲染，而 mock 的能力位恒为 true ⇒ 该页面在 mock 车道上没有任何可达路径，截图证据断在这里。
 * 这里钉住新增的 `?nonadmin=1` 门：**只摘一个能力位**（演"少一个能力位"，不是"降成空集"——
 * 后者在 CP 里不存在），且默认形态（无参数 / 只有 ?denied=1）一个字节都不变。
 */
const REFERER = (query: string) => "http://127.0.0.1:5199/settings/instance/rag" + query;

describe("previewPermissions ?nonadmin=1（task-227 H-11 截图通道）", () => {
    it("只在 nonadmin=1 / true 时判定为真，其余查询串与缺失 Referer 都不误伤", () => {
        expect(isNonAdminPreviewMode(REFERER("?nonadmin=1"))).toBe(true);
        expect(isNonAdminPreviewMode(REFERER("?nonadmin=true"))).toBe(true);
        expect(isNonAdminPreviewMode(REFERER(""))).toBe(false);
        // 既有受限形态（?denied=1）不是非管理员形态：它演的是"少了凭据原子"，能力位仍在
        expect(isNonAdminPreviewMode(REFERER("?denied=1"))).toBe(false);
        expect(isNonAdminPreviewMode(REFERER("?nonadmin=0"))).toBe(false);
        expect(isNonAdminPreviewMode(undefined)).toBe(false);
        expect(isNonAdminPreviewMode("not a url")).toBe(false);
    });

    it("mockAuthCapabilities 默认原样返回（引用相等），非管理员时只摘 isInstanceAdmin", () => {
        const caps = { isInstanceAdmin: true, isInstanceSuper: false, manageRoles: true };
        expect(mockAuthCapabilities(caps, false)).toBe(caps);

        const projected = mockAuthCapabilities(caps, true);
        expect(projected).not.toHaveProperty("isInstanceAdmin");
        // 其余能力位保持不变：这不是"降成空集"，是"少一个位"
        expect(projected.isInstanceSuper).toBe(false);
        expect(projected.manageRoles).toBe(true);
        // 入参不被原地改写（默认投影仍是管理员形态，其他镜头不受影响）
        expect(caps.isInstanceAdmin).toBe(true);
    });
});
