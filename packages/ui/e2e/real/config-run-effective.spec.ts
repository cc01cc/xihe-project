import { generateE2EPassword } from './helpers/password'

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`
const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? 'mock'

// PLAN-0307 T2.17 / V17: 真实浏览器端到端 — 用户层配置改动必须真正到达
// Agent 的 LLM 调用。fake LLM 在 success 模式回显请求里的 `model`，因此
// 「UI 保存 openaiModel → 下一轮 chat 的回复里出现该模型名」即证明
// UI → CP（user 层存储 + run payload overrides）→ Agent（per-run 合成）
// → LLM 调用 的全链路生效。
// 跑法：XIHE_E2E_LLM_MODE=success mise run test:e2e-host -- e2e/real/config-run-effective.spec.ts
test.describe('@host PLAN-0307 V17 — UI config reaches the Agent run', () => {
  test.skip(LLM_MODE !== 'success', 'requires XIHE_E2E_LLM_MODE=success (fake LLM model echo)')

  test('user-layer llm-provider override is applied by the next chat run', async ({ page, request }) => {
    test.setTimeout(120000)

    const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email: `v17-${Date.now()}@test.com`, password: SHARED_PASSWORD, name: 'V17' },
    })
    expect(reg.ok()).toBe(true)
    const auth = await reg.json()
    await page.addInitScript(({ token, workspaceId }) => {
      localStorage.setItem('xihe-token', token)
      localStorage.setItem('xihe-user', JSON.stringify({ workspaceId }))
      localStorage.setItem('xihe-workspace', JSON.stringify({ id: workspaceId, name: 'Default Workspace' }))
    }, { token: auth.accessToken, workspaceId: auth.workspaceId })

    // 1. Save a unique user-layer openaiModel through the real settings UI.
    await page.goto('/settings/config', { waitUntil: 'load' })
    await expect(page.getByTestId('settings-config-heading')).toBeVisible({ timeout: 10000 })
    await page.getByTestId('config-tab-user').click()

    const panel = page.getByTestId('config-domain-llm-provider')
    await expect(panel).toBeVisible({ timeout: 8000 })
    await panel.locator(':scope > button').click()

    const uniqueModel = `fake-v17-${Date.now()}`
    const modelInput = panel.getByTestId('config-field-llm-provider-openaiModel').locator('input')
    await expect(modelInput).toBeVisible({ timeout: 8000 })
    await modelInput.fill(uniqueModel)
    // Also override defaultModel: it keeps the chat UI from resolving an
    // available catalog model and sending its own `model` override, which
    // would shadow the Agent-side merged config.
    await panel.getByTestId('config-field-llm-provider-defaultModel').locator('input').fill(uniqueModel)

    const [saveResponse] = await Promise.all([
      page.waitForResponse(response =>
        response.url().includes('/api/v1/config/user/llm-provider')
        && response.request().method() === 'PUT'),
      panel.getByRole('button', { name: '保存', exact: true }).click(),
    ])
    expect(saveResponse.status()).toBe(200)
    await expect(page.getByText(/LLM 提供商.*已保存/)).toBeVisible({ timeout: 10000 })
    await page.screenshot({ path: test.info().outputPath('config-run-effective-saved.png'), fullPage: true })

    // 2. Start a real run from the chat UI. Wait until the app refreshed the
    //    resolved config cache, so the UI cannot fall back to the stale store.
    await page.goto('/chat', { waitUntil: 'load' })
    await page.waitForFunction((expected) => {
      const raw = localStorage.getItem('xihe-config-merged')
      if (!raw) return false
      try {
        return JSON.parse(raw)['llm-provider']?.defaultModel === expected
      } catch {
        return false
      }
    }, uniqueModel, { timeout: 15000 })
    const textarea = page.locator('textarea')
    await expect(textarea).toBeVisible({ timeout: 10000 })
    const marker = `v17-${Date.now()}`
    await textarea.fill(marker)
    await page.keyboard.press('Enter')
    await expect(page.getByText(marker, { exact: true })).toBeVisible({ timeout: 10000 })

    // 3. The fake LLM echoes the model it was called with — proves the
    //    UI-saved user override travelled CP → run payload → Agent → call.
    await expect(page.getByText(new RegExp(`model=${uniqueModel}`))).toBeVisible({ timeout: 60000 })
    await expect(page.getByText(/Thinking/)).not.toBeVisible({ timeout: 60000 })
    await page.screenshot({ path: test.info().outputPath('config-run-effective-applied.png'), fullPage: true })
  })
})
