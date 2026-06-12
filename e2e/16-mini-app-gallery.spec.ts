import { test, expect } from '@playwright/test'
import { loginAs } from './helpers/auth'

// ─── Tests ──────────────────────────────────────────────────────────────────
// The gallery dialog UI was removed (apps are shown inline in the sidebar).
// Only the sidebar-level Mini-Apps tests remain.

test.describe.serial('Mini App Gallery', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await loginAs(page)
    await page.waitForSelector('[data-sidebar="sidebar"]', { timeout: 10000 })
  })

  test('should show Mini-Apps section in Apps tab', async ({ page }) => {
    // Navigate to Mini-Apps tab
    const appsTab = page.getByRole('tab', { name: 'Mini-Apps' })
    await appsTab.click()

    // The tab content should be visible (Mini-Apps list renders inline)
    await expect(appsTab).toHaveAttribute('data-state', 'active')
  })

  test('should show Mini-Apps empty state in sidebar when no apps exist', async ({ page }) => {
    // Navigate to Mini-Apps tab
    const appsTab = page.getByRole('tab', { name: 'Mini-Apps' })
    await appsTab.click()

    // The empty state text depends on whether an Agent is selected:
    // - With an Agent selected: "No apps yet" / "Ask an Agent to create one"
    // - Without an Agent selected: "Select an Agent" / "Select an Agent to see its mini-apps"
    const noAppsYet = page.getByText('No apps yet')
    const selectAAgent = page.getByText('Select an Agent', { exact: true })

    // One of the two empty states should be visible
    await expect(noAppsYet.or(selectAAgent)).toBeVisible({ timeout: 5000 })
  })
})
