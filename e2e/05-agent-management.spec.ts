import { test, expect, type Page } from '@playwright/test'
import { loginAs, mockProviderModels } from './helpers/auth'

/**
 * Helper: Click on an agent card in the sidebar by name.
 */
async function selectAgent(page: Page, agentName: string) {
  await page.getByText(agentName, { exact: true }).first().click()
  // Wait for chat area to load
  await expect(page.getByPlaceholder('Send a message...')).toBeVisible({ timeout: 10_000 })
}

/**
 * Helper: Open the agent edit modal via the Settings2 icon on the agent card.
 */
async function openAgentEditModal(page: Page, agentName: string) {
  // Right-click on the agent card to open context menu, then click Edit
  const agentText = page.getByText(agentName, { exact: true }).first()
  await agentText.click({ button: 'right' })

  // Click the "Edit" context menu item (has Settings2 icon)
  await page.getByRole('menuitem').filter({ hasText: /edit/i }).click()

  // Wait for the edit dialog to appear
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 })
}

/**
 * Helper: Create an agent via the UI (used as setup for edit/delete tests).
 */
async function createAgent(page: Page, name: string, role: string) {
  await page.getByTitle('New Agent').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Describe your Agent' })).toBeVisible()
  await page.getByRole('button', { name: 'Create manually' }).click()

  await page.fill('#agentFormName', name)
  await page.fill('#agentFormRole', role)

  // Select model
  const modelPicker = page.getByRole('combobox').first()
  await modelPicker.click()
  await page.getByRole('option', { name: /GPT-4o/i }).click()
  await page.locator('#agentFormName').click() // close popover

  await page.getByRole('button', { name: 'Create Agent' }).click()
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 15_000 })
}

test.describe.serial('Agent management', () => {
  test.beforeEach(async ({ page }) => {
    await mockProviderModels(page)

    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 10_000 })
    await loginAs(page)
    await expect(page.getByText('Agents', { exact: true })).toBeVisible({ timeout: 10_000 })
  })

  test('should create a second agent for management tests', async ({ page }) => {
    await createAgent(page, 'Management Test Agent', 'An agent for testing edit and delete operations')

    // Verify it appears in the sidebar
    await expect(page.getByText('Management Test Agent').first()).toBeVisible()
  })

  test('should open agent edit modal and see general tab', async ({ page }) => {
    await openAgentEditModal(page, 'Management Test Agent')

    // Should see the agent name in the form
    const nameInput = page.locator('#agentFormName')
    await expect(nameInput).toBeVisible({ timeout: 5_000 })
    await expect(nameInput).toHaveValue('Management Test Agent')

    // Should see the role field
    const roleInput = page.locator('#agentFormRole')
    await expect(roleInput).toBeVisible()
    await expect(roleInput).toHaveValue('An agent for testing edit and delete operations')
  })

  test('should edit agent name and role', async ({ page }) => {
    await openAgentEditModal(page, 'Management Test Agent')

    // Change name
    await page.locator('#agentFormName').fill('Renamed Agent')

    // Change role
    await page.locator('#agentFormRole').fill('Updated role description')

    // Save — look for the save button
    await page.getByRole('button', { name: /Save/i }).click()

    // Should see success indication (toast or dialog closes)
    // Wait for the dialog to close or success toast
    await expect(page.getByText('Renamed Agent').first()).toBeVisible({ timeout: 10_000 })
  })

  test('should edit agent character and expertise fields', async ({ page }) => {
    await openAgentEditModal(page, 'Renamed Agent')

    // Find character field (textarea or markdown editor)
    const characterField = page.locator('#agentFormCharacter, [data-testid="character-editor"] textarea, .cm-content').first()
    if (await characterField.isVisible()) {
      await characterField.click()
      await characterField.fill('Friendly and helpful personality')
    }

    // Find expertise field
    const expertiseField = page.locator('#agentFormExpertise, [data-testid="expertise-editor"] textarea').first()
    if (await expertiseField.isVisible()) {
      await expertiseField.click()
      await expertiseField.fill('Testing and quality assurance')
    }

    // Save
    const saveButton = page.getByRole('button', { name: /Save/i })
    if (await saveButton.isVisible()) {
      await saveButton.click()
      // Wait briefly for save to complete
      await page.waitForTimeout(1_000)
    }
  })

  test('should navigate to tools tab in edit modal', async ({ page }) => {
    await openAgentEditModal(page, 'Renamed Agent')

    // Click the tools tab (Wrench icon)
    const toolsTab = page.getByRole('dialog').locator('button:has(.lucide-wrench)')
    await expect(toolsTab).toBeVisible({ timeout: 5_000 })
    await toolsTab.click()

    // Should see tool-related content (tool domain groups)
    await expect(page.getByRole('dialog').getByText(/tool/i).first()).toBeVisible({ timeout: 5_000 })
  })

  test('should navigate to memory tab in edit modal', async ({ page }) => {
    await openAgentEditModal(page, 'Renamed Agent')

    // Click the memory tab (Brain icon)
    const memoryTab = page.getByRole('dialog').locator('button:has(.lucide-brain)')
    await expect(memoryTab).toBeVisible({ timeout: 5_000 })
    await memoryTab.click()

    // Should see memory-related content
    await expect(page.getByRole('dialog').getByText(/memor/i).first()).toBeVisible({ timeout: 5_000 })
  })

  test('should delete an agent with confirmation', async ({ page }) => {
    // First create a disposable agent
    await createAgent(page, 'Disposable Agent', 'Will be deleted')

    await openAgentEditModal(page, 'Disposable Agent')

    // Find the delete button (Trash2 icon or ConfirmDeleteButton)
    const deleteButton = page.getByRole('dialog').locator('button:has(.lucide-trash-2, .lucide-trash)')
    await expect(deleteButton).toBeVisible({ timeout: 5_000 })
    await deleteButton.click()

    // Should show confirmation — click confirm/delete
    const confirmButton = page.getByRole('button', { name: /Delete|Confirm/i }).last()
    await expect(confirmButton).toBeVisible({ timeout: 5_000 })
    await confirmButton.click()

    // The agent should disappear from the sidebar
    await expect(page.getByText('Disposable Agent')).toBeHidden({ timeout: 10_000 })
  })

  test('should create an agent via the wizard dialog', async ({ page }) => {
    // Open the new agent dialog
    await page.getByTitle('New Agent').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Describe your Agent' })).toBeVisible()

    // Verify the wizard has a text area for describing the agent
    const descriptionInput = page.getByRole('dialog').locator('textarea').first()
    await expect(descriptionInput).toBeVisible({ timeout: 5_000 })

    // Verify "Create manually" button exists as alternative
    await expect(page.getByRole('button', { name: 'Create manually' })).toBeVisible()

    // Use manual creation (wizard requires LLM calls)
    await page.getByRole('button', { name: 'Create manually' }).click()

    // Verify manual form appeared
    await expect(page.locator('#agentFormName')).toBeVisible({ timeout: 5_000 })

    // Cancel/close the dialog
    // Press Escape to close
    await page.keyboard.press('Escape')
  })

  test('should select an agent and open its chat', async ({ page }) => {
    await selectAgent(page, 'Renamed Agent')

    // Chat area should be visible with message input
    const messageInput = page.getByPlaceholder('Send a message...')
    await expect(messageInput).toBeVisible()

    // The agent name should appear in the chat header or breadcrumb
    await expect(page.getByText('Renamed Agent').first()).toBeVisible()
  })
})
