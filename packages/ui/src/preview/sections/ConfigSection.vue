<script setup lang="ts">
import { computed, ref } from "vue";
import {
    CheckCircle2,
    CircleAlert,
    CircleSlash,
    FileCode2,
    Link2,
    PlayCircle,
    RefreshCw,
    Send,
} from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import SectionShell from "../SectionShell.vue";
import { mockApiTypes, mockConnections, mockRequestTemplates } from "../mockData";

/**
 * Provider connections + API request templates. Status vocabulary is the real
 * `ProviderConnectionStatus` (`READY` / `INVALID_CREDENTIALS` / `UNVERIFIED` / …);
 * template rows use the real `ApiRequestTemplate` shape (`apiTypeId` + `apiTypeVersion` +
 * `status: draft | published`).
 */
const selectedId = ref(mockConnections[0]?.id);
const selected = computed(() => mockConnections.find((row) => row.id === selectedId.value));
const drafts = computed(() => mockRequestTemplates.filter((row) => row.status === "draft"));

const statusTone = (status: string) => {
    if (status === "READY") return { label: "READY", variant: "default" as const };
    if (status === "INVALID_CREDENTIALS")
        return { label: "凭据无效", variant: "destructive" as const };
    if (status === "UNVERIFIED") return { label: "未验证", variant: "outline" as const };
    if (status === "DISABLED") return { label: "已停用", variant: "secondary" as const };
    return { label: status, variant: "secondary" as const };
};
</script>

<template>
    <SectionShell
        id="config"
        index="05"
        title="配置页：连接与 API 请求模板"
        description="ProviderHub 形态（连接列表 + 详情 + 验证状态 READY / 凭据无效）与 API 请求模板面板（API 类型 + 版本 + 草稿/发布）。字段名对齐 openapi.yaml 的 provider-connections 与 config/api-request-templates。"
    >
        <div class="grid grid-cols-[320px_minmax(0,1fr)_minmax(0,1fr)] gap-5">
            <!-- connections -->
            <Card class="flex h-[660px] flex-col overflow-hidden">
                <CardHeader class="border-b border-border/70">
                    <CardTitle class="flex items-center gap-2">
                        <Link2 class="size-4 text-muted-foreground" />
                        连接
                        <Badge variant="secondary">{{ mockConnections.length }}</Badge>
                    </CardTitle>
                    <CardAction>
                        <Button variant="ghost" size="sm">新建</Button>
                    </CardAction>
                </CardHeader>
                <CardContent class="min-h-0 flex-1 space-y-1.5 overflow-y-auto py-3">
                    <button
                        v-for="connection in mockConnections"
                        :key="connection.id"
                        type="button"
                        class="w-full rounded-lg border p-2.5 text-left transition-colors"
                        :class="
                            connection.id === selectedId
                                ? 'border-border bg-muted/60'
                                : 'border-transparent hover:bg-muted/40'
                        "
                        @click="selectedId = connection.id"
                    >
                        <div class="flex items-center gap-2">
                            <span class="truncate text-sm font-medium">{{ connection.label }}</span>
                            <Badge
                                :variant="statusTone(connection.status).variant"
                                class="ml-auto shrink-0"
                            >
                                {{ statusTone(connection.status).label }}
                            </Badge>
                        </div>
                        <div
                            class="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground"
                        >
                            <span class="font-mono">{{ connection.providerId }}</span>
                            <span class="text-border">·</span>
                            <span class="font-mono">{{ connection.apiTypeId }}</span>
                            <span class="font-mono">v{{ connection.apiTypeVersion }}</span>
                        </div>
                    </button>
                </CardContent>
                <div class="border-t border-border/70 px-3 py-2 text-[11px] text-muted-foreground">
                    连接弹窗只做「输入 key 快速新建凭据」；换绑在凭据页完成。
                </div>
            </Card>

            <!-- connection detail -->
            <Card class="flex h-[660px] flex-col overflow-hidden">
                <CardHeader class="border-b border-border/70">
                    <CardTitle class="flex items-center gap-2">
                        {{ selected?.label }}
                        <Badge v-if="selected" :variant="statusTone(selected.status).variant">
                            {{ statusTone(selected.status).label }}
                        </Badge>
                    </CardTitle>
                    <CardAction>
                        <Button variant="outline" size="sm">
                            <RefreshCw class="size-3.5" />
                            验证
                        </Button>
                    </CardAction>
                </CardHeader>
                <CardContent class="min-h-0 flex-1 space-y-3 overflow-y-auto py-4 text-sm">
                    <div class="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2">
                        <span class="text-muted-foreground">baseUrl</span>
                        <span class="truncate font-mono text-xs">{{
                            selected?.baseUrl ?? "—"
                        }}</span>
                        <span class="text-muted-foreground">API 类型</span>
                        <span class="font-mono text-xs">
                            {{ selected?.apiTypeId }} · v{{ selected?.apiTypeVersion }}
                        </span>
                        <span class="text-muted-foreground">模型发现</span>
                        <span class="font-mono text-xs">{{ selected?.modelDiscovery }}</span>
                        <span class="text-muted-foreground">凭据</span>
                        <span class="font-mono text-xs">{{ selected?.maskedKey ?? "无" }}</span>
                        <span class="text-muted-foreground">作用域</span>
                        <span class="font-mono text-xs">{{ selected?.scope }}</span>
                        <span class="text-muted-foreground">revision</span>
                        <span class="font-mono text-xs">{{ selected?.revision }}</span>
                    </div>

                    <Separator />

                    <div
                        v-if="selected?.status === 'READY'"
                        class="flex items-start gap-2 rounded-md bg-muted/50 p-2.5 text-xs text-muted-foreground"
                    >
                        <CheckCircle2 class="mt-0.5 size-4 shrink-0" />
                        <span>
                            最近验证 2026-11-03 09:50 · 模型列表已同步 42 个；连接可用于会话。
                        </span>
                    </div>
                    <div
                        v-else-if="selected?.status === 'INVALID_CREDENTIALS'"
                        class="flex items-start gap-2 rounded-md border border-border p-2.5 text-xs"
                    >
                        <CircleAlert class="mt-0.5 size-4 shrink-0 text-destructive" />
                        <span class="text-muted-foreground">
                            凭据无效（PROVIDER_CREDENTIAL_INVALID）。请到凭据页替换密钥，或提高该
                            key 的模型列表权限后重试验证。
                        </span>
                    </div>
                    <div
                        v-else
                        class="flex items-start gap-2 rounded-md bg-muted/50 p-2.5 text-xs text-muted-foreground"
                    >
                        <CircleSlash class="mt-0.5 size-4 shrink-0" />
                        <span>未验证：保存 key 后立刻验证一次，失败不影响已保存的配置。</span>
                    </div>

                    <div
                        class="rounded-md border border-border p-2.5 text-xs text-muted-foreground"
                    >
                        <div class="mb-1 font-medium text-foreground">可用 API 类型（目录）</div>
                        <div
                            v-for="apiType in mockApiTypes"
                            :key="apiType.apiTypeId + apiType.version"
                            class="flex items-center justify-between py-0.5 font-mono"
                        >
                            <span>{{ apiType.apiTypeId }}</span>
                            <span>v{{ apiType.version }}</span>
                        </div>
                    </div>
                </CardContent>
                <div class="flex items-center gap-2 border-t border-border/70 px-4 py-2.5">
                    <Button size="sm">
                        <PlayCircle class="size-3.5" />
                        验证连接
                    </Button>
                    <Button variant="ghost" size="sm">编辑</Button>
                    <span class="ml-auto text-[11px] text-muted-foreground"
                        >保存必须等真实 PUT 200</span
                    >
                </div>
            </Card>

            <!-- request templates -->
            <Card class="flex h-[660px] flex-col overflow-hidden">
                <CardHeader class="border-b border-border/70">
                    <CardTitle class="flex items-center gap-2">
                        <FileCode2 class="size-4 text-muted-foreground" />
                        API 请求模板
                        <Badge variant="secondary">{{ drafts.length }} 份草稿</Badge>
                    </CardTitle>
                    <CardAction>
                        <Button variant="outline" size="sm">
                            <Send class="size-3.5" />
                            发布
                        </Button>
                    </CardAction>
                </CardHeader>
                <CardContent class="min-h-0 flex-1 space-y-2 overflow-y-auto py-3">
                    <div
                        v-for="template in mockRequestTemplates"
                        :key="template.id + template.version"
                        class="rounded-lg border border-border p-2.5"
                    >
                        <div class="flex items-center gap-2">
                            <span class="truncate text-sm font-medium">{{ template.name }}</span>
                            <Badge
                                :variant="template.status === 'draft' ? 'secondary' : 'outline'"
                                class="ml-auto shrink-0"
                            >
                                {{ template.status === "draft" ? "草稿" : "已发布" }}
                            </Badge>
                        </div>
                        <div
                            class="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground"
                        >
                            <span>{{ template.apiTypeId }}</span>
                            <span class="text-border">·</span>
                            <span>API v{{ template.apiTypeVersion }}</span>
                            <span class="text-border">·</span>
                            <span>模板 v{{ template.version }}</span>
                        </div>
                        <p
                            v-if="template.description"
                            class="mt-1 line-clamp-2 text-xs text-muted-foreground"
                        >
                            {{ template.description }}
                        </p>
                        <div class="mt-1.5 flex items-center gap-1.5">
                            <Badge variant="secondary" class="font-mono text-[10px]">
                                {{ template.status === "draft" ? "未发布" : "生效中" }}
                            </Badge>
                            <Button variant="ghost" size="sm" class="h-6 px-2 text-[11px]">
                                校验
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                class="h-6 px-2 text-[11px]"
                                :disabled="template.status === 'published'"
                            >
                                发布此版本
                            </Button>
                        </div>
                    </div>
                </CardContent>
                <div
                    class="border-t border-border/70 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground"
                >
                    发布诊断来自 CP validator；UI 只展示，不自动修复模板原文。
                </div>
            </Card>
        </div>
    </SectionShell>
</template>
