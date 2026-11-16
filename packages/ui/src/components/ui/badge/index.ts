import { cva, type VariantProps } from "class-variance-authority";

export { default as Badge } from "./Badge.vue";

export const badgeVariants = cva(
    "h-5 gap-1 rounded-4xl border px-2 py-0.5 text-xs font-medium transition-all has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&>svg]:size-3! group/badge inline-flex w-fit shrink-0 items-center justify-center overflow-hidden whitespace-nowrap focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none",
    {
        variants: {
            variant: {
                default:
                    "border-transparent bg-primary text-primary-foreground [a]:hover:bg-primary/80",
                /* PLAN-0631 色彩方案：中性徽标（底/字/边）独立成 token，C1/C2/C3 只覆盖它。 */
                secondary:
                    "border-transparent bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
                /* task-89：本行**故意偏离 upstream shadcn 默认**（upstream = 红底红字 `bg-destructive/10
                   text-destructive`）。原因：浅色主题实测 4.30:1（叠 --card）/ 3.96:1（叠 --background）
                   < 正文 SC 1.4.3 的 4.5。改法与已入库的 `buttonVariants.destructive` 同口径：
                   中性底 + 红描边 + 红字 ⇒ 文字 4.73:1(light) / 6.85:1(dark)。
                   **重新 vendor 时必须手工保留本行**，否则 AA 违例会随同步静默回归。
                   立形靠 `border-destructive/40`（软描边，对 --background 仅 2.11 light / 1.95 dark
                   —— 与 G 批 4 个危险按钮同档，属全仓既有口径，不单独引 1.4.11 结论）。
                   使用面：全仓 61 个 <Badge> 中显式 destructive = 0，唯一入口是 preview
                   ConfigSection:100 的动态 variant（INVALID_CREDENTIALS）。 */
                destructive:
                    "border-destructive/40 bg-background [a]:hover:bg-destructive/10 dark:bg-background dark:[a]:hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 text-destructive",
                outline:
                    "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
                ghost: "border-transparent hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
                link: "border-transparent text-primary underline-offset-4 hover:underline",
            },
        },
        defaultVariants: {
            variant: "default",
        },
    },
);
export type BadgeVariants = VariantProps<typeof badgeVariants>;
