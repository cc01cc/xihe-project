<script setup lang="ts">
import { CheckCircle2, CircleAlert, Clock, ShieldCheck, ShieldX, XCircle } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import MessageItem from "@/features/workspace/chat/components/MessageItem.vue";
import ToolCallCard from "@/features/workspace/chat/components/ToolCallCard.vue";
import SectionShell from "../SectionShell.vue";
import {
    mockLongToolCalls,
    mockMessageSamples,
    mockRefusedToolCall,
    mockSuccessToolCall,
} from "../mockData";
</script>

<template>
    <SectionShell
        id="messages"
        index="02"
        title="消息与工具卡"
        description="MessageItem 原样渲染两种消息；ToolCallCard 原样渲染成功卡与被拒卡（拒绝原因由 CP 的 refusalCode 经本地化文案给出，属 PLAN-0649 观测面）。审批卡当前只有弹窗形态（ApprovalModal），此处用 Card/Badge/Button 组装行内三态，作为待评审的候选形态。"
    >
        <div class="grid grid-cols-2 gap-6">
            <div class="space-y-4">
                <h3 class="text-sm font-medium text-muted-foreground">消息（MessageItem）</h3>
                <div class="space-y-5 rounded-xl border border-border bg-background p-5">
                    <MessageItem
                        v-for="message in mockMessageSamples"
                        :key="message.id"
                        :message="message"
                    />
                </div>
            </div>

            <div class="space-y-4">
                <h3 class="text-sm font-medium text-muted-foreground">
                    工具卡（ToolCallCard · 成功 / 被拒）
                </h3>
                <div class="space-y-3 rounded-xl border border-border bg-background p-4">
                    <ToolCallCard
                        :tool-call="mockSuccessToolCall"
                        @approve="() => {}"
                        @reject="() => {}"
                    />
                    <ToolCallCard
                        :tool-call="mockRefusedToolCall"
                        @approve="() => {}"
                        @reject="() => {}"
                    />
                </div>

                <h3 class="pt-1 text-sm font-medium text-muted-foreground">
                    工具卡 · 真实量级长串（bash 命令 / 绝对路径 / 参数 JSON / runId / 错误码）
                </h3>
                <div
                    class="space-y-3 rounded-xl border border-border bg-background p-4"
                    data-mono-probe="chat-long"
                >
                    <ToolCallCard
                        v-for="call in mockLongToolCalls"
                        :key="call.id"
                        :tool-call="call"
                        initial-expanded
                        @approve="() => {}"
                        @reject="() => {}"
                    />
                </div>

                <h3 class="pt-1 text-sm font-medium text-muted-foreground">
                    审批卡（待批 / 已批 / 已拒）
                </h3>
                <div class="space-y-3">
                    <!-- pending -->
                    <div class="rounded-xl border border-border bg-background p-4">
                        <div class="flex items-center gap-2">
                            <Clock class="size-4 text-muted-foreground" />
                            <span class="text-sm font-medium">需要审批</span>
                            <Badge variant="secondary">待批</Badge>
                            <span class="ml-auto font-mono text-xs text-muted-foreground"
                                >workspace.exec_shell</span
                            >
                        </div>
                        <pre
                            class="mt-2 overflow-x-auto rounded-md bg-muted/60 p-2 font-mono text-xs text-muted-foreground"
                        >
{ "command": "mise run test:ui -- --run" }</pre>
                        <div class="mt-3 flex items-center gap-2">
                            <Button variant="outline" size="sm">拒绝</Button>
                            <Button size="sm">批准并运行</Button>
                            <span class="text-xs text-muted-foreground">2 分钟后超时自动拒绝</span>
                        </div>
                    </div>

                    <!-- approved -->
                    <div class="rounded-xl border border-border bg-background p-4">
                        <div class="flex items-center gap-2">
                            <ShieldCheck class="size-4 text-muted-foreground" />
                            <span class="text-sm font-medium">需要审批</span>
                            <Badge>已批</Badge>
                            <span class="ml-auto text-xs text-muted-foreground">林可 · 10:14</span>
                        </div>
                        <pre
                            class="mt-2 overflow-x-auto rounded-md bg-muted/60 p-2 font-mono text-xs text-muted-foreground"
                        >
{ "command": "pnpm run typecheck" }</pre>
                    </div>

                    <!-- rejected -->
                    <div class="rounded-xl border border-border bg-background p-4">
                        <div class="flex items-center gap-2">
                            <ShieldX class="size-4 text-muted-foreground" />
                            <span class="text-sm font-medium">需要审批</span>
                            <Badge variant="outline">已拒</Badge>
                            <span class="ml-auto text-xs text-muted-foreground">周衡 · 10:16</span>
                        </div>
                        <pre
                            class="mt-2 overflow-x-auto rounded-md bg-muted/60 p-2 font-mono text-xs text-muted-foreground"
                        >
{ "command": "git push origin develop" }</pre>
                        <p class="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                            <CircleAlert class="size-3.5" />
                            拒绝原因：推送不在本会话授权范围
                        </p>
                    </div>
                </div>

                <div
                    class="flex items-start gap-2 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground"
                >
                    <CheckCircle2 class="mt-0.5 size-3.5 shrink-0" />
                    <span>
                        成功卡与被拒卡都是产品组件原样输出；两者的差别只来自 `status` 与
                        `refusalCode`，预览没有为它们加任何 prop。
                    </span>
                </div>
                <div
                    class="flex items-start gap-2 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground"
                >
                    <XCircle class="mt-0.5 size-3.5 shrink-0" />
                    <span
                        >审批卡三态是候选形态（组件尚未存在），需要评审后再决定是否落成产品组件。</span
                    >
                </div>
            </div>
        </div>
    </SectionShell>
</template>
