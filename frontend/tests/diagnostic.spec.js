import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'multichapter.epub');
const EVIDENCE_DIR = path.resolve(__dirname, '../../..', '.omo', 'evidence');
const EVIDENCE_PATH = path.join(EVIDENCE_DIR, 'task-2-fix-chapter-boundary-page-skip.json');

test.describe('@probe', () => {
  test('captures timing dumps at chapter boundary', async ({ browser }) => {
    test.setTimeout(120_000);

    const context = await browser.newContext();

    // Serve fresh app.js on ALL requests (including SW-triggered reloads)
    const APP_JS_PATH = path.join(__dirname, '..', 'app.js');
    const freshAppJs = fs.readFileSync(APP_JS_PATH, 'utf-8');
    await context.route('**/app.js', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: freshAppJs,
        headers: { 'Cache-Control': 'no-store' },
      });
    });

    const page = await context.newPage();

    // Open reader with probe flag
    await page.goto('/index.html?__probe=boundary');

    // Import fixture
    await page.setInputFiles('#file-input', FIXTURE);

    // Wait for book to load
    await expect(page.locator('#toolbar-book-title')).toContainText('multichapter', { timeout: 15_000 });

    // Wait for relocated to fire (chapter title changes from loading)
    // Give it extra time since epub.js may be slow in headless
    await page.waitForFunction(() => {
      const el = document.querySelector('#toolbar-chapter');
      return el && el.textContent !== '选择一本书开始阅读' && el.textContent !== '加载中…';
    }, { timeout: 30_000 }).catch(() => {
      // relocated may not fire in headless — proceed with navigation clicks
    });

    // Navigate page-by-page to trigger relocated events (limited attempts to avoid timeout)
    for (let i = 0; i < 15; i++) {
      try {
        await page.click('#btn-nav-next');
        await page.waitForTimeout(500);
        const count = await page.evaluate(() => window.__probeDump ? window.__probeDump.length : 0);
        if (count >= 3) break;
      } catch (e) {
        // Page might be closed or navigation failed — stop trying
        break;
      }
    }

    // Give final dumps time to accumulate
    await page.waitForTimeout(500);

    // Get dumps from window
    const dumps = await page.evaluate(() => window.__probeDump || null);

    // Save evidence
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(dumps, null, 2));

    // Assert we got meaningful dumps
    expect(dumps).not.toBeNull();
    expect(Array.isArray(dumps)).toBe(true);
    expect(dumps.length).toBeGreaterThanOrEqual(3);
    expect(dumps[0].displayedPage).not.toBeNull();
    expect(dumps[0].href).toBeTruthy();
    expect(typeof dumps[0].viewLeft).toBe('number');

    await context.close();
  });
});
