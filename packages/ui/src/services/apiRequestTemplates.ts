import { request } from "../composables/api";
import { logger } from "../lib/logger";

export interface TemplateRef {
    layer: "instance" | "user" | "workspace";
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
export function templateKey(ref: TemplateRef): string {
    return `${ref.layer}:${ref.templateId}:${ref.version}`;
}
export function validateTemplate(template: ApiRequestTemplate) {
    return request<{ valid: boolean; diagnostics: TemplateDiagnostic[] }>(
        `/api-input-types/${encodeURIComponent(template.apiTypeId)}/versions/${template.apiTypeVersion}/validate`,
        { method: "POST", body: JSON.stringify({ bodySource: template.bodySource }) },
    );
}
export async function readTemplateConfig(layer: TemplateRef["layer"], workspaceId?: string) {
    const query = new URLSearchParams({ layer, includeMeta: "true" });
    if (workspaceId) query.set("workspaceId", workspaceId);
    const body = await request<{ entries?: Record<string, string> }>(
        `/config/api-request-templates?${query}`,
    );
    return body.entries ?? {};
}
export async function listVisibleTemplates(workspaceId?: string): Promise<TemplateOption[]> {
    const layers: TemplateRef["layer"][] = [
        "instance",
        "user",
        ...(workspaceId ? ["workspace" as const] : []),
    ];
    const result = await Promise.all(
        layers.map(async (layer) => {
            const entries = await readTemplateConfig(layer, workspaceId);
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
