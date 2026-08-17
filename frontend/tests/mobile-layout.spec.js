import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'multichapter.epub');

async function expectNoHorizontalOverflow(page) {
  const metrics = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewport + 1);
  expect(metrics.bodyWidth).toBeLessThanOrEqual(metrics.viewport + 1);
}

function expectSameBounds(actual, expected, tolerance = 1) {
  expect(actual).not.toBeNull();
  expect(expected).not.toBeNull();
  for (const key of ['x', 'y', 'width', 'height']) {
    expect(Math.abs(actual[key] - expected[key])).toBeLessThanOrEqual(tolerance);
  }
}

async function openFixture(page, url = '/index.html') {
  await page.goto(url);
  await page.setInputFiles('#file-input', FIXTURE);
  await expect(page.locator('#toolbar-book-title')).toContainText(/multichapter/i, { timeout: 15_000 });
  await expect(page.locator('#reader-view')).toHaveClass(/active/);
}

async function tapReaderZoneWithTouchscreen(page, direction) {
  await page.locator('#epub-container').evaluate((host, tapDirection) => {
    const iframe = Array.from(host.querySelectorAll('iframe')).find(item => item.contentDocument?.body);
    if (!iframe) throw new Error('No active EPUB iframe found');
    const doc = iframe.contentDocument;
    const width = iframe.clientWidth || doc.documentElement.clientWidth;
    const height = iframe.clientHeight || doc.documentElement.clientHeight;
    const x = width * (tapDirection === 'prev' ? 0.16 : 0.84);
    const y = height * 0.55;
    const touch = new Touch({
      identifier: 41,
      target: doc.body,
      clientX: x,
      clientY: y,
    });
    const dispatchPointer = type => doc.body.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 41,
      pointerType: 'touch',
      isPrimary: true,
      clientX: x,
      clientY: y,
    }));
    dispatchPointer('pointerdown');
    doc.body.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true,
      cancelable: true,
      touches: [touch],
      targetTouches: [touch],
      changedTouches: [touch],
    }));
    dispatchPointer('pointerup');
    doc.body.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true,
      cancelable: true,
      touches: [],
      targetTouches: [],
      changedTouches: [touch],
    }));
    doc.body.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: x,
      clientY: y,
    }));
  }, direction);
}

async function doubleTapIframeWithTouchscreen(page) {
  await doubleTapIframe(page);
}

async function swipeReaderWithTouchscreen(page, {
  deltaX = 0,
  deltaY = 0,
  duration = 180,
  hold = 0,
} = {}) {
  await page.locator('#epub-container').evaluate(async (host, gesture) => {
    const iframe = Array.from(host.querySelectorAll('iframe'))
      .filter(item => item.contentDocument?.body)
      .sort((left, right) => (
        right.clientWidth * right.clientHeight - left.clientWidth * left.clientHeight
      ))[0];
    if (!iframe) throw new Error('No active EPUB iframe found');
    const doc = iframe.contentDocument;
    const width = iframe.clientWidth || doc.documentElement.clientWidth;
    const height = iframe.clientHeight || doc.documentElement.clientHeight;
    const startX = width * 0.5 - gesture.deltaX * 0.5;
    const startY = height * 0.5 - gesture.deltaY * 0.5;
    const makeTouch = (x, y) => new Touch({
      identifier: 9,
      target: doc.body,
      clientX: x,
      clientY: y,
    });
    const start = makeTouch(startX, startY);
    doc.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true,
      cancelable: true,
      touches: [start],
      targetTouches: [start],
      changedTouches: [start],
    }));
    if (gesture.hold > 0) {
      await new Promise(resolve => setTimeout(resolve, gesture.hold));
    }
    const steps = 6;
    let current = start;
    for (let step = 1; step <= steps; step += 1) {
      await new Promise(resolve => setTimeout(resolve, gesture.duration / steps));
      current = makeTouch(
        startX + gesture.deltaX * (step / steps),
        startY + gesture.deltaY * (step / steps)
      );
      doc.dispatchEvent(new TouchEvent('touchmove', {
        bubbles: true,
        cancelable: true,
        touches: [current],
        targetTouches: [current],
        changedTouches: [current],
      }));
    }
    doc.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true,
      cancelable: true,
      touches: [],
      targetTouches: [],
      changedTouches: [current],
    }));
  }, { deltaX, deltaY, duration, hold });
}

async function tapOuterIOSZone(page, direction) {
  const selector = direction === 'next'
    ? '.ios-reader-swipe-zone-right'
    : '.ios-reader-swipe-zone-left';
  const bounds = await page.locator(selector).boundingBox();
  if (!bounds) throw new Error(`No visible iOS ${direction} tap zone found`);
  await page.touchscreen.tap(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
}

async function swipeOuterIOSZone(page, { direction = 'next', duration = 180 } = {}) {
  const selector = direction === 'next'
    ? '.ios-reader-swipe-zone-right'
    : '.ios-reader-swipe-zone-left';
  const deltaX = direction === 'next' ? -150 : 150;
  await page.locator(selector).evaluate(async (zone, gesture) => {
    const rect = zone.getBoundingClientRect();
    const startX = rect.left + rect.width * 0.5;
    const startY = rect.top + rect.height * 0.5;
    const makeTouch = (x) => new Touch({
      identifier: 29,
      target: zone,
      clientX: x,
      clientY: startY,
    });
    const start = makeTouch(startX);
    zone.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true,
      cancelable: true,
      touches: [start],
      targetTouches: [start],
      changedTouches: [start],
    }));
    const steps = 6;
    let current = start;
    for (let step = 1; step <= steps; step += 1) {
      await new Promise(resolve => setTimeout(resolve, gesture.duration / steps));
      current = makeTouch(startX + gesture.deltaX * (step / steps));
      zone.dispatchEvent(new TouchEvent('touchmove', {
        bubbles: true,
        cancelable: true,
        touches: [current],
        targetTouches: [current],
        changedTouches: [current],
      }));
    }
    zone.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true,
      cancelable: true,
      touches: [],
      targetTouches: [],
      changedTouches: [current],
    }));
  }, { deltaX, duration });
}

async function swipeReaderWithPointerEvents(page, { deltaX = 0, deltaY = 0, duration = 180 } = {}) {
  await page.locator('#epub-container').evaluate(async (host, gesture) => {
    const iframe = Array.from(host.querySelectorAll('iframe'))
      .filter(item => item.contentDocument?.body)
      .sort((left, right) => (
        right.clientWidth * right.clientHeight - left.clientWidth * left.clientHeight
      ))[0];
    if (!iframe) throw new Error('No active EPUB iframe found');
    const doc = iframe.contentDocument;
    const width = iframe.clientWidth || doc.documentElement.clientWidth;
    const height = iframe.clientHeight || doc.documentElement.clientHeight;
    const startX = width * 0.5 - gesture.deltaX * 0.5;
    const startY = height * 0.5 - gesture.deltaY * 0.5;
    const dispatch = (type, x, y) => doc.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 19,
      pointerType: 'touch',
      isPrimary: true,
      clientX: x,
      clientY: y,
    }));
    dispatch('pointerdown', startX, startY);
    const steps = 6;
    for (let step = 1; step <= steps; step += 1) {
      await new Promise(resolve => setTimeout(resolve, gesture.duration / steps));
      dispatch(
        'pointermove',
        startX + gesture.deltaX * (step / steps),
        startY + gesture.deltaY * (step / steps)
      );
    }
    dispatch('pointerup', startX + gesture.deltaX, startY + gesture.deltaY);
  }, { deltaX, deltaY, duration });
}

function pageInfoFromText(text) {
  const match = String(text || '').match(/第\s*(\d+)\s*\/\s*(\d+)\s*页/);
  return match ? { current: Number(match[1]), total: Number(match[2]) } : null;
}

function currentPageFromText(text) {
  return pageInfoFromText(text)?.current || 0;
}

async function getReaderPageInfo(page) {
  return pageInfoFromText(await page.locator('#page-text').textContent());
}

async function doubleTapIframe(page, { x = null, y = null } = {}) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const tapped = await page.locator('#epub-container').evaluate(async (host, point) => {
      const iframe = Array.from(host.querySelectorAll('iframe')).find(item => item.contentDocument?.body);
      if (!iframe) return false;
      const doc = iframe.contentDocument;
      const width = iframe.clientWidth || doc.documentElement.clientWidth;
      const height = iframe.clientHeight || doc.documentElement.clientHeight;
      const tapX = Number.isFinite(point.x) ? point.x : width * 0.5;
      const tapY = Number.isFinite(point.y) ? point.y : height * 0.5;
      const dispatchTap = () => {
        const touch = new Touch({
          identifier: 7,
          target: doc.body,
          clientX: tapX,
          clientY: tapY,
        });
        doc.dispatchEvent(new TouchEvent('touchstart', {
          bubbles: true,
          cancelable: true,
          touches: [touch],
          targetTouches: [touch],
          changedTouches: [touch],
        }));
        doc.dispatchEvent(new TouchEvent('touchend', {
          bubbles: true,
          cancelable: true,
          touches: [],
          targetTouches: [],
          changedTouches: [touch],
        }));
      };
      dispatchTap();
      await new Promise(resolve => setTimeout(resolve, 90));
      if (!doc.body || !doc.defaultView) return false;
      dispatchTap();
      return true;
    }, { x, y });
    if (tapped) return;
    await page.waitForTimeout(100);
  }
  throw new Error('No stable EPUB iframe found for double tap');
}

async function selectIframeText(page) {
  return page.locator('#epub-container').evaluate((host) => {
    const iframe = Array.from(host.querySelectorAll('iframe')).find(item => item.contentDocument?.body);
    if (!iframe) throw new Error('No active EPUB iframe found');
    const doc = iframe.contentDocument;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && node.nodeValue.trim().length < 36) node = walker.nextNode();
    if (!node) throw new Error('No selectable fixture text found');

    const leadingWhitespace = node.nodeValue.search(/\S/);
    const start = Math.max(0, leadingWhitespace);
    const end = Math.min(node.nodeValue.length, start + 30);
    const range = doc.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new Event('selectionchange'));
    return selection.toString().trim();
  });
}

async function selectMultilineIframeText(page) {
  return page.locator('#epub-container').evaluate((host) => {
    const iframe = Array.from(host.querySelectorAll('iframe')).find(item => item.contentDocument?.body);
    if (!iframe) throw new Error('No active EPUB iframe found');
    const doc = iframe.contentDocument;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && node.nodeValue.trim().length < 120) node = walker.nextNode();
    if (!node) throw new Error('No long selectable fixture text found');

    const leadingWhitespace = node.nodeValue.search(/\S/);
    const start = Math.max(0, leadingWhitespace);
    const end = Math.min(node.nodeValue.length, start + 120);
    const range = doc.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new Event('selectionchange'));

    const frameRect = iframe.getBoundingClientRect();
    const rects = Array.from(range.getClientRects()).filter(item => item.width || item.height);
    if (rects.length < 2) throw new Error('Fixture selection did not span multiple lines');
    const bounds = rects.reduce((acc, item) => ({
      top: Math.min(acc.top, item.top),
      bottom: Math.max(acc.bottom, item.bottom),
    }), { top: rects[0].top, bottom: rects[0].bottom });

    return {
      text: selection.toString().trim(),
      selectionTop: bounds.top + frameRect.top,
      selectionBottom: bounds.bottom + frameRect.top,
    };
  });
}

test.describe('@mobile mobile layout', () => {
  test.use({ serviceWorkers: 'block' });
  test('has no horizontal overflow at common phone and tablet widths', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('#library-view')).toHaveClass(/active/);
    for (const viewport of [
      { width: 360, height: 800 },
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
    ]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(50);
      await expectNoHorizontalOverflow(page);
    }
  });

  test('keeps the app shell and workspace inside the safe viewport', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('#library-view')).toHaveClass(/active/);
    await expectNoHorizontalOverflow(page);

    const homeHeader = await page.locator('.home-nav').boundingBox();
    const creationEntry = await page.locator('#btn-library-create').boundingBox();
    expect(homeHeader).not.toBeNull();
    expect(creationEntry).not.toBeNull();
    expect(homeHeader.y).toBeLessThanOrEqual(1);
    expect(creationEntry.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator('.nav-tabs')).toHaveCount(0);

    await page.locator('#btn-library-create').click();
    await expect(page.locator('#creation-view')).toHaveClass(/active/);
    await expect(page.locator('#library-view')).not.toHaveClass(/active/);
    await expect(page.locator('#btn-creation-back')).toBeVisible();
    await expect(page.locator('.home-nav')).toBeHidden();
    await expect(page).toHaveURL(/#\/creation$/);
    await expectNoHorizontalOverflow(page);

    const flowMetrics = await page.evaluate(() => {
      const steps = document.querySelector('.creation-steps').getBoundingClientRect();
      const firstPane = document.querySelector('.workspace-pane').getBoundingClientRect();
      return { stepsHeight: steps.height, stepsBottom: steps.bottom, firstPaneTop: firstPane.top };
    });
    expect(flowMetrics.stepsHeight).toBeGreaterThanOrEqual(40);
    expect(flowMetrics.firstPaneTop).toBeGreaterThanOrEqual(flowMetrics.stepsBottom - 1);

    const paneWidths = await page.locator('.workspace-pane').evaluateAll((panes) => (
      panes.map((pane) => {
        const rect = pane.getBoundingClientRect();
        return { left: rect.left, right: rect.right, viewport: window.innerWidth };
      })
    ));
    for (const pane of paneWidths) {
      expect(pane.left).toBeGreaterThanOrEqual(0);
      expect(pane.right).toBeLessThanOrEqual(pane.viewport + 1);
    }
  });

  test('uses a full-height reader and modal mobile tool panels', async ({ page }) => {
    await openFixture(page);
    await expectNoHorizontalOverflow(page);
    await expect(page.locator('#btn-nav-prev, #btn-nav-next')).toHaveCount(0);

    const readerMetrics = await page.evaluate(() => {
      const host = document.querySelector('#epub-container').getBoundingClientRect();
      const toolbar = document.querySelector('.reader-toolbar').getBoundingClientRect();
      return {
        hostHeight: host.height,
        hostTop: host.top,
        hostBottom: host.bottom,
        toolbarBottom: toolbar.bottom,
        viewportHeight: window.innerHeight,
      };
    });
    expect(readerMetrics.hostHeight).toBeGreaterThan(400);
    expect(readerMetrics.hostTop).toBeLessThan(readerMetrics.toolbarBottom);
    expect(readerMetrics.hostBottom).toBeGreaterThan(readerMetrics.viewportHeight - 16);
    await expect(page.locator('.reader-footer')).toHaveCount(0);
    await expect(page.locator('#reader-navigator')).toBeHidden();

    await page.locator('#btn-reader-tools').click();
    await expect(page.locator('#reader-tool-panel')).toBeVisible();
    await page.locator('#btn-toggle-navigator').click();
    await expect(page.locator('#reader-navigator')).toBeVisible();
    await expect(page.locator('#reader-panel-backdrop')).toBeVisible();
    await page.locator('#btn-close-navigator').click();
    await expect(page.locator('#reader-navigator')).toBeHidden();
    await page.locator('#btn-reader-tools').click();
    await page.locator('#btn-toggle-ai').click();
    await expect(page.locator('#reader-tool-panel')).toBeHidden();
    await expect(page.locator('#ai-panel')).toBeVisible();
    await expect(page.locator('#reader-panel-backdrop')).toBeVisible();

    await page.locator('#btn-close-ai').click();
    await expect(page.locator('#ai-panel')).toBeHidden();
    await expect(page.locator('#reader-panel-backdrop')).toBeHidden();

    await page.locator('#btn-reader-tools').click();
    await page.locator('#btn-toggle-notes').click();
    await expect(page.locator('#notes-panel')).toBeVisible();
    await expect(page.locator('#ai-panel')).toBeHidden();
    await page.locator('#btn-close-notes-panel').click();
    await expect(page.locator('#notes-panel')).toBeHidden();

    await page.locator('#btn-reader-tools').click();
    await page.locator('#btn-toggle-search').click();
    await expect(page.locator('#search-panel')).toBeVisible();
    await expect(page.locator('#search-input')).toBeVisible();
    await page.locator('#btn-close-search-panel').click();
    await expect(page.locator('#search-panel')).toBeHidden();
  });

  test('turns exactly one page for left and right taps without duplicate navigation', async ({ page }) => {
    await openFixture(page);
    await expect(page.locator('#page-text')).toHaveText(/第\s*\d+\s*\/\s*\d+\s*页/, { timeout: 15_000 });
    await expect(page.locator('#reader-view')).toHaveClass(/reader-chrome-hidden/, { timeout: 6_000 });
    await page.waitForTimeout(350);

    const initialPage = currentPageFromText(await page.locator('#page-text').textContent());
    await tapReaderZoneWithTouchscreen(page, 'next');
    await expect.poll(async () => currentPageFromText(
      await page.locator('#page-text').textContent()
    )).toBe(initialPage + 1);
    await page.waitForTimeout(800);
    expect(currentPageFromText(await page.locator('#page-text').textContent())).toBe(initialPage + 1);

    await tapReaderZoneWithTouchscreen(page, 'prev');
    await expect.poll(async () => currentPageFromText(
      await page.locator('#page-text').textContent()
    )).toBe(initialPage);
    await page.waitForTimeout(800);
    expect(currentPageFromText(await page.locator('#page-text').textContent())).toBe(initialPage);
  });

  test('turns exactly one page for horizontal swipes in both directions', async ({ page }) => {
    await openFixture(page);
    await expect(page.locator('#page-text')).toHaveText(/第\s*\d+\s*\/\s*\d+\s*页/, { timeout: 15_000 });
    await expect(page.locator('#reader-view')).toHaveClass(/reader-chrome-hidden/, { timeout: 6_000 });
    await page.waitForTimeout(350);

    const initialChapter = await page.locator('#toolbar-chapter').textContent();
    const initialPage = currentPageFromText(await page.locator('#page-text').textContent());
    await swipeReaderWithTouchscreen(page, { deltaX: -150 });
    await expect.poll(async () => currentPageFromText(
      await page.locator('#page-text').textContent()
    )).toBe(initialPage + 1);
    expect(await page.locator('#toolbar-chapter').textContent()).toBe(initialChapter);

    await page.waitForTimeout(350);
    await swipeReaderWithTouchscreen(page, { deltaX: 150 });
    await expect.poll(async () => currentPageFromText(
      await page.locator('#page-text').textContent()
    )).toBe(initialPage);
    expect(await page.locator('#toolbar-chapter').textContent()).toBe(initialChapter);

    await page.waitForTimeout(350);
    await swipeReaderWithPointerEvents(page, { deltaX: -150 });
    await expect.poll(async () => currentPageFromText(
      await page.locator('#page-text').textContent()
    )).toBe(initialPage + 1);

    await page.waitForTimeout(350);
    await swipeReaderWithPointerEvents(page, { deltaX: 150 });
    await expect.poll(async () => currentPageFromText(
      await page.locator('#page-text').textContent()
    )).toBe(initialPage);
  });

  test('uses the iOS outer swipe zones when iframe touch events are unavailable', async ({ page }) => {
    await openFixture(page, '/index.html?gestureDebug=1');
    await expect(page.locator('#page-text')).toHaveText(/第\s*\d+\s*\/\s*\d+\s*页/, { timeout: 15_000 });
    await expect(page.locator('.ios-reader-swipe-zone-right')).toBeVisible();
    await expect(page.locator('#reader-view')).toHaveClass(/reader-chrome-hidden/, { timeout: 6_000 });
    await page.waitForTimeout(350);

    const initialPage = currentPageFromText(await page.locator('#page-text').textContent());
    await swipeOuterIOSZone(page, { direction: 'next' });
    await expect.poll(async () => currentPageFromText(
      await page.locator('#page-text').textContent()
    )).toBe(initialPage + 1);

    await page.waitForTimeout(350);
    await swipeOuterIOSZone(page, { direction: 'prev' });
    await expect.poll(async () => currentPageFromText(
      await page.locator('#page-text').textContent()
    )).toBe(initialPage);

    await page.waitForTimeout(350);
    await tapOuterIOSZone(page, 'next');
    await expect.poll(async () => currentPageFromText(
      await page.locator('#page-text').textContent()
    )).toBe(initialPage + 1);
    await page.waitForTimeout(800);
    expect(currentPageFromText(await page.locator('#page-text').textContent())).toBe(initialPage + 1);

    await tapOuterIOSZone(page, 'prev');
    await expect.poll(async () => currentPageFromText(
      await page.locator('#page-text').textContent()
    )).toBe(initialPage);
  });

  test('crosses chapter boundaries correctly with left and right swipes', async ({ page }) => {
    await openFixture(page);
    await expect(page.locator('#page-text')).toHaveText(/第\s*\d+\s*\/\s*\d+\s*页/, { timeout: 15_000 });
    const initialChapter = await page.locator('#toolbar-chapter').textContent();
    await expect(page.locator('#reader-view')).toHaveClass(/reader-chrome-hidden/, { timeout: 6_000 });
    await page.waitForTimeout(850);

    let lastPageInfo = await getReaderPageInfo(page);
    for (let attempt = 0; lastPageInfo && lastPageInfo.current < lastPageInfo.total && attempt < 120; attempt += 1) {
      const previousPage = lastPageInfo.current;
      await page.keyboard.press('ArrowRight');
      await expect.poll(async () => (await getReaderPageInfo(page))?.current || 0).toBe(previousPage + 1);
      await page.waitForTimeout(220);
      lastPageInfo = await getReaderPageInfo(page);
    }
    expect(lastPageInfo).not.toBeNull();
    expect(lastPageInfo.current).toBe(lastPageInfo.total);
    expect(await page.locator('#toolbar-chapter').textContent()).toBe(initialChapter);

    await page.waitForTimeout(350);
    await swipeReaderWithTouchscreen(page, { deltaX: -150 });
    await expect.poll(async () => page.locator('#toolbar-chapter').textContent()).not.toBe(initialChapter);
    const nextChapter = await page.locator('#toolbar-chapter').textContent();
    await expect.poll(async () => (await getReaderPageInfo(page))?.current || 0).toBe(1);

    await page.waitForTimeout(350);
    await swipeReaderWithTouchscreen(page, { deltaX: 150 });
    await expect.poll(async () => page.locator('#toolbar-chapter').textContent()).toBe(initialChapter);
    const returnedPageInfo = await getReaderPageInfo(page);
    expect(returnedPageInfo).not.toBeNull();
    expect(returnedPageInfo.current).toBe(returnedPageInfo.total);
    expect(nextChapter).not.toBe(initialChapter);
  });

  test('does not turn pages for vertical, diagonal, or long-press swipes', async ({ page }) => {
    await openFixture(page);
    await expect(page.locator('#page-text')).toHaveText(/第\s*\d+\s*\/\s*\d+\s*页/, { timeout: 15_000 });
    await expect(page.locator('#reader-view')).toHaveClass(/reader-chrome-hidden/, { timeout: 6_000 });
    await page.waitForTimeout(350);

    const initialChapter = await page.locator('#toolbar-chapter').textContent();
    const initialPage = currentPageFromText(await page.locator('#page-text').textContent());
    await swipeReaderWithTouchscreen(page, { deltaY: -150 });
    await page.waitForTimeout(350);
    expect(currentPageFromText(await page.locator('#page-text').textContent())).toBe(initialPage);

    await swipeReaderWithTouchscreen(page, { deltaX: -90, deltaY: -100 });
    await page.waitForTimeout(350);
    expect(currentPageFromText(await page.locator('#page-text').textContent())).toBe(initialPage);

    await swipeReaderWithTouchscreen(page, { deltaX: -150, hold: 700 });
    await page.waitForTimeout(350);
    expect(currentPageFromText(await page.locator('#page-text').textContent())).toBe(initialPage);
    expect(await page.locator('#toolbar-chapter').textContent()).toBe(initialChapter);
  });

  test('floats reader chrome without resizing or repaginating the book', async ({ page }) => {
    await openFixture(page);
    const reader = page.locator('#reader-view');
    const revealButton = page.locator('#btn-reveal-reader-chrome');
    await expect(reader).toHaveClass(/reader-chrome-hidden/, { timeout: 6_000 });
    await revealButton.click();
    await expect(reader).not.toHaveClass(/reader-chrome-hidden/, { timeout: 1_500 });
    await expect(page.locator('.reader-toolbar')).toBeVisible();
    await expect(page.locator('.reader-footer')).toHaveCount(0);
    await expect(page.locator('.home-nav')).toBeHidden();
    await page.waitForTimeout(350);

    const visibleHost = await page.locator('#epub-container').boundingBox();
    const stablePage = currentPageFromText(await page.locator('#page-text').textContent());
    const overlayMetrics = await page.evaluate(() => {
      const host = document.querySelector('#epub-container').getBoundingClientRect();
      const toolbar = document.querySelector('.reader-toolbar').getBoundingClientRect();
      return { hostTop: host.top, hostBottom: host.bottom, toolbarBottom: toolbar.bottom, viewportHeight: window.innerHeight };
    });
    expect(overlayMetrics.hostTop).toBeLessThan(overlayMetrics.toolbarBottom);
    expect(overlayMetrics.hostBottom).toBeGreaterThan(overlayMetrics.viewportHeight - 16);

    await doubleTapIframeWithTouchscreen(page);
    await expect(reader).toHaveClass(/reader-chrome-hidden/);
    await expect(page.locator('.reader-toolbar')).toBeHidden();
    await expect(page.locator('.reader-footer')).toHaveCount(0);
    await expect(page.locator('.home-nav')).toBeHidden();
    await page.waitForTimeout(350);

    const hiddenHost = await page.locator('#epub-container').boundingBox();
    expectSameBounds(hiddenHost, visibleHost);
    expect(currentPageFromText(await page.locator('#page-text').textContent())).toBe(stablePage);

    await page.waitForTimeout(500);
    await doubleTapIframeWithTouchscreen(page);
    await expect(reader).not.toHaveClass(/reader-chrome-hidden/, { timeout: 1_500 });
    await page.waitForTimeout(350);
    expectSameBounds(await page.locator('#epub-container').boundingBox(), visibleHost);
    expect(currentPageFromText(await page.locator('#page-text').textContent())).toBe(stablePage);

    await page.waitForTimeout(500);
    await doubleTapIframeWithTouchscreen(page);
    await expect(reader).toHaveClass(/reader-chrome-hidden/);
    await expect(revealButton).toBeVisible();
    expect(await revealButton.boundingBox()).not.toBeNull();
    await expect(page.locator('#btn-nav-prev, #btn-nav-next')).toHaveCount(0);
    await revealButton.click();
    await expect(reader).not.toHaveClass(/reader-chrome-hidden/);
  });

  test('keeps reader chrome visible while the tool menu is open', async ({ page }) => {
    await openFixture(page);
    const reader = page.locator('#reader-view');
    await expect(reader).toHaveClass(/reader-chrome-hidden/, { timeout: 6_000 });
    await page.waitForTimeout(350);
    await doubleTapIframeWithTouchscreen(page);
    await expect(reader).not.toHaveClass(/reader-chrome-hidden/, { timeout: 1_500 });

    await page.locator('#btn-reader-tools').click();
    await expect(page.locator('#reader-tool-panel')).toBeVisible();
    const pageWhileToolsOpen = currentPageFromText(await page.locator('#page-text').textContent());
    await swipeReaderWithTouchscreen(page, { deltaX: -150 });
    await page.waitForTimeout(350);
    expect(currentPageFromText(await page.locator('#page-text').textContent())).toBe(pageWhileToolsOpen);
    await page.waitForTimeout(4_000);
    await expect(reader).not.toHaveClass(/reader-chrome-hidden/);

    await page.locator('#btn-reader-tools').click();
    await expect(page.locator('#reader-tool-panel')).toBeHidden();
    await expect(reader).toHaveClass(/reader-chrome-hidden/, { timeout: 6_000 });
  });

  test('can disable reader chrome auto-hide and remembers the preference', async ({ page }) => {
    await openFixture(page);
    const reader = page.locator('#reader-view');
    const toggle = page.locator('#btn-toggle-reader-auto-hide');

    await page.locator('#btn-reader-tools').click();
    await expect(page.locator('#reader-tool-panel')).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toHaveText('自动收起：关');
    await page.locator('#btn-reader-tools').click();
    await expect(page.locator('#reader-tool-panel')).toBeHidden();

    await page.waitForTimeout(4_000);
    await expect(reader).not.toHaveClass(/reader-chrome-hidden/);

    await page.reload();
    await expect(page.locator('#btn-toggle-reader-auto-hide')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#btn-toggle-reader-auto-hide')).toHaveText('自动收起：关');
  });

  test('creates an exact highlight from a touch-style iframe selection', async ({ page }) => {
    await openFixture(page);
    await expect(page.locator('#page-text')).toHaveText(/第\s*\d+\s*\/\s*\d+\s*页/, { timeout: 15_000 });

    const selectedText = await selectIframeText(page);
    const toolbar = page.locator('#selection-toolbar');
    await expect(toolbar).toBeVisible();
    const chromeWasHidden = await page.locator('#reader-view').evaluate(element => (
      element.classList.contains('reader-chrome-hidden')
    ));
    await doubleTapIframe(page);
    await expect(toolbar).toBeVisible();
    expect(await page.locator('#reader-view').evaluate(element => (
      element.classList.contains('reader-chrome-hidden')
    ))).toBe(chromeWasHidden);

    const toolbarBounds = await toolbar.boundingBox();
    const viewport = page.viewportSize();
    expect(toolbarBounds).not.toBeNull();
    expect(toolbarBounds.x).toBeGreaterThanOrEqual(0);
    expect(toolbarBounds.y).toBeGreaterThanOrEqual(0);
    expect(toolbarBounds.x + toolbarBounds.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(toolbarBounds.y + toolbarBounds.height).toBeLessThanOrEqual(viewport.height + 1);

    const pageBeforeSwipe = await page.locator('#page-text').textContent();
    const currentPageBeforeSwipe = Number(pageBeforeSwipe.match(/第\s*(\d+)/)?.[1] || 0);
    const dispatchedTouch = await page.locator('#epub-container').evaluate((host) => {
      const iframe = Array.from(host.querySelectorAll('iframe')).find(item => item.contentDocument?.body);
      if (!iframe) throw new Error('No active EPUB iframe found');
      const doc = iframe.contentDocument;
      if (typeof Touch !== 'function' || typeof TouchEvent !== 'function') return false;
      const start = new Touch({
        identifier: 1,
        target: doc.body,
        clientX: 300,
        clientY: 300,
      });
      const end = new Touch({
        identifier: 1,
        target: doc.body,
        clientX: 180,
        clientY: 300,
      });
      doc.dispatchEvent(new TouchEvent('touchstart', {
        bubbles: true,
        cancelable: true,
        touches: [start],
        targetTouches: [start],
        changedTouches: [start],
      }));
      doc.dispatchEvent(new TouchEvent('touchend', {
        bubbles: true,
        cancelable: true,
        touches: [],
        targetTouches: [],
        changedTouches: [end],
      }));
      return true;
    });
    expect(dispatchedTouch).toBe(true);
    await page.waitForTimeout(300);
    await expect(toolbar).toBeVisible();
    const pageAfterSwipe = await page.locator('#page-text').textContent();
    expect(Number(pageAfterSwipe.match(/第\s*(\d+)/)?.[1] || 0)).toBe(currentPageBeforeSwipe);

    await page.locator('#selection-toolbar [data-color="yellow"]').click();
    await expect(toolbar).toBeHidden();
    await expect(page.locator('#notes-count')).toHaveText('1 条');

    const savedHighlight = await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('marginalia', 5);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('highlights', 'readonly');
        const allRequest = transaction.objectStore('highlights').getAll();
        allRequest.onsuccess = () => resolve(allRequest.result[0]);
        allRequest.onerror = () => reject(allRequest.error);
        transaction.oncomplete = () => db.close();
      };
    }));
    expect(savedHighlight.highlight_text).toBe(selectedText);
    expect(savedHighlight.cfi).toMatch(/^epubcfi\(.*,.+,.+\)$/);
    expect(savedHighlight.color).toBe('yellow');
  });

  test('places the highlight toolbar above a multiline selection', async ({ page }) => {
    await openFixture(page);
    await expect(page.locator('#page-text')).toHaveText(/第\s*\d+\s*\/\s*\d+\s*页/, { timeout: 15_000 });

    const selectionBounds = await selectMultilineIframeText(page);
    const toolbar = page.locator('#selection-toolbar');
    await expect(toolbar).toBeVisible();

    const toolbarBounds = await toolbar.boundingBox();
    expect(toolbarBounds).not.toBeNull();
    expect(toolbarBounds.y + toolbarBounds.height).toBeLessThanOrEqual(selectionBounds.selectionTop + 1);
    expect(toolbarBounds.y + toolbarBounds.height).toBeLessThan(selectionBounds.selectionBottom - 8);
  });
});
