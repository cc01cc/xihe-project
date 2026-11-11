/**
 * task-170 / F-07：API Type 是 CP 目录（`/api-input-types`）里的技术标识，形如
 * `anthropic-messages@1`。设置区正文直接显示裸值等于把 wire 词表端到用户面前，
 * 所以这里只提供**显示名映射**；能力判定/权威仍以目录为准，UI 不据此推断。
 *
 * 未登记的类型**原样返回**（诚实优先，不猜）：新增 API Type 时不会因为漏配词表
 * 而显示错误名字，只会显示技术标识。
 */
const API_TYPE_LABEL_KEYS: Record<string, string> = {
    "openai-chat-completions": "settings.apiTypeOpenaiChatCompletions",
    "anthropic-messages": "settings.apiTypeAnthropicMessages",
    "mimo-responses": "settings.apiTypeMimoResponses",
    "dashscope-generation": "settings.apiTypeDashscopeGeneration",
    "dashscope-multimodal-embedding": "settings.apiTypeDashscopeMultimodalEmbedding",
};

/** i18n 键，或 `null`（未登记 ⇒ 调用方回退到原始 apiTypeId）。 */
export function apiTypeLabelKey(apiTypeId: string | null | undefined): string | null {
    return API_TYPE_LABEL_KEYS[(apiTypeId ?? "").trim()] ?? null;
}
/**
 * 展示用短名：`openai-chat-completions@1` ⇒ `OpenAI 对话补全@1`。
 * 版本号保留（同一 API Type 的多版本行为不同，抹掉会误导）。
 */
export function formatApiType(
    apiTypeId: string | null | undefined,
    version: number | null | undefined,
    translate: (key: string) => string,
): string {
    const id = (apiTypeId ?? "").trim();
    const labelKey = apiTypeLabelKey(id);
    const label = labelKey ? translate(labelKey) : id;
    return version == null ? label : `${label}@${version}`;
}
