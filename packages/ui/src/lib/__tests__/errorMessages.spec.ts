import { describe, expect, it } from "vitest";
import { chatErrorToastText, humanizeErrorCode } from "../errorMessages";

describe("humanizeErrorCode", () => {
    it("maps runtime unavailable to human copy without assuming Docker", () => {
        const runtimeCopy = humanizeErrorCode("RUNTIME_UNAVAILABLE");
        expect(runtimeCopy).toContain("运行时未就绪");
        expect(runtimeCopy).not.toContain("Docker");
        expect(humanizeErrorCode("RUNTIME_ERROR")).toContain("运行时未就绪");
        expect(humanizeErrorCode("MCP_STREAM_UNAVAILABLE")).toContain("Docker");
    });

    it("separates an unknown tool from dependency unavailability", () => {
        expect(humanizeErrorCode("UNKNOWN_TOOL")).toContain("工具不存在");
        expect(humanizeErrorCode("UNKNOWN_TOOL")).not.toContain("运行时");
        expect(humanizeErrorCode("AGENT_UNAVAILABLE")).toContain("Agent");
    });

    it("maps approval terminal states", () => {
        expect(humanizeErrorCode("APPROVAL_REJECTED")).toContain("取消");
        expect(humanizeErrorCode("APPROVAL_EXPIRED")).toContain("过期");
    });

    it("keeps unknown codes visible", () => {
        expect(humanizeErrorCode("SOMETHING", "boom")).toContain("SOMETHING");
        expect(chatErrorToastText("RUNTIME_ERROR")).toContain("RUNTIME_ERROR");
        expect(chatErrorToastText("RUNTIME_ERROR")).toContain("运行时");
    });

    it("maps Workspace Job execution codes to stable UI copy", () => {
        const cases: Record<string, string> = {
            PATH_OUT_OF_SCOPE: "超出工作区范围",
            CAPABILITY_UNAVAILABLE: "能力当前不可用",
            PROCESS_TIMEOUT: "进程执行超时",
            PROCESS_CANCELLED: "进程已取消",
            JOB_BACKEND_LAUNCH_PENDING: "尚未提供 Job 启动器",
            UNMAPPED_ERROR: "未映射具体错误",
        };

        for (const [code, copy] of Object.entries(cases)) {
            expect(humanizeErrorCode(code), code).toContain(copy);
        }
    });
});
