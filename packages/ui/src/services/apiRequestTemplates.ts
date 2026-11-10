import { request } from "../composables/api";
import { logger } from "../lib/logger";

export interface TemplateRef {
    // task-253：工作区层移除后，模板引用只可能在实例/用户两层。
    layer: "instance" | "user";
    templateId: string;
    version: number;
}
export interface ApiRequestTemplate {
    id: string;
    version: number;
    name: string;
    description?: string;
    apiTypeId: string;
    apiTypeVersion: number;
    bodySource: string;
    status: "draft" | "published";
}
export interface TemplateOption extends TemplateRef {
    name: string;
    apiTypeId: string;
    apiTypeVersion: number;
}
export interface TemplateDiagnostic {
    code: string;
    path: string;
    message: string;
}
export function parseTemplates(raw?: string): ApiRequestTemplate[] {
    if (!raw) return [];
    try {
        const value: unknown = JSON.parse(raw);
        return Array.isArray(value) ? (value as ApiRequestTemplate[]) : [];
    } catch (cause) {
        logger.warn("Invalid API request template configuration", cause);
        return [];
    }
}
/**
 * 模板引用的稳定键。`layer` 放宽为 string：会话记录（CP `Session.contextTemplateLayer`）
 * 仍可能报历史 workspace 层（契约侧只标 deprecated、未删枚举），UI 不再新增该层绑定，
 * 但读回时必须能如实展示，键也就不该把类型收窄回两层。
 */
export function templateKey(ref: { layer: string; templateId: string; version: number }): string {
    return `${ref.layer}:${ref.templateId}:${ref.version}`;
}
export function validateTemplate(template: ApiRequestTemplate) {
    return request<{ valid: boolean; diagnostics: TemplateDiagnostic[] }>(
        `/api-input-types/${encodeURIComponent(template.apiTypeId)}/versions/${template.apiTypeVersion}/validate`,
        { method: "POST", body: JSON.stringify({ bodySource: template.bodySource }) },
    );
}
export async function readTemplateConfig(layer: TemplateRef["layer"]) {
    const query = new URLSearchParams({ layer, includeMeta: "true" });
    const body = await request<{ entries?: Record<string, string> }>(
        `/config/api-request-templates?${query}`,
    );
    return body.entries ?? {};
}
/** task-253：只列实例 / 用户两层（工作区层调用已从 UI 移除）。 */
export async function listVisibleTemplates(): Promise<TemplateOption[]> {
    const layers: TemplateRef["layer"][] = ["instance", "user"];
    const result = await Promise.all(
        layers.map(async (layer) => {
            const entries = await readTemplateConfig(layer);
            return parseTemplates(entries.templates)
                .filter((item) => item.status === "published")
                .map((item) => ({
                    layer,
                    templateId: item.id,
                    version: item.version,
                    name: item.name,
                    apiTypeId: item.apiTypeId,
                    apiTypeVersion: item.apiTypeVersion,
                }));
        }),
    );
    return result.flat();
}
