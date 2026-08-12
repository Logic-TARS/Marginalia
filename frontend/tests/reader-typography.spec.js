import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'multichapter.epub');
const TYPOGRAPHY_KEY = 'marginalia.readerTypography';

async function openFixture(page) {
  await page.goto('/index.html');
  await page.evaluate(key => localStorage.removeItem(key), TYPOGRAPHY_KEY);
  await page.reload();
  await page.setInputFiles('#file-input', FIXTURE);
  await expect(page.locator('#toolbar-book-title')).toContainText(/multichapter/i, { timeout: 15_000 });
  await expect(page.locator('#page-text')).toHaveText(/第\s*\d+\s*\/\s*\d+\s*页/, { timeout: 15_000 });
}

async function revealTools(page) {
  const reveal = page.locator('#btn-reveal-reader-chrome');
  if (await reveal.isVisible()) await reveal.click();
  if (await page.locator('#reader-tool-panel').isHidden()) {
    await page.locator('#btn-reader-tools').click();
  }
  await expect(page.locator('#reader-tool-panel')).toBeVisible();
}

async function getReaderTypography(page) {
  return page.locator('#epub-container').evaluate((host) => {
    const iframe = Array.from(host.querySelectorAll('iframe')).find(item => item.contentDocument?.body);
    if (!iframe) return null;
    const doc = iframe.contentDocument;
    const style = doc.getElementById('marginalia-reader-typography-style');
    return {
      family: doc.documentElement.getAttribute('data-marginalia-reader-font'),
      fontSize: parseFloat(getComputedStyle(doc.body).fontSize),
      styleText: style?.textContent || '',
    };
  });
}

async function getVisibleParagraphs(page) {
  return page.locator('#epub-container').evaluate((host) => {
    const iframe = Array.from(host.querySelectorAll('iframe')).find(item => item.contentDocument?.body);
    if (!iframe) return [];
    const doc = iframe.contentDocument;
    const width = doc.documentElement.clientWidth;
    const height = doc.documentElement.clientHeight;
    return Array.from(doc.querySelectorAll('p'))
      .filter((paragraph) => {
        const rect = paragraph.getBoundingClientRect();
        return rect.right > 0 && rect.left < width && rect.bottom > 0 && rect.top < height;
      })
      .map(paragraph => (paragraph.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80))
      .filter(Boolean);
  });
}

test.describe('reader typography settings', () => {
  test.use({ serviceWorkers: 'block' });

  test('applies fonts and sizes, preserves the reading anchor, and restores preferences', async ({ page }) => {
    await openFixture(page);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(350);
    const chapterBefore = await page.locator('#toolbar-chapter').textContent();
    const visibleBefore = await getVisibleParagraphs(page);
    expect(visibleBefore.length).toBeGreaterThan(0);

    await revealTools(page);
    await expect(page.locator('#reader-font-family')).toHaveValue('original');
    await expect(page.locator('#reader-font-size')).toHaveValue('100');
    await expect(page.locator('#reader-font-size-value')).toHaveText('100%');

    const initialTypography = await getReaderTypography(page);
    expect(initialTypography).not.toBeNull();

    await page.locator('#reader-font-family').selectOption('sans');
    await expect.poll(() => getReaderTypography(page)).toMatchObject({ family: 'sans' });
    await expect.poll(async () => (await getReaderTypography(page))?.styleText || '')
      .toContain('PingFang SC');

    await page.locator('#reader-font-size').fill('125');
    await expect(page.locator('#reader-font-size-value')).toHaveText('125%');
    await page.waitForTimeout(900);
    await expect.poll(async () => (await getReaderTypography(page))?.fontSize || 0)
      .toBeGreaterThan(initialTypography.fontSize);
    expect(await page.locator('#toolbar-chapter').textContent()).toBe(chapterBefore);
    const visibleAfter = await getVisibleParagraphs(page);
    expect(visibleAfter.some(text => visibleBefore.includes(text))).toBeTruthy();

    await page.locator('#btn-reader-font-reset').click();
    await expect(page.locator('#reader-font-size-value')).toHaveText('100%');
    await page.locator('#reader-font-family').selectOption('original');
    await expect.poll(() => getReaderTypography(page)).toMatchObject({ family: null, styleText: '' });

    await page.locator('#reader-font-family').selectOption('kai');
    await page.locator('#reader-font-size').fill('130');
    await page.locator('#epub-container').evaluate((host) => {
      const iframe = Array.from(host.querySelectorAll('iframe')).find(item => item.contentDocument?.body);
      iframe.contentDocument.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -100,
      }));
    });
    await expect(page.locator('#reader-font-size-value')).toHaveText('135%');
    await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null'), TYPOGRAPHY_KEY))
      .toEqual({ fontFamily: 'kai', fontSize: 135 });

    await page.reload();
    await expect(page.locator('#reader-font-family')).toHaveValue('kai');
    await expect(page.locator('#reader-font-size')).toHaveValue('135');
    await expect(page.locator('#reader-font-size-value')).toHaveText('135%');
    await expect(page.locator('#toolbar-book-title')).toContainText(/multichapter/i, { timeout: 15_000 });
    await expect.poll(() => getReaderTypography(page)).toMatchObject({ family: 'kai' });
  });

  test('keeps typography controls inside all target viewport widths', async ({ page }) => {
    for (const width of [360, 390, 768, 1000, 1440]) {
      await page.setViewportSize({ width, height: width < 700 ? 844 : 900 });
      await page.goto('/index.html');
      await page.evaluate(() => {
        document.querySelector('#library-view').classList.remove('active');
        document.querySelector('#reader-view').classList.add('active');
        document.body.classList.add('reader-active');
      });
      await page.locator('#btn-reader-tools').click();
      const panel = page.locator('#reader-tool-panel');
      await expect(panel).toBeVisible();

      const metrics = await page.evaluate(() => ({
        viewport: window.innerWidth,
        root: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
      }));
      expect(metrics.root).toBeLessThanOrEqual(metrics.viewport + 1);
      expect(metrics.body).toBeLessThanOrEqual(metrics.viewport + 1);

      const panelBounds = await panel.boundingBox();
      expect(panelBounds).not.toBeNull();
      expect(panelBounds.x).toBeGreaterThanOrEqual(0);
      expect(panelBounds.x + panelBounds.width).toBeLessThanOrEqual(width + 1);
      await expect(page.locator('#reader-font-family')).toBeVisible();
      await expect(page.locator('#reader-font-size')).toBeVisible();

      if (width <= 900) {
        for (const selector of ['#reader-font-family', '#btn-reader-font-decrease', '#btn-reader-font-reset', '#btn-reader-font-increase']) {
          const bounds = await page.locator(selector).boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds.height).toBeGreaterThanOrEqual(44);
        }
      }
    }
  });
});
