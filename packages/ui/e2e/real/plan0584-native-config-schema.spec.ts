import { expect, test, type APIRequestContext } from "@playwright/test";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`,
    ADMIN_EMAIL = "admin@xihe.local";

// `logging` is not writable at the user layer (`ConfigService.USER_WRITABLE_DOMAINS`
// omits it: log levels are an instance-level operations concern), so this schema
// check runs on the ADMIN-only instance layer — the layer the settings page writes
// for instance-level log levels.
async function loginAsAdmin(request: APIRequestContext) {
    const password = process.env.XIHE_E2E_ADMIN_PASSWORD ?? "",
        login = await request.post(`${CP_URL}/api/v1/auth/login`, {
            data: { identifier: ADMIN_EMAIL, password },
        }),
        body = (await login.json()) as { accessToken?: string };
    expect(password, "XIHE_E2E_ADMIN_PASSWORD must be provided by e2e-host").not.toBe("");
    expect(login.ok(), `admin login returned HTTP ${login.status()}`).toBe(true);
    expect(body.accessToken, "admin login must return a non-empty accessToken").toBeTruthy();
    return body.accessToken as string;
}

// Plain USER (role=USER) token for the authorization-boundary assertions.
async function registerPlainUser(request: APIRequestContext) {
    const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: {
                email: `plan0584-auth-${Date.now()}@test.local`,
                password: "Pl4n0584-Auth!aB9",
                name: "PLAN-0584 Auth Boundary",
            },
        }),
        body = (await response.json()) as { accessToken?: string };
    expect(response.status(), `registration returned ${response.status()}`).toBe(201);
    expect(body.accessToken, "registration must return a non-empty accessToken").toBeTruthy();
    return body.accessToken as string;
}

test("@host PLAN-0584 native CP validates config schema through HTTP", async ({ request }) => {
    const token = await loginAsAdmin(request),
        headers = { Authorization: `Bearer ${token}` },
        valid = await request.put(`${CP_URL}/api/v1/config/instance/logging`, {
            headers,
            data: { logLevel: "INFO" },
        }),
        validBody = await valid.json();
    expect(valid.status()).toBe(200);
    expect(validBody).toMatchObject({ status: "ok", keys: 1 });

    {
        const invalid = await request.put(`${CP_URL}/api/v1/config/instance/logging`, {
                headers,
                data: { unknownKey: "must be rejected" },
            }),
            invalidBody = await invalid.json();
        expect(invalid.status()).toBe(400);
        expect(invalidBody).toMatchObject({ code: "INVALID_REQUEST" });
    }
});

// T3.2 authorization boundary: the native image must reject an anonymous write and a
// role-insufficient write with the same shapes as the JVM build (probed on an isolated
// native CP: 401 AUTHORIZATION_REQUIRED / 403 FORBIDDEN).
test("@host PLAN-0584 native CP rejects anonymous and under-privileged config writes", async ({
    request,
}) => {
    const anonymous = await request.put(`${CP_URL}/api/v1/config/instance/logging`, {
            data: { logLevel: "INFO" },
        }),
        anonymousBody = await anonymous.json();
    expect(anonymous.status()).toBe(401);
    expect(anonymousBody).toMatchObject({ code: "AUTHORIZATION_REQUIRED" });

    {
        const userToken = await registerPlainUser(request),
            underPrivileged = await request.put(`${CP_URL}/api/v1/config/instance/logging`, {
                headers: { Authorization: `Bearer ${userToken}` },
                data: { logLevel: "INFO" },
            }),
            underPrivilegedBody = await underPrivileged.json();
        expect(underPrivileged.status()).toBe(403);
        expect(underPrivilegedBody).toMatchObject({ code: "FORBIDDEN" });
    }
});
