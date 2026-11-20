/**
 * 对话框宽度档位表 —— **唯一 SSOT**（task-137 / DSD-1507 ①②）。
 *
 * <p><b>为什么要有表</b>：vendor 默认宽度是 `sm:max-w-sm`（384px），业务想改宽必须在 **同一响应式通道**
 * 覆写（`sm:max-w-*`），否则 twMerge 不视作冲突、默认值在 ≥640px 胜出，弹窗被静默压回 384px ——
 * 这就是用户反馈「弹窗都非常窄」的机制（task-98 的成因注释、task-137 的全量盘点）。
 * 与其让每个调用点自己拼 class，不如只允许四个档位，宽度只从这张表取。</p>
 *
 * <p><b>四档（Lead 2026-11-20 裁定）</b>：confirm=sm(384) / form=lg(512) / config=3xl(768) /
 * workbench=5xl(1024)。新弹窗**只能**用这四档；调用点写 `<DialogContent width="config">`，
 * 不再传任何 `max-w-*` 宽度 class（`dialogWidthSmVariants.spec.ts` 硬判）。</p>
 */
export const DIALOG_WIDTH_TIERS = {
    /** 确认/删除类：单句 + 两按钮。 */
    confirm: "sm:max-w-sm",
    /** 单列表单：字段不多、无需横向空间。 */
    form: "sm:max-w-lg",
    /** 多段配置：身份/人设/模型/白名单等多段并排两列（agent 配置、角色编辑器）。 */
    config: "sm:max-w-3xl",
    /** 宽表格 / 编辑器 / 资源预览。 */
    workbench: "sm:max-w-5xl",
} as const;

export type DialogWidthTier = keyof typeof DIALOG_WIDTH_TIERS;

/** 档位对应的 ≥640px 实宽（px）。只用于文档与读数对照，**不要**拿来拼 class。 */
export const DIALOG_WIDTH_TIER_PX: Record<DialogWidthTier, number> = {
    confirm: 384,
    form: 512,
    config: 768,
    workbench: 1024,
};

export const DEFAULT_DIALOG_WIDTH_TIER: DialogWidthTier = "confirm";

/** 档位 ⇒ class。未知档位（运行期传入非法字符串）回落默认档，不静默产出半截 class。 */
export function dialogWidthClass(tier?: DialogWidthTier | null): string {
    if (tier && Object.prototype.hasOwnProperty.call(DIALOG_WIDTH_TIERS, tier)) {
        return DIALOG_WIDTH_TIERS[tier];
    }
    return DIALOG_WIDTH_TIERS[DEFAULT_DIALOG_WIDTH_TIER];
}

/** 运行期校验：任意字符串是否为已登记档位（用于 report-only 报警与测试夹具）。 */
export function isDialogWidthTier(value: unknown): value is DialogWidthTier {
    return (
        typeof value === "string" && Object.prototype.hasOwnProperty.call(DIALOG_WIDTH_TIERS, value)
    );
}
