<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
    Bot,
    ChevronDown,
    CircleHelp,
    Info,
    Lock,
    Plus,
    Shield,
    Sparkles,
    Trash2,
    Users,
} from "@lucide/vue";
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import SectionShell from "../SectionShell.vue";
import { principalNameError } from "../../lib/principalName";
import { mockAgents } from "../mockData";

/**
 * Target shape of the agent panel: `Card` sections, a collapsible create form (with its
 * own "advanced" sub-collapsible), `Badge` for scope/permission/built-in, `Tooltip` for
 * implementation detail that must not occupy permanent space, `Skeleton` for the loading
 * row and a CTA-driven empty state. `Collapsible` comes straight from `reka-ui` — the
 * product has no `components/ui/collapsible` primitive yet (see report).
 */
const { t } = useI18n();
const formOpen = ref(true);
const name = ref("Nova 实现");
/** 2026-11-04 用户裁定：实时校验 + 阻止提交（空格即非法）。 */
const nameError = computed(() => principalNameError(name.value));
const advancedOpen = ref(true);
const showEmpty = ref(true);

const scopeLabel = (scope?: string) =>
    scope === "WORKSPACE" ? "工作区" : scope === "PERSONAL" ? "个人" : "实例";
</script>

<template>
    <SectionShell
        id="agent-panel"
        index="03"
        title="智能体面板（改造后形态）"
        description="Card 分区 + Collapsible 创建表单（含「高级」子折叠）+ Badge（作用域 / 权限 / 内置）+ Tooltip（实现细节）+ Skeleton 加载行 + 空态 CTA；主 CTA 固定在卡片底部。"
    >
        <TooltipProvider>
            <div class="grid grid-cols-[1.25fr_1fr] gap-6">
                <!-- list -->
                <Card class="flex h-[660px] flex-col overflow-hidden">
                    <CardHeader class="border-b border-border/70">
                        <CardTitle class="flex items-center gap-2">
                            <Users class="size-4 text-muted-foreground" />
                            工作区智能体
                            <Badge variant="secondary">3</Badge>
                        </CardTitle>
                        <CardAction>
                            <Button variant="outline" size="sm">
                                <Plus class="size-3.5" />
                                新建
                            </Button>
                        </CardAction>
                    </CardHeader>
                    <CardContent class="min-h-0 flex-1 space-y-2 overflow-y-auto py-4">
                        <div
                            v-for="agent in mockAgents"
                            :key="agent.principalId"
                            class="rounded-lg border border-border p-3"
                            :class="agent.disabled && 'opacity-60'"
                        >
                            <div class="flex items-center gap-2">
                                <div
                                    class="flex size-7 items-center justify-center rounded-md bg-muted"
                                >
                                    <Bot class="size-4 text-muted-foreground" />
                                </div>
                                <span class="text-sm font-medium">{{ agent.name }}</span>
                                <Badge variant="outline">{{ scopeLabel(agent.scope) }}</Badge>
                                <Badge v-if="agent.source === 'instance'" variant="secondary"
                                    >内置</Badge
                                >
                                <Badge v-if="!agent.bound" variant="secondary">未绑定</Badge>
                                <Badge v-if="agent.disabled" variant="secondary">已停用</Badge>
                                <Tooltip>
                                    <TooltipTrigger as-child>
                                        <button
                                            type="button"
                                            class="ml-auto text-muted-foreground hover:text-foreground"
                                            aria-label="实现细节"
                                        >
                                            <CircleHelp class="size-4" />
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent class="max-w-xs">
                                        principalId = {{ agent.principalId }}；模板
                                        {{ agent.templateName ?? "无（自定义）" }}；冻结能力
                                        {{ agent.permissionsSnapshot.length }} 条（CP 快照，UI
                                        不重算）。
                                    </TooltipContent>
                                </Tooltip>
                            </div>
                            <div class="mt-2 flex flex-wrap items-center gap-1.5">
                                <Badge
                                    v-for="atom in agent.permissionsSnapshot"
                                    :key="atom.actionClass"
                                    variant="secondary"
                                    class="font-mono text-[10px]"
                                >
                                    <Shield class="mr-1 size-3" />
                                    {{ atom.actionClass }}
                                </Badge>
                                <span
                                    v-if="agent.permissionsSnapshot.length === 0"
                                    class="text-xs text-muted-foreground"
                                    >无冻结能力上限</span
                                >
                                <span class="ml-auto font-mono text-[11px] text-muted-foreground">
                                    {{ agent.defaultModelProvider ?? "—" }} /
                                    {{ agent.defaultModelName ?? "—" }}
                                </span>
                            </div>
                        </div>

                        <!-- loading row -->
                        <div class="rounded-lg border border-dashed border-border p-3">
                            <div class="flex items-center gap-2">
                                <Skeleton class="size-7 rounded-md" />
                                <Skeleton class="h-4 w-24" />
                                <Skeleton class="h-4 w-14" />
                                <Skeleton class="ml-auto h-4 w-16" />
                            </div>
                            <Skeleton class="mt-2 h-3 w-2/3" />
                        </div>

                        <!-- empty state -->
                        <div
                            v-if="showEmpty"
                            class="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border py-6 text-center"
                        >
                            <Sparkles class="size-6 text-muted-foreground" />
                            <p class="text-sm font-medium">还没有智能体</p>
                            <p class="max-w-xs text-xs text-muted-foreground">
                                智能体需要一个名称与模板；创建后还要在工作区里绑定才能建会话。
                            </p>
                            <Button size="sm" class="mt-1">
                                <Plus class="size-3.5" />
                                创建第一个智能体
                            </Button>
                        </div>
                    </CardContent>
                    <div
                        class="flex items-center justify-between border-t border-border/70 px-4 py-2 text-xs text-muted-foreground"
                    >
                        <span>加载行与空态为同一列表的两种终态</span>
                        <Button variant="ghost" size="sm" @click="showEmpty = !showEmpty">
                            {{ showEmpty ? "隐藏空态" : "显示空态" }}
                        </Button>
                    </div>
                </Card>

                <!-- create form -->
                <Card class="flex h-[660px] flex-col overflow-hidden">
                    <CardHeader class="border-b border-border/70">
                        <CardTitle class="flex items-center gap-2">
                            <Plus class="size-4 text-muted-foreground" />
                            新建智能体
                        </CardTitle>
                        <CardAction>
                            <Button variant="ghost" size="sm" @click="formOpen = !formOpen">
                                {{ formOpen ? "收起" : "展开" }}
                            </Button>
                        </CardAction>
                    </CardHeader>

                    <CollapsibleRoot v-model:open="formOpen">
                        <CollapsibleContent class="min-h-0 flex-1 overflow-y-auto">
                            <CardContent class="space-y-3 py-4">
                                <label class="block space-y-1">
                                    <span class="text-xs font-medium text-muted-foreground"
                                        >名称</span
                                    >
                                    <Input
                                        v-model="name"
                                        placeholder="例如：Nova"
                                        data-testid="preview-agent-name"
                                    />
                                    <span
                                        v-if="nameError"
                                        class="block text-xs text-destructive"
                                        data-testid="preview-agent-name-error"
                                    >
                                        {{
                                            nameError === "required"
                                                ? t("validation.principalNameRequired")
                                                : t("validation.principalNamePattern")
                                        }}
                                    </span>
                                    <span v-else class="block text-xs text-muted-foreground">
                                        {{ t("validation.nameAllowed") }}
                                    </span>
                                </label>
                                <label class="block space-y-1">
                                    <span class="text-xs font-medium text-muted-foreground"
                                        >模板</span
                                    >
                                    <div
                                        class="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
                                    >
                                        <span class="text-muted-foreground">选择模板（可选）</span>
                                        <ChevronDown class="size-4 text-muted-foreground" />
                                    </div>
                                </label>
                                <label class="block space-y-1">
                                    <span class="text-xs font-medium text-muted-foreground"
                                        >作用域</span
                                    >
                                    <div class="flex gap-2">
                                        <Button variant="outline" size="sm">个人</Button>
                                        <Button variant="secondary" size="sm">工作区</Button>
                                        <Button variant="ghost" size="sm" disabled>
                                            <Lock class="size-3.5" />
                                            实例
                                        </Button>
                                    </div>
                                </label>

                                <CollapsibleRoot v-model:open="advancedOpen">
                                    <CollapsibleTrigger as-child>
                                        <button
                                            type="button"
                                            class="flex w-full items-center gap-1.5 rounded-md py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                                        >
                                            <ChevronDown
                                                class="size-3.5 transition-transform"
                                                :class="!advancedOpen && '-rotate-90'"
                                            />
                                            高级
                                        </button>
                                    </CollapsibleTrigger>
                                    <CollapsibleContent class="space-y-3 pt-2">
                                        <div class="grid grid-cols-2 gap-2">
                                            <Input placeholder="默认 provider" />
                                            <Input placeholder="默认 model" />
                                        </div>
                                        <div
                                            class="flex items-start gap-2 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground"
                                        >
                                            <Info class="mt-0.5 size-3.5 shrink-0" />
                                            <span>
                                                允许模型留空 =
                                                不限制；空数组同样按不限制处理，避免误锁死。
                                            </span>
                                        </div>
                                    </CollapsibleContent>
                                </CollapsibleRoot>

                                <div
                                    class="flex items-start gap-2 rounded-md border border-border p-2 text-xs text-muted-foreground"
                                >
                                    <Trash2 class="mt-0.5 size-3.5 shrink-0" />
                                    <span>创建后可停用，不可删除已被会话引用的绑定。</span>
                                </div>
                            </CardContent>
                        </CollapsibleContent>
                    </CollapsibleRoot>

                    <div class="mt-auto border-t border-border/70 p-3">
                        <Button class="w-full" :disabled="!!nameError">
                            <Sparkles class="size-4" />
                            创建智能体
                        </Button>
                        <p class="mt-1.5 text-center text-[11px] text-muted-foreground">
                            {{
                                nameError
                                    ? t("validation.principalNamePattern")
                                    : t("validation.nameAllowed")
                            }}
                        </p>
                    </div>
                </Card>
            </div>
        </TooltipProvider>
    </SectionShell>
</template>
