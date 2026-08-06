import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'multichapter.epub');

test.describe('home page navigation', () => {
  test.use({ serviceWorkers: 'block' });

  test('opens creation only from home and returns to home', async ({ page }) => {
    await page.goto('/index.html');

    await expect(page.locator('#library-view')).toHaveClass(/active/);
    await expect(page.locator('.home-nav')).toBeVisible();
    await expect(page.locator('.nav-tabs')).toHaveCount(0);
    await expect(page).toHaveURL(/#\/$/);

    await page.locator('#btn-library-create').click();

    await expect(page.locator('#creation-view')).toHaveClass(/active/);
    await expect(page.locator('#library-view')).not.toHaveClass(/active/);
    await expect(page.locator('.home-nav')).toBeHidden();
    await expect(page.locator('#btn-creation-back')).toBeVisible();
    await expect(page.locator('#btn-back')).toBeHidden();
    await expect(page).toHaveURL(/#\/creation$/);

    await page.locator('#btn-creation-back').click();

    await expect(page.locator('#library-view')).toHaveClass(/active/);
    await expect(page.locator('#creation-view')).not.toHaveClass(/active/);
    await expect(page.locator('.home-nav')).toBeVisible();
    await expect(page).toHaveURL(/#\/$/);
  });

  test('opens a book from home and browser history returns to the home page', async ({ page }) => {
    await page.goto('/index.html');
    await page.setInputFiles('#file-input', FIXTURE);

    await expect(page.locator('#reader-view')).toHaveClass(/active/, { timeout: 15_000 });
    await expect(page.locator('#toolbar-book-title')).toContainText(/multichapter/i, { timeout: 15_000 });
    await expect(page.locator('.home-nav')).toBeHidden();
    await expect(page.locator('#btn-back')).toBeVisible();
    await expect(page.locator('#btn-library-create')).toBeHidden();
    await expect(page.locator('#btn-creation-back')).toBeHidden();
    await expect(page).toHaveURL(/#\/reader$/);

    await page.goBack();

    await expect(page.locator('#library-view')).toHaveClass(/active/);
    await expect(page.locator('#reader-view')).not.toHaveClass(/active/);
    await expect(page.locator('.home-nav')).toBeVisible();
    await expect(page).toHaveURL(/#\/$/);

    await page.goForward();

    await expect(page.locator('#reader-view')).toHaveClass(/active/, { timeout: 15_000 });
    await expect(page.locator('#toolbar-book-title')).toContainText(/multichapter/i, { timeout: 15_000 });
    await expect(page).toHaveURL(/#\/reader$/);
  });
});
