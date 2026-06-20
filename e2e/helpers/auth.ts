import { expect, type Page } from '@playwright/test'

export const TEST_USER = {
  firstName: 'Test',
  lastName: 'User',
  email: 'test@hivekeep.local',
  pseudonym: 'Tester',
  password: 'TestPassword123!',
}

/**
 * Open the app and wait for onboarding step 1 to be ready.
 * The step indicator becoming visible is the synchronization point, so there is
 * no need for a discouraged `waitForLoadState('networkidle')`.
 */
export async function gotoOnboarding(page: Page) {
  await page.goto('/')
  await expect(page.getByText('Step 1 of 5')).toBeVisible({ timeout: 15_000 })
}

/**
 * Fill and submit the identity form (onboarding step 1).
 * Expects the page to already show the identity step.
 */
export async function fillIdentityStep(page: Page) {
  await page.fill('#firstName', TEST_USER.firstName)
  await page.fill('#lastName', TEST_USER.lastName)
  await page.fill('#email', TEST_USER.email)
  await page.fill('#pseudonym', TEST_USER.pseudonym)
  await page.fill('#password', TEST_USER.password)
  await page.fill('#passwordConfirm', TEST_USER.password)
  await page.getByRole('button', { name: 'Next' }).click()
}

/**
 * Login via the login page UI.
 */
export async function loginAs(page: Page, email = TEST_USER.email, password = TEST_USER.password) {
  await page.fill('#email', email)
  await page.fill('#password', password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

/**
 * Mock provider-related API routes so onboarding step 3 works without real API keys.
 * The server-side E2E_SKIP_PROVIDER_TEST=true handles testProviderConnection(),
 * but we also need to mock the models endpoint since no real provider exists to list models from.
 */
export async function mockProviderModels(page: Page) {
  await page.route('**/api/providers/models', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          models: [
            {
              id: 'gpt-4o',
              name: 'GPT-4o',
              providerId: 'e2e-provider',
              providerName: 'E2E Provider',
              providerType: 'openai',
              capability: 'llm',
            },
            {
              id: 'text-embedding-3-small',
              name: 'Text Embedding 3 Small',
              providerId: 'e2e-provider',
              providerName: 'E2E Provider',
              providerType: 'openai',
              capability: 'embedding',
            },
          ],
        }),
      })
    }
    return route.continue()
  })
}
