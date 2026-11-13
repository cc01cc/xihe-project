<script setup lang="ts">
import { KeyRound, Lock, Plus, ShieldCheck, UserCog, Users } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import SectionShell from "../SectionShell.vue";
import { mockBindings, mockCredentials, mockRoles } from "../mockData";

/**
 * Credentials + roles/bindings. Rows mirror `Credential` (sanitized metadata only — never
 * a value) and `ApiRole` / `ApiBindingRow`; the empty and no-permission states are the
 * same components in their terminal shapes.
 */
</script>

<template>
    <SectionShell
        id="access"
        index="06"
        title="凭据页 / 角色与绑定页"
        description="凭据列表与「无凭据」空态、角色与绑定列表、以及 403 无权限态。凭据只显示脱敏元数据（指纹/revision/引用数），与真实 DTO 一致；无权限态置灰操作并给出可执行的下一步。"
    >
        <div class="grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] gap-5">
            <div class="space-y-5">
                <!-- credentials list -->
                <Card class="overflow-hidden">
                    <CardHeader class="border-b border-border/70">
                        <CardTitle class="flex items-center gap-2">
                            <KeyRound class="size-4 text-muted-foreground" />
                            凭据
                            <Badge variant="secondary">{{ mockCredentials.length }}</Badge>
                        </CardTitle>
                        <CardAction>
                            <Button variant="outline" size="sm">
                                <Plus class="size-3.5" />
                                新建
                            </Button>
                        </CardAction>
                    </CardHeader>
                    <CardContent class="divide-y divide-border/70 py-0">
                        <div
                            v-for="credential in mockCredentials"
                            :key="credential.id"
                            class="flex items-center gap-3 py-3"
                            :class="credential.status === 'disabled' && 'opacity-60'"
                        >
                            <div
                                class="flex size-8 items-center justify-center rounded-md bg-muted"
                            >
                                <Lock class="size-4 text-muted-foreground" />
                            </div>
                            <div class="min-w-0">
                                <div class="flex items-center gap-2">
                                    <span class="truncate text-sm font-medium">{{
                                        credential.label
                                    }}</span>
                                    <Badge
                                        :variant="
                                            credential.status === 'active' ? 'outline' : 'secondary'
                                        "
                                    >
                                        {{ credential.status === "active" ? "启用" : "已停用" }}
                                    </Badge>
                                </div>
                                <div
                                    class="mt-0.5 flex items-center gap-1.5 font-mono text-xs text-muted-foreground"
                                >
                                    <span>{{ credential.kind }}</span>
                                    <span class="text-border">·</span>
                                    <span>{{ credential.deliveryTier }}</span>
                                    <span class="text-border">·</span>
                                    <span>{{ credential.ownerType }}</span>
                                    <span class="text-border">·</span>
                                    <span>{{ credential.fingerprint }}</span>
                                </div>
                            </div>
                            <div class="ml-auto shrink-0 text-right">
                                <div class="text-xs text-muted-foreground">
                                    引用 {{ credential.referenceCount }}
                                </div>
                                <div class="font-mono text-xs text-muted-foreground">
                                    r{{ credential.revision }}
                                </div>
                            </div>
                        </div>
                    </CardContent>
                    <div
                        class="flex items-center gap-2 border-t border-border/70 px-4 py-2 text-xs text-muted-foreground"
                    >
                        <ShieldCheck class="size-3.5" />
                        删除被引用的凭据返回 409；先换绑再删。
                    </div>
                </Card>

                <div class="grid grid-cols-2 gap-5">
                    <!-- empty state -->
                    <Card class="flex h-[236px] flex-col">
                        <CardHeader>
                            <CardTitle class="text-sm">空态：还没有凭据</CardTitle>
                        </CardHeader>
                        <CardContent
                            class="flex flex-1 flex-col items-center justify-center gap-2 text-center"
                        >
                            <KeyRound class="size-6 text-muted-foreground" />
                            <p class="max-w-[15rem] text-xs text-muted-foreground">
                                连接验证需要一个 key；先建凭据，再在连接里引用它。
                            </p>
                            <Button size="sm" class="mt-1">
                                <Plus class="size-3.5" />
                                新建凭据
                            </Button>
                        </CardContent>
                    </Card>

                    <!-- no permission -->
                    <Card class="flex h-[236px] flex-col">
                        <CardHeader>
                            <CardTitle class="flex items-center gap-2 text-sm">
                                <Lock class="size-3.5 text-muted-foreground" />
                                无权限（403）
                            </CardTitle>
                        </CardHeader>
                        <CardContent class="flex flex-1 flex-col justify-center gap-2">
                            <p class="text-sm font-medium">没有查看凭据的权限</p>
                            <p class="text-xs leading-relaxed text-muted-foreground">
                                需要能力原子 <span class="font-mono">credentials.manage</span>；
                                可请管理员在「角色与绑定」页授权，或联系工作区所有者。
                            </p>
                            <div class="flex gap-2">
                                <Button size="sm" disabled>新建凭据</Button>
                                <Button variant="outline" size="sm" disabled>关联到连接</Button>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </div>

            <!-- roles + bindings -->
            <Card class="overflow-hidden">
                <CardHeader class="border-b border-border/70">
                    <CardTitle class="flex items-center gap-2">
                        <UserCog class="size-4 text-muted-foreground" />
                        角色与绑定
                        <Badge variant="outline">{{ mockBindings.scopeType }}</Badge>
                    </CardTitle>
                    <CardAction>
                        <Button variant="outline" size="sm">
                            <Plus class="size-3.5" />
                            新建角色
                        </Button>
                    </CardAction>
                </CardHeader>
                <CardContent class="space-y-4 py-4">
                    <div>
                        <div class="mb-2 text-xs font-medium text-muted-foreground">
                            角色（能力原子来自 roles/catalog，UI 不硬编码）
                        </div>
                        <div class="space-y-2">
                            <div
                                v-for="role in mockRoles"
                                :key="role.id"
                                class="rounded-lg border border-border p-2.5"
                            >
                                <div class="flex items-center gap-2">
                                    <span class="text-sm font-medium">{{ role.displayName }}</span>
                                    <Badge v-if="role.system" variant="secondary">内置</Badge>
                                    <span class="font-mono text-xs text-muted-foreground">{{
                                        role.name
                                    }}</span>
                                    <Badge variant="outline" class="ml-auto"
                                        >{{ role.bindingCount }} 个绑定</Badge
                                    >
                                </div>
                                <p
                                    v-if="role.description"
                                    class="mt-0.5 text-xs text-muted-foreground"
                                >
                                    {{ role.description }}
                                </p>
                                <div class="mt-1.5 flex flex-wrap gap-1">
                                    <Badge
                                        v-for="atom in role.atoms"
                                        :key="atom.name"
                                        variant="secondary"
                                        class="font-mono text-xs"
                                    >
                                        <ShieldCheck class="mr-1 size-3" />
                                        {{ atom.name }} · {{ atom.scopeClass }}
                                    </Badge>
                                </div>
                            </div>
                        </div>
                    </div>

                    <Separator />

                    <div>
                        <div
                            class="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground"
                        >
                            <Users class="size-3.5" />
                            当前绑定（PUT /bindings 全量替换）
                        </div>
                        <div class="space-y-1.5">
                            <div
                                v-for="binding in mockBindings.bindings"
                                :key="binding.id"
                                class="flex items-center gap-2 rounded-md border border-border px-2.5 py-2"
                            >
                                <Badge variant="outline" class="font-mono text-xs">{{
                                    binding.subjectType
                                }}</Badge>
                                <span class="truncate font-mono text-xs text-muted-foreground">{{
                                    binding.subjectId
                                }}</span>
                                <span class="ml-auto shrink-0 text-xs">{{ binding.roleName }}</span>
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>
        </div>
    </SectionShell>
</template>
