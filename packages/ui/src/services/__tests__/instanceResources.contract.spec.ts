import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BASE } from "../instanceResources";

/**
 * task-38 防再犯门（R1，P0 真栈 404 的成因）：
 *
 * 实例层资源路径是**写死的字符串**，而 mock 夹具当时也有自己的一份 —— 两份各自漂，
 * 结果是「mock 绿、真栈 404」。所以这里直接拿**契约正文**对账：`BASE` 里每个段都必须在
 * `docs/api/openapi.yaml` 里以 `  /api/v1<base>:` 的形式存在。
 *
 * 对账对象选契约而不是 CP 注解，因为契约是 wire 的唯一 SSOT（AGENTS.md API 契约治理段）；
 * CP 与契约不一致时，先红的是契约门而不是这个 spec，两者层次不重复。
 */
// __tests__ → services → src → ui → packages → A03-xihe（5 层），契约在 A03/docs/api/
const OPENAPI_PATH = path.resolve(__dirname, "../../../../../docs/api/openapi.yaml");

describe("实例层资源路径必须出现在契约里（task-38 R1）", () => {
    const openapi = readFileSync(OPENAPI_PATH, "utf8");

    it("agents 段是 /instance/agent-principals（不是 /instance/agents）", () => {
        expect(BASE.agents).toBe("/instance/agent-principals");
    });

    it.each(Object.entries(BASE))("%s 段 %s 在 openapi.yaml 里有对应 path", (_name, relative) => {
        expect(openapi).toContain(`  /api/v1${relative}:`);
    });

    it("UI 里不再有 /instance/agents 这写死的旧路径", () => {
        expect(JSON.stringify(BASE)).not.toContain('"/instance/agents"');
    });
});
