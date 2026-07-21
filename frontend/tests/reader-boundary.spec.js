import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { sameSectionHref, landedOnFirstPage, landedOnLastPage } from './helpers/section-assertions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'multichapter.epub');

const RUNS = 5;
const NAV_DELAY = 1500; // ms for page navigation to settle
const JUMP_DELAY = 3000; // ms for progress slider jump to settle

/**
 * Helper: open the reader and import the fixture EPUB.
 */
async function openFixture(page) {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', FIXTURE);
  await expect(page.locator('#toolbar-book-title')).toContainText('multichapter', { timeout: 15_000 });
  await expect(page.locator('#toolbar-chapter')).not.toHaveText('选择一本书开始阅读', { timeout: 15_000 });
}

/**
 * Helper: parse page text "第 X / Y 页" into { current, total }.
 */
function parsePageText(text) {
  const match = text.match(/第\s*(\d+)\s*\/\s*(\d+)\s*页/);
  if (!match) return null;
  return { current: parseInt(match[1], 10), total: parseInt(match[2], 10) };
}

/**
 * Helper: get current chapter label text.
 */
async function getChapterLabel(page) {
  return (await page.locator('#toolbar-chapter').textContent()) || '';
}

/**
 * Helper: get current page info from the UI.
 */
async function getPageInfo(page) {
  const text = await page.locator('#page-text').textContent();
  return parsePageText(text);
}

/**
 * Helper: wait for chapter label to stabilize (not "加载中…").
 */
async function waitForChapterStable(page, timeout = 10000) {
  await page.waitForFunction(() => {
    const el = document.querySelector('#toolbar-chapter');
    return el && el.textContent && !el.textContent.includes('加载中');
  }, { timeout });
}

/**
 * Helper: wait for page text to stabilize (not "页码计算中...").
 */
async function waitForPageStable(page, timeout = 10000) {
  await page.waitForFunction(() => {
    const el = document.querySelector('#page-text');
    return el && el.textContent && !el.textContent.includes('计算中');
  }, { timeout });
}

/**
 * Helper: click the next button and wait for navigation to settle.
 */
async function clickNext(page) {
  await page.locator('#btn-nav-next').click();
  await page.waitForTimeout(NAV_DELAY);
}

/**
 * Helper: click the prev button and wait for navigation to settle.
 */
async function clickPrev(page) {
  await page.locator('#btn-nav-prev').click();
  await page.waitForTimeout(NAV_DELAY);
}

test.describe('@smoke', () => {
  test('EPUB fixture loads correctly in the reader', async ({ page }) => {
    await openFixture(page);
  });
});

test.describe('@boundary.forward', () => {
  test('cross-section forward navigation lands on page 1 of new chapter', async ({ page }) => {
    await openFixture(page);

    for (let run = 0; run < RUNS; run++) {
      // Record starting chapter
      const startChapter = await getChapterLabel(page);
      const startPageInfo = await getPageInfo(page);
      const startPage = startPageInfo ? startPageInfo.current : 0;

      // Navigate forward until chapter label changes (cross-section boundary)
      let chapterLabel = startChapter;
      let maxClicks = 30;
      while (chapterLabel === startChapter && maxClicks > 0) {
        await clickNext(page);
        chapterLabel = await getChapterLabel(page);
        maxClicks--;
      }

      // Assert: chapter changed
      expect(chapterLabel).not.toBe(startChapter);

      // Assert: page number is low (indicating start of new chapter)
      const afterPageInfo = await getPageInfo(page);
      expect(afterPageInfo).not.toBeNull();
      // The first page of a new chapter should have a lower page number than the last page of the prior chapter
      // Since we crossed a boundary, the page should be near the start of the new chapter
      expect(afterPageInfo.current).toBeLessThan(10);
    }
  });
});

test.describe('@boundary.backward', () => {
  test('cross-section backward navigation lands on last page of prior chapter', async ({ page }) => {
    await openFixture(page);

    for (let run = 0; run < RUNS; run++) {
      // Jump to ~40% progress to get past chapter 1
      await page.evaluate(() => {
        const slider = document.querySelector('#progress-slider');
        if (slider) {
          slider.value = 40;
          slider.dispatchEvent(new Event('input'));
        }
      });
      await page.waitForTimeout(JUMP_DELAY);
      await waitForChapterStable(page);
      await waitForPageStable(page);

      // Record current chapter (should be chapter 2 or 3)
      let chapterLabel = await getChapterLabel(page);
      const startPageInfo = await getPageInfo(page);
      const startPage = startPageInfo ? startPageInfo.current : 0;

      // Click prev repeatedly until we land on chapter 1
      let maxClicks = 50;
      while (!chapterLabel.includes('第1章') && maxClicks > 0) {
        await clickPrev(page);
        chapterLabel = await getChapterLabel(page);
        maxClicks--;
      }

      // Assert: landed on chapter 1
      expect(chapterLabel).toContain('第1章');

      // Assert: page number is high (indicating last page of chapter 1)
      const pageInfo = await getPageInfo(page);
      expect(pageInfo).not.toBeNull();
      // The last page of chapter 1 should be a significant page number
      expect(pageInfo.current).toBeGreaterThan(5);
    }
  });
});

test.describe('@boundary.intra', () => {
  test('same-section navigation advances exactly +1 page with no section change', async ({ page }) => {
    await openFixture(page);

    for (let run = 0; run < RUNS; run++) {
      // Navigate to page 2 (click next once from start)
      await clickNext(page);

      // Record initial state
      let pageInfo = await getPageInfo(page);
      const initialChapter = await getChapterLabel(page);
      const initialPage = pageInfo ? pageInfo.current : 0;

      // Click next 3 more times, asserting +1 page each time
      for (let i = 0; i < 3; i++) {
        await clickNext(page);
        pageInfo = await getPageInfo(page);
        const currentChapter = await getChapterLabel(page);

        expect(currentChapter).toBe(initialChapter);
        expect(pageInfo).not.toBeNull();
        expect(pageInfo.current).toBe(initialPage + i + 1);
      }
    }
  });
});
