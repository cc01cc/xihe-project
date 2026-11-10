<script setup lang="ts">
import { FolderOpen, Info, Plus, ShieldAlert } from "@lucide/vue";
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from "@/components/ui/empty";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Sheet 06 — the two states that today have no component: empty and permission-denied.
 *
 * **空态文案判据（C-01 + T-04，先写判据再落字）**：一条合格的空态说明要同时回答三件事，且
 * **不许用否定句当主句**（旧文案「本域 0 项配置 … 不建也能用」= 先否定数量、再否定需求，读者
 * 两头都拿不到信息）：
 *   (a) 这里**本来会有什么**（能力存在，不是没有这个功能）；
 *   (b) **现在为什么是空的**（本层还没建 / 可从下层继承 / 需要先有前置物）；
 *   (c) **下一步做什么**（一个主行动 + 一条替代路径）。
 * 标题也不放计数（「0 项配置」是审计口径，不是用户语言）。
 *
 * The right half keeps the product's existing **semantic** split intact (PRODUCT RULE, see
 * packages/ui/AGENTS.md "设置信息架构"): `no-atom` = CP never had this atom, the page still loads;
 * `atom-denied` = 403, the body must not mount. The vendored `Alert` only changes the skin —
 * renaming or merging the two would be a regression, so both are shown with their own wording.
 */
</script>

<template>
    <div class="flex h-full min-h-0">
        <section class="flex min-w-0 flex-1 flex-col border-r border-border">
            <div
                class="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-5"
            >
                <span class="mk-caption font-semibold">空态</span>
                <span class="mk-caption text-muted-foreground">components/ui/empty（vendor）</span>
            </div>
            <div class="flex min-h-0 flex-1 items-center justify-center gap-8 p-10">
                <div class="w-[560px] rounded-lg border border-border">
                    <Empty class="py-14">
                        <EmptyHeader>
                            <EmptyMedia variant="icon">
                                <FolderOpen class="size-5" />
                            </EmptyMedia>
                            <EmptyTitle>实例层还没有模板</EmptyTitle>
                            <EmptyDescription>
                                模板是新建智能体时的**起手式**：选一个能少填几项，团队里新人也照着填。
                                现在这里还是空的 —— 建一个，或创建智能体时直接手填。
                            </EmptyDescription>
                        </EmptyHeader>
                        <EmptyContent>
                            <div class="flex items-center gap-2">
                                <Button size="sm">
                                    <Plus class="size-4" />
                                    新建模板
                                </Button>
                                <Button size="sm" variant="ghost">从 JSON 导入</Button>
                            </div>
                        </EmptyContent>
                    </Empty>
                </div>
                <div class="w-[280px] space-y-3">
                    <p class="mk-caption leading-6 text-muted-foreground">
                        空态的标准四件套：**图标 + 标题 + 一句为什么 + 一个可执行动作**。
                    </p>
                    <p class="mk-caption leading-6 text-muted-foreground">
                        现在的 7 处空态（WorkspacePicker / AgentPrincipalsPanel /
                        AgentRoleBindingsSection ×2 / AgentTemplatesPanel / ConfigDomainPanel ×2）
                        都只有一句灰字 <span class="font-mono">t("settings.empty")</span>。
                    </p>
                </div>
            </div>
        </section>

        <section class="flex min-w-0 flex-1 flex-col">
            <div
                class="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-5"
            >
                <span class="mk-caption font-semibold">权限不足（两种，不可合并）</span>
                <span class="mk-caption text-muted-foreground">components/ui/alert（vendor）</span>
            </div>
            <div class="min-h-0 flex-1 space-y-6 p-10">
                <div>
                    <Badge variant="outline" class="mb-2 font-mono mk-caption"
                        >no-atom（信息条，页面照常取数）</Badge
                    >
                    <Alert>
                        <Info class="size-4" />
                        <AlertTitle>这部分没有对应的权限原子</AlertTitle>
                        <AlertDescription>
                            CP 侧本来就没有
                            <span class="font-mono">provider_connection:read</span>
                            这个原子，所以这里不做拦截——数据照常展示，只是不能改。
                        </AlertDescription>
                    </Alert>
                </div>

                <div>
                    <Badge variant="outline" class="mb-2 font-mono mk-caption"
                        >atom-denied（403 卡片，主体不挂载）</Badge
                    >
                    <Alert variant="destructive">
                        <ShieldAlert class="size-4" />
                        <AlertTitle>缺少原子：MANAGE_ROLES</AlertTitle>
                        <AlertDescription>
                            当前账号没有 <span class="font-mono">instance:roles:manage</span>
                            能力位，角色页不会发起任何请求。
                            <span class="font-semibold">这不是后端缺口</span>——是权限没授到位。
                        </AlertDescription>
                        <AlertAction>
                            <Button size="sm" variant="outline">申请授权</Button>
                        </AlertAction>
                    </Alert>
                </div>

                <p class="mk-caption leading-6 text-muted-foreground">
                    两张卡只换了皮：<span class="font-mono">no-atom</span> 仍然只是信息条（页面照常
                    取数），<span class="font-mono">atom-denied</span> 仍然是 403（主体不挂载、不发
                    无谓请求）。合并这两种语义属于回归。
                </p>
            </div>
        </section>
    </div>
</template>
