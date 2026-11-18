import { describe, expect, it } from "vitest";
import { shallowClone } from "../shallowClone";

describe("shallowClone", () => {
    it("返回新对象：改副本不影响源", () => {
        const source = { a: 1, b: "x" };
        const copy = shallowClone(source);
        copy.a = 2;
        expect(copy).not.toBe(source);
        expect(source.a).toBe(1);
        expect(copy).toEqual({ a: 2, b: "x" });
    });

    it("是浅拷贝：嵌套对象仍共享引用（不许被改成深拷贝）", () => {
        const nested = { deep: 1 };
        const source = { nested };
        const copy = shallowClone(source);
        expect(copy.nested).toBe(nested);
        copy.nested.deep = 9;
        expect(source.nested.deep).toBe(9);
    });

    it("不丢属性、不带上原型外的多余键", () => {
        const source = { id: "p1", allowedModels: [{ provider: "a", name: "b" }] };
        expect(shallowClone(source)).toEqual(source);
        expect(Object.keys(shallowClone(source))).toEqual(["id", "allowedModels"]);
    });
});
