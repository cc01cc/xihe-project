import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    listInstanceAgents,
    listInstanceCredentials,
    listInstanceMcpServers,
} from "../instanceResources";
import { wireStateOf } from "../fieldState";

/**
 * task-42：三态（值 / 键在但空 / 键不在）在服务层就必须分得清。
 *
 * <p>为什么这条要单独钉：normalizeCredential 会给缺席的 revision 填 1、给缺席的 enabled 填 true、
 * 把 referenceCount 缺席填成 0 —— 这些默认值是面板依赖的既有行为（本卡不动），但它们让
 * 「后端没返回」与「后端返回了 0/1/true」在 DTO 上完全一样。states 是唯一还分得清的地方，
 * 所以本 spec 三态都断言：只断一侧就退化成「只测了有值」。</p>
 *
 * <p>阳性对照（D-1182）：同一条用例里既断 absent，也断同一字段的 value/empty —— 只断「缺席时是
 * absent」而不证明「有值时不是 absent」的写法，把实现写成常量也能过。</p>
 */

const api = vi.hoisted(() => ({ request: vi.fn<(path: string) => Promise<unknown>>() }));

vi.mock("../../composables/api", () => ({ request: api.request }));

beforeEach(() => {
    vi.clearAllMocks();
});

describe("wireStateOf —— 三态判据本身", () => {
    it("值 / 空 / 缺席 三种都判对（含 alias 键与空数组）", () => {
        expect(wireStateOf({ a: 1 }, ["a"])).toBe("value");
        expect(wireStateOf({ a: 0 }, ["a"])).toBe("value");
        expect(wireStateOf({ a: false }, ["a"])).toBe("value");
        expect(wireStateOf({ a: null }, ["a"])).toBe("empty");
        expect(wireStateOf({ a: "" }, ["a"])).toBe("empty");
        expect(wireStateOf({ a: [] }, ["a"])).toBe("empty");
        expect(wireStateOf({}, ["a"])).toBe("absent");
        expect(wireStateOf({ b: "x" }, ["a"])).toBe("absent");
        expect(wireStateOf(null, ["a"])).toBe("absent");
    });

    it("alias 键：任一有值即 value，都在但都空才是 empty", () => {
        expect(wireStateOf({ name: "n" }, ["label", "name"])).toBe("value");
        expect(wireStateOf({ label: "l", name: "n" }, ["label", "name"])).toBe("value");
        expect(wireStateOf({ label: "", name: "" }, ["label", "name"])).toBe("empty");
        expect(wireStateOf({ other: 1 }, ["label", "name"])).toBe("absent");
    });
});

describe("实例层 DTO 的 states（值是默认值，三态另存）", () => {
    it("凭据：revision 缺席 ⇒ states.revision = absent，而 DTO 的 revision 仍是默认 1", async () => {
        api.request.mockResolvedValue({
            credentials: [{ id: "c1", label: "实例令牌", kind: "token", deliveryTier: "reveal" }],
        });
        const { credentials } = await listInstanceCredentials();
        const row = credentials[0];
        expect(row.revision).toBe(1);
        expect(row.states.revision).toBe("absent");
        expect(row.states.replacedAt).toBe("absent");
        expect(row.states.label).toBe("value");
    });

    it("凭据：revision=0 与 revision=null 分别是 value 与 empty（不靠数字判真假）", async () => {
        api.request.mockResolvedValue({
            credentials: [
                { id: "c1", label: "甲", revision: 0 },
                { id: "c2", label: "乙", revision: null },
            ],
        });
        const { credentials } = await listInstanceCredentials();
        expect(credentials[0].states.revision).toBe("value");
        expect(credentials[1].states.revision).toBe("empty");
    });

    it("智能体：disabled 缺席 ⇒ absent（面板仍按 false 渲染「否」）", async () => {
        api.request.mockResolvedValue({
            agents: [{ id: "p1", name: "审计员" }],
        });
        const { agents } = await listInstanceAgents();
        expect(agents[0].disabled).toBe(false);
        expect(agents[0].states.disabled).toBe("absent");
        expect(agents[0].states.description).toBe("absent");
    });

    it("MCP：enabled 缺席 ⇒ absent；载荷里出现 enabled=false ⇒ value", async () => {
        api.request.mockResolvedValue({
            servers: [
                { name: "s1", transport: "stdio" },
                { name: "s2", transport: "http", enabled: false },
            ],
        });
        const { servers } = await listInstanceMcpServers();
        expect(servers[0].enabled).toBe(true);
        expect(servers[0].states.enabled).toBe("absent");
        expect(servers[1].enabled).toBe(false);
        expect(servers[1].states.enabled).toBe("value");
    });
});
