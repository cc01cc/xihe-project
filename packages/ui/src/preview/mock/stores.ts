import { useAuthStore } from "../../stores/auth";
import { EMPTY_USER_CAPABILITIES } from "../../types";

/**
 * Seeds only the stores the reused **product** components read, so the mock sheets render real
 * components without a backend.
 *
 * `SettingsSidebar` gates its instance groups on `auth.hasInstanceAdminCapability`, and that is a
 * **computed over `user.capabilities`** — a preview must not (and cannot) assign to a computed, so we
 * seed the source value instead. The cast is deliberate and narrow: the sheet needs exactly one
 * capability flag, not a full `User`.
 *
 * `ensureSelfPermissions` is replaced on **this page's store instance** so the components' onMount
 * hook issues no request. Nothing else is stubbed and the component sources are untouched.
 */
export function installMockStores(): void {
    const auth = useAuthStore();
    const adminSeed = {
        capabilities: { ...EMPTY_USER_CAPABILITIES, isInstanceAdmin: true },
    };
    (auth as unknown as { user: typeof adminSeed }).user = adminSeed;
    auth.ensureSelfPermissions = async () => true;
}
