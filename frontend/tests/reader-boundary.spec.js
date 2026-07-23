import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { sameSectionHref, landedOnFirstPage, landedOnLastPage } from './helpers/section-assertions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'multichapter.epub');

const RUNS = 1;
const NAV_DELAY = 250; // ms for page navigation to settle
const JUMP_DELAY = 1000; // ms for progress slider jump to settle

/**
 * Helper: open the reader and import the fixture EPUB.
 */
async function openFixture(page) {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', FIXTURE);
  await expect(page.locator('#toolbar-book-title')).toContainText(/multichapter/i, { timeout: 15_000 });
  await expect(page.locator('#toolbar-chapter')).not.toHaveText(/加载中|选择一本书开始阅读/, { timeout: 15_000 });
  await expect(page.locator('#page-text')).toHaveText(/第\s*\d+\s*\/\s*\d+\s*页/, { timeout: 15_000 });
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

    const containerMetrics = await page.locator('#epub-container > .epub-container').evaluate((inner) => {
      const host = document.querySelector('#epub-container');
      return {
        hostClientWidth: host ? host.clientWidth : 0,
        innerClientWidth: inner.clientWidth,
        innerBorderWidth: getComputedStyle(inner).borderTopWidth,
      };
    });

    expect(containerMetrics.innerBorderWidth).toBe('0px');
    expect(containerMetrics.innerClientWidth).toBe(containerMetrics.hostClientWidth);
  });

  test('narrow viewport keeps exact one-page button navigation', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 800 });
    await openFixture(page);

    const initialChapter = await getChapterLabel(page);
    const initialPageInfo = await getPageInfo(page);
    expect(initialPageInfo).not.toBeNull();

    await clickNext(page);

    const nextPageInfo = await getPageInfo(page);
    expect(await getChapterLabel(page)).toBe(initialChapter);
    expect(nextPageInfo).not.toBeNull();
    expect(nextPageInfo.current).toBe(initialPageInfo.current + 1);

    const widths = await page.locator('#epub-container > .epub-container').evaluate((inner) => {
      const host = document.querySelector('#epub-container');
      return {
        host: host ? host.clientWidth : 0,
        inner: inner.clientWidth,
      };
    });
    expect(widths.inner).toBe(widths.host);
  });
});

test.describe('@boundary.forward', () => {
  test('cross-section forward navigation lands on page 1 of new chapter', async ({ page }) => {
    await openFixture(page);

    for (let run = 0; run < RUNS; run++) {
      // Record starting chapter
      const startChapter = await getChapterLabel(page);
      const startPageInfo = await getPageInfo(page);
      expect(startPageInfo).not.toBeNull();

      // Navigate forward until chapter label changes (cross-section boundary)
      let chapterLabel = startChapter;
      let previousPageInfo = startPageInfo;
      let maxClicks = Math.max(30, (startPageInfo?.total || 0) + 5);
      while (chapterLabel === startChapter && maxClicks > 0) {
        await clickNext(page);
        chapterLabel = await getChapterLabel(page);
        const currentPageInfo = await getPageInfo(page);
        expect(currentPageInfo).not.toBeNull();
        if (chapterLabel === startChapter) {
          expect(currentPageInfo.current).toBe(previousPageInfo.current + 1);
          previousPageInfo = currentPageInfo;
        }
        maxClicks--;
      }

      // Assert: chapter changed
      expect(chapterLabel).not.toBe(startChapter);
      expect(previousPageInfo.current).toBe(previousPageInfo.total);

      // Assert: cross-section navigation lands on the first page
      const afterPageInfo = await getPageInfo(page);
      expect(afterPageInfo).not.toBeNull();
      expect(afterPageInfo.current).toBe(1);
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
      while (!chapterLabel.includes('Chapter 1') && maxClicks > 0) {
        await clickPrev(page);
        chapterLabel = await getChapterLabel(page);
        maxClicks--;
      }

      // Assert: landed on chapter 1
      expect(chapterLabel).toContain('Chapter 1');

      // Assert: page number is high (indicating last page of chapter 1)
      const pageInfo = await getPageInfo(page);
      expect(pageInfo).not.toBeNull();
      expect(pageInfo.current).toBe(pageInfo.total);
    }
  });
});

test.describe('@boundary.intra', () => {
  test('same-section navigation advances exactly +1 page with no section change', async ({ page }) => {
    await openFixture(page);

    for (let run = 0; run < RUNS; run++) {
      // Record initial state
      let pageInfo = await getPageInfo(page);
      const initialChapter = await getChapterLabel(page);
      const initialPage = pageInfo ? pageInfo.current : 0;
      expect(pageInfo).not.toBeNull();

      // Every click, including the first one, must advance exactly one page.
      for (let i = 0; i < 4; i++) {
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
