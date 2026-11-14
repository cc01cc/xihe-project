import { describe, expect, it } from "vitest";
import { isUuid, UUID_PATTERN } from "../uuid";

/**
 * task-537：入口判定用到的唯一原语。这里钉的是**形状**语义（CP 只要求形状），
 * 以及三条容易被「顺手放宽」的边界：前后空格、大写、非 UUID 的 slug。
 */
describe("isUuid（task-537 工作区 id 形状判定）", () => {
    it("接受标准 UUID（任意版本位，大小写不敏感）", () => {
        expect(isUuid("19e1c21c-9b93-40d8-94e6-0b371f3c7f19")).toBe(true);
        expect(isUuid("19E1C21C-9B93-40D8-94E6-0B371F3C7F19")).toBe(true);
        expect(isUuid("00000000-0000-0000-0000-000000000000")).toBe(true);
    });

    it("容忍首尾空白（URL/输入框复制常带），但不容忍内部空白", () => {
        expect(isUuid(" 19e1c21c-9b93-40d8-94e6-0b371f3c7f19 ")).toBe(true);
        expect(isUuid("19e1c21c 9b93-40d8-94e6-0b371f3c7f19")).toBe(false);
    });

    it("拒绝真实会撞的形状：slug、截断、超长、非字符串", () => {
        expect(isUuid("workspace-1")).toBe(false);
        expect(isUuid("19e1c21c-9b93-40d8-94e6-0b371f3c7f1")).toBe(false);
        expect(isUuid("19e1c21c-9b93-40d8-94e6-0b371f3c7f190")).toBe(false);
        expect(isUuid("")).toBe(false);
        expect(isUuid(null)).toBe(false);
        expect(isUuid(undefined)).toBe(false);
        expect(isUuid(42)).toBe(false);
    });

    it("UUID_PATTERN 不是带 g 标志的正则（避免 lastIndex 状态导致的间歇性假阴性）", () => {
        expect(UUID_PATTERN.global).toBe(false);
        const value = "19e1c21c-9b93-40d8-94e6-0b371f3c7f19";
        expect(isUuid(value)).toBe(true);
        expect(isUuid(value)).toBe(true);
    });
});
