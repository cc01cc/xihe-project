import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { i18n } from "../../../i18n";
import { api, type ApiPresetGovernanceCompare } from "../../../composables/api";
import type * as apiModule from "../../../composables/api";
import RolePresetDriftDialog from "../RolePresetDriftDialog.vue";

/**
 * task-948 R39（UI 段）：差异四桶完全来自服务端；重新对齐必须先二次确认，回执显示
 * created/deleted；无 `MANAGE_ROLES` 时不出现写按钮。
 */
vi.mock("../../../composables/api", async (importOriginal) => {
    const actual = await importOriginal<typeof apiModule>();
    return {
        ...actual,
        api: {
            ...actual.api,
            comparePresetGovernance: vi.fn<typeof apiModule.api.comparePresetGovernance>(),
            realignPresetGovernance: vi.fn<typeof apiModule.api.realignPresetGovernance>(),
        },
    };
});
const mockedApi = vi.mocked(api, true);

const authState = vi.hoisted(() => ({ canManageRoles: true }));
vi.mock("../../../stores/auth", () => ({
    useAuthStore: () => ({
        get canManageRoles() {
            return authState.canManageRoles;
        },
    }),
}));

const SUBJECT_ID = "11111111-1111-1111-1111-111111111111";

function comparison(
    overrides: Partial<ApiPresetGovernanceCompare> = {},
): ApiPresetGovernanceCompare {
    return {
        subjectType: "user",
        subjectId: SUBJECT_ID,
        scopes: [
            {
                scopeType: "instance",
                scopeId: null,
                missing: [
                    {
                        actionClass: "action:read",
                        resource: "*",
                        originPresetIds: ["22222222-2222-2222-2222-222222222222"],
                    },
                ],
                extra: [{ actionClass: "action:write", resource: "*", originPresetId: null }],
                localAdded: [{ actionClass: "WRITE_INSTANCE_CONTENT", resource: "*" }],
                overridden: [{ actionClass: "action:exec", resource: "*" }],
                inSync: false,
            },
        ],
        summary: { missing: 1, extra: 1, localAdded: 1, overridden: 1, changed: true },
        ...overrides,
    };
}

let wrappers: VueWrapper[] = [];

async function mountDialog(): Promise<VueWrapper> {
    const wrapper = mount(RolePresetDriftDialog, {
        attachTo: document.body,
        props: {
            open: true,
            subjectType: "user",
            subjectId: SUBJECT_ID,
            subjectLabel: "alice@test.com",
            workspaces: [],
        },
        global: { plugins: [i18n] },
    });
    wrappers.push(wrapper);
    await flushPromises();
    return wrapper;
}

function bodyEl<T extends Element>(selector: string): T {
    const el = document.body.querySelector(selector);
    expect(el, `missing ${selector}`).toBeTruthy();
    return el as T;
}

beforeEach(() => {
    vi.clearAllMocks();
    authState.canManageRoles = true;
    mockedApi.comparePresetGovernance.mockResolvedValue(comparison());
    mockedApi.realignPresetGovernance.mockResolvedValue({
        created: 1,
        deleted: 1,
        changed: true,
        scopes: 1,
        source: "assigned",
    });
});

afterEach(() => {
    wrappers.forEach((wrapper) => wrapper.unmount());
    wrappers = [];
    document.body.innerHTML = "";
});

describe("RolePresetDriftDialog · task-948", () => {
    it("renders the server-provided four buckets and never derives a diff locally", async () => {
        await mountDialog();
        expect(mockedApi.comparePresetGovernance).toHaveBeenCalledWith("user", SUBJECT_ID);
        expect(bodyEl('[data-testid="role-preset-drift-bucket-missing"]')).toBeTruthy();
        expect(bodyEl('[data-testid="role-preset-drift-bucket-extra"]')).toBeTruthy();
        expect(bodyEl('[data-testid="role-preset-drift-bucket-localAdded"]')).toBeTruthy();
        expect(bodyEl('[data-testid="role-preset-drift-bucket-overridden"]')).toBeTruthy();
        // Canonical atom names are localized: action:read shows its readable label, not the wire name.
        const missing = bodyEl('[data-testid="role-preset-drift-atom-missing"]');
        expect(missing.textContent).not.toContain("action:read");
        expect(bodyEl('[data-testid="role-preset-drift-realign"]')).toBeTruthy();
    });

    it("requires a second confirmation before calling realign, then shows the receipt", async () => {
        await mountDialog();
        bodyEl<HTMLElement>('[data-testid="role-preset-drift-realign"]').click();
        await flushPromises();
        expect(mockedApi.realignPresetGovernance).not.toHaveBeenCalled();
        expect(bodyEl('[data-testid="role-preset-drift-confirm"]')).toBeTruthy();

        bodyEl<HTMLElement>('[data-testid="role-preset-drift-confirm-realigned"]').click();
        await flushPromises();
        expect(mockedApi.realignPresetGovernance).toHaveBeenCalledWith("user", SUBJECT_ID);
        const receipt = bodyEl('[data-testid="role-preset-drift-receipt"]');
        expect(receipt.textContent).toContain("1");
    });

    it("反证：服务端返回空对比时不出四桶、不显示重新对齐", async () => {
        mockedApi.comparePresetGovernance.mockResolvedValue(
            comparison({
                scopes: [],
                summary: { missing: 0, extra: 0, localAdded: 0, overridden: 0, changed: false },
            }),
        );
        await mountDialog();
        // Empty scopes ⇒ no scope section at all; the in-sync banner is the only state shown.
        expect(
            document.body.querySelector('[data-testid="role-preset-drift-atom-missing"]'),
        ).toBeNull();
        expect(bodyEl('[data-testid="role-preset-drift-in-sync"]')).toBeTruthy();
        expect(document.body.querySelector('[data-testid="role-preset-drift-realign"]')).toBeNull();
    });

    it("hides the write affordances when the caller lacks MANAGE_ROLES", async () => {
        authState.canManageRoles = false;
        await mountDialog();
        expect(document.body.querySelector('[data-testid="role-preset-drift-realign"]')).toBeNull();
        expect(document.body.querySelector('[data-testid="role-preset-drift-refresh"]')).toBeNull();
        expect(bodyEl('[data-testid="role-preset-drift-close"]')).toBeTruthy();
    });
});
