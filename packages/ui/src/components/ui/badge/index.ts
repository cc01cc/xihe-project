import { cva, type VariantProps } from "class-variance-authority";

export { default as Badge } from "./Badge.vue";

export const badgeVariants = cva(
    "h-5 gap-1 rounded-4xl border px-2 py-0.5 text-xs font-medium transition-all has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&>svg]:size-3! group/badge inline-flex w-fit shrink-0 items-center justify-center overflow-hidden whitespace-nowrap focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none",
    {
        variants: {
            variant: {
                default:
                    "border-action-border bg-action text-action-foreground [a]:hover:bg-action/80",
                /* PLAN-0631 色彩方案：中性徽标（底/字/边）独立成 token，C1/C2/C3 只覆盖它。 */
                secondary:
                    "border-badge-border bg-badge text-badge-foreground [a]:hover:bg-badge/80",
                destructive:
                    "border-transparent bg-destructive/10 [a]:hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 text-destructive dark:bg-destructive/20",
                outline:
                    "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
                ghost: "border-transparent hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
                link: "border-transparent text-link underline-offset-4 hover:underline",
            },
        },
        defaultVariants: {
            variant: "default",
        },
    },
);
export type BadgeVariants = VariantProps<typeof badgeVariants>;
