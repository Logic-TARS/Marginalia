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

async function doubleClickIframe(page) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const clicked = await page.locator('#epub-container').evaluate((host) => {
      const iframe = Array.from(host.querySelectorAll('iframe')).find(item => item.contentDocument?.body);
      if (!iframe) return false;
      iframe.contentDocument.body.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        detail: 2,
      }));
      return true;
    });
    if (clicked) return;
    await page.waitForTimeout(100);
  }
  throw new Error('No stable EPUB iframe found for double click');
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

function expectSameBounds(actual, expected, tolerance = 1) {
  expect(actual).not.toBeNull();
  expect(expected).not.toBeNull();
  for (const key of ['x', 'y', 'width', 'height']) {
    expect(Math.abs(actual[key] - expected[key])).toBeLessThanOrEqual(tolerance);
  }
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
 * Helpers: use the retained desktop keyboard navigation and wait for it to settle.
 */
async function navigateNext(page) {
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(NAV_DELAY);
}

async function navigatePrev(page) {
  await page.keyboard.press('ArrowLeft');
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

  test('opens a collapsible directory and manages bookmarks without resizing the book', async ({ page }) => {
    await openFixture(page);
    const navigator = page.locator('#reader-navigator');
    const hostBefore = await page.locator('#epub-container').boundingBox();
    const pageBefore = await getPageInfo(page);

    await expect(navigator).toBeHidden();
    await expect(page.locator('#btn-reveal-navigator')).toBeVisible();

    await page.locator('#btn-reveal-navigator').hover();
    await expect(navigator).toBeVisible();
    await expect(page.locator('#reader-view')).toHaveClass(/reader-chrome-hidden/);
    await expect(page.locator('#toc-list .toc-item')).toHaveCount(3);
    await expect(page.locator('#toc-list .toc-item').first()).toHaveAttribute('aria-current', 'location');
    expectSameBounds(await page.locator('#epub-container').boundingBox(), hostBefore);
    expect(await getPageInfo(page)).toEqual(pageBefore);

    await page.locator('#epub-container').hover();
    await expect(navigator).toBeHidden();
    await page.locator('#btn-reveal-notes').hover();
    await expect(page.locator('#notes-panel')).toBeVisible();
    await expect(page.locator('#reader-view')).toHaveClass(/reader-chrome-hidden/);
    await page.locator('#epub-container').hover();
    await expect(page.locator('#notes-panel')).toBeHidden();
    await page.locator('#btn-reveal-navigator').hover();
    await expect(navigator).toBeVisible();
    await page.locator('#btn-reveal-reader-chrome').click();
    await expect(page.locator('#reader-view')).not.toHaveClass(/reader-chrome-hidden/);
    await page.locator('#btn-reader-tools').click();
    await page.locator('#btn-add-bookmark').click();
    await expect(page.locator('#bookmarks-count')).toHaveText('1');
    await page.locator('#btn-reveal-navigator').click();
    await expect(page.locator('#bookmarks-list .bookmark-item')).toHaveCount(1);
    await page.locator('#bookmarks-list .bookmark-delete').click();
    await expect(page.locator('#bookmarks-count')).toHaveText('0');
    await page.locator('#btn-reader-tools').click();

    await page.locator('#toc-list .toc-item', { hasText: 'Chapter 2' }).click();
    await expect(page.locator('#toolbar-chapter')).toContainText('Chapter 2');
    await expect(page.locator('#toc-list .toc-item', { hasText: 'Chapter 2' })).toHaveAttribute('aria-current', 'location');
  });

  test('desktop reader chrome floats without resizing or repaginating the book', async ({ page }) => {
    await openFixture(page);
    const reader = page.locator('#reader-view');
    const revealButton = page.locator('#btn-reveal-reader-chrome');
    await expect(reader).toHaveClass(/reader-chrome-hidden/, { timeout: 6_000 });
    await revealButton.click();
    await expect(reader).not.toHaveClass(/reader-chrome-hidden/);
    await expect(page.locator('.home-nav')).toBeHidden();
    await expect(page.locator('.reader-toolbar')).toBeVisible();
    await expect(page.locator('.reader-footer')).toHaveCount(0);
    await page.waitForTimeout(350);

    const visibleHost = await page.locator('#epub-container').boundingBox();
    const stablePage = await getPageInfo(page);
    const stableChapter = await getChapterLabel(page);

    await doubleClickIframe(page);
    await expect(reader).toHaveClass(/reader-chrome-hidden/);
    await expect(page.locator('.home-nav')).toBeHidden();
    await expect(page.locator('.reader-toolbar')).toBeHidden();
    await expect(page.locator('.reader-footer')).toHaveCount(0);
    await page.waitForTimeout(350);

    expectSameBounds(await page.locator('#epub-container').boundingBox(), visibleHost);
    expect(await getPageInfo(page)).toEqual(stablePage);
    expect(await getChapterLabel(page)).toBe(stableChapter);

    await page.waitForTimeout(500);
    await doubleClickIframe(page);
    await expect(reader).not.toHaveClass(/reader-chrome-hidden/);
    await page.waitForTimeout(350);
    expectSameBounds(await page.locator('#epub-container').boundingBox(), visibleHost);
    expect(await getPageInfo(page)).toEqual(stablePage);
    expect(await getChapterLabel(page)).toBe(stableChapter);
  });

  test('narrow desktop viewport keeps exact one-page keyboard navigation', async ({ page }) => {
    await page.setViewportSize({ width: 920, height: 800 });
    await openFixture(page);

    const initialChapter = await getChapterLabel(page);
    const initialPageInfo = await getPageInfo(page);
    expect(initialPageInfo).not.toBeNull();

    await navigateNext(page);

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
        await navigateNext(page);
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
      // Use the reader directory to enter chapter 2 before navigating backward.
      await page.locator('#btn-reveal-navigator').click();
      await expect(page.locator('#toc-list .toc-item')).toHaveCount(3);
      await page.locator('#toc-list .toc-item', { hasText: 'Chapter 2' }).click();
      await page.locator('#btn-close-navigator').click();
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
        await navigatePrev(page);
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

      // Every key press, including the first one, must advance exactly one page.
      for (let i = 0; i < 4; i++) {
        await navigateNext(page);
        pageInfo = await getPageInfo(page);
        const currentChapter = await getChapterLabel(page);

        expect(currentChapter).toBe(initialChapter);
        expect(pageInfo).not.toBeNull();
        expect(pageInfo.current).toBe(initialPage + i + 1);
      }
    }
  });
});
