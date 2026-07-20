import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'multichapter.epub');

test.describe('@smoke', () => {
  test('EPUB fixture loads correctly in the reader', async ({ page }) => {
    // Open the reader PWA
    await page.goto('/index.html');

    // Import the EPUB fixture via the hidden file input
    await page.setInputFiles('#file-input', FIXTURE);

    // Wait for the toolbar to show the book title (confirms openBook fired)
    await expect(page.locator('#toolbar-book-title')).toContainText('multichapter', { timeout: 15_000 });

    // Wait for the chapter label to populate (confirms epub.js relocated to first chapter)
    await expect(page.locator('#toolbar-chapter')).not.toHaveText('选择一本书开始阅读', { timeout: 15_000 });
  });
});
