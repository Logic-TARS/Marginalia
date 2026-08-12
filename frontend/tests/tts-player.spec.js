import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'multichapter.epub');
const CHAPTER_ONE_TEXT = new AdmZip(FIXTURE)
  .readAsText('OEBPS/chapter-1.xhtml')
  .match(/<(?:h[1-4]|p|li|blockquote|figcaption)\b[^>]*>[\s\S]*?<\/(?:h[1-4]|p|li|blockquote|figcaption)>/gi)
  .map(block => block.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
  .filter(Boolean)
  .join('\n');

function silentWav() {
  const samples = 8000;
  const buffer = Buffer.alloc(44 + samples);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(8000, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples, 40);
  buffer.fill(128, 44);
  return buffer;
}

test.describe('automatic narration player', () => {
  test.use({ serviceWorkers: 'block' });

  test('plays, waits for the next segment, restores position, and cleans up on chapter change', async ({ page }) => {
    test.setTimeout(60_000);
    let allowSecondSegment = false;
    let failMode = false;
    const book = {
      id: 'tts-book',
      title: 'Multichapter Test Fixture',
      author: 'Test Fixture Generator',
      filename: 'tts-book.epub',
      original_filename: 'multichapter.epub',
      content_hash: 'tts-fixture-hash',
      knowledge_book_id: 'knowledge-tts',
      knowledge_status: 'ready',
      knowledge_error: '',
    };
    const emptyState = {
      book_id: book.id,
      revision: 0,
      progress: null,
      bookmarks: [],
      highlights: [],
    };
    const finalCueText = 'Quis autem';
    const finalCueStart = CHAPTER_ONE_TEXT.lastIndexOf(finalCueText);
    const timedSegment = (index) => index === 0 ? {
      index: 0,
      status: 'ready',
      audioUrl: '/api/tts/tasks/task-tts/segments/0',
      text: CHAPTER_ONE_TEXT,
      chapterStart: 0,
      chapterEnd: CHAPTER_ONE_TEXT.length,
      cues: [
        { text: 'Chapter', start: 0, end: 7, startMs: 0, durationMs: 800 },
        { text: finalCueText, start: finalCueStart, end: finalCueStart + finalCueText.length, startMs: 2000, durationMs: 800 },
      ],
    } : {
      index: 1,
      status: 'ready',
      audioUrl: '/api/tts/tasks/task-tts/segments/1',
      text: 'Quis autem vel eum iure reprehenderit',
      chapterStart: CHAPTER_ONE_TEXT.length - 200,
      chapterEnd: CHAPTER_ONE_TEXT.length - 160,
      cues: [{ text: 'Quis', start: 0, end: 4, startMs: 0, durationMs: 500 }],
    };

    await page.addInitScript(() => {
      Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
        configurable: true,
        get() { return 60; },
      });
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
        configurable: true,
        get() { return this.__mockCurrentTime || 0; },
        set(value) { this.__mockCurrentTime = Number(value) || 0; },
      });
      HTMLMediaElement.prototype.load = function load() {
        setTimeout(() => this.dispatchEvent(new Event('loadedmetadata')), 0);
      };
      HTMLMediaElement.prototype.play = function play() {
        this.dataset.mockPlaying = 'true';
        this.dispatchEvent(new Event('play'));
        return Promise.resolve();
      };
      HTMLMediaElement.prototype.pause = function pause() {
        this.dataset.mockPlaying = 'false';
        this.dispatchEvent(new Event('pause'));
      };
    });

    await page.addInitScript(() => {
      window.addEventListener('DOMContentLoaded', () => {
        window.__ttsDisplayTargets = [];
        window.__ttsUnderlineCalls = [];
        window.__ttsUnderlineRemovals = [];
        window.__delayTtsDisplay = false;
        const originalEpub = window.ePub;
        const instrumentedEpub = function instrumentedEpub(...args) {
          const bookInstance = originalEpub.apply(this, args);
          const originalRenderTo = bookInstance.renderTo.bind(bookInstance);
          bookInstance.renderTo = (...renderArgs) => {
            const rendition = originalRenderTo(...renderArgs);
            const originalDisplay = rendition.display.bind(rendition);
            rendition.display = async (target) => {
              if (typeof target === 'string' && target.startsWith('epubcfi(')) {
                window.__ttsDisplayTargets.push(target);
                if (window.__delayTtsDisplay) {
                  await new Promise(resolve => setTimeout(resolve, 80));
                }
              }
              return originalDisplay(target);
            };
            if (typeof rendition.annotations.underline === 'function') {
              const originalUnderline = rendition.annotations.underline.bind(rendition.annotations);
              rendition.annotations.underline = (cfi, data, callback, className, styles) => {
                window.__ttsUnderlineCalls.push({ cfi, data, className, styles });
                return originalUnderline(cfi, data, callback, className, styles);
              };
            }
            const originalRemove = rendition.annotations.remove.bind(rendition.annotations);
            rendition.annotations.remove = (cfi, type) => {
              if (type === 'underline') window.__ttsUnderlineRemovals.push(cfi);
              return originalRemove(cfi, type);
            };
            return rendition;
          };
          return bookInstance;
        };
        Object.assign(instrumentedEpub, originalEpub);
        window.ePub = instrumentedEpub;
      }, { once: true });
    });

    await page.route('**/api/**', async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const method = request.method();
      if (pathname === '/api/books' && method === 'GET') {
        await route.fulfill({ json: { books: [book] } });
        return;
      }
      if (pathname === `/api/books/${book.id}/file`) {
        await route.fulfill({
          status: 200,
          contentType: 'application/epub+zip',
          body: fs.readFileSync(FIXTURE),
        });
        return;
      }
      if (pathname === `/api/books/${book.id}/sync`) {
        await route.fulfill({ json: emptyState });
        return;
      }
      if (pathname === '/api/tts/voices') {
        await route.fulfill({ json: {
          enabled: true,
          provider: 'edge-tts',
          defaultVoice: 'zh-CN-XiaoxiaoNeural',
          voices: [
            { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓（女声）', gender: 'Female', locale: 'zh-CN' },
            { id: 'zh-CN-YunxiNeural', name: '云希（男声）', gender: 'Male', locale: 'zh-CN' },
          ],
        } });
        return;
      }
      if (pathname.includes('/chapters/') && pathname.endsWith('/tts') && method === 'POST') {
        const options = request.postDataJSON();
        expect(Object.keys(options).sort()).toEqual(['rate', 'voice']);
        const task = failMode ? {
          taskId: 'task-failed', bookId: book.id, chapterId: 'chapter-2.xhtml',
          status: 'failed', segmentCount: 1, completedSegments: 0, segments: [],
          voice: options.voice, rate: options.rate, error: '语音服务连接失败',
        } : {
          taskId: 'task-tts', bookId: book.id, chapterId: 'chapter-1.xhtml',
          status: allowSecondSegment ? 'completed' : 'pending', segmentCount: 2,
          completedSegments: allowSecondSegment ? 2 : 0,
          segments: allowSecondSegment ? [timedSegment(0), timedSegment(1)] : [],
          voice: options.voice, rate: options.rate, error: null,
        };
        await route.fulfill({ status: 202, json: task });
        return;
      }
      if (pathname === '/api/tts/tasks/task-tts') {
        const segments = [timedSegment(0)];
        if (allowSecondSegment) segments.push(timedSegment(1));
        await route.fulfill({ json: {
          taskId: 'task-tts', bookId: book.id, chapterId: 'chapter-1.xhtml',
          status: allowSecondSegment ? 'completed' : 'generating', segmentCount: 2,
          completedSegments: segments.length, segments,
          voice: 'zh-CN-XiaoxiaoNeural', rate: 1, error: null,
        } });
        return;
      }
      if (pathname.startsWith('/api/tts/tasks/task-tts/segments/')) {
        await route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() });
        return;
      }
      if (pathname === '/api/knowledge/books/knowledge-tts') {
        await route.fulfill({ json: { id: 'knowledge-tts', status: 'ready' } });
        return;
      }
      if (pathname.endsWith('/conversations')) {
        await route.fulfill({ json: { conversations: [], count: 0 } });
        return;
      }
      await route.fulfill({ status: 404, json: { detail: 'not mocked' } });
    });

    await page.goto('/index.html');
    await expect(page.locator('.book-card')).toHaveCount(1);
    await page.click('.book-card');
    await expect(page.locator('#toolbar-book-title')).toContainText('Multichapter');

    await page.click('#btn-reader-tools');
    await page.click('#btn-toggle-tts');
    await expect(page.locator('.tts-option-field')).toHaveCount(2);
    await expect(page.locator('.tts-transport')).toBeVisible();
    const ttsPanelBounds = await page.locator('#tts-panel').boundingBox();
    const viewport = page.viewportSize();
    expect(ttsPanelBounds).not.toBeNull();
    expect(ttsPanelBounds.x).toBeGreaterThanOrEqual(0);
    expect(ttsPanelBounds.x + ttsPanelBounds.width).toBeLessThanOrEqual(viewport.width + 1);
    await page.click('#btn-tts-start');
    await expect(page.locator('#tts-status')).toContainText('正在播放', { timeout: 10_000 });
    await expect(page.locator('#tts-audio')).toHaveAttribute('data-mock-playing', 'true');
    await expect(page.locator('#reader-view')).toHaveClass(/tts-navigation-locked/);
    await expect(page.locator('#btn-nav-prev, #btn-nav-next')).toHaveCount(0);
    await expect(page.locator('#progress-slider')).toHaveCount(0);
    const iframe = page.locator('#epub-container iframe').first();
    await expect.poll(() => iframe.evaluate(frame => frame.contentDocument.documentElement.dataset.ttsFollowText)).toBe('Chapter');
    await expect.poll(() => page.evaluate(() => window.__ttsDisplayTargets.length)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => window.__ttsUnderlineCalls.at(-1))).toMatchObject({
      className: 'marginalia-tts-follow-underline',
      data: { ttsFollow: true, source: 'start' },
      styles: { stroke: 'rgb(171, 82, 19)', 'stroke-width': '2.4' },
    });

    // Even when updates overlap, the serialized follow queue must finish at the latest cue.
    const displaysBeforeRapidUpdate = await page.evaluate(() => window.__ttsDisplayTargets.length);
    await page.evaluate(() => { window.__delayTtsDisplay = true; });
    await page.locator('#tts-audio').evaluate(audio => {
      audio.currentTime = 3;
      audio.dispatchEvent(new Event('timeupdate'));
      audio.currentTime = 0;
      audio.dispatchEvent(new Event('timeupdate'));
    });
    await expect.poll(() => page.evaluate(() => window.__ttsDisplayTargets.length))
      .toBeGreaterThanOrEqual(displaysBeforeRapidUpdate + 2);
    await expect.poll(() => iframe.evaluate(frame => frame.contentDocument.documentElement.dataset.ttsFollowText)).toBe('Chapter');
    await expect.poll(() => page.evaluate(() => {
      const target = window.__ttsDisplayTargets.at(-1);
      const underline = window.__ttsUnderlineCalls.at(-1);
      return Boolean(target && underline && target === underline.cfi && underline.data.source === 'timeline');
    })).toBe(true);
    await page.evaluate(() => { window.__delayTtsDisplay = false; });

    const pageBeforeLockedNavigation = await page.locator('#page-text').textContent();
    await page.keyboard.press('ArrowRight');
    await iframe.evaluate(frame => frame.contentDocument.dispatchEvent(new WheelEvent('wheel', { deltaY: 180, cancelable: true })));
    await page.locator('#toc-list .toc-item', { hasText: 'Chapter 2' }).click();
    await expect(page.locator('#page-text')).toHaveText(pageBeforeLockedNavigation);
    await expect(page.locator('#toolbar-chapter')).toContainText('Chapter 1');

    // A late cue is on a distant page: narration may follow it even while manual navigation is locked.
    await page.locator('#tts-audio').evaluate(audio => {
      audio.currentTime = 3;
      audio.dispatchEvent(new Event('timeupdate'));
    });
    await expect.poll(() => iframe.evaluate(frame => frame.contentDocument.documentElement.dataset.ttsFollowText)).toBe(finalCueText);
    await expect(page.locator('#page-text')).not.toHaveText(pageBeforeLockedNavigation);
    await expect(page.locator('#reader-view')).toHaveClass(/tts-navigation-locked/);

    const underlineRemovalsBeforePause = await page.evaluate(() => window.__ttsUnderlineRemovals.length);
    await page.click('#btn-tts-pause');
    await expect(page.locator('#tts-status')).toContainText('已暂停');
    await expect(page.locator('#tts-audio')).toHaveAttribute('data-mock-playing', 'false');
    await expect(page.locator('#reader-view')).not.toHaveClass(/tts-navigation-locked/);
    await expect.poll(() => iframe.evaluate(frame => frame.contentDocument.documentElement.dataset.ttsFollowText)).toBe(finalCueText);
    expect(await page.evaluate(() => window.__ttsUnderlineRemovals.length)).toBe(underlineRemovalsBeforePause);
    await page.click('#btn-tts-play');

    // Ending segment 1 before segment 2 exists enters a generated-wait state.
    await page.locator('#tts-audio').evaluate(audio => audio.dispatchEvent(new Event('ended')));
    await expect(page.locator('#tts-status')).toContainText('仍在生成');
    allowSecondSegment = true;
    await expect(page.locator('#tts-segment-label')).toContainText('第 2 / 2 段', { timeout: 10_000 });
    await expect(page.locator('#tts-audio')).toHaveAttribute('data-segment-index', '1');

    // Save a deterministic position, reload, and recreate the same cache task.
    await page.locator('#tts-audio').evaluate(audio => {
      audio.currentTime = 17;
      audio.dispatchEvent(new Event('timeupdate'));
    });
    await page.click('#btn-tts-pause');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('marginalia.tts.position')));
    expect(saved.segment_index).toBe(1);
    expect(Math.round(saved.current_time)).toBe(17);

    await page.reload();
    await expect(page.locator('#toolbar-book-title')).toContainText('Multichapter', { timeout: 10_000 });
    await page.click('#btn-reader-tools');
    await page.click('#btn-toggle-tts');
    await page.click('#btn-tts-start');
    await expect(page.locator('#tts-segment-label')).toContainText('第 2 / 2 段');
    await expect.poll(async () => page.locator('#tts-audio').evaluate(audio => Math.round(audio.currentTime))).toBe(17);

    // Navigation remains blocked after restore; pausing releases it before a chapter switch.
    await expect(page.locator('#reader-view')).toHaveClass(/tts-navigation-locked/);
    await page.click('#btn-tts-pause');
    await expect(page.locator('#reader-view')).not.toHaveClass(/tts-navigation-locked/);

    // A directory chapter switch must cancel the active task view and reset controls.
    await page.locator('#toc-list .toc-item', { hasText: 'Chapter 2' }).click();
    await expect(page.locator('#toolbar-chapter')).not.toContainText('Chapter 1', { timeout: 15_000 });
    await expect(page.locator('#tts-segment-label')).toHaveText('第 0 / 0 段');
    await expect(page.locator('#tts-audio')).toHaveAttribute('data-mock-playing', 'false');
    await expect.poll(() => page.evaluate(() => window.__ttsUnderlineRemovals.length)).toBeGreaterThan(0);
    await expect.poll(() => iframe.evaluate(frame => frame.contentDocument.documentElement.dataset.ttsFollowText)).toBeUndefined();

    failMode = true;
    if (await page.locator('#tts-panel').isHidden()) {
      await page.click('#btn-reader-tools');
      await page.click('#btn-toggle-tts');
    }
    await page.click('#btn-tts-start');
    await expect(page.locator('#tts-status')).toContainText('语音服务连接失败');
  });
});
