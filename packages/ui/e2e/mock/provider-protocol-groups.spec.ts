import { test, expect } from '@playwright/test'
import path from 'node:path'

/**
 * PLAN-0364 M4：ProviderHub 协议族分组与能力只读展示；
 * 「模型发现」不再提供后端未实现的选项。
 */

const EVIDENCE_DIR = path.resolve(process.cwd(), '.local/pln364-e2e')
const VIEWPORT_TAG = process.env.XIHE_E2E_VIEWPORT ?? '1920x1080'

const CATALOG = {
  catalogRevision: 'rev-mock-1',
  providers: [
    {
      id: 'xiaomi',
      displayName: '小米 MiMo',
      category: 'recommended',
      description: '深度推理与长上下文。',
      adapter: 'native-litellm',
      litellmProvider: 'xiaomi_mimo',
      defaultBaseUrl: 'https://api.xiaomimimo.com/v1',
      modelDiscovery: 'remote-models',
      credential: { type: 'api-key', required: true },
      supports: { customBaseUrl: true, streaming: true, tools: false, vision: false },
    },
    {
      id: 'zhipu',
      displayName: '智谱 GLM',
      category: 'other',
      adapter: 'openai-compatible',
      litellmProvider: 'openai',
      defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      modelDiscovery: 'remote-models',
      credential: { type: 'api-key', required: true },
      supports: { customBaseUrl: true, streaming: true, tools: true },
    },
    {
      id: 'custom-openai-compatible',
      displayName: '自定义 OpenAI 兼容',
      category: 'custom',
      adapter: 'openai-compatible',
      litellmProvider: 'openai',
      defaultBaseUrl: '',
      modelDiscovery: 'manual',
      credential: { type: 'api-key', required: false },
      supports: { customBaseUrl: true, streaming: true },
    },
  ],
}

test.describe('Provider protocol groups (PLAN-0364 M4)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('xihe-token', 'mock-token')
      localStorage.setItem(
        'xihe-user',
        JSON.stringify({ id: 'u1', email: 'admin@xihe.local', role: 'ADMIN' }),
      )
      localStorage.setItem('xihe-workspace', JSON.stringify({ id: 'ws-1', name: 'Mock Workspace' }))
    })

    // LIFO: catch-all first, specific routes after.
    await page.route('**/api/v1/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
    await page.route('**/api/v1/config/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
    await page.route('**/api/v1/provider-catalog', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(CATALOG),
      }))
    await page.route('**/api/v1/provider-connections', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ connections: [] }),
      }))
    await page.route('**/api/v1/events**', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: 'retry: 5000\n\n',
      }))
  })

  test('groups by protocol family, shows supports read-only, and drops unimplemented discovery modes', async ({
    page,
  }) => {
    await page.goto('/settings/config', { waitUntil: 'load' })
    await page.getByTestId('config-tab-workspace').click()
    await expect(page.getByTestId('provider-hub')).toBeVisible()

    await page.getByTestId('provider-hub-connect').click()
    await expect(page.getByTestId('provider-picker-modal')).toBeVisible()

    // 协议族分组（adapter）
    await expect(page.getByText('原生协议', { exact: true })).toBeVisible()
    await expect(page.getByText('OpenAI 兼容', { exact: true })).toBeVisible()

    // 能力只读展示以 catalog supports 为准
    await expect(page.getByTestId('provider-supports-xiaomi').getByText('流式')).toBeVisible()
    await expect(page.getByTestId('provider-supports-xiaomi').getByText('工具')).toHaveCount(0)
    await expect(page.getByTestId('provider-supports-zhipu').getByText('工具')).toBeVisible()
    // 未声明 tools 的条目不得宣称工具（unknown，不展示）
    await expect(
      page.getByTestId('provider-supports-custom-openai-compatible').getByText('工具'),
    ).toHaveCount(0)

    // DOM/computed：徽标确实渲染且可见（非 a11y-only）
    const streamingBadge = page.getByTestId('provider-supports-xiaomi').getByText('流式')
    const color = await streamingBadge.evaluate((el) => getComputedStyle(el).color)
    expect(color).not.toBe('rgba(0, 0, 0, 0)')
    await expect(streamingBadge).toBeVisible()

    // 模型发现仅保留有实现的两种
    await page.getByTestId('provider-picker-custom-openai-compatible').click()
    const optionText = (await page.locator('select option').allTextContents()).join(' | ')
    expect(optionText).toContain('Provider /models')
    expect(optionText).toContain('手动输入模型')
    expect(optionText).not.toContain('LiteLLM Catalog')
    expect(optionText).not.toContain('精选模型')

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, `provider-groups-${VIEWPORT_TAG}.png`),
      fullPage: true,
    })
  })
})
