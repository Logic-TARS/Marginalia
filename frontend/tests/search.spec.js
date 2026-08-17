import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'multichapter.epub');

test.describe('in-book search', () => {
  test.use({ serviceWorkers: 'block' });

  async function openFixture(page) {
    await page.goto('/index.html');
    await page.setInputFiles('#file-input', FIXTURE);
    await expect(page.locator('#reader-view')).toHaveClass(/active/, { timeout: 15_000 });
    await expect(page.locator('#toolbar-book-title')).toContainText(/multichapter/i, { timeout: 15_000 });
  }

  async function openSearchPanel(page) {
    const reveal = page.locator('#btn-reveal-reader-chrome');
    if (await reveal.isVisible()) await reveal.click();
    if (await page.locator('#reader-tool-panel').isHidden()) {
      await page.locator('#btn-reader-tools').click();
    }
    await expect(page.locator('#reader-tool-panel')).toBeVisible();
    await page.locator('#btn-toggle-search').click();
    await expect(page.locator('#search-panel')).toBeVisible();
  }

  test('finds real matches across chapters and jumps to a result', async ({ page }) => {
    await openFixture(page);
    await openSearchPanel(page);

    // "perspiciatis" only appears in one lorem paragraph, repeated per chapter
    await page.locator('#search-input').fill('perspiciatis');

    const results = page.locator('.search-result-item');
    await expect(results.first()).toBeVisible({ timeout: 15_000 });
    expect(await results.count()).toBeGreaterThan(1);
    await expect(page.locator('#search-count')).toContainText(/\d+ 条/);
    // query highlighted in the excerpt
    await expect(results.first().locator('mark').first()).toBeVisible();

    // clicking a result navigates without error
    await results.first().click();
    await expect(page.locator('#reader-view')).toHaveClass(/active/);
  });

  test('shows an empty state when nothing matches', async ({ page }) => {
    await openFixture(page);
    await openSearchPanel(page);

    await page.locator('#search-input').fill('zzqqxxyy');

    await expect(page.locator('#search-results .empty-search')).toContainText('没有找到匹配的内容', { timeout: 15_000 });
    await expect(page.locator('#search-count')).toContainText('0 条');
  });

  test('matches case-insensitively', async ({ page }) => {
    await openFixture(page);
    await openSearchPanel(page);

    await page.locator('#search-input').fill('PERSPICIATIS');

    await expect(page.locator('.search-result-item').first()).toBeVisible({ timeout: 15_000 });
  });
});
