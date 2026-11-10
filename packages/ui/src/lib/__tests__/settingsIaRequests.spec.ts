import { describe, expect, it } from "vitest";
import {
    configRequestDomain,
    configRequestLayer,
    isConfigRequestForDomain,
    isWorkspaceLayerConfigRequest,
    parseConfigRequest,
} from "../settingsIaRequests";

/**
 * task-230：`isWorkspaceLayerConfigRequest` 的判据单测。
 *
 * <p>这组用例的存在理由不是覆盖率，而是**防回退**：被替换掉的旧写法是
 * `p.includes("/config/workspace/")`，而工作区层的读路径是
 * `/config/<domain>?layer=workspace` —— pathname 里根本没有层段，于是那条断言
 * **恒真**（绿了很久但什么也没验）。下面「反例」组里第一条就是同一 pathname 的
 * user 层读请求：旧写法对它同样返回 false（恒真），新写法必须也 false，
 * 而正例组里的读请求旧写法同样 false（漏判）—— 一正一反同时钉住两个方向。</p>
 */
const BASE = "http://localhost:12630";

describe("isWorkspaceLayerConfigRequest —— 正例（必须识别为工作区层）", () => {
    it("读路径：层在 query（stores/config.ts:277 的真实形态）", () => {
        expect(
            isWorkspaceLayerConfigRequest(
                `${BASE}/api/v1/config/rag?layer=workspace&includeMeta=true`,
            ),
        ).toBe(true);
    });

    it("meta 读路径：/config/<domain>/meta?layer=workspace", () => {
        expect(
            isWorkspaceLayerConfigRequest(
                `${BASE}/api/v1/config/agent-runtime/meta?layer=workspace`,
            ),
        ).toBe(true);
    });

    it("写路径：层在 path 段（域级与单键级都算）", () => {
        expect(isWorkspaceLayerConfigRequest(`${BASE}/api/v1/config/workspace/rag`)).toBe(true);
        expect(
            isWorkspaceLayerConfigRequest(
                `${BASE}/api/v1/config/workspace/agent-runtime/approval-policy.mode`,
            ),
        ).toBe(true);
    });
});

describe("isWorkspaceLayerConfigRequest —— 反例（不得识别为工作区层）", () => {
    it("同一 pathname 的 user 层读请求（旧「前缀」写法无法区分这一条）", () => {
        expect(
            isWorkspaceLayerConfigRequest(`${BASE}/api/v1/config/rag?layer=user&includeMeta=true`),
        ).toBe(false);
    });

    it("缺 layer 的 config 读请求：解析不出层就不猜", () => {
        expect(isWorkspaceLayerConfigRequest(`${BASE}/api/v1/config/rag`)).toBe(false);
        // 层名拼错也不能当成工作区层。
        expect(isWorkspaceLayerConfigRequest(`${BASE}/api/v1/config/rag?layer=workspaces`)).toBe(
            false,
        );
    });

    it("实例层写路径与非 config 请求", () => {
        expect(isWorkspaceLayerConfigRequest(`${BASE}/api/v1/config/instance/llm-provider`)).toBe(
            false,
        );
        expect(isWorkspaceLayerConfigRequest(`${BASE}/api/v1/workspaces/ws-1/settings`)).toBe(
            false,
        );
        // 导入导出不是域请求。
        expect(isWorkspaceLayerConfigRequest(`${BASE}/api/v1/config/export`)).toBe(false);
    });
});

describe("parseConfigRequest —— 层与域的归属", () => {
    it("读路径从 query 取层、域取首个非层段", () => {
        expect(parseConfigRequest(`${BASE}/api/v1/config/logging?layer=instance`)).toEqual({
            layer: "instance",
            domain: "logging",
        });
        expect(configRequestDomain(`${BASE}/api/v1/config/logging/meta?layer=instance`)).toBe(
            "logging",
        );
    });

    it("写路径从 path 段取层与域", () => {
        expect(configRequestLayer(`${BASE}/api/v1/config/workspace/logging`)).toBe("workspace");
        expect(configRequestDomain(`${BASE}/api/v1/config/workspace/logging`)).toBe("logging");
    });

    it("域判定覆盖读 / 读 meta / 写三种形态（logging 只在实例层，见 settingsIa)", () => {
        for (const url of [
            `${BASE}/api/v1/config/logging?layer=instance`,
            `${BASE}/api/v1/config/logging/meta?layer=instance`,
            `${BASE}/api/v1/config/instance/logging`,
            `${BASE}/api/v1/config/instance/logging/some.key`,
        ]) {
            expect(isConfigRequestForDomain(url, "logging"), url).toBe(true);
        }
        expect(
            isConfigRequestForDomain(`${BASE}/api/v1/config/loggingx?layer=instance`, "logging"),
        ).toBe(false);
    });

    it("相对路径（只有 path+search）也能解析", () => {
        expect(configRequestLayer("/api/v1/config/rag?layer=workspace")).toBe("workspace");
    });
});
