import { describe, expect, it } from "vitest";
import { canViewRawHostPath, discloseHostPath } from "../hostPathDisclosure";

// task-1026 要求 4：盘符大小写归一必须收敛在 discloseHostPath 出口，两页同享。
const OWNER = { userId: "owner-1", isInstanceAdmin: false, ownerId: "owner-1" };
const MEMBER = { userId: "member-1", isInstanceAdmin: false, ownerId: "owner-1" };

describe("hostPathDisclosure (task-1026 drive-letter normalization)", () => {
    it("小写盘符归一为大写", () => {
        expect(discloseHostPath("h:/x", OWNER)).toBe("H:/x");
    });

    it("已是大写与 UNC 路径保持原样", () => {
        expect(discloseHostPath("H:/x", OWNER)).toBe("H:/x");
        expect(discloseHostPath("\\\\host\\share", OWNER)).toBe("\\\\host\\share");
    });

    it("非 owner 仍返回 null（归一不放宽披露闸门）", () => {
        expect(canViewRawHostPath(MEMBER)).toBe(false);
        expect(discloseHostPath("h:/x", MEMBER)).toBeNull();
    });
});
