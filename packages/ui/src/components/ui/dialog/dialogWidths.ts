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

/**
 * Sheet（侧边抽屉）的侧向：只有 `left` / `right` 两档宽度语义。
 *
 * <p>`top` / `bottom` 抽屉是「贴边满幅 + 限高」形态，宽度由 `inset-x-0` 决定，不下发宽度 class。</p>
 */
export type SheetSide = "top" | "right" | "bottom" | "left";

/**
 * Sheet 宽度 class —— **档位值仍只从上面那张表取**，这里只加一层「侧向前缀」包装（task-185，Lead 裁定）。
 *
 * <p><b>为什么必须带前缀</b>：vendor SheetContent 的默认宽度写成侧向变体
 * `data-[side=right]:sm:max-w-sm`。调用点给裸 `sm:max-w-lg` 时，两者**不在同一个变体命名空间**，
 * twMerge 不视作冲突 ⇒ 两条都下发；而 `data-[side=right]` 编译出的 `[data-side="right"]` 属性选择器
 * 特异性高于裸 `sm:` 媒体查询 ⇒ 默认 384px 胜出。这就是 task-182 实测「写了 `sm:max-w-lg` 仍是 384」
 * 的机制，也是 Dialog 侧同一类缺口的成因（task-98 / task-137）。</p>
 *
 * <p><b>为什么不另立 `sheetWidths.ts` 第二张表</b>：Sheet 与 Dialog 只是承载面不同，四档语义与 px
 * 完全一致；两张表存同一组数字必然漂移——task-98 时 20 个调用点各自拼四套刻度、宽度照样被默认值
 * 压回窄档，就是前车。所以这里只包一层前缀，宽度值仍然只有 `DIALOG_WIDTH_TIERS` 一处可改。</p>
 */
export function sheetWidthClass(side: SheetSide, tier?: DialogWidthTier | null): string {
    if (side !== "left" && side !== "right") return "";
    return `data-[side=${side}]:` + dialogWidthClass(tier);
}

/** 运行期校验：任意字符串是否为已登记档位（用于 report-only 报警与测试夹具）。 */
export function isDialogWidthTier(value: unknown): value is DialogWidthTier {
    return (
        typeof value === "string" && Object.prototype.hasOwnProperty.call(DIALOG_WIDTH_TIERS, value)
    );
}
