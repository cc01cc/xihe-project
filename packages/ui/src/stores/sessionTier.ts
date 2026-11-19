import { defineStore } from "pinia";
import { ref } from "vue";
import { api } from "../composables/api";
import { i18n } from "../i18n";
import { presentCauseError } from "../lib/errorMessages";
import { logger } from "../lib/logger";
import type {
    SessionTier,
    SessionTierDenyReason,
    SessionTierSource,
    SessionTierState,
} from "../types";

/**
 * D-1908（DSD id=1448）会话权限三档的投影。
 *
 * 与 `stores/policy.ts` 同形（load/change/reset + 逐会话 state + 代际守卫），刻意不复用
 * policy store：审批模式（`sessions.approval_mode`）在 D-1908 里已降级为派生，档位是另一个
 * 维度（来源不同、写接口不同、失效条件不同），合并只会把两个失效链缠在一起。
 *
 * `error` 存**可读文案**（瞬时面：控件下方一行内联提示 + 徽标），原始码与英文 detail 只进
 * `logger.warn` —— 与 `stores/policy.ts` 的错误面判定一致。
 */
export interface SessionTierViewState {
    /** 生效档位；`null` = 尚未加载（不是「无权限」）。 */
    tier: SessionTier | null;
    source: SessionTierSource;
    workspaceTier: SessionTier | null;
    canConfigure: boolean;
    denyReason: SessionTierDenyReason | null;
    /** 该工作区执行方式下允许的档位；加载前按「三档全在」占位，避免闪一条越层说明。 */
    available: SessionTier[];
    loading: boolean;
    changing: boolean;
    loaded: boolean;
    error: string | null;
}

const ALL_TIERS: readonly SessionTier[] = ["view", "workspace", "full"];

function createState(): SessionTierViewState {
    return {
        tier: null,
        source: "none",
        workspaceTier: null,
        canConfigure: false,
        denyReason: null,
        available: [...ALL_TIERS],
        loading: false,
        changing: false,
        loaded: false,
        error: null,
    };
}

export const useSessionTierStore = defineStore("sessionTier", () => {
    const states = ref<Record<string, SessionTierViewState>>({}),
        loadPromises = new Map<string, Promise<void>>(),
        mutationGenerations = new Map<string, number>();

    function getState(sessionId: string): SessionTierViewState | undefined {
        return states.value[sessionId];
    }

    function stateFor(sessionId: string): SessionTierViewState {
        const existing = states.value[sessionId];
        if (existing) return existing;
        const created = createState();
        states.value[sessionId] = created;
        return states.value[sessionId]!;
    }

    function errorCopy(cause: unknown, fallback: string): string {
        return presentCauseError(i18n.global.t, cause, fallback).copy;
    }

    /** 把服务端结果投影进 state（读写共用）。 */
    function apply(state: SessionTierViewState, result: SessionTierState): void {
        state.tier = result.tier;
        state.source = result.source;
        state.workspaceTier = result.workspaceTier;
        state.canConfigure = result.canConfigure;
        state.denyReason = result.denyReason;
        state.available = [...result.available];
        state.loaded = true;
    }

    async function load(sessionId: string): Promise<void> {
        if (!sessionId) return;
        const existingRequest = loadPromises.get(sessionId);
        if (existingRequest) return existingRequest;

        const state = stateFor(sessionId);
        if (state.loaded) return;
        const mutationGeneration = mutationGenerations.get(sessionId) ?? 0;
        state.loading = true;
        state.error = null;
        const request = Promise.resolve().then(async () => {
            try {
                const result = await api.getSessionTier(sessionId);
                if ((mutationGenerations.get(sessionId) ?? 0) === mutationGeneration) {
                    apply(state, result);
                }
            } catch (cause) {
                if ((mutationGenerations.get(sessionId) ?? 0) === mutationGeneration) {
                    state.error = errorCopy(cause, i18n.global.t("errors.requestFailed"));
                    logger.warn("Failed to load session tier", cause);
                }
            } finally {
                if (states.value[sessionId] === state) state.loading = false;
                if (loadPromises.get(sessionId) === request) loadPromises.delete(sessionId);
            }
        });
        loadPromises.set(sessionId, request);
        return request;
    }

    /**
     * 改档**不做乐观更新**：写成功后以服务端返回为准，失败时 `state.tier` 仍是旧值
     * ⇒ 选择器天然回滚（D-1908 七：失败必须回到原档位，不能停在用户点的那一档）。
     */
    async function change(sessionId: string, tier: SessionTier): Promise<SessionTierState> {
        const state = stateFor(sessionId),
            generation = (mutationGenerations.get(sessionId) ?? 0) + 1;
        mutationGenerations.set(sessionId, generation);
        state.changing = true;
        state.error = null;
        try {
            const result = await api.setSessionTier(sessionId, tier);
            if (mutationGenerations.get(sessionId) === generation) apply(state, result);
            return result;
        } catch (cause) {
            if (mutationGenerations.get(sessionId) === generation) {
                state.error = errorCopy(cause, i18n.global.t("errors.requestFailed"));
                logger.warn("Failed to change session tier", cause);
            }
            throw cause;
        } finally {
            if (mutationGenerations.get(sessionId) === generation) state.changing = false;
        }
    }

    function reset() {
        states.value = {};
        loadPromises.clear();
        mutationGenerations.clear();
    }

    return { states, getState, stateFor, load, change, reset };
});
