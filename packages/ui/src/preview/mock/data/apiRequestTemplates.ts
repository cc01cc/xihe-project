/**
 * task-459 / D-1306：API 请求模板夹具 —— **impact 面与 config 读面共用这一份**。
 *
 * <p>为什么单独成文件：`ProviderHub.previewTypeChange()` 要两样东西才算整条修好 ——
 * ① `GET /provider-connections/{id}/api-type-change-impact` 的 `compatibleTemplates`；
 * ② `listVisibleTemplates()` 读 `GET /config/api-request-templates?layer=…` 的 `entries.templates`
 * （JSON 字符串 → `parseTemplates` → 再 filter `status==="published"`）。这两样若各写一份常量，
 * 迟早漂移（454/457 已踩过「两处名字不一致」）⇒ 单一事实源在这里，两个消费方都从它派生。</p>
 *
 * <p>形状照 `ApiRequestTemplate`（`openapi.yaml:8189` required = id/version/name/apiTypeId/
 * apiTypeVersion/bodySource/status）。`bodySource` 只用 `spec/fixtures/xh-variables.json` 声明的
 * `${xh.*}` 槽（同文件 :103/:115 有 CP 侧范例）：单遍替换、`$${…}` 出字面量。</p>
 *
 * <p><b>诚实边界</b>：mock 不跑 CP 的模板校验器，也不真发上游请求 —— 这里只保证「UI 拿到的是
 * 契约形状的已发布模板」，不保证模板内容被 CP 接受。<b>故意留一条 draft</b>：UI 侧 `published`
 * 过滤若被绕过，那条会出现在选项里 ⇒ 判据能抓到，而不是只证明「给什么显示什么」。</p>
 */
import type { ApiRequestTemplate } from "../../../services/apiRequestTemplates";

export const API_REQUEST_TEMPLATE_FIXTURE: readonly ApiRequestTemplate[] = [
    {
        id: "9f1c2a70-4b1e-4d2a-9c31-7a5e0b1c2d31",
        version: 1,
        name: "OpenAI Chat 标准请求体",
        description: "切到 openai-chat-completions 时可选的已发布模板（mock 夹具）。",
        apiTypeId: "openai-chat-completions",
        apiTypeVersion: 1,
        bodySource:
            '{"model":"${xh.model}","messages":[{"role":"system","content":"${xh.agent_instructions}"},{"role":"user","content":"${xh.user_input}"}]}',
        status: "published",
    },
    {
        id: "9f1c2a70-4b1e-4d2a-9c31-7a5e0b1c2d32",
        version: 1,
        name: "Anthropic Messages 标准请求体",
        description: "切到 anthropic-messages 时可选的已发布模板（mock 夹具）。",
        apiTypeId: "anthropic-messages",
        apiTypeVersion: 1,
        bodySource:
            '{"model":"${xh.model}","system":"${xh.agent_instructions}","messages":[{"role":"user","content":"${xh.user_input}"}]}',
        status: "published",
    },
    {
        id: "9f1c2a70-4b1e-4d2a-9c31-7a5e0b1c2d33",
        version: 1,
        name: "草稿模板（不应出现在选项里）",
        apiTypeId: "openai-chat-completions",
        apiTypeVersion: 1,
        bodySource: "{}",
        status: "draft",
    },
];

/** 供 `entriesFor("api-request-templates")` 用：CP 的 config string map 里 `templates` 是 JSON 字符串。 */
export function apiRequestTemplateEntries(): Record<string, string> {
    return { templates: JSON.stringify(API_REQUEST_TEMPLATE_FIXTURE) };
}

/**
 * 供 impact 面用：**与 UI `listVisibleTemplates()` 同口径**（published ∧ 类型/版本匹配）。
 * layer 固定 `instance`：mock 的 `mergedEntries` 只给 instance 层夹具（user 层恒 {}，那是另一条轴）。
 */
export function compatibleTemplateOptions(apiTypeId: string, apiTypeVersion: number) {
    return API_REQUEST_TEMPLATE_FIXTURE.filter(
        (item) =>
            item.status === "published" &&
            item.apiTypeId === apiTypeId &&
            item.apiTypeVersion === apiTypeVersion,
    ).map((item) => ({
        layer: "instance" as const,
        templateId: item.id,
        version: item.version,
        name: item.name,
        apiTypeId: item.apiTypeId,
        apiTypeVersion: item.apiTypeVersion,
    }));
}
