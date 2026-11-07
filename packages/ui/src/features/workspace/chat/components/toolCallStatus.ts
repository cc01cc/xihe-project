/**
 * PLAN-0688 T1.3: shared status vocabulary and duration formatting for tool-call
 * cards. The dedicated cards consume it through `toolCallVisual.vue`; the generic
 * fallback consumes it directly, so a wire-status/tone change is one edit, not
 * one copy per card.
 */
import { Bot, CheckCircle, Clock, LoaderCircle, XCircle } from "@lucide/vue";
import type { Component } from "vue";

const statusIcons: Record<string, Component> = {
    pending: Clock,
    running: LoaderCircle,
    completed: CheckCircle,
    failed: XCircle,
    cancelled: XCircle,
    approved: CheckCircle,
    rejected: XCircle,
};

const statusTones: Record<string, string> = {
    pending: "text-yellow-500",
    running: "text-blue-500",
    completed: "text-green-500",
    failed: "text-red-500",
    cancelled: "text-muted-foreground",
    approved: "text-green-500",
    rejected: "text-red-500",
};

export function toolStatusIcon(status: string): Component {
    return statusIcons[status] ?? Bot;
}

export function toolStatusTone(status: string): string {
    return statusTones[status] ?? "text-muted-foreground";
}

export function formatToolDuration(startedAt?: string, completedAt?: string): string | null {
    if (!startedAt || !completedAt) return null;
    const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}
