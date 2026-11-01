import { expect, type Page } from '@playwright/test'

/**
 * Opens the active log view's "…" menu, if its toolbar is too narrow for all its controls (as a test's screen may be):
 * the controls it folds are only in there. Leaves it open if it is, and does nothing if there's none.
 */
export async function unfoldLogToolbar(window: Page) {
  const more = window.getByRole('button', { name: 'More controls' })
  if ((await more.count()) === 0 || (await more.getAttribute('aria-expanded')) === 'true') return
  await more.click()
  await expect(more).toHaveAttribute('aria-expanded', 'true')
}
