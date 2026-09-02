import { expect, test } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

test.describe('Workspace environment status', () => {
  test('shows assignment, storage and Runtime observation', async ({ page, request }) => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`
    const registration = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: {
        email: `environment-${suffix}@test.local`,
        password: `A${suffix}environment!`,
        name: 'Environment E2E',
      },
    })
    expect(registration.status()).toBe(201)
    const auth = await registration.json()
    expect(auth.workspaceId).toBeTruthy()

    await page.addInitScript(({ token, workspaceId }) => {
      localStorage.setItem('xihe-token', token)
      localStorage.setItem('xihe-user', JSON.stringify({ workspaceId }))
    }, { token: auth.accessToken, workspaceId: auth.workspaceId })

    await page.goto(`/workspace/${auth.workspaceId}/environment`, { waitUntil: 'load' })
    await expect(page.getByTestId('workspace-environment-heading')).toBeVisible()
    await expect(page.getByTestId('workspace-environment-status')).toContainText(/ready|blocked|unbound/)
    await expect(page.getByText(auth.workspaceId, { exact: true }).first()).toBeVisible()
    await expect(page.getByText('host_directory', { exact: true })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('storagePath')

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByTestId('workspace-environment-heading')).toBeVisible()
    const overflow = await page.evaluate(() => {
      const documentElement = document.scrollingElement
      return documentElement ? documentElement.scrollWidth - documentElement.clientWidth : 0
    })
    expect(overflow).toBeLessThanOrEqual(2)
  })
})
