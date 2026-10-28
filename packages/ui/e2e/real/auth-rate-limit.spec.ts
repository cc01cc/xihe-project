import { expect, test } from "@playwright/test";
import { generateE2EPassword } from "./helpers/password";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();

/**
 * PLAN-0566 T3.4 (D6 ②): asserts the PLAN-0558 register rate limit over the
 * real chain. Run through the runner's ratelimit lane so CP boots with
 * `XIHE_CP_AUTH_LOGIN_REGISTER_MAX_ATTEMPTS=6` and
 * `XIHE_CP_AUTH_TRUSTED_PROXIES=127.0.0.1/32,::1/128`:
 *
 *   node scripts/e2e-host.mjs --auth-lane=ratelimit e2e/real/auth-rate-limit.spec.ts
 *
 * The non-loopback X-Forwarded-For literal is honored (loopback remote is a
 * trusted proxy) and shares one register bucket, so attempt 7 must be
 * throttled with 429 + AUTH_RATE_LIMITED + Retry-After. Without the trusted
 * proxies this assertion would legitimately fail — that gap is the
 * PLAN-0570 IPv6 loopback-exemption defect, intentionally not worked around
 * here.
 */
test.describe("@host Auth register rate limit", () => {
    test("throttles registrations sharing one non-loopback XFF bucket", async ({ request }) => {
        const xff = "203.0.113.77";
        let throttled: Response | null = null;
        for (let attempt = 0; attempt < 8 && throttled === null; attempt += 1) {
            const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
                headers: { "Content-Type": "application/json", "X-Forwarded-For": xff },
                data: {
                    email: `rate-limit-${Date.now()}-${attempt}@test.com`,
                    password: PASSWORD,
                    name: `RateLimit${attempt}`,
                },
            });
            if (response.status() === 429) {
                throttled = response;
                break;
            }
            expect(
                response.ok(),
                `attempt ${attempt}: ${response.status()} ${await response.text()}`,
            ).toBe(true);
        }
        expect(throttled, "register bucket never reached the threshold").toBeTruthy();
        expect(throttled!.status()).toBe(429);
        const problem = (await throttled!.json()) as { code?: string; title?: string };
        expect(problem.code).toBe("AUTH_RATE_LIMITED");
        const retryAfter = Number(throttled!.headers()["retry-after"]);
        expect(Number.isFinite(retryAfter) && retryAfter >= 1).toBe(true);
    });
});
