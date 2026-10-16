// PLAN-0525: readiness wait for the isolated Agent, extracted so the
// fail-closed contract can be exercised by a bounded automated test without
// importing `e2e-host.mjs` (importing the runner executes `main()`).
//
// Contract:
// - `expectReady: false` (the intentional `missing` lane) returns immediately:
//   that lane has no profile and is *expected* to stay not-ready, so it must not
//   burn the readiness budget waiting for a state it can never reach.
// - `expectReady: true` polls Agent direct health until `llmReady === "ready"`.
//   If the budget is exhausted the call throws, so the runner aborts (and
//   tears down) instead of starting Playwright against a not-ready Agent — a
//   regression here used to surface as an opaque 30s `beforeAll` timeout.
export async function waitForAgentLlmReady({
    healthUrl,
    expectReady,
    timeoutMs,
    pollMs = 2000,
    now = Date.now,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
    if (!expectReady) {
        return { ready: false, expected: false, lastState: 'readiness-not-expected' }
    }
    const deadline = now() + timeoutMs
    let lastState = 'health unreachable'
    for (;;) {
        try {
            const response = await fetchImpl(healthUrl)
            if (response.ok) {
                const body = await response.json()
                lastState = `llmReady=${body?.llmReady ?? 'unknown'}`
                if (body?.llmReady === 'ready') {
                    return { ready: true, expected: true, lastState }
                }
            } else {
                lastState = `health HTTP ${response.status}`
            }
        } catch (error) {
            lastState = `health unreachable: ${error instanceof Error ? error.message : String(error)}`
        }
        if (now() >= deadline) break
        await sleep(pollMs)
    }
    throw new Error(
        `Agent did not report llmReady=ready within ${timeoutMs}ms (${lastState}); refusing to start Playwright on a not-ready Agent`,
    )
}
