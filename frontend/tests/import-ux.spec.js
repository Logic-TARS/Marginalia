import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'multichapter.epub');
const fixtureBytes = fs.readFileSync(FIXTURE);

function makeServerBook(overrides = {}) {
  return {
    id: 'ux-server-book',
    title: 'Multichapter Test Fixture',
    author: 'Test Fixture Generator',
    filename: 'ux-server-book.epub',
    original_filename: 'multichapter.epub',
    content_hash: 'ux-fixture-hash',
    knowledge_book_id: 'ux-knowledge-book',
    knowledge_status: 'ready',
    knowledge_error: '',
    ...overrides,
  };
}

async function revealReaderChrome(page) {
  // Desktop reader chrome starts hidden; reveal it before toolbar clicks.
  if (await page.locator('#btn-back').isVisible()) return;
  const reveal = page.locator('#btn-reveal-reader-chrome');
  await reveal.waitFor({ state: 'visible', timeout: 10_000 });
  // dispatchEvent avoids the hover flicker: a real mouseenter opens the
  // chrome, which hides this button before the click lands.
  await reveal.dispatchEvent('click');
  await expect(page.locator('#btn-back')).toBeVisible();
}

async function installCommonRoutes(page, { uploadHandler, fileHandler, books = [] } = {}) {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();

    if (pathname === '/api/books' && method === 'GET') {
      await route.fulfill({ json: { books } });
      return;
    }
    if (pathname === '/api/books/upload' && method === 'POST' && uploadHandler) {
      await uploadHandler(route);
      return;
    }
    if (pathname.endsWith('/file') && method === 'GET' && fileHandler) {
      await fileHandler(route);
      return;
    }
    if (pathname.endsWith('/sync')) {
      const bookId = pathname.split('/')[3];
      await route.fulfill({
        json: {
          book_id: bookId,
          revision: 0,
          progress: null,
          bookmarks: [],
          highlights: [],
        },
      });
      return;
    }
    if (pathname.includes('/api/knowledge/books/')) {
      await route.fulfill({
        json: {
          id: 'ux-knowledge-book',
          status: 'ready',
          error_message: '',
        },
      });
      return;
    }
    if (pathname.endsWith('/conversations')) {
      await route.fulfill({ json: { conversations: [], count: 0 } });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: 'not mocked' } });
  });
}

test.describe('EPUB import feedback', () => {
  test.use({ serviceWorkers: 'block' });

  test('opens the first page before a slow server upload finishes', async ({ page }) => {
    test.setTimeout(30_000);
    const serverBook = makeServerBook();
    let releaseUpload;
    const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
    let uploadStarted = false;

    await installCommonRoutes(page, {
      uploadHandler: async route => {
        uploadStarted = true;
        await uploadGate;
        await route.fulfill({ status: 202, json: { created: true, book: serverBook } });
      },
    });

    await page.goto('/index.html');
    await page.setInputFiles('#file-input', FIXTURE);

    await expect(page.locator('#operation-status')).toBeVisible();
    await expect(page.locator('#toolbar-book-title')).toContainText('Multichapter', { timeout: 10_000 });
    await expect(page.locator('#reader-loading')).toBeHidden();
    await expect.poll(() => uploadStarted).toBe(true);

    releaseUpload();
    await expect(page.locator('#operation-status-message')).toContainText(/已保存到服务器|已全部就绪/);
  });

  test('keeps a failed upload readable and offers retry feedback', async ({ page }) => {
    await installCommonRoutes(page, {
      uploadHandler: async route => {
        await route.fulfill({ status: 503, json: { detail: 'temporary outage' } });
      },
    });

    await page.goto('/index.html');
    await page.setInputFiles('#file-input', FIXTURE);

    await expect(page.locator('#toolbar-book-title')).toContainText('Multichapter', { timeout: 10_000 });
    await expect(page.locator('#operation-status-message')).toContainText('上传失败');
    await expect(page.locator('#btn-operation-retry')).toBeVisible();
    await expect(page.locator('#reader-view')).toHaveClass(/active/);
  });

  test('accepts an EPUB file with an uppercase extension', async ({ page }) => {
    await installCommonRoutes(page, {
      uploadHandler: async route => {
        await route.fulfill({ status: 503, json: { detail: 'temporary outage' } });
      },
    });

    await page.goto('/index.html');
    await page.setInputFiles('#file-input', {
      name: 'BOOK.EPUB',
      mimeType: 'application/epub+zip',
      buffer: fixtureBytes,
    });

    await expect(page.locator('#toolbar-book-title')).toContainText('Multichapter', { timeout: 10_000 });
    await expect(page.locator('#reader-view')).toHaveClass(/active/);
  });

  test('deduplicates a re-import of the same content under a different filename', async ({ page }) => {
    await installCommonRoutes(page, {
      uploadHandler: async route => {
        await route.fulfill({ status: 503, json: { detail: 'temporary outage' } });
      },
    });

    await page.goto('/index.html');
    await page.setInputFiles('#file-input', {
      name: 'first.epub',
      mimeType: 'application/epub+zip',
      buffer: fixtureBytes,
    });
    await expect(page.locator('#toolbar-book-title')).toContainText('Multichapter', { timeout: 10_000 });

    await revealReaderChrome(page);
    await page.click('#btn-back');
    await expect(page.locator('.book-card')).toHaveCount(1);

    // Same bytes, different name: content-hash dedup must reuse the record.
    await page.setInputFiles('#file-input', {
      name: 'second-copy.epub',
      mimeType: 'application/epub+zip',
      buffer: fixtureBytes,
    });
    await expect(page.locator('#toolbar-book-title')).toContainText('Multichapter', { timeout: 10_000 });

    await revealReaderChrome(page);
    await page.click('#btn-back');
    await expect(page.locator('.book-card')).toHaveCount(1);
  });

  test('rejects an oversized file before reading it', async ({ page }) => {
    await installCommonRoutes(page, {});

    // Playwright caps setInputFiles buffers at 50MB, so use a real temp file.
    const hugePath = path.join(__dirname, 'fixtures', '.tmp-oversized.epub');
    fs.writeFileSync(hugePath, Buffer.alloc(91 * 1024 * 1024));
    try {
      await page.goto('/index.html');
      await page.setInputFiles('#file-input', hugePath);

      await expect(page.locator('#toast')).toContainText('超过 90MB 上限');
      await expect(page.locator('#operation-status-message')).toContainText('超过大小上限');
      await expect(page.locator('#reader-view')).not.toHaveClass(/active/);
    } finally {
      fs.rmSync(hugePath, { force: true });
    }
  });

  test('keeps the current read available when the offline copy exceeds browser quota', async ({ page }) => {
    const serverBook = makeServerBook();
    await page.addInitScript(() => {
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function patchedPut(value, ...args) {
        if (this.name === 'books' && value?.file_blob && value?.cached_content_hash) {
          throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
        }
        return originalPut.call(this, value, ...args);
      };
    });
    await installCommonRoutes(page, {
      books: [serverBook],
      fileHandler: route => route.fulfill({
        status: 200,
        contentType: 'application/epub+zip',
        body: fixtureBytes,
      }),
    });

    await page.goto('/index.html');
    await expect(page.locator('.book-card')).toHaveCount(1);
    await page.click('.book-card');

    await expect(page.locator('#toolbar-book-title')).toContainText('Multichapter', { timeout: 10_000 });
    await expect(page.locator('#toast')).toContainText('浏览器存储空间不足');
    await expect(page.locator('#reader-view')).toHaveClass(/active/);
  });

  test('persists a server EPUB locally and refreshes it only when the content changes', async ({ page }) => {
    test.setTimeout(30_000);
    const serverBook = makeServerBook();
    let fileRequestCount = 0;

    await installCommonRoutes(page, {
      books: [serverBook],
      fileHandler: async route => {
        fileRequestCount += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/epub+zip',
          headers: { 'Content-Length': String(fixtureBytes.length) },
          body: fixtureBytes,
        });
      },
    });

    await page.goto('/index.html');
    await expect(page.locator('.book-card')).toHaveCount(1);
    await expect(page.locator('.book-card-meta')).toContainText('需要联网打开');
    await page.click('.book-card');
    await expect(page.locator('#toolbar-book-title')).toContainText('Multichapter', { timeout: 10_000 });
    expect(fileRequestCount).toBe(1);

    await revealReaderChrome(page);
    await page.click('#btn-back');
    await expect(page.locator('#library-view')).toHaveClass(/active/);
    await expect(page.locator('.book-card-meta')).toContainText('已保存到本机');
    await page.click('.book-card');
    await expect(page.locator('#toolbar-book-title')).toContainText('Multichapter', { timeout: 10_000 });
    expect(fileRequestCount).toBe(1);

    await page.reload();
    await expect(page.locator('#toolbar-book-title')).toContainText('Multichapter', { timeout: 10_000 });
    expect(fileRequestCount).toBe(1);

    await revealReaderChrome(page);
    await page.click('#btn-back');
    await page.context().setOffline(true);
    await page.click('.book-card');
    await expect(page.locator('#toolbar-book-title')).toContainText('Multichapter', { timeout: 10_000 });
    expect(fileRequestCount).toBe(1);

    await revealReaderChrome(page);
    await page.click('#btn-back');
    await page.context().setOffline(false);
    serverBook.content_hash = 'ux-fixture-hash-v2';
    await page.reload();
    await expect(page.locator('.book-card-meta')).toContainText('需要联网打开');
    await page.click('.book-card');
    await expect(page.locator('#toolbar-book-title')).toContainText('Multichapter', { timeout: 10_000 });
    expect(fileRequestCount).toBe(2);
  });
});
