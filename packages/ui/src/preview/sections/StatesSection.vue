<script setup lang="ts">
import { CircleAlert, Inbox, Lock, RefreshCw } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import SectionShell from "../SectionShell.vue";
</script>

<template>
    <SectionShell
        id="states"
        index="07"
        title="四态样张"
        description="空 / 加载中（Skeleton）/ 错误（红条 + 重试）/ 无权限（按钮置灰 + 说明）。四态共用同一卡片骨架，只替换内容区，避免各页各写一套。"
    >
        <div class="grid grid-cols-4 gap-5">
            <!-- empty -->
            <Card class="flex h-[420px] flex-col">
                <CardHeader class="border-b border-border/70">
                    <CardTitle class="text-sm">空</CardTitle>
                </CardHeader>
                <CardContent
                    class="flex flex-1 flex-col items-center justify-center gap-2 text-center"
                >
                    <Inbox class="size-7 text-muted-foreground" />
                    <p class="text-sm font-medium">还没有内容</p>
                    <p class="max-w-[13rem] text-xs text-muted-foreground">
                        空态要给出下一步，而不是只写「暂无数据」。
                    </p>
                    <Button size="sm" class="mt-1">创建第一个</Button>
                </CardContent>
            </Card>

            <!-- loading -->
            <Card class="flex h-[420px] flex-col">
                <CardHeader class="border-b border-border/70">
                    <CardTitle class="text-sm">加载中</CardTitle>
                </CardHeader>
                <CardContent class="flex-1 space-y-3 py-4">
                    <div class="flex items-center gap-2">
                        <Skeleton class="size-8 rounded-md" />
                        <div class="space-y-1.5">
                            <Skeleton class="h-3.5 w-28" />
                            <Skeleton class="h-3 w-20" />
                        </div>
                    </div>
                    <Skeleton class="h-3 w-full" />
                    <Skeleton class="h-3 w-5/6" />
                    <Skeleton class="h-3 w-2/3" />
                    <div class="flex items-center gap-2 pt-2">
                        <Skeleton class="h-8 w-20 rounded-md" />
                        <Skeleton class="h-8 w-20 rounded-md" />
                    </div>
                    <p class="pt-2 text-xs text-muted-foreground">
                        骨架块数与真实行一致，避免加载完成时布局跳动。
                    </p>
                </CardContent>
            </Card>

            <!-- error -->
            <Card class="flex h-[420px] flex-col">
                <CardHeader class="border-b border-border/70">
                    <CardTitle class="text-sm">错误</CardTitle>
                </CardHeader>
                <CardContent class="flex flex-1 flex-col gap-3 py-4">
                    <div
                        class="flex items-start gap-2 rounded-md border border-border bg-muted/50 p-2.5"
                    >
                        <CircleAlert class="mt-0.5 size-4 shrink-0 text-destructive" />
                        <div class="text-xs">
                            <p class="text-sm font-medium text-foreground">加载失败</p>
                            <p class="mt-0.5 text-muted-foreground">
                                RUNTIME_UNAVAILABLE · 运行时未就绪，稍后重试
                            </p>
                        </div>
                    </div>
                    <Button variant="outline" size="sm" class="w-fit">
                        <RefreshCw class="size-3.5" />
                        重试
                    </Button>
                    <p class="mt-auto text-xs leading-relaxed text-muted-foreground">
                        错误条保留 CP 的错误码 + 一句人话；技术细节不上主界面。
                    </p>
                </CardContent>
            </Card>

            <!-- no permission -->
            <Card class="flex h-[420px] flex-col">
                <CardHeader class="border-b border-border/70">
                    <CardTitle class="flex items-center gap-2 text-sm">
                        <Lock class="size-3.5 text-muted-foreground" />
                        无权限
                    </CardTitle>
                </CardHeader>
                <CardContent class="flex flex-1 flex-col gap-3 py-4">
                    <p class="text-sm font-medium">缺少 workspace.file.write</p>
                    <p class="text-xs leading-relaxed text-muted-foreground">
                        需要的能力原子未授予。管理员可在「角色与绑定」页追加，或用只读方式继续。
                    </p>
                    <div class="mt-auto space-y-2">
                        <Button size="sm" class="w-full" disabled>写入并保存</Button>
                        <Button variant="outline" size="sm" class="w-full" disabled>
                            打开设置
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    </SectionShell>
</template>
