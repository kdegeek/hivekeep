import { test, expect } from '@playwright/test'
import { fillIdentityStep, gotoOnboarding, mockProviderModels } from './helpers/auth'

// The onboarding password-mismatch copy, kept in sync with
// onboarding.identity.passwordMismatch in src/client/locales/en.json.
const PASSWORD_MISMATCH_TEXT = 'Passwords do not match'

test.describe.serial('Onboarding flow', () => {
  test('shows the identity form on a fresh database', async ({ page }) => {
    await gotoOnboarding(page)

    await expect(page.getByText('Your identity')).toBeVisible()

    for (const id of [
      '#firstName',
      '#lastName',
      '#email',
      '#pseudonym',
      '#password',
      '#passwordConfirm',
    ]) {
      await expect(page.locator(id)).toBeVisible()
    }

    await expect(page.locator('button:has(.lucide-camera)')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Next' })).toBeVisible()
  })

  test('derives the avatar initials from the typed name', async ({ page }) => {
    await gotoOnboarding(page)

    await page.fill('#firstName', 'Alice')
    await page.fill('#lastName', 'Bob')

    await expect(page.locator('[data-slot="avatar-fallback"]')).toContainText('AB')
  })

  test('rejects a password that does not match its confirmation', async ({ page }) => {
    await gotoOnboarding(page)

    await page.fill('#firstName', 'Test')
    await page.fill('#lastName', 'User')
    await page.fill('#email', 'mismatch@test.local')
    await page.fill('#pseudonym', 'mismatch')
    await page.fill('#password', 'Password123!')
    await page.fill('#passwordConfirm', 'DifferentPassword456!')

    await page.getByRole('button', { name: 'Next' }).click()

    await expect(page.getByText(PASSWORD_MISMATCH_TEXT)).toBeVisible({ timeout: 5_000 })
    await expect(page.getByText('Step 1 of 5')).toBeVisible()
  })

  test('completes the full flow, including back navigation', async ({ page }) => {
    await mockProviderModels(page)
    await gotoOnboarding(page)

    await fillIdentityStep(page)

    // Step 2: Preferences (optional)
    await expect(page.getByText('Step 2 of 5')).toBeVisible()
    await expect(page.getByText('Preferences')).toBeVisible()
    await expect(page.getByText('Light', { exact: true })).toBeVisible()
    await expect(page.getByText('Dark', { exact: true })).toBeVisible()
    await expect(page.getByText('System', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Back' })).toBeVisible()
    await page.getByRole('button', { name: 'Next' }).click()

    // Step 3: Providers — add an OpenAI provider through the dialog
    await expect(page.getByText('Step 3 of 5')).toBeVisible()
    await expect(page.getByText('AI Providers')).toBeVisible()
    await expect(page.getByText('Missing').first()).toBeVisible()

    await page.getByRole('button', { name: 'Add a provider' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.locator('[data-slot="select-trigger"]').click()
    await page.getByRole('option', { name: /OpenAI/ }).click()
    await page.fill('#apiKey', 'sk-fake-e2e-test-key-1234567890')
    await page.getByRole('button', { name: 'Test connection' }).click()
    await expect(page.getByText('Connection successful')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Add provider' }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page.getByText('Covered').first()).toBeVisible()

    await page.getByRole('button', { name: 'Customize memory & search' }).click()

    // Step 4: Memory — Back returns to step 3, then forward again
    await expect(page.getByText('Step 4 of 5')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Memory' })).toBeVisible()
    await page.getByRole('button', { name: 'Back' }).click()
    await expect(page.getByText('Step 3 of 5')).toBeVisible()
    await page.getByRole('button', { name: 'Customize memory & search' }).click()
    await expect(page.getByText('Step 4 of 5')).toBeVisible()
    await page.getByRole('button', { name: 'Next' }).click()

    // Step 5: Search providers — Back returns to step 4, then forward and skip
    await expect(page.getByText('Step 5 of 5')).toBeVisible()
    await expect(page.getByText('Search Providers')).toBeVisible()
    await page.getByRole('button', { name: 'Back' }).click()
    await expect(page.getByText('Step 4 of 5')).toBeVisible()
    await page.getByRole('button', { name: 'Next' }).click()
    await expect(page.getByText('Step 5 of 5')).toBeVisible()
    await page.getByRole('button', { name: 'Skip for now' }).click()

    await expect(page.getByText('Agents', { exact: true })).toBeVisible({ timeout: 10_000 })
  })

  test('redirects to login once onboarding is complete', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByText('Step 1 of 5')).not.toBeVisible({ timeout: 5_000 })
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 5_000 })
  })
})
