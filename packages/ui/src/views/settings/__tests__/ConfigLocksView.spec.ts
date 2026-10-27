import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { i18n } from "../../../i18n";

const request = vi.fn<(path: string, options?: RequestInit) => Promise<unknown>>();
const admin = { value: true };

vi.mock("../../../composables/api", () => ({
    request: (path: string, options?: RequestInit) => request(path, options),
    ApiError: class ApiError extends Error {
        problem: { code: string; detail?: string };
        constructor(problem: { code: string; detail?: string }) {
            super(problem.detail ?? problem.code);
            this.problem = problem;
        }
    },
}));

vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({ isAdmin: admin.value }),
}));

import ConfigLocksView from "../ConfigLocksView.vue";

const catalog = {
    domain: "rag",
    revision: 111,
    keys: [
        {
            key: "chunkSize",
            lockable: true,
            notLockableReason: null,
            locked: true,
            reason: "统一分块",
            mode: "enforce_value",
            updatedBy: "admin",
            updatedAt: "2026-10-27T00:00:00Z",
            revision: 111,
            valuePresent: true,
        },
        {
            key: "topK",
            lockable: true,
            notLockableReason: null,
            locked: false,
            reason: null,
            mode: null,
            updatedBy: null,
            updatedAt: null,
            revision: 0,
            valuePresent: false,
        },
        {
            key: "minScore",
            lockable: false,
            notLockableReason: "ENV_LOCKED",
            locked: false,
            reason: null,
            mode: null,
            updatedBy: null,
            updatedAt: null,
            revision: 0,
            valuePresent: false,
        },
    ],
};

function stubApi() {
    request.mockImplementation((path: string) => {
        if (path.startsWith("/config-locks")) return Promise.resolve(catalog);
        if (path.startsWith("/config/")) return Promise.resolve({ chunkSize: "4096" });
        return Promise.resolve({});
    });
}

async function mountView() {
    const wrapper = mount(ConfigLocksView, { global: { plugins: [i18n] } });
    await flushPromises();
    return wrapper;
}

describe("ConfigLocksView", () => {
    beforeEach(() => {
        admin.value = true;
        request.mockReset();
        stubApi();
    });

    it("renders the catalog with lock state and reasons", async () => {
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="config-lock-table"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="config-lock-row-chunkSize"]').text()).toContain(
            "统一分块",
        );
        expect(wrapper.find('[data-testid="config-lock-badge-chunkSize"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="config-lock-row-topK"]').text()).toContain("未锁定");
        expect(wrapper.find('[data-testid="config-lock-not-lockable-minScore"]').text()).toContain(
            "env 覆盖",
        );
        expect(request).toHaveBeenCalledWith(
            expect.stringContaining("/config-locks?domain=rag"),
            undefined,
        );
    });

    it("renders 403 for non-admin without loading the catalog", async () => {
        admin.value = false;
        const wrapper = await mountView();

        expect(wrapper.find('[data-testid="config-locks-forbidden"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="config-lock-table"]').exists()).toBe(false);
        expect(request).not.toHaveBeenCalled();
    });

    it("submits the lock with the current revision and reason", async () => {
        const wrapper = await mountView();
        await wrapper.find('[data-testid="config-lock-select-topK"]').trigger("click");
        await wrapper.find('[data-testid="config-lock-value-input"]').setValue("7");
        await wrapper.find('[data-testid="config-lock-reason-input"]').setValue("固定召回");
        await wrapper.find('[data-testid="config-lock-save"]').trigger("click");
        await flushPromises();

        expect(request).toHaveBeenCalledWith(
            "/config-locks/rag/topK",
            expect.objectContaining({ method: "PUT" }),
        );
        const init = request.mock.calls.find(([path]) => path === "/config-locks/rag/topK")?.[1];
        expect(JSON.parse(String(init?.body))).toMatchObject({
            mode: "enforce_value",
            reason: "固定召回",
            value: "7",
            revision: 0,
        });
    });

    it("unlocks with clearValue and the row revision", async () => {
        const wrapper = await mountView();
        await wrapper.find('[data-testid="config-lock-select-chunkSize"]').trigger("click");
        await wrapper.find('[data-testid="config-lock-clear-value"]').setValue(true);
        await wrapper.find('[data-testid="config-lock-unlock"]').trigger("click");
        await flushPromises();

        expect(request).toHaveBeenCalledWith(
            "/config-locks/rag/chunkSize?revision=111&clearValue=true",
            expect.objectContaining({ method: "DELETE" }),
        );
    });
});
