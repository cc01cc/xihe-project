/**
 * task-149 A：`config/{domain}/meta` 生成器的**单测**（不起浏览器、不开 server ⇒ 秒级、无端口占用）。
 *
 * <p>**为什么这条必须有**：这个端点是「按域展开」的，域集合来自产品侧 `INSTANCE_DOMAINS`。
 * 手写桩的失效形态是**静默的** —— 新加一个域时没人会想起去补一条 `page.route`，症状出现在
 * 别处（面板少一域、断言红在文案上）。所以判据不是「12 个桩都在」，而是：**给定任意一个域，
 * 路径解析 → 键生成 → 结构齐备 这条链自洽，且域集合与产品侧那份清单一致**。
 */
import { expect, test } from "@playwright/test";
import { INSTANCE_DOMAINS } from "../../src/stores/config";
import { INSTANCE_CONFIG_FIXTURES } from "./helpers/auth";
import {
    API_INPUT_TYPES_FIXTURE,
    CHECKPOINT_RETENTION_FIXTURE,
    CONFIG_KEY_META_FIELDS,
    ORG_UNIT_NODES_FIXTURE,
    PROVIDER_CATALOG_FIXTURE,
    agentTemplatesResponse,
    CONFIG_SOURCE_ENUM,
    buildConfigMetaKeys,
    contextSourcesResponse,
    parseConfigMetaPath,
} from "./helpers/stub-families";
import {
    chatRunCancelProjection,
    chatRunProjection,
    createMockRunRegistry,
    parseChatRunPath,
} from "./helpers/run-registry";

/** 该域的实例夹具转 wire 形态（值一律字符串）——与 auth.ts 里注册路由时的转换同一口径。 */
function wireEntries(domain: string): Record<string, string> {
    const fixture = INSTANCE_CONFIG_FIXTURES[domain] ?? {};
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(fixture)) {
        entries[key] = typeof value === "string" ? value : JSON.stringify(value);
    }
    return entries;
}

test.describe("task-149 A：config/{domain}/meta 按域生成器", () => {
    test("12 域逐条：路径命中 + 键集合来自该域夹具 + 结构逐字段一致", () => {
        // 域集合是产品侧清单（`src/stores/config.ts` 的 INSTANCE_DOMAINS）。
        expect(INSTANCE_DOMAINS.length, "INSTANCE_DOMAINS 至少 12 域").toBeGreaterThanOrEqual(12);
        const seenPaths = new Set<string>();
        for (const domain of INSTANCE_DOMAINS) {
            const pathname = `/api/v1/config/${domain}/meta`;
            expect(parseConfigMetaPath(pathname), `${domain} 的 meta 路径必须被识别`).toBe(domain);
            expect(seenPaths.has(pathname), `${domain} 的路径不得与其它域重复`).toBe(false);
            seenPaths.add(pathname);

            const fixture = INSTANCE_CONFIG_FIXTURES[domain];
            // 缺夹具 = 该域在 mock 车道没有值面 ⇒ meta 只会给空 keys ⇒ 面板渲染不出字段。
            expect(fixture, `${domain} 必须有实例夹具，否则 meta 是空壳`).toBeDefined();
            const entries = wireEntries(domain);
            expect(Object.keys(entries).length, `${domain} 的夹具键不得为空`).toBeGreaterThan(0);

            const keys = buildConfigMetaKeys(entries);
            // ① 键集合与夹具一致（不多不少：多出来的是虚构键，少了的就是「配置项消失」）
            expect(keys.map((item) => item.key).sort()).toEqual(Object.keys(entries).sort());
            // ② 结构逐字段一致：每条 key 的字段清单**完全相同**
            for (const item of keys) {
                expect(Object.keys(item).sort(), `${domain}/${item.key} 字段清单`).toEqual(
                    [...CONFIG_KEY_META_FIELDS].sort(),
                );
                // ③ source 必须落在契约枚举内（openapi.yaml:6357）
                expect(CONFIG_SOURCE_ENUM).toContain(item.source);
                expect(item.locked, "mock 车道无锁事实源 ⇒ 恒 false").toBe(false);
                expect(item.writable, "实例层值可写").toBe(true);
                expect(item.adminLocked, "管理员锁需要事实源，mock 不虚构").toBe(false);
            }
        }
        expect(seenPaths.size, "域数 = 不同 meta 路径数").toBe(INSTANCE_DOMAINS.length);
    });

    test("只认精确的 /meta 尾巴：不误吞配置值请求、不放过更深路径", () => {
        // 配置值请求由另一条桩负责，信封是 map 而不是 { keys } —— 错答会让面板拿不到值。
        expect(parseConfigMetaPath("/api/v1/config/rag")).toBeNull();
        expect(parseConfigMetaPath("/api/v1/config/rag/meta/extra")).toBeNull();
        expect(parseConfigMetaPath("/api/v1/config/RAG/meta"), "域名是小写 kebab").toBeNull();
        expect(parseConfigMetaPath("/api/v1/workspaces/ws-1/members")).toBeNull();
        expect(parseConfigMetaPath("/api/v1/config/rag/meta")).toBe("rag");
    });

    test("未知域不给 keys：路由回 fallback ⇒ 走 404 兜底保住「没桩」可见", () => {
        // 生成器本身对空 entries 是合法的（空 keys）；域是否已知由调用方的夹具表判定，
        // 这里钉住「空集合 ⇒ 空数组」这条，避免有人把空 keys 写成 undefined 让面板抛错。
        expect(buildConfigMetaKeys({})).toEqual([]);
    });
});

test.describe("task-149 B：其余读面族夹具的自洽性（不起浏览器）", () => {
    test("provider-catalog 的每个 apiTypeId 都能在 api-input-types 里查到（跨夹具一致性）", () => {
        const known = new Set(API_INPUT_TYPES_FIXTURE.types.map((item) => item.apiTypeId));
        expect(PROVIDER_CATALOG_FIXTURE.providers.length).toBeGreaterThan(0);
        for (const provider of PROVIDER_CATALOG_FIXTURE.providers) {
            // 空 supportedApiTypes = 这家 provider 一个类型都选不了（弹窗看着能用、其实建不出连接）。
            expect(provider.supportedApiTypes.length, provider.id).toBeGreaterThan(0);
            for (const supported of provider.supportedApiTypes) {
                // 组合校验在 CP（supportedPair）：词表对不上 = UI 通过、真实 CP 400。
                expect(known, provider.id + " -> " + supported.apiTypeId).toContain(
                    supported.apiTypeId,
                );
            }
            expect(known, provider.id + " 的 defaultApiType").toContain(
                provider.defaultApiType.apiTypeId,
            );
        }
    });

    test("org-units：声明 hasChildren 的节点必须真的能在 parentId 查询下返回子级", () => {
        for (const node of ORG_UNIT_NODES_FIXTURE) {
            const children = ORG_UNIT_NODES_FIXTURE.filter((child) => child.parentId === node.id);
            // 声明有子节点却查不到子级 ⇒ 树展开后是空的（UI 只信 hasChildren，不猜）。
            expect(children.length > 0, node.id + " 的 hasChildren 与子级自洽").toBe(
                node.hasChildren,
            );
            if (node.parentId !== null) {
                expect(
                    ORG_UNIT_NODES_FIXTURE.some((parent) => parent.id === node.parentId),
                    node.id + " 的 parentId 指向存在节点",
                ).toBe(true);
            }
        }
    });

    test("checkpoints/retention：四个字段都是非负整数（否则 normalize 会抛）", () => {
        for (const value of Object.values(CHECKPOINT_RETENTION_FIXTURE)) {
            expect(Number.isInteger(value) && value >= 0, String(value)).toBe(true);
        }
        expect(Object.keys(CHECKPOINT_RETENTION_FIXTURE).sort()).toEqual([
            "currentRefs",
            "currentRuns",
            "maxRuns",
            "ttlDays",
        ]);
    });

    test("context sources 是单对象且不带正文；agent-templates 层回显只认三值", () => {
        const sources = contextSourcesResponse("s1");
        expect(Object.keys(sources).sort()).toEqual(["hashPrefix", "sourceKey", "status"]);
        expect(sources.status, "CP 缺省 unknown，不编已加载").toBe("unknown");
        expect(agentTemplatesResponse("workspace", "w1").layer).toBe("workspace");
        expect(agentTemplatesResponse("bogus", null).layer, "非法层回落 instance").toBe("instance");
        expect(agentTemplatesResponse("user", "w1").templates).toEqual([]);
    });
});

test.describe("task-149 B：chat run 登记表", () => {
    test("只服务登记过的 runId：未登记必须查不到（否则就是「任何 id 都回同一个 run」的空转绿）", () => {
        const runs = createMockRunRegistry();
        expect(runs.get("run-never-recorded")).toBeUndefined();
        expect(runs.cancel("run-never-recorded"), "未登记不得被取消成一条幽灵 run").toBeUndefined();
        expect(runs.size).toBe(0);
    });

    test("登记后的 run 带齐 api.ts 硬校验的两个字段，且 sessionId 来自调用方（不另造）", () => {
        const runs = createMockRunRegistry();
        const record = runs.record({ runId: "run-1", sessionId: "session-a" });
        const projection = chatRunProjection(record);
        // api.ts:5259-5265：缺 sessionId 或 origin 会直接抛 ⇒ 这两条是「能查到」的前提。
        expect(projection.sessionId).toBe("session-a");
        expect(projection.origin).toBe("user_submission");
        expect(projection.runId).toBe("run-1");
        expect(runs.size).toBe(1);
    });

    test("取消把状态推到 cancelled，且响应就是 {status, runId}", () => {
        const runs = createMockRunRegistry();
        runs.record({ runId: "run-2", sessionId: "session-b" });
        const cancelled = runs.cancel("run-2");
        expect(cancelled?.status).toBe("cancelled");
        expect(chatRunCancelProjection(cancelled!)).toEqual({
            status: "cancelled",
            runId: "run-2",
        });
        // 查一次也要看到 cancelled（不能在响应里改、表里不改）。
        expect(chatRunProjection(runs.get("run-2")!).status).toBe("cancelled");
    });

    test("路径解析只认 run 本体与 /cancel，别的子资源放行给各自的桩", () => {
        expect(parseChatRunPath("/api/v1/chat/runs/abc")).toEqual({ runId: "abc", action: "get" });
        expect(parseChatRunPath("/api/v1/chat/runs/abc/cancel")).toEqual({
            runId: "abc",
            action: "cancel",
        });
        // 这些子资源有独立桩（guidance / attempts / trace），这里必须返回 null 让它们继续走原路。
        expect(parseChatRunPath("/api/v1/chat/runs/abc/guidance")).toBeNull();
        expect(parseChatRunPath("/api/v1/chat/runs/abc/attempts")).toBeNull();
        expect(parseChatRunPath("/api/v1/chat/runs")).toBeNull();
    });
});
