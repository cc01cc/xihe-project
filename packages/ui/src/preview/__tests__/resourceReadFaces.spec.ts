import { describe, expect, it } from "vitest";

import {
    mockCredentialEvents,
    mockCredentialList,
    mockCredentialReferences,
    mockMcpServerStatus,
    mockStdioServers,
} from "../mock/data/resourceReadFaces";

/**
 * task-247：preview mock 的 5 条资源读面夹具的**形状守卫**。
 *
 * <p>为什么单测要管 mock 夹具：这些端点是"让页面进入 `ready`"的唯一来源 —— 夹具形状走形
 * （少 `count`、`state` 用了 openapi 没有的字面量、stdio 配置名与状态 `serverId` 对不上）时，
 * 页面会静默退化成半张页或 `error`，而**没有任何 e2e/单测**覆盖 preview 车道。这里把
 * "开preview 时至少数据面是自洽的"钉成可判定条件；真页面是否 `ready` 由
 * `evidence/2026-11-12-preview-resource-readfaces/verify.json` 的浏览器读数证明。</p>
 *
 * <p>判据边界：本文件**不**测 HTTP 派发（`api-server.ts` 是 vite 插件，挂载点是 dev server）；
 * 端点连通性由证据包里的 `curl` 读数负责。这里只测夹具自身不撒谎。</p>
 */
describe("preview 资源读面夹具（task-247）", () => {
    it("凭据列表：2 条、必填字段齐全、count 与数组一致", () => {
        const list = mockCredentialList("USER");
        expect(list.count).toBe(list.credentials.length);
        expect(list.credentials).toHaveLength(2);
        for (const credential of list.credentials) {
            // openapi `CredentialView.required` + `CredentialSummary.referenceCount`。
            for (const key of [
                "id",
                "label",
                "kind",
                "deliveryTier",
                "ownerType",
                "ownerId",
                "status",
                "fingerprint",
                "revision",
            ] as const) {
                expect(credential[key], `missing ${key}`).toBeTruthy();
            }
            expect(typeof credential.referenceCount).toBe("number");
            expect(["token", "key_pair"]).toContain(credential.kind);
            expect(["lease", "reveal"]).toContain(credential.deliveryTier);
        }
    });

    it("WORKSPACE 层凭据回合法空集（mock 工作区确实没有工作区级凭据）", () => {
        const list = mockCredentialList("WORKSPACE");
        expect(list).toEqual({ credentials: [], count: 0 });
    });

    it("引用/审计都按凭据 id 取：不存在的 id 回 null（调用方 404，不编空集合）", () => {
        expect(mockCredentialReferences("mock-cred-deploy")).toHaveLength(2);
        expect(mockCredentialEvents("mock-cred-deploy", 200)).toHaveLength(2);
        // 第二条凭据是"空态样本"：存在但确实没有引用/事件（页面要能显示空态句）。
        expect(mockCredentialReferences("mock-cred-archive")).toEqual([]);
        expect(mockCredentialEvents("mock-cred-archive", 200)).toEqual([]);
        expect(mockCredentialReferences("no-such-credential")).toBeNull();
        expect(mockCredentialEvents("no-such-credential", 200)).toBeNull();
    });

    it("审计事件的 eventType 只用 openapi 列出的字面量", () => {
        const allowed = [
            "created",
            "replaced",
            "deleted",
            "lease_issued",
            "lease_redeemed",
            "revealed",
        ];
        for (const event of mockCredentialEvents("mock-cred-deploy", 200) ?? []) {
            expect(allowed).toContain(event.eventType);
        }
    });

    it("events 的 limit 生效（截断到请求上限）", () => {
        expect(mockCredentialEvents("mock-cred-deploy", 1)).toHaveLength(1);
    });

    it("stdio 配置与 mcp 状态的 serverId 对得上（否则详情页会 ready 但状态字段全空）", () => {
        const stdio = mockStdioServers();
        const status = mockMcpServerStatus();
        expect(status.count).toBe(status.servers.length);
        const configNames = Object.keys(stdio.servers);
        expect(configNames.length).toBeGreaterThan(0);
        for (const snapshot of status.servers) {
            expect(configNames).toContain(snapshot.serverId);
            // openapi：state 只允许这五个字面量。
            expect(["starting", "ready", "restarting", "failed", "stopped"]).toContain(
                snapshot.state,
            );
            expect(typeof snapshot.attempt).toBe("number");
            expect(typeof snapshot.sinceMs).toBe("number");
            expect(typeof snapshot.epoch).toBe("number");
        }
        // stdio 配置项形状照 CP plainServers 透出的对象（command/args）。
        for (const config of Object.values(stdio.servers)) {
            expect(typeof config.command).toBe("string");
            expect(Array.isArray(config.args)).toBe(true);
        }
        expect(stdio.generation).toBeGreaterThan(0);
        expect(stdio.hash.length).toBeGreaterThan(0);
    });
});
