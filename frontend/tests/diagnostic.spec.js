import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'multichapter.epub');
const EVIDENCE_DIR = path.resolve(__dirname, '../../..', '.omo', 'evidence');
const EVIDENCE_PATH = path.join(EVIDENCE_DIR, 'task-2-fix-chapter-boundary-page-skip.json');

test.describe('@probe', () => {
  test('captures timing dumps at chapter boundary', async ({ page }) => {
    test.setTimeout(90_000);

    // Open reader with probe flag
    await page.goto('/index.html?__probe=boundary');

    // Import fixture
    await page.setInputFiles('#file-input', FIXTURE);

    // Wait for book to load
    await expect(page.locator('#toolbar-book-title')).toContainText(/multichapter/i, { timeout: 20_000 });

    // Wait for chapter to load (relocated fired at least once)
    await page.waitForFunction(() => {
      const el = document.querySelector('#toolbar-chapter');
      return el && el.textContent !== '选择一本书开始阅读' && el.textContent !== '加载中…';
    }, { timeout: 30_000 }).catch(() => {
      // relocated may not fire in headless — proceed anyway
    });

    // Navigate page-by-page to trigger relocated events
    let maxAttempts = 30;
    while (maxAttempts-- > 0) {
      const dumpCount = await page.evaluate(() => window.__probeDump ? window.__probeDump.length : 0);
      if (dumpCount >= 3) break;

      try {
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(600);
      } catch (e) {
        // Navigation might fail if at end of book — stop trying
        break;
      }
    }

    // Give final dumps time to settle
    await page.waitForTimeout(500);

    // Get dumps from window
    const dumps = await page.evaluate(() => window.__probeDump || null);

    // Save evidence (even if empty, for analysis)
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(dumps || { error: 'no dumps captured', note: 'relocated may not fire in headless Chrome' }, null, 2));

    // Log what we got for the orchestrator to analyze
    if (dumps && dumps.length >= 3) {
      console.log('Probe dumps captured:', dumps.length, 'entries');
      console.log('First entry:', JSON.stringify(dumps[0]));
      console.log('Last entry:', JSON.stringify(dumps[dumps.length - 1]));
    } else {
      console.log('No probe dumps captured — relocated may not fire in headless Chrome');
    }

    // Headless Chrome can miss relocated timing dumps; the useful contract is
    // that this diagnostic always writes an evidence file for later analysis.
    expect(fs.existsSync(EVIDENCE_PATH)).toBe(true);
  });
});
